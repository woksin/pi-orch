import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { mkdirSync, watch } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { atomic, now, readJson, role, Store } from '../lib/store.ts';
import { deliveryBatch, formatMessage, guard, holds } from '../lib/decisions.ts';
import { status } from '../lib/status.ts';

const primaryKey = Symbol.for('pi-orch.primary-session');
const string = { type: 'string', minLength: 1 };
const result = (data: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }], details: data });
export function handoffActive(sessionId: string, root = join(homedir(), '.pi/agent/context-budget/status')) {
  try {
    const s = readJson<any>(join(root, `${sessionId}.json`));
    return !s.projected && ['handoff-required', 'handoff-pending-commit', 'compacting', 'fallback-armed'].includes(s.phase);
  } catch { return false; } // Missing/unreadable detector must not suppress durable orders.
}
export default function laneBus(pi: ExtensionAPI) {
  const id = process.env.PI_ORCH_ID;
  if (!id) return;
  const store = new Store(), kind = role(id), repo = process.env.PI_REPO;
  let context: ExtensionContext | undefined, sessionId = '', primary = false, busy = false;
  let state = 'idle', lastTurnEndAt: string | null = null;
  let heartbeatTimer: ReturnType<typeof setInterval> | undefined, pollTimer: ReturnType<typeof setInterval> | undefined;
  let watcher: ReturnType<typeof watch> | undefined;
  const digestFile = store.path('bus', `${id}.digest.json`);
  const isPrimary = (ctx: ExtensionContext) => ctx.hasUI !== false && (globalThis as any)[primaryKey] === ctx.sessionManager.getSessionId();
  function heartbeat() {
    if (!primary || !context) return;
    const handoff = handoffActive(sessionId);
    atomic(store.path('heartbeats', `${id}.json`), { id, at: now(), pid: process.pid, wrapperPid: Number(process.env.PI_SESSION_WRAPPER_PID) || null, sessionId, state: handoff ? 'handoff' : state, lastTurnEndAt, unacked: store.unacked(id).map(m => m.id), note: '' });
    const data: any = status(store, id, repo), cand = data.candidates?.at(-1);
    context.ui.setStatus('orch', `orch ${id} · ${data.unacked.length} unacked${data.holds?.length ? ' · hold' : ''} · cand ${cand?.name || '-'} ${data.gh?.prs?.find((p: any) => p.number === cand?.pr)?.ci || 'unknown'}`);
  }
  function scan() {
    if (!primary || busy || handoffActive(sessionId)) return;
    busy = true;
    try {
      const lastDigest = readJson<any>(digestFile, { at: 0 }).at;
      const batch = deliveryBatch(store.messages(id), id, (msg, state) => store.has(id, msg, state), lastDigest);
      for (const m of batch.immediate) { pi.sendUserMessage(formatMessage(m), { deliverAs: 'followUp' }); store.record(id, m.id, 'delivered'); }
      if (batch.digest.length) {
        pi.sendUserMessage(`[orch digest]\n${batch.digest.map(formatMessage).join('\n\n')}`, { deliverAs: 'followUp' });
        batch.digest.forEach(m => store.record(id, m.id, 'delivered'));
        atomic(digestFile, { at: Date.now() });
      }
      for (const m of batch.reminders) { pi.sendUserMessage(`[orch reminder]\n${formatMessage(m)}`, { deliverAs: 'followUp' }); store.record(id, m.id, 'reminded'); }
      heartbeat();
    } finally { busy = false; }
  }
  function safelyScan() { try { scan(); } catch (e) { context?.ui.notify(`orch: ${e}`, 'error'); } }
  function stop() { clearInterval(heartbeatTimer); clearInterval(pollTimer); watcher?.close(); }
  pi.on('session_start', (_event, ctx) => {
    stop(); context = ctx; sessionId = ctx.sessionManager.getSessionId();
    if (ctx.hasUI !== false && !(globalThis as any)[primaryKey]) (globalThis as any)[primaryKey] = sessionId;
    primary = isPrimary(ctx);
    if (!primary) return;
    atomic(store.path('sessions', `${id}.json`), { id, kind, repo, sessionId, pid: process.pid, wrapperPid: Number(process.env.PI_SESSION_WRAPPER_PID) || null, cwd: ctx.cwd, startedAt: now() });
    mkdirSync(store.path('inbox', id), { recursive: true });
    heartbeatTimer = setInterval(() => { try { heartbeat(); } catch (e) { ctx.ui.notify(`orch: ${e}`, 'error'); } }, 30000); heartbeatTimer.unref();
    pollTimer = setInterval(safelyScan, 20000); pollTimer.unref();
    try { watcher = watch(store.path('inbox', id), safelyScan); watcher.unref(); } catch { /* Poll fallback remains active. */ }
    scan();
  });
  pi.on('session_shutdown', () => { stop(); });
  pi.on('agent_start', (_event, ctx) => { if (isPrimary(ctx)) { state = 'working'; heartbeat(); } });
  pi.on('agent_end', (_event, ctx) => { if (isPrimary(ctx)) { state = 'idle'; lastTurnEndAt = now(); heartbeat(); safelyScan(); } });
  pi.on('before_agent_start', () => ({ message: { customType: 'orch-role', content: `Orch role ${kind} (${id}). Orders arrive as messages; use order_ack/orch_status.`, display: false } }));
  pi.on('tool_call', (event, ctx) => {
    if (!['bash', 'job_start', 'job_watch'].includes(event.toolName)) return;
    const input = event.input as Record<string, unknown>;
    for (const command of [input.command, input.check]) if (typeof command === 'string') {
      const reason = guard(command, kind, isPrimary(ctx), repo, holds(store.messages(`R-${repo}`), repo));
      if (reason) return { block: true, reason };
    }
  });
  function register(name: string, properties: Record<string, unknown>, required: string[], execute: (p: any, ctx: ExtensionContext) => unknown) {
    pi.registerTool({ name, label: name, description: name.replaceAll('_', ' '), parameters: { type: 'object', properties, required, additionalProperties: false } as any,
      async execute(_callId, p, _signal, _update, ctx) { return result(execute(p, ctx)); } });
  }
  for (const [name, receipt, field] of [['order_ack', 'acked', 'plan'], ['order_decline', 'declined', 'reason'], ['order_done', 'done', 'evidence']]) {
    register(name, { id: string, [field]: string }, ['id', field], (p, ctx) => {
      if (!isPrimary(ctx)) throw new Error('orders belong to the primary session');
      if (!store.messages(id).some(m => m.id === p.id)) throw new Error(`message not in own inbox: ${p.id}`);
      store.record(id, p.id, receipt, field === 'evidence' ? { evidence: p[field] } : { text: p[field] }); heartbeat(); return { id: p.id, state: receipt };
    });
  }
  register('orch_send', { to: string, kind: string, subject: string, body: string, requiresAck: { type: 'boolean' }, deadlineMin: { type: 'number', exclusiveMinimum: 0 } }, ['to', 'kind', 'subject', 'body'], (p, ctx) => {
    if (!isPrimary(ctx)) throw new Error('orders belong to the primary session');
    return store.send({ from: id, to: p.to, kind: p.kind, subject: p.subject, body: p.body, requiresAck: p.requiresAck ?? false, ackDeadlineMin: p.deadlineMin ?? 30 });
  });
  register('orch_status', { repo: string }, [], p => status(store, id, p.repo || repo));
}
