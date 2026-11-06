import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { atomic, now, readJson } from '../src/lib/store.ts';
import { acquirePollLock, pollOnce, rollup } from '../src/lib/poller.ts';
import { fixture } from './helpers.ts';

function healthFixture() {
  const f = fixture(), s = f.store, time = Date.now(), statusDir = s.path('status'); mkdirSync(statusDir, { recursive: true });
  const options = { env: { LANE_STATUS_DIR: statusDir }, alive: (_pid: number) => true, start: (_pid: number) => 'start' as string | undefined };
  const add = (id: string, pid: number, repo = 'Test', age = 700000, wrapperPid?: number) => {
    const key = `${wrapperPid ? 'w' : 'p'}${wrapperPid || pid}`, role = id === 'L0' ? 'l0' : id.startsWith('R-') ? 'owner' : 'lane', binding = { pid: wrapperPid || pid, start: 'start' };
    atomic(s.path('sessions', `${key}.json`), { key, id, kind: role, repo: role === 'l0' ? undefined : repo, pid, wrapperPid, hostStart: 'start', processIdentity: binding, cwd: f.root, assigned: true });
    atomic(s.path('assignments', `${key}.json`), { key, id, role, repo: role === 'l0' ? undefined : repo, binding });
    atomic(s.path('heartbeats', `${key}.json`), { key, id, pid, wrapperPid, at: new Date(time - age).toISOString() });
    return key;
  };
  add('R-Test', 900, 'Test', 0);
  const notices = (id: string) => s.messages(id).filter(m => m.refs?.source === 'heartbeat-health');
  return { ...f, s, time, statusDir, options, add, notices, poll: (at = time) => pollOnce(s, at, options) };
}

test('health groups accountable recipients, dedupes persisted edges and silently clears/reopens', () => {
  const f = healthFixture(); try {
    const { s, time } = f; atomic(s.path('repos.json'), { ...s.repos(), Other: { ...s.repo('Test'), enrolled: false } });
    f.add('R-Other', 901, 'Other', 0); const a = f.add('L1', 11), b = f.add('L2', 12); f.add('L3', 13, 'Other');
    assert.deepEqual(f.poll().errors, []); assert.equal(f.notices('R-Test').length, 1); assert.equal(f.notices('R-Other').length, 1); assert.equal(f.notices('L0').length, 0);
    assert.match(f.notices('R-Test')[0].body, /L1/); assert.match(f.notices('R-Test')[0].body, /L2/);
    for (const key of [a, b]) atomic(s.path('heartbeats', `${key}.json`), { ...readJson<any>(s.path('heartbeats', `${key}.json`)), at: new Date(time - 800000).toISOString(), unacked: ['new'] });
    f.poll(time + 120000); f.poll(time + 240000); assert.equal(f.notices('R-Test').length, 1);
    for (const key of [a, b]) atomic(s.path('heartbeats', `${key}.json`), { ...readJson<any>(s.path('heartbeats', `${key}.json`)), at: new Date(time).toISOString() });
    f.poll(); assert.equal(f.notices('R-Test').length, 1); f.poll(time + 700001); assert.equal(f.notices('R-Test').length, 2);
    unlinkSync(s.path('heartbeats', `${a}.json`)); f.poll(time + 700002);
    assert.ok(!JSON.stringify(readJson<any>(s.path('poller-state.json')).health).includes(`\"${a}\"`));
    assert.ok(s.messages('ALL').length === 0 && s.messages('L1').length === 0); assert.equal(f.notices('R-Test')[0].requiresAck, false);
  } finally { f.restore(); }
});

test('health per-target failure retries pending only, recovery cancels retry, old state is compatible', () => {
  const f = healthFixture(); try {
    f.add('L1', 11); f.add('L0', 14, 'Test');
    atomic(f.s.path('poller-state.json'), { staleDigestAt: f.time });
    const send = f.s.send.bind(f.s); let fail = true, failingTarget = 'L0';
    f.s.send = input => { if (input.to === failingTarget && fail) throw new Error('target unavailable'); return send(input); };
    assert.match(f.poll().errors.join(), /target unavailable/); assert.equal(f.notices('R-Test').length, 1); assert.equal(f.notices('L0').length, 0);
    fail = false; assert.deepEqual(f.poll().errors, []); assert.equal(f.notices('R-Test').length, 1); assert.equal(f.notices('L0').length, 1);
    f.poll(); assert.equal(f.notices('L0').length, 1);
    f.options.alive = pid => pid !== 11; fail = true; failingTarget = 'R-Test'; assert.match(f.poll().errors.join(), /target unavailable/);
    f.add('L1', 11, 'Test', 0); f.options.alive = () => true; f.poll(); fail = false; f.poll();
    assert.equal(f.notices('L0').length, 1); assert.equal(f.notices('R-Test').length, 1);
  } finally { f.restore(); }
});

for (const scenario of ['fresh', 'stale', 'parked', 'waiting', 'expired', 'malformed', 'directory', 'dead-parked', 'wrapper', 'reused', 'unverifiable', 'invalid-at', 'missing-at', 'future-at', 'mismatched', 'ambiguous', 'owner', 'no-owner']) {
  test(`health observation ${scenario} does not confuse intent, age and process identity`, () => {
    const f = healthFixture(); try {
      const id = scenario === 'owner' ? 'R-Test' : 'L1', key = f.add(id, 11, 'Test', scenario === 'fresh' ? 0 : 700000, scenario === 'wrapper' ? 111 : undefined);
      const path = f.s.path('heartbeats', `${key}.json`), hb = readJson<any>(path);
      if (scenario.endsWith('-at')) { if (scenario === 'missing-at') delete hb.at; else hb.at = scenario === 'future-at' ? new Date(f.time + 1).toISOString() : 'invalid'; atomic(path, hb); }
      const status = join(f.statusDir, `${id}.status`);
      if (['parked', 'dead-parked'].includes(scenario)) writeFileSync(status, 'parked');
      if (scenario === 'waiting') writeFileSync(status, `waiting-on "CI" until ${new Date(f.time + 60000).toISOString()}`);
      if (scenario === 'expired') writeFileSync(status, `barred-by "owner" until ${new Date(f.time - 1).toISOString()}`);
      if (scenario === 'malformed') writeFileSync(status, 'unknown'); if (scenario === 'directory') mkdirSync(status);
      if (scenario === 'dead-parked') f.options.alive = pid => pid !== 11;
      if (scenario === 'wrapper') f.options.alive = pid => pid !== 11;
      if (scenario === 'reused') f.options.start = pid => pid === 11 ? 'other' : 'start';
      if (scenario === 'unverifiable') f.options.start = pid => pid === 11 ? undefined : 'start';
      if (scenario === 'mismatched') atomic(f.s.path('assignments', `${key}.json`), { key, id, role: 'lane', repo: 'Other', binding: { pid: 11, start: 'wrong' } });
      if (scenario === 'ambiguous') atomic(f.s.path('assignments', 'p222.json'), { key: 'p222', id, role: 'lane', repo: 'Test', binding: { pid: 222, start: 'start' } });
      if (scenario === 'no-owner') f.options.start = pid => pid === 900 ? undefined : 'start';
      assert.deepEqual(f.poll().errors, []);
      const healthy = ['fresh', 'parked', 'waiting'].includes(scenario), fallback = ['reused', 'unverifiable', 'mismatched', 'ambiguous', 'owner', 'no-owner'].includes(scenario);
      assert.equal(f.notices('R-Test').length, !healthy && !fallback ? 1 : 0, scenario); assert.equal(f.notices('L0').length, !healthy && fallback ? 1 : 0, scenario);
      const notice = [...f.notices('R-Test'), ...f.notices('L0')][0];
      if (notice) assert.match(notice.body, scenario === 'dead-parked' ? /dead/ : ['stale', 'wrapper'].includes(scenario) ? /stale/ : /uncertain|stale/);
      f.poll(f.time + 1); assert.equal([...f.notices('R-Test'), ...f.notices('L0')].length, healthy ? 0 : 1);
      assert.ok(existsSync(f.s.path('heartbeats', `${key}.json`))); // notification tracking never prunes observations
    } finally { f.restore(); }
  });
}

test('health edges change only with process, class or accountable recipient, not heartbeat bytes', () => {
  const f = healthFixture(); try {
    f.add('L1', 11); f.poll(); assert.equal(f.notices('R-Test').length, 1);
    f.options.start = pid => pid === 900 ? undefined : 'start'; f.poll(); assert.equal(f.notices('L0').length, 1); f.poll(); assert.equal(f.notices('L0').length, 1);
    f.options.start = () => 'start'; f.poll(); assert.equal(f.notices('R-Test').length, 2);
    for (const [dir, field] of [['sessions', 'processIdentity'], ['assignments', 'binding']]) {
      const path = f.s.path(dir, 'p11.json'), doc = readJson<any>(path); doc[field].start = 'new'; if (dir === 'sessions') doc.hostStart = 'new'; atomic(path, doc);
    }
    f.options.start = pid => pid === 11 ? 'new' : 'start'; f.poll(); assert.equal(f.notices('R-Test').length, 3); f.poll(); assert.equal(f.notices('R-Test').length, 3);
    const subjects = f.notices('R-Test').at(-1)!.refs!.subjects as any[]; assert.equal(subjects[0].key, 'p11'); assert.equal(subjects[0].classification, 'stale'); assert.ok(subjects[0].episode); assert.equal(subjects[0].processIdentity.start, 'new');
    assert.equal(f.notices('L1').length, 0); assert.equal(f.notices('ALL').length, 0);
  } finally { f.restore(); }
});

test('health uses shared directory precedence and nonblocking safe file reads', () => {
  for (const type of ['inbox', 'override', 'symlink', 'fifo', 'large', 'unsafe']) {
    const f = healthFixture(); try {
      f.add('L1', 11);
      const inbox = f.s.path('inbox-root'); mkdirSync(join(inbox, 'status'), { recursive: true }); writeFileSync(join(inbox, 'status', 'L1.status'), 'parked');
      const env: NodeJS.ProcessEnv = { INBOX_DIR: inbox };
      if (type !== 'inbox') env.LANE_STATUS_DIR = f.statusDir;
      const path = join(f.statusDir, 'L1.status');
      if (type === 'override') writeFileSync(path, 'working');
      if (type === 'symlink') symlinkSync(join(inbox, 'status', 'L1.status'), path);
      if (type === 'fifo') execFileSync('mkfifo', [path]);
      if (type === 'large') writeFileSync(path, 'parked\n' + 'x'.repeat(4097));
      if (type === 'unsafe') { const doc = readJson<any>(f.s.path('heartbeats', 'p11.json')); doc.id = '../L1'; atomic(f.s.path('heartbeats', 'p11.json'), doc); }
      assert.deepEqual(pollOnce(f.s, f.time, { ...f.options, env }).errors, []);
      assert.equal([...f.notices('R-Test'), ...f.notices('L0')].length, type === 'inbox' ? 0 : 1, type);
    } finally { f.restore(); }
  }
});

test('poller rollup decisions: pending, success, failure and no checks', () => {
  assert.equal(rollup([]), 'UNKNOWN'); assert.equal(rollup([{ status: 'IN_PROGRESS' }]), 'PENDING');
  assert.equal(rollup([{ conclusion: 'SUCCESS' }, { state: 'SUCCESS' }, { conclusion: 'SKIPPED' }]), 'SUCCESS');
  assert.equal(rollup([{ conclusion: 'SUCCESS' }, { conclusion: 'FAILURE' }]), 'FAILURE');
});

test('poller transitions + closed PR view + escalation + health edge + rate backoff + single instance', () => {
  const f = fixture(); try {
    const s = f.store, time = Date.now();
    s.saveCandidate({ name: 'Test-poll', repo: 'Test', branch: 'cand/Test-poll', base: 'base', headSha: 'head', createdAt: now(), members: [], bounced: [], express: false, pr: 10 });
    const release = acquirePollLock(s); assert.throws(() => acquirePollLock(s), /EEXIST/);
    const child = spawnSync(process.execPath, [fileURLToPath(new URL('../src/cli/poll.ts', import.meta.url)), '--once'], { env: { ...process.env, ORCH_HOME: s.home }, encoding: 'utf8', timeout: 5000 });
    assert.equal(child.status, 2); assert.match(child.stderr, /single instance/); release(); const again = acquirePollLock(s); again();
    const pr = { number: 10, headRefName: 'cand/Test-poll', headRefOid: 'head', statusCheckRollup: [{ conclusion: 'SUCCESS' }] };
    writeFileSync(f.ghData, JSON.stringify({ list: [pr] })); assert.deepEqual(pollOnce(s, time).errors, []);
    assert.equal(s.messages('R-Test').filter(m => m.kind === 'ci').length, 1); pollOnce(s, time + 120000); assert.equal(s.messages('R-Test').length, 1);
    writeFileSync(f.ghData, JSON.stringify({ list: [{ ...pr, statusCheckRollup: [{ conclusion: 'FAILURE' }] }] })); pollOnce(s, time + 240000); assert.equal(s.messages('R-Test').length, 2);
    writeFileSync(f.ghData, JSON.stringify({ list: [], view: { ...pr, state: 'MERGED' } })); pollOnce(s, time + 360000); assert.equal(s.messages('R-Test').length, 3);
    const viewCalls = readFileSync(f.ghCalls, 'utf8').split('\n').filter(l => l.includes('"view"')).length; pollOnce(s, time + 480000); assert.equal(readFileSync(f.ghCalls, 'utf8').split('\n').filter(l => l.includes('"view"')).length, viewCalls);
    const [m] = s.send({ from: 'L0', to: 'L1', kind: 'order', subject: 'late', body: 'work', requiresAck: true, ackDeadlineMin: 1 });
    const [acked] = s.send({ from: 'L0', to: 'L2', kind: 'order', subject: 'acked', body: 'work', requiresAck: true, ackDeadlineMin: 1 }); s.record('L2', acked.id, 'acked');
    const [declined] = s.send({ from: 'L0', to: 'L3', kind: 'order', subject: 'declined', body: 'work', requiresAck: true, ackDeadlineMin: 1 }); s.record('L3', declined.id, 'declined');
    atomic(s.path('heartbeats', 'L1.json'), { id: 'L1', at: new Date(time - 700000).toISOString(), pid: process.pid });
    pollOnce(s, time + 17 * 60000); assert.ok(s.has('L1', m.id, 'escalated')); assert.equal(s.messages('L0').length, 3);
    pollOnce(s, time + 18 * 60000); assert.equal(s.messages('L0').length, 3); pollOnce(s, time + 48 * 60000); assert.equal(s.messages('L0').length, 3);
    writeFileSync(f.ghData, JSON.stringify({ error: 'HTTP 429 too many requests' })); assert.equal(pollOnce(s, time + 49 * 60000).errors.length, 1);
    const count = readFileSync(f.ghCalls, 'utf8').split('\n').length; pollOnce(s, time + 50 * 60000); assert.equal(readFileSync(f.ghCalls, 'utf8').split('\n').length, count);
    assert.equal(readJson<any>(s.path('poller-state.json')).backoff.Test, time + 59 * 60000);
  } finally { f.restore(); }
});

test('poller reclaims a stale crash lock and keeps single-instance exclusion', () => {
  const f = fixture(); try {
    atomic(f.store.path('poller.lock'), { pid: 2147483647, at: new Date().toISOString() });
    const release = acquirePollLock(f.store); assert.throws(() => acquirePollLock(f.store), /EEXIST/); release();
    assert.deepEqual(pollOnce(f.store).errors, []);
  } finally { f.restore(); }
});


test('N1: each poller tick prunes dead and reused assignment bindings, including tombstones', () => {
  const f = fixture(); try {
    for (const [key, pid, start, id] of [['w11', 11, 'start', 'L11'], ['p12', 12, 'old', 'L12'], ['w13', 13, 'start', 'L13'], ['w14', 14, 'start', null], ['p15', 15, 'start', 'L15']]) {
      atomic(f.store.path('assignments', `${key}.json`), { key, id, binding: { pid, start } });
    }
    const options = { alive: (pid: number) => pid !== 11 && pid !== 14, start: (pid: number) => pid === 15 ? undefined : 'start' };
    assert.deepEqual(pollOnce(f.store, Date.now(), options).errors, []);
    assert.deepEqual(f.store.list<any>('assignments').map(a => a.key), ['p15', 'w13']);
    assert.equal(existsSync(f.store.path('locks', 'assignments.lock')), false);
  } finally { f.restore(); }
});

for (const owner of ['live', 'stale-heartbeat', 'dead', 'reused', 'unverifiable', 'absent', 'invalid', 'legacy']) {
  test(`CI failure fallback: ${owner} owner binding and persisted edge dedupe`, () => {
    const f = fixture();
    try {
      const s = f.store, time = Date.now(), ci = () => s.messages('L0').filter(m => m.kind === 'ci');
      s.saveCandidate({ name: 'Test-owner', repo: 'Test', branch: 'cand/Test-owner', base: 'base', headSha: 'head', createdAt: now(), members: [], bounced: [], express: false, pr: 10 });
      if (!['absent', 'legacy'].includes(owner)) atomic(s.path('assignments', 'p42.json'), { key: 'p42', id: 'R-Test', role: owner === 'invalid' ? 'lane' : 'owner', repo: 'Test', binding: { pid: 42, start: owner === 'reused' ? 'old' : 'start' } });
      // A heartbeat alone must neither prove nor disprove a live process binding.
      atomic(s.path('heartbeats', 'p42.json'), { id: 'R-Test', at: new Date(time - 1000000).toISOString(), pid: 42 });
      if (owner === 'legacy') atomic(s.path('owners.json'), { Test: 'R-Test' });
      const options = { alive: () => owner !== 'dead', start: () => owner === 'unverifiable' ? undefined : 'start' };
      const pr = { number: 10, headRefName: 'cand/Test-owner', headRefOid: 'head', statusCheckRollup: [{ conclusion: 'FAILURE' }] };
      writeFileSync(f.ghData, JSON.stringify({ list: [pr] }));
      assert.deepEqual(pollOnce(s, time, options).errors, []);
      assert.equal(s.messages('R-Test').filter(m => m.kind === 'ci').length, 1);
      assert.equal(ci().length, ['live', 'stale-heartbeat'].includes(owner) ? 0 : 1, owner);
      const count = ci().length;
      pollOnce(s, time + 120000, options); assert.equal(ci().length, count); // Fresh call reads persisted state.
      for (const [i, conclusion] of ['SUCCESS', 'FAILURE'].entries()) {
        writeFileSync(f.ghData, JSON.stringify({ list: [{ ...pr, statusCheckRollup: [{ conclusion }] }] }));
        pollOnce(s, time + (i + 2) * 120000, options);
      }
      assert.equal(s.messages('R-Test').filter(m => m.kind === 'ci').length, 3);
      assert.equal(ci().length, count * 2, owner);
      writeFileSync(f.ghData, JSON.stringify({ list: [], view: { ...pr, state: 'MERGED' } }));
      pollOnce(s, time + 600000, options); assert.equal(ci().length, count * 2);
    } finally { f.restore(); }
  });
}
