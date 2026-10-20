import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import laneBus, { handoffActive } from '../src/extension/lane-bus.ts';
import { atomic, Store } from '../src/lib/store.ts';
import { deliveryBatch, formatMessage, guard, holds, phaseGuard } from '../src/lib/decisions.ts';
import { enrol, unenrol } from '../src/lib/discovery.ts';
import { busFixture } from './bus-harness.ts';

test('lane-bus delivery formatting, receipts, reminder and L0 digest decisions', () => {
  const s = new Store(mkdtempSync(join(tmpdir(), 'orch-bus-unit-')));
  const [m] = s.send({ from: 'L0', to: 'L1', kind: 'order', subject: 'Fix', body: 'Body', requiresAck: true, ackDeadlineMin: 1 });
  assert.equal(formatMessage(m), `[orch order from L0] Fix\nBody\n→ ack with order_ack/order_decline (id ${m.id})`);
  const batch = (id = 'L1', last = 0, time = Date.now() + 120000) => deliveryBatch([m], id, (msg, state) => s.has('L1', msg, state), last, time);
  assert.equal(batch().immediate.length, 1); assert.equal(batch('L0').digest.length, 1); assert.equal(batch('L0', Date.now()).digest.length, 0);
  s.record('L1', m.id, 'delivered'); assert.equal(batch().immediate.length, 0); assert.equal(batch().reminders.length, 1);
  s.record('L1', m.id, 'reminded'); assert.equal(batch().reminders.length, 0); s.record('L1', m.id, 'acked'); assert.equal(s.unacked('L1').length, 0);
  for (const kind of ['question', 'escalation', 'idle', 'report']) assert.equal(deliveryBatch([{ ...m, id: kind, kind }], 'L0', () => false, Date.now()).immediate.length, 1);
});

test('guard covers shell keywords, prefixes, substitutions, multiline and orch publication', () => {
  const commands = ['git push', 'git -C /tmp/x push origin topic', 'gh pr create', 'gh pr merge 2', 'gh pr ready', 'gh pr close', 'gh release create v1', 'gh workflow run x', 'bash -lc "git push"', 'true && gh pr create', 'env -u GH_TOKEN git push', 'timeout 30 gh pr merge 2', 'env FOO=x /usr/bin/git -C/tmp push', 'echo "$(git push)"', 'echo `git push`', "eval 'gh pr create'", 'A=1 git push', 'command git push', 'env git push', 'sudo -u root gh pr create', '(git push)', '$(gh pr merge 1)', 'git status\ngit push', '{ git push; }', 'if true; then git push; fi', 'while true; do git push; done', '! git push', 'else git push', 'until git push; do true; done', 'xargs git push', 'nice -n 5 git push', 'npx --yes gh pr merge 1', 'orch cand push --repo Test --cand x', 'orch cand land --repo Test --cand x', 'orch cand rebuild --repo Test --cand x --drop a'];
  for (const cmd of commands) assert.match(guard(cmd, 'lane', true, 'Test', [])!, /deliver to R-Test/, cmd);
  for (const cmd of ['gh run watch 1', 'gh pr checks 2 --watch', "bash -c 'gh run watch 1'"]) assert.match(guard(cmd, 'l0', true, 'Test', [])!, /orch_status/);
  assert.ok(guard('git push', 'owner', false, 'Test', []));
  for (const cmd of ['git status', 'gh pr view 2', 'echo "git push"', 'printf gh', "echo bash -c 'git push'", "echo 'bash -lc gh pr create'", "printf '%s' '`git push`'", 'git show HEAD:push', 'orch deliver --repo Test', 'gh api repos/fake/Test/pulls']) assert.equal(guard(cmd, 'lane', true, 'Test', []), undefined, cmd);
});

test('owner holds and releases cover git/gh and orch push/land without broadening blocks', () => {
  const hold: any = { createdAt: '2026-01-01', id: 'a', kind: 'hold', repo: 'Test', blocks: ['push', 'pr-create', 'pr-merge'] };
  const active = holds([hold], 'Test');
  for (const cmd of ['git push', 'gh pr create', 'gh pr merge', 'orch cand push', 'orch cand land']) assert.match(guard(cmd, 'owner', true, 'Test', active)!, /hold/);
  const released = holds([hold, { ...hold, createdAt: '2026-01-02', id: 'b', kind: 'release', blocks: ['push', 'pr-create', 'pr-merge'] }], 'Test');
  for (const cmd of ['git push', 'gh pr create', 'orch cand push', 'orch cand land']) assert.equal(guard(cmd, 'owner', true, 'Test', released), undefined);
  assert.equal(guard('orch cand notes', 'owner', true, 'Test', active), undefined);
});

test('throwaway fake-pi loader: dormant outside roots/optout; active tools and handoff deferral', async () => {
  for (const input of [{ configured: false }, { optout: '1' }]) { const h = busFixture(input); h.start(); assert.equal(h.tools.size, 0); assert.equal(h.handlers.size, 0); assert.equal(h.store.list('sessions').length, 0); }
  const h = busFixture({ id: 'R-Test' });
  try {
    atomic(h.store.path('config.json'), { roots: [h.root], excludes: [join(h.root, 'excluded')] });
    h.start('outside', true, tmpdir()); assert.equal(h.tools.size, 0); assert.equal(h.tool('git push', 'bash', 'command', h.context('out', true, tmpdir())), undefined);
    h.start('excluded', true, join(h.root, 'excluded')); assert.equal(h.tools.size, 0);
    const m = h.send(); h.setHandoff(true); h.start(); assert.equal(h.tools.size, 5); assert.equal(h.sent.length, 0); assert.equal(h.store.has('R-Test', m.id, 'delivered'), false);
    h.setHandoff(false); h.tick(); assert.equal(h.sent.length, 1); await h.call('order_ack', { id: m.id, plan: 'do it' }); assert.equal(h.store.unacked('R-Test').length, 0);
    const root = join(h.root, 'context'); atomic(join(root, 'main.json'), { phase: 'handoff-required' }); assert.ok(handoffActive('main', root)); assert.equal(handoffActive('missing', root), false);
  } finally { h.stop(); }
});

test('default extension factory imports and registers using a throwaway fake pi without a live session', () => {
  const h = busFixture(), old = { ...process.env }, handlers = new Map<string, any>(), tools: string[] = [];
  try {
    process.env.ORCH_HOME = h.store.home; delete process.env.PI_ORCH_ID; delete process.env.PI_ORCH_OPTOUT; delete process.env.PI_SESSION_WRAPPER_PID;
    laneBus({ on: (name: string, fn: any) => handlers.set(name, fn), registerTool: (t: any) => tools.push(t.name), sendUserMessage() {} } as any);
    const ctx = h.context(); handlers.get('session_start')({}, ctx); assert.equal(tools.length, 5); handlers.get('session_shutdown')({}, ctx);
  } finally { for (const name of ['ORCH_HOME', 'PI_ORCH_ID', 'PI_ORCH_OPTOUT', 'PI_SESSION_WRAPPER_PID']) { if (old[name] === undefined) delete process.env[name]; else process.env[name] = old[name]; } }
});

test('new/resume and wrapper relaunch re-pin primary without repeat delivery; workers stay passive', () => {
  const h = busFixture({ id: 'R-Test', wrapper: '99999' });
  try {
    h.send(); h.start('first'); assert.equal(h.key, 'w99999'); assert.equal(h.sent.length, 1);
    h.start('new'); assert.equal(h.sent.length, 1); assert.equal(h.tool('git push'), undefined);
    h.send('R-Test', 'order', 'after resume'); h.start('resumed'); assert.equal(h.sent.length, 2); assert.equal(h.store.list<any>('heartbeats')[0].sessionId, 'resumed');
    const activeTimers = h.timers.filter(t => !t.closed).length;
    h.start('child', false); assert.equal(h.timers.filter(t => !t.closed).length, activeTimers);
    const child = h.context('child', false);
    assert.ok(h.tool('git push', 'bash', 'command', child)?.block); assert.ok(h.tool('gh pr checks 1 --watch', 'job_watch', 'check', child)?.block); assert.ok(h.tool('orch cand push', 'job_start', 'command', child)?.block);
    assert.equal(h.emit('before_agent_start', {}, child), undefined);
    assert.ok(h.emit('before_agent_start')?.message); assert.equal(h.emit('before_agent_start'), undefined);
    assert.equal(h.store.list('sessions').length, 1); assert.equal(h.store.list('heartbeats').length, 1);
    h.stop(); assert.equal(h.timers.filter(t => !t.closed).length, 0); assert.equal(h.watches.filter(w => !w.closed).length, 0); assert.equal(h.store.list('heartbeats').length, 0);
    const restarted = busFixture({ root: h.root, id: 'R-Test', wrapper: '99999' });
    try { restarted.start('relaunch'); assert.equal(restarted.sent.length, 0); assert.equal(restarted.store.list('sessions').length, 1); assert.equal(restarted.tool('git push'), undefined); } finally { restarted.stop(); }
  } finally { h.stop(); }
});

test('real extension reminder once, ack/decline suppression, agent_end rescan and shutdown cleanup', async () => {
  const h = busFixture({ id: 'L1' });
  try {
    const a = h.send('L1', 'order', 'remind me', true, 1), b = h.send('L1', 'order', 'acked', true, 1), c = h.send('L1', 'order', 'declined', true, 1);
    h.start(); await h.call('order_ack', { id: b.id, plan: 'yes' }); await h.call('order_decline', { id: c.id, reason: 'no' });
    h.advance(61000); h.tick(); h.tick(); assert.equal(h.sent.filter(s => s.startsWith('[orch reminder]')).length, 1); assert.ok(h.store.has('L1', a.id, 'reminded'));
    h.send('L1', 'order', 'on end', false); h.emit('agent_end'); assert.match(h.sent.at(-1)!, /on end/);
    const hb = h.store.list<any>('heartbeats')[0]; assert.equal(hb.state, 'idle'); assert.ok(hb.lastTurnEndAt);
  } finally { h.stop(); }
});

test('L0 digest throttle persists across scans and session switches', () => {
  const h = busFixture({ id: 'L0' });
  try {
    h.send('L0', 'info', 'first', false); h.start(); assert.equal(h.sent.length, 1); assert.match(h.sent[0], /digest/);
    h.send('L0', 'info', 'batched', false); h.tick(); h.start('new'); assert.equal(h.sent.length, 1);
    h.send('L0', 'question', 'immediate', false); h.tick(); assert.equal(h.sent.length, 2); assert.match(h.sent[1], /immediate/);
    h.advance(600001); h.emit('agent_end'); assert.equal(h.sent.length, 3); assert.match(h.sent[2], /batched/); h.tick(); assert.equal(h.sent.length, 3);
  } finally { h.stop(); }
});

test('delivery claims precede send; simulated send crash cannot repeat a turn or stale-lock spam', () => {
  const h = busFixture({ id: 'L1', send: () => { throw new Error('simulated crash at send'); } });
  try {
    const m = h.send(); atomic(h.store.path('receipts', 'L1', `${m.id}.delivered.json.lock`), { pid: 2147483647 });
    h.start(); assert.ok(h.store.has('L1', m.id, 'delivered')); assert.equal(h.sent.length, 1); assert.match(h.errors[0], /simulated crash/);
    h.tick(); h.start('resumed'); assert.equal(h.sent.length, 1);
  } finally { h.stop(); }
});

test('discovered unassigned sessions receive only ALL/orders by key or effective ID and switch roles live', async () => {
  const h = busFixture({ wrapper: '12345' }), options = { processes: () => [], alive: () => true };
  try {
    h.start(); assert.equal(h.tools.size, 5); assert.equal(h.tool('git push'), undefined); assert.equal(h.tool('gh run watch 1'), undefined); assert.equal(h.emit('before_agent_start'), undefined);
    h.send(h.key, 'info', 'not an order', false); h.send('L99', 'order', 'not ours'); h.send(h.key, 'order', 'key order'); h.send(`S-${h.key}`, 'order', 'id order'); h.send('ALL', 'info', 'broadcast', false); h.tick(); assert.equal(h.sent.length, 3);
    const a = enrol(h.store, h.key, { id: 'L7', role: 'lane', repo: 'Test', by: 'L0', rules: 'Lane rules' }, options);
    assert.ok(h.tool('git push')?.block); h.watch(); assert.match(h.sent.at(-1)!, /Lane rules/); assert.equal(h.store.list<any>('sessions')[0].id, 'L7');
    const rule = h.store.messages(h.key).find(m => m.kind === 'rule')!; await h.call('order_ack', { id: rule.id, plan: 'follow rules' }); assert.ok(h.store.has(h.key, rule.id, 'acked')); assert.equal(a.rev, 1);
    unenrol(h.store, 'L7', options); assert.equal(h.tool('git push'), undefined); h.watch(); assert.equal(h.store.list<any>('sessions')[0].id, `S-${h.key}`);
    assert.ok(existsSync(h.store.path('heartbeats', `${h.key}.json`)));
  } finally { h.stop(); }
});

test('env identity wins over assignments and phaseWindow covers assigned/unassigned but not opted-out/outside', () => {
  const h = busFixture({ id: 'R-Test' }), unassigned = busFixture(), out = busFixture({ optout: '1' });
  try {
    atomic(h.store.path('assignments', `${h.key}.json`), { key: h.key, id: 'L9', role: 'lane', repo: 'Test', rev: 5 }); h.start(); assert.equal(h.tool('git push'), undefined);
    const window = { until: new Date(h.time + 60000).toISOString(), requirePriority: 'low' as const, exempt: [] as string[] };
    for (const bus of [h, unassigned]) {
      atomic(bus.store.path('config.json'), { roots: [bus.root], excludes: [], phaseWindow: window }); bus.start();
      assert.match(bus.tool('pi-phase run --kind build -- node test.js')!.reason, /phaseWindow/);
      assert.equal(bus.tool('pi-phase run --priority low -- node test.js'), undefined);
      assert.equal(bus.tool('pi-phase run -- node test.js', 'bash', 'command', bus.context('out', true, tmpdir())), undefined);
    }
    out.start(); assert.equal(out.tool('pi-phase run -- node test.js'), undefined);
    assert.equal(phaseGuard('echo "pi-phase run"', window, 'L1', h.time), undefined);
    assert.equal(phaseGuard('pi-phase run --priority low --priority high -- x', window, 'L1', h.time)?.includes('phaseWindow'), true);
    assert.equal(phaseGuard('pi-phase run -- x', { ...window, exempt: ['L1'] }, 'L1', h.time), undefined);
    assert.equal(phaseGuard('pi-phase run -- x', window, 'L1', h.time + 60001), undefined);
  } finally { h.stop(); unassigned.stop(); out.stop(); }
});
