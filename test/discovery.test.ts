import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { atomic, now } from '../src/lib/store.ts';
import { active, authorizePublication, enrol, identity, metadata, originSlug, owners, sessionKey, sessions, unenrol } from '../src/lib/discovery.ts';
import { main } from '../src/cli/main.ts';
import { fixture } from './helpers.ts';

function register(f: ReturnType<typeof fixture>, key: string, extra: any = {}) {
  const s = { key, id: `S-${key}`, pid: 111, tty: `ttys${key}`, cwd: f.main, branch: 'd/task', detectedRepo: 'Test', sessionId: `s-${key}`, startedAt: now(), ...extra };
  atomic(f.store.path('sessions', `${key}.json`), s); atomic(f.store.path('heartbeats', `${key}.json`), { ...s, at: now() }); return s;
}
const options = { processes: () => [], alive: () => true };

test('discovery activation uses canonical roots, excludes, optout, stable wrapper key and git/tty metadata', () => {
  const f = fixture(); try {
    const alias = join(f.root, 'alias'); symlinkSync(f.root, alias); mkdirSync(join(f.root, 'excluded'));
    atomic(f.store.path('config.json'), { roots: [alias], excludes: [join(alias, 'excluded')] });
    assert.ok(active(f.store, f.main, {})); assert.equal(active(f.store, f.root + '-other', {}), false); assert.equal(active(f.store, join(f.root, 'excluded'), {}), false); assert.equal(active(f.store, f.main, { PI_ORCH_OPTOUT: '1' }), false);
    assert.equal(sessionKey({ PI_SESSION_WRAPPER_PID: '444' }, 123), 'w444'); assert.equal(sessionKey({ PI_SESSION_WRAPPER_PID: '444' }, 999), 'w444'); assert.equal(sessionKey({}, 123), 'p123');
    const info = metadata(f.store, join(alias, 'main')); assert.equal(info.detectedRepo, 'Test'); assert.equal(info.branch, 'main'); assert.ok(info.gitToplevel); assert.ok('tty' in info);
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

test('enrol by key/tty writes revisioned assignment and ack-required rules, unenrol by id, env wins', () => {
  const f = fixture(); try {
    register(f, 'w10', { tty: '/dev/ttys010' });
    const a = enrol(f.store, 'ttys010', { id: 'Lane-A', role: 'lane', repo: 'Test', by: 'L0', rules: 'exact rules' }, options);
    assert.equal(a.key, 'w10'); assert.equal(a.rev, 1); assert.equal(identity(f.store, 'w10').id, 'Lane-A');
    assert.equal(identity(f.store, 'w10', { PI_ORCH_ID: 'L0' }).role, 'l0');
    const rule = f.store.messages('w10')[0]; assert.equal(rule.requiresAck, true); assert.equal(rule.kind, 'rule'); assert.equal(rule.body, 'exact rules');
    const b = enrol(f.store, 'w10', { id: 'Chief', role: 'owner', repo: 'Test', by: 'L0' }, options); assert.equal(b.rev, 2); assert.equal(identity(f.store, 'w10').role, 'owner');
    assert.deepEqual(owners(f.store, options).map(o => o.id), ['Chief']);
    unenrol(f.store, 'Chief', options); assert.equal(identity(f.store, 'w10').assigned, false); assert.equal(existsSync(f.store.path('assignments', 'w10.json')), false);
    register(f, 'w11', { envId: 'R-Test', envRepo: 'Test', id: 'R-Test' });
    assert.throws(() => unenrol(f.store, 'w11', options), /overrides/); assert.throws(() => enrol(f.store, 'w11', { id: 'L1', role: 'lane', repo: 'Test', by: 'L0' }, options), /overrides/);
  } finally { f.restore(); }
});

test('two live owners per repo are refused; stale/dead owners release admission and wrapper liveness counts', () => {
  const f = fixture(); try {
    register(f, 'w10', { wrapperPid: 10 }); register(f, 'w20', { wrapperPid: 20 });
    enrol(f.store, 'w10', { id: 'R-Test', role: 'owner', repo: 'Test', by: 'L0' }, options);
    assert.throws(() => enrol(f.store, 'w20', { id: 'OtherOwner', role: 'owner', repo: 'Test', by: 'L0' }, options), /live owner/);
    assert.equal(owners(f.store, { ...options, alive: pid => pid === 10 }).length, 1);
    atomic(f.store.path('heartbeats', 'w10.json'), { at: new Date(Date.now() - 91000).toISOString() });
    enrol(f.store, 'w20', { id: 'OtherOwner', role: 'owner', repo: 'Test', by: 'L0' }, options); assert.equal(owners(f.store, options)[0].id, 'OtherOwner');
  } finally { f.restore(); }
});

test('CLI enrol/unenrol/owners and owners/lanes broadcasts use current assignments', () => {
  const f = fixture(); try {
    register(f, 'w10', { tty: 'ttys010' }); register(f, 'w20');
    const rules = join(f.root, 'rules.txt'); writeFileSync(rules, 'CLI rules');
    assert.equal(main(['enrol', 'ttys010', '--id', 'Boss', '--role', 'owner', '--repo', 'Test', '--rules-file', rules], f.store, options), 0);
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
    assert.throws(() => authorizePublication(f.store, 'Test', 'rebuild', { PI_SESSION_WRAPPER_PID: '30' }), /deliver/);
  } finally { f.restore(); }
});
