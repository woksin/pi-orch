import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import laneBus, { handoffActive } from '../src/extension/lane-bus.ts';
import { atomic, Store } from '../src/lib/store.ts';
import { deliveryBatch, formatMessage, guard, holds } from '../src/lib/decisions.ts';

test('lane-bus delivery formatting, receipts, reminder and L0 digest decisions', () => {
  const s = new Store(mkdtempSync(join(tmpdir(), 'orch-bus-')));
  const [m] = s.send({ from: 'L0', to: 'L1', kind: 'order', subject: 'Fix', body: 'Body', requiresAck: true, ackDeadlineMin: 1 });
  assert.equal(formatMessage(m), `[orch order from L0] Fix\nBody\n→ ack with order_ack/order_decline (id ${m.id})`);
  const batch = (id = 'L1', last = 0, time = Date.now() + 120000) => deliveryBatch([m], id, (msg, state) => s.has('L1', msg, state), last, time);
  assert.equal(batch().immediate.length, 1); assert.equal(batch('L0').digest.length, 1);
  assert.equal(batch('L0', Date.now()).digest.length, 0);
  s.record('L1', m.id, 'delivered'); assert.equal(batch().immediate.length, 0); assert.equal(batch().reminders.length, 1);
  s.record('L1', m.id, 'reminded'); assert.equal(batch().reminders.length, 0);
  s.record('L1', m.id, 'acked'); assert.equal(s.unacked('L1').length, 0);
  for (const kind of ['question', 'escalation', 'idle', 'report']) {
    assert.equal(deliveryBatch([{ ...m, id: kind, kind }], 'L0', () => false, Date.now()).immediate.length, 1);
  }
});

test('guard decisions: workers, owners, holds/releases, watches, unrelated commands', () => {
  for (const cmd of ['git push', 'git -C /tmp/x push origin topic', 'gh pr create', 'gh pr merge 2', 'gh pr ready', 'gh pr close', 'gh release create v1', 'gh workflow run x', 'bash -lc "git push"', 'true && gh pr create']) assert.match(guard(cmd, 'lane', true, 'Test', [])!, /deliver to R-Test/);
  for (const cmd of ['gh run watch 1', 'gh pr checks 2 --watch', "bash -c 'gh run watch 1'"]) assert.match(guard(cmd, 'l0', true, 'Test', [])!, /orch_status/);
  assert.ok(guard('git push', 'owner', false, 'Test', []));
  assert.ok(guard('git push', 'owner', true, 'Test', ['push']));
  for (const cmd of ['git status', 'gh pr view 2', 'echo "git push"', 'printf gh', 'git show HEAD:push', 'orch deliver --repo Test']) assert.equal(guard(cmd, 'lane', true, 'Test', []), undefined);
  const m: any = { createdAt: '2026-01-01', id: 'a', kind: 'hold', repo: 'Test', blocks: ['push', 'pr-create'] };
  assert.deepEqual(holds([m, { ...m, id: 'b', kind: 'release', blocks: ['push'] }], 'Test'), ['pr-create']);
});

test('throwaway fake-pi loader: dormant, active registrations, delivery, passive child, handoff', async () => {
  const old = { id: process.env.PI_ORCH_ID, home: process.env.ORCH_HOME, repo: process.env.PI_REPO };
  const symbol = Symbol.for('pi-orch.primary-session'); const primary = (globalThis as any)[symbol]; delete (globalThis as any)[symbol];
  const handlers = new Map<string, any>(), tools = new Map<string, any>(), sent: string[] = [];
  const pi: any = { on: (n: string, f: any) => handlers.set(n, f), registerTool: (t: any) => tools.set(t.name, t), sendUserMessage: (text: string, options: any) => { assert.deepEqual(options, { deliverAs: 'followUp' }); sent.push(text); } };
  try {
    delete process.env.PI_ORCH_ID; laneBus(pi); assert.equal(handlers.size, 0); assert.equal(tools.size, 0);
    process.env.PI_ORCH_ID = 'R-Test'; process.env.PI_REPO = 'Test'; process.env.ORCH_HOME = mkdtempSync(join(tmpdir(), 'orch-loader-'));
    const s = new Store(); const [m] = s.send({ from: 'L0', to: 'R-Test', kind: 'order', subject: 'test', body: 'ok', requiresAck: true, ackDeadlineMin: 30 });
    laneBus(pi); assert.equal(tools.size, 5);
    const ctx: any = { hasUI: true, cwd: s.home, sessionManager: { getSessionId: () => 'main' }, ui: { setStatus() {}, notify() {} } };
    handlers.get('session_start')({}, ctx); assert.equal(sent.length, 1); assert.ok(s.has('R-Test', m.id, 'delivered'));
    await tools.get('order_ack').execute('', { id: m.id, plan: 'do it' }, null, null, ctx); assert.equal(s.unacked('R-Test').length, 0);
    handlers.get('session_shutdown')();
    const child: any = { ...ctx, hasUI: false, sessionManager: { getSessionId: () => 'child' } };
    handlers.get('session_start')({}, child); assert.equal(sent.length, 1);
    assert.ok(handlers.get('tool_call')({ toolName: 'bash', input: { command: 'git push' } }, child).block);
    assert.equal(handlers.get('tool_call')({ toolName: 'order_ack', input: {} }, child), undefined);
    const root = mkdtempSync(join(tmpdir(), 'orch-context-')); atomic(join(root, 'main.json'), { phase: 'handoff-required' }); assert.ok(handoffActive('main', root)); assert.equal(handoffActive('absent', root), false);
  } finally {
    handlers.get('session_shutdown')?.(); (globalThis as any)[symbol] = primary;
    for (const [key, value] of [['PI_ORCH_ID', old.id], ['ORCH_HOME', old.home], ['PI_REPO', old.repo]]) { if (value === undefined) delete process.env[key!]; else process.env[key!] = value; }
  }
});
