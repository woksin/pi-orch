import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { atomic, now } from '../src/lib/store.ts';
import { active, authorizePublication, enrol, identity, metadata, originSlug, owners, sessionKey, sessions, unenrol } from '../src/lib/discovery.ts';
import { main } from '../src/cli/main.ts';
import { fixture } from './helpers.ts';

function register(f: ReturnType<typeof fixture>, key: string, extra: any = {}) {
  if (!existsSync(f.store.path('config.json'))) atomic(f.store.path('config.json'), { roots: [f.root], excludes: [] });
  const wrapperPid = key.startsWith('w') ? Number(key.slice(1)) : undefined;
  const s = { key, id: `S-${key}`, pid: process.pid, wrapperPid, hostStart: START, processIdentity: { pid: wrapperPid || process.pid, start: START }, admittedEnv: true, tty: `ttys${key}`, cwd: f.main, branch: 'd/task', detectedRepo: 'Test', sessionId: `s-${key}`, startedAt: now(), ...extra };
  atomic(f.store.path('sessions', `${key}.json`), s); atomic(f.store.path('heartbeats', `${key}.json`), { ...s, at: now() }); return s;
}
const START = '2020-01-01T00:00:00.000Z';
const options = { processes: () => [], alive: () => true, start: () => START, ancestors: () => [], pid: 900001, env: {} };

test('discovery activation uses canonical roots, excludes, optout, stable wrapper key and git/tty metadata', async () => {
  const f = fixture(); try {
    const alias = join(f.root, 'alias'); symlinkSync(f.root, alias); mkdirSync(join(f.root, 'excluded'));
    atomic(f.store.path('config.json'), { roots: [alias], excludes: [join(alias, 'excluded')] });
    assert.ok(active(f.store, f.main, {})); assert.equal(active(f.store, f.root + '-other', {}), false); assert.equal(active(f.store, join(f.root, 'excluded'), {}), false); assert.equal(active(f.store, f.main, { PI_ORCH_OPTOUT: '1' }), false);
    assert.equal(sessionKey({ PI_SESSION_WRAPPER_PID: '444' }, 123), 'w444'); assert.equal(sessionKey({ PI_SESSION_WRAPPER_PID: '444' }, 999), 'w444'); assert.equal(sessionKey({}, 123), 'p123');
    const info = await metadata(f.store, join(alias, 'main')); assert.equal(info.detectedRepo, 'Test'); assert.equal(info.branch, 'main'); assert.ok(info.gitToplevel); assert.ok('tty' in info);
    for (const url of ['git@github.com:Cratis/Studio.git', 'https://github.com/Cratis/Studio.git', 'ssh://git@github.com/Cratis/Studio']) assert.equal(originSlug(url), 'Cratis/Studio');
  } finally { f.restore(); }
});

test('sessions merges injected uninstrumented pi processes and cached PRs without probing host discovery', () => {
  const f = fixture(); try {
    register(f, 'w10', { pid: 101, wrapperPid: 10 });
    atomic(f.store.path('gh', 'Test.json'), { at: now(), prs: [{ number: 20, state: 'OPEN', headRefName: 'd/task', ci: 'SUCCESS' }, { number: 21, state: 'CLOSED', headRefName: 'd/task' }] });
    const injected = { ...options, processes: () => [{ pid: 102, wrapperPid: 10, cwd: f.main }, { pid: 202, tty: 'ttys202', cwd: f.main }], inspect: () => ({ detectedRepo: 'Test', branch: 'd/task' }) };
    assert.equal(sessions(f.store, false, injected).length, 1);
    const all = sessions(f.store, true, injected); assert.equal(all.length, 2); assert.equal(all[0].key, 'w10'); assert.equal(all[1].key, 'p202'); assert.equal(all[1].instrumented, false); assert.deepEqual(all[1].prs, [{ number: 20, ci: 'SUCCESS' }]);
    assert.equal(main(['sessions', '--all', '--json'], f.store, injected), 0);
  } finally { f.restore(); }
});

test('enrol by key/tty writes revisioned assignment and ack-required rules, unenrol by id, assignment wins', () => {
  const f = fixture(); try {
    register(f, 'w10', { tty: '/dev/ttys010' });
    const a = enrol(f.store, 'ttys010', { id: 'Lane-A', role: 'lane', repo: 'Test', by: 'L0', rules: 'exact rules' }, options);
    assert.equal(a.key, 'w10'); assert.equal(a.rev, 1); assert.equal(identity(f.store, 'w10').id, 'Lane-A');
    assert.equal(identity(f.store, 'w10', { PI_ORCH_ID: 'L0' }).role, 'lane');
    const rule = f.store.messages('w10')[0]; assert.equal(rule.requiresAck, true); assert.equal(rule.kind, 'rule'); assert.equal(rule.body, 'exact rules');
    const b = enrol(f.store, 'w10', { id: 'R-Test', role: 'owner', repo: 'Test', by: 'L0' }, options); assert.equal(b.rev, 2); assert.equal(identity(f.store, 'w10').role, 'owner');
    assert.deepEqual(owners(f.store, options).map(o => o.id), ['R-Test']);
    unenrol(f.store, 'R-Test', options); assert.equal(identity(f.store, 'w10').assigned, false); assert.equal(existsSync(f.store.path('assignments', 'w10.json')), true);
    register(f, 'w11', { envId: 'R-Test', envRepo: 'Test', id: 'R-Test' });
    unenrol(f.store, 'w11', options); assert.equal(identity(f.store, 'w11', { PI_ORCH_ID: 'R-Test' }).assigned, false); enrol(f.store, 'w11', { id: 'L1', role: 'lane', repo: 'Test', by: 'L0' }, options); assert.equal(identity(f.store, 'w11', { PI_ORCH_ID: 'R-Test' }).role, 'lane');
    unenrol(f.store, 'w11', options); assert.equal(identity(f.store, 'w11', { PI_ORCH_ID: 'R-Test' }).assigned, false);
    register(f, 'w12'); enrol(f.store, 'w12', { id: 'R-Test', role: 'owner', repo: 'Test', by: 'L0' }, options);
  } finally { f.restore(); }
});

test('two live owners per repo are refused; stale owners reserve admission until explicit handover and wrapper liveness counts', () => {
  const f = fixture(); try {
    register(f, 'w10', { wrapperPid: 10 }); register(f, 'w20', { wrapperPid: 20 });
    enrol(f.store, 'w10', { id: 'R-Test', role: 'owner', repo: 'Test', by: 'L0' }, options);
    assert.throws(() => enrol(f.store, 'w20', { id: 'R-Test', role: 'owner', repo: 'Test', by: 'L0' }, options), /ID already/);
    assert.equal(owners(f.store, { ...options, alive: pid => pid === 10 }).length, 1);
    register(f, 'w20', { wrapperPid: 20 }); // The dead-registration query pruned this simulated process.
    atomic(f.store.path('heartbeats', 'w10.json'), { at: new Date(Date.now() - 91000).toISOString() });
    assert.throws(() => enrol(f.store, 'w20', { id: 'R-Test', role: 'owner', repo: 'Test', by: 'L0' }, options), /ID already/);
    unenrol(f.store, 'w10', options); enrol(f.store, 'w20', { id: 'R-Test', role: 'owner', repo: 'Test', by: 'L0' }, options); assert.equal(owners(f.store, options)[0].id, 'R-Test');
  } finally { f.restore(); }
});

test('CLI enrol/unenrol/owners and owners/lanes broadcasts use current assignments', () => {
  const f = fixture(); try {
    register(f, 'w10', { tty: 'ttys010' }); register(f, 'w20');
    const rules = join(f.root, 'rules.txt'); writeFileSync(rules, 'CLI rules');
    assert.equal(main(['enrol', 'ttys010', '--id', 'R-Test', '--role', 'owner', '--repo', 'Test', '--rules-file', rules], f.store, options), 0);
    assert.equal(main(['enrol', 'w20', '--id', 'L2', '--role', 'lane', '--repo', 'Test'], f.store, options), 0); assert.equal(main(['owners'], f.store, options), 0);
    const msg = { from: 'L0', kind: 'info', subject: 'group', body: 'hello', requiresAck: false, ackDeadlineMin: 30 };
    assert.deepEqual(f.store.send({ ...msg, to: 'owners' }).map(m => m.to), ['w10']); assert.deepEqual(f.store.send({ ...msg, to: 'lanes' }).map(m => m.to), ['w20']);
    assert.equal(main(['unenrol', 'L2'], f.store, options), 0); assert.equal(identity(f.store, 'w20').assigned, false);
  } finally { f.restore(); }
});

test('CLI rejects lane publication and owner holds for orch push/land/rebuild before side effects', () => {
  const f = fixture(); try {
    for (const command of ['push', 'land', 'rebuild']) assert.equal(main(['cand', command, '--repo', 'Test', '--cand', 'missing'], f.store, { ...options, env: { PI_ORCH_ID: 'L2', PI_REPO: 'Test' } }), 2);
    assert.equal(existsSync(f.ghCalls), false);
    const hold = { id: 'hold', from: 'L0', to: 'R-Test', kind: 'hold', subject: 'pause', body: '', requiresAck: false, ackDeadlineMin: 30, createdAt: '2026-01-01', repo: 'Test', blocks: ['push', 'pr-create', 'pr-merge'] };
    atomic(f.store.path('inbox', 'R-Test', 'hold.json'), hold);
    const ownerEnv = { PI_ORCH_ID: 'R-Test', PI_REPO: 'Test' };
    for (const command of ['push', 'land'] as const) { assert.throws(() => authorizePublication(f.store, 'Test', command, ownerEnv), /hold/); assert.equal(main(['cand', command, '--repo', 'Test', '--cand', 'missing'], f.store, { ...options, env: ownerEnv }), 2); }
    atomic(f.store.path('inbox', 'R-Test', 'release.json'), { ...hold, id: 'release', kind: 'release', createdAt: '2026-01-02' });
    assert.doesNotThrow(() => authorizePublication(f.store, 'Test', 'push', ownerEnv)); assert.doesNotThrow(() => authorizePublication(f.store, 'Test', 'land', ownerEnv));
    register(f, 'w30'); enrol(f.store, 'w30', { id: 'L3', role: 'lane', repo: 'Test', by: 'L0' }, options);
    assert.throws(() => authorizePublication(f.store, 'Test', 'rebuild', { PI_SESSION_WRAPPER_PID: '30' }, options), /deliver/);
  } finally { f.restore(); }
});

test('B2: a registered lane cannot unenrol or promote itself, spoof L0, opt out, or administer another session', () => {
  const f = fixture(); try {
    register(f, 'w10'); register(f, 'w20'); enrol(f.store, 'w10', { id: 'L7', role: 'lane', repo: 'Test', by: 'L0' }, options);
    const before = JSON.stringify(f.store.list('assignments'));
    const caller = { ...options, ancestors: () => [process.pid], env: { PI_ORCH_ID: 'L0', PI_SESSION_WRAPPER_PID: '20', PI_ORCH_OPTOUT: '1' } };
    for (const args of [ ['unenrol', 'w10'], ['enrol', 'w10', '--id', 'R-Test', '--role', 'owner', '--repo', 'Test'], ['enrol', 'w20', '--id', 'L0', '--role', 'l0'] ]) assert.equal(main(args, f.store, caller), 2);
    assert.equal(JSON.stringify(f.store.list('assignments')), before);
    assert.throws(() => authorizePublication(f.store, 'Test', 'push', caller.env, caller), /deliver/);
    assert.equal(identity(f.store, 'w10', { PI_ORCH_ID: 'L0' }).role, 'lane');
    unenrol(f.store, 'w10', options); assert.equal(identity(f.store, 'w10', { PI_ORCH_ID: 'L0' }).assigned, false);
    assert.equal(main(['enrol', 'w10', '--id', 'L0', '--role', 'l0'], f.store, caller), 2);
  } finally { f.restore(); }
});

test('B3: process start mismatch invalidates p and w assignments, and mismatched CLI callers fail closed', () => {
  const f = fixture(); try {
    for (const k of [`p${process.pid}`, 'w10']) {
      const s = register(f, k); enrol(f.store, k, { id: `L-${k}`, role: 'lane', repo: 'Test', by: 'L0' }, options);
      const next = { ...s, hostStart: '2021-01-01T00:00:00.000Z', processIdentity: { ...s.processIdentity, start: '2021-01-01T00:00:00.000Z' } };
      atomic(f.store.path('sessions', `${k}.json`), next); assert.equal(identity(f.store, k).assigned, false);
      const caller = { ...options, ancestors: () => [process.pid] };
      assert.throws(() => authorizePublication(f.store, 'Test', 'push', {}, caller), /identity mismatch/);
    }
  } finally { f.restore(); }
});

test('B4: enrol enforces canonical ID-role-repo pairs and refuses duplicate lane IDs', () => {
  const f = fixture(); try {
    register(f, 'w10'); register(f, 'w20');
    for (const input of [ { id: 'R-Test', role: 'lane', repo: 'Test' }, { id: 'O-Test', role: 'owner', repo: 'Test' }, { id: 'R-Other', role: 'owner', repo: 'Test' }, { id: 'L0', role: 'owner', repo: 'Test' }, { id: 'L9', role: 'l0' }, { id: 'L0', role: 'l0', repo: 'Test' } ]) assert.throws(() => enrol(f.store, 'w10', { ...input, by: 'L0' } as any, options), /id\/role mismatch/);
    enrol(f.store, 'w10', { id: 'L9', role: 'lane', repo: 'Test', by: 'L0' }, options);
    assert.throws(() => enrol(f.store, 'w20', { id: 'L9', role: 'lane', repo: 'Test', by: 'L0' }, options), /ID already/);
    assert.equal(identity(f.store, 'w20', { PI_ORCH_ID: 'R-Other', PI_REPO: 'Test' }).assigned, false);
  } finally { f.restore(); }
});

test('A5: prune dead registrations, broadcast only to fresh rooted sessions, and resolve reused tty live', () => {
  const f = fixture(); try {
    register(f, 'w11', { pid: 111, tty: 'ttys009' }); register(f, 'w22', { tty: 'ttys009' });
    const live = { ...options, alive: (pid: number) => pid === process.pid || pid === 22 };
    assert.deepEqual(sessions(f.store, false, live).map(s => s.key), ['w22']); assert.equal(existsSync(f.store.path('sessions', 'w11.json')), false);
    assert.equal(enrol(f.store, 'ttys009', { id: 'L2', role: 'lane', repo: 'Test', by: 'L0' }, live).key, 'w22');
    const msg = { from: 'L0', to: 'ALL', kind: 'info', subject: 'fresh only', body: '', requiresAck: false, ackDeadlineMin: 30 };
    assert.deepEqual(f.store.send(msg).map(m => m.to), ['w22']);
    atomic(f.store.path('heartbeats', 'w22.json'), { at: new Date(Date.now() - 91000).toISOString() }); assert.equal(f.store.send(msg).length, 0);
    const discovered = { ...options, processes: () => [{ pid: 404, cwd: f.main }, { pid: 405, cwd: f.root + '-outside' }], inspect: () => ({ detectedRepo: 'Test' }) };
    assert.deepEqual(sessions(f.store, true, discovered).filter(s => !s.instrumented).map(s => s.key), ['p404']);
    assert.throws(() => enrol(f.store, 'p404', { id: 'L4', role: 'lane', repo: 'Test', by: 'L0' }, discovered), /not instrumented/);
  } finally { f.restore(); }
});
