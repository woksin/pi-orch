import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { existsSync, mkdirSync, unlinkSync, watch } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { canonical } from '../lib/paths.ts';
import { atomic, now, readJson, Store } from '../lib/store.ts';
import type { Message } from '../lib/store.ts';
import { deliveryBatch, formatMessage, guard, holds, phaseGuard } from '../lib/decisions.ts';
import { active, admitBootstrap, config, identity, metadata, sessionKey } from '../lib/discovery.ts';
import { sameBinding } from '../lib/identity.ts';
import type { Binding } from '../lib/identity.ts';
import type { Identity } from '../lib/discovery.ts';
import { status } from '../lib/status.ts';

const string = { type: 'string', minLength: 1 };
const result = (data: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }], details: data });
export function handoffActive(sessionId: string, root = join(homedir(), '.pi/agent/context-budget/status')) {
  try {
    const s = readJson<any>(join(root, `${sessionId}.json`));
    return !s.projected && ['handoff-required', 'handoff-pending-commit', 'compacting', 'fallback-armed'].includes(s.phase);
  } catch { return false; }
}
interface Resource { unref?: () => void; close?: () => void }
export interface BusOptions {
  env?: NodeJS.ProcessEnv; pid?: number; clock?: () => number;
  handoff?: (id: string) => boolean;
  metadata?: (store: Store, cwd: string, pid: number, wrapperPid?: number) => Record<string, any> | Promise<Record<string, any>>;
  defer?: (fn: () => Promise<void>) => void;
  processStart?: (pid: number) => Promise<string | undefined>; alive?: (pid: number) => boolean;
  interval?: (fn: () => void, ms: number) => Resource;
  clear?: (timer: Resource) => void;
  watch?: (path: string, fn: () => void) => Resource;
}
interface Entry { box: string; message: Message }
export default function laneBus(pi: ExtensionAPI) { return createLaneBus(pi); }
export function createLaneBus(pi: ExtensionAPI, options: BusOptions = {}) {
  const env = options.env || { ...process.env }, pid = options.pid || process.pid;
  const store = new Store(env.ORCH_HOME), clock = options.clock || Date.now, skey = sessionKey(env, pid);
  const initialConfig = config(store);
  if (!initialConfig.error && (env.PI_ORCH_OPTOUT === '1' || !initialConfig.roots.length) && !env.PI_ORCH_ID && !existsSync(store.path('assignments', `${skey}.json`))) return;
  const handoff = options.handoff || handoffActive;
  const interval = options.interval || ((fn, ms) => setInterval(fn, ms));
  const clear = options.clear || (timer => clearInterval(timer as ReturnType<typeof setInterval>));
  const observe = options.watch || ((path, fn) => watch(path, fn));
  let context: ExtensionContext | undefined, sessionId = '', primary = false, busy = false, toolsRegistered = false;
  let current: Identity = { id: `S-${skey}`, assigned: false, rev: 0 }, info: Record<string, any> = {}, startedAt = now();
  let epoch = 0, admittedEnv = false, admissionError = '';
  const cachedInfo = new Map<string, Record<string, any>>(), warnings = new Set<string>();
  const toolNames = ['order_ack', 'order_decline', 'order_done', 'orch_send', 'orch_status'];
  let state = 'idle', lastTurnEndAt: string | null = null, promptIdentity = '';
  let timers: Resource[] = [], inboxWatches: Resource[] = [], assignmentWatch: Resource | undefined, watchedBoxes = '';
  const isPrimary = (ctx: ExtensionContext) => primary && ctx.hasUI !== false && ctx.sessionManager.getSessionId() === sessionId && active(store, ctx.cwd, env);
  const boxes = () => [...new Set([current.id, skey])];
  function entries(): Entry[] {
    if (!info.processIdentity || current.pending) return [];
    return boxes().flatMap(box => store.messages(box).filter(m => {
      if (!current.assigned && m.kind !== 'order' && m.refs?.broadcast !== 'ALL') return false;
      if (box !== skey) return true;
      if (m.refs?.processIdentity) return sameBinding(m.refs.processIdentity as Binding, info.processIdentity);
      return Date.parse(m.createdAt) >= Date.parse(info.processIdentity.start);
    }).map(message => ({ box, message })));
  }
  function actor(): Identity {
    const value = identity(store, skey, env, info.processIdentity || null, admittedEnv);
    return value.assigned ? value : { ...value, pending: admissionError || value.pending };
  }
  function notifyConfig(ctx: ExtensionContext) {
    const error = config(store).error;
    if (error && !warnings.has(error)) { warnings.add(error); ctx.ui.notify(`orch: ${error}; discovery dormant`, 'error'); }
  }
  function presentation() {
    if (!context) return false;
    const visible = current.assigned || entries().length > 0;
    if (visible) registerTools();
    if (pi.getActiveTools && pi.setActiveTools) {
      const before = pi.getActiveTools(), after = visible ? [...new Set([...before, ...toolNames])] : before.filter(n => !toolNames.includes(n));
      if (JSON.stringify(before) !== JSON.stringify(after)) pi.setActiveTools(after);
    }
    if (!visible) context.ui.setStatus('orch', undefined);
    return visible;
  }
  function unacked() { return entries().filter(e => e.message.requiresAck && !['acked', 'declined', 'done'].some(s => store.has(e.box, e.message.id, s))).map(e => e.message); }
  function registration() {
    atomic(store.path('sessions', `${skey}.json`), { ...info, key: skey, id: current.id, kind: current.role, repo: current.repo, assigned: current.assigned, envId: env.PI_ORCH_ID, envRepo: env.PI_REPO, sessionId, pid, wrapperPid: Number(env.PI_SESSION_WRAPPER_PID) || null, startedAt, admittedEnv, admissionError: admissionError || undefined });
  }
  function refreshIdentity() {
    const next = actor();
    if (JSON.stringify(next) !== JSON.stringify(current)) { current = next; if (primary) registration(); }
    if (!primary) return;
    const watched = boxes().join(',');
    if (watched === watchedBoxes) return;
    inboxWatches.forEach(w => w.close?.()); inboxWatches = []; watchedBoxes = watched;
    for (const box of boxes()) {
      const path = store.path('inbox', box); mkdirSync(path, { recursive: true });
      try { const w = observe(path, safelyScan); w.unref?.(); inboxWatches.push(w); } catch { /* Poll remains active. */ }
    }
  }
  function heartbeat() {
    if (!primary || !context || !active(store, context.cwd, env)) return;
    refreshIdentity();
    atomic(store.path('heartbeats', `${skey}.json`), { key: skey, id: current.id, at: new Date(clock()).toISOString(), pid, wrapperPid: Number(env.PI_SESSION_WRAPPER_PID) || null, sessionId, state: handoff(sessionId) ? 'handoff' : state, lastTurnEndAt, unacked: unacked().map(m => m.id), note: '' });
    if (!presentation()) return;
    const data: any = status(store, current.id, current.repo), cand = data.candidates?.at(-1);
    context.ui.setStatus('orch', `orch ${current.id} · ${unacked().length} unacked${data.holds?.length ? ' · hold' : ''} · cand ${cand?.name || '-'} ${data.gh?.prs?.find((p: any) => p.number === cand?.pr)?.ci || 'unknown'}`);
  }
  function sendOnce(entry: Entry, receipt: string, body: string) {
    // Claim before sending: a crash/throw cannot repeat a turn every scan. See README for the loss window.
    if (store.record(entry.box, entry.message.id, receipt)) pi.sendUserMessage(body, { deliverAs: 'followUp' });
  }
  function scan() {
    if (!primary || busy || !context || !active(store, context.cwd, env)) return;
    refreshIdentity();
    if (handoff(sessionId)) return;
    busy = true;
    try {
      const all = entries(), byId = new Map(all.map(e => [e.message.id, e]));
      const digestFile = store.path('bus', `${skey}.digest.json`), lastDigest = readJson<any>(digestFile, { at: 0 }).at;
      const batch = deliveryBatch(all.map(e => e.message), current.role === 'l0' ? 'L0' : current.id, (msg, state) => { const e = byId.get(msg)!; return store.has(e.box, msg, state); }, lastDigest, clock());
      for (const m of batch.immediate) sendOnce(byId.get(m.id)!, 'delivered', formatMessage(m));
      if (batch.digest.length) {
        const claimed = batch.digest.filter(m => store.record(byId.get(m.id)!.box, m.id, 'delivered'));
        atomic(digestFile, { at: clock() });
        if (claimed.length) pi.sendUserMessage(`[orch digest]\n${claimed.map(formatMessage).join('\n\n')}`, { deliverAs: 'followUp' });
      }
      for (const m of batch.reminders) sendOnce(byId.get(m.id)!, 'reminded', `[orch reminder]\n${formatMessage(m)}`);
      heartbeat();
    } finally { busy = false; }
  }
  function safelyScan() { try { scan(); } catch (e) { context?.ui.notify(`orch: ${e}`, 'error'); } }
  function stop() {
    epoch++;
    context?.ui.setStatus('orch', undefined);
    if (pi.getActiveTools && pi.setActiveTools) pi.setActiveTools(pi.getActiveTools().filter(n => !toolNames.includes(n)));
    timers.forEach(clear); timers = [];
    inboxWatches.forEach(w => w.close?.()); inboxWatches = []; watchedBoxes = '';
    assignmentWatch?.close?.(); assignmentWatch = undefined;
  }
  function removeHeartbeat() {
    const path = store.path('heartbeats', `${skey}.json`);
    const hb = readJson<any>(path, {});
    if (hb.pid === pid && hb.sessionId === sessionId && existsSync(path)) unlinkSync(path);
  }
  pi.on('session_start', (_event, ctx) => {
    if (ctx.hasUI === false) return; // In-process workers must not stop/re-pin their parent's UI session.
    stop(); if (primary) removeHeartbeat(); primary = false;
    context = ctx; sessionId = ctx.sessionManager.getSessionId(); notifyConfig(ctx);
    if (!active(store, ctx.cwd, env)) return;
    primary = true; state = 'idle'; lastTurnEndAt = null; promptIdentity = ''; startedAt = now();
    info = cachedInfo.get(ctx.cwd) || { cwd: canonical(ctx.cwd) };
    current = actor(); registration(); refreshIdentity();
    const dir = store.path('assignments'); mkdirSync(dir, { recursive: true });
    try { assignmentWatch = observe(dir, safelyScan); assignmentWatch.unref?.(); } catch { /* Poll fallback. */ }
    timers = [interval(() => { try { heartbeat(); } catch (e) { ctx.ui.notify(`orch: ${e}`, 'error'); } }, 30000), interval(safelyScan, 20000)];
    timers.forEach(t => t.unref?.()); heartbeat(); safelyScan();
    const generation = epoch;
    const fill = async () => {
      if (generation !== epoch || !primary || !active(store, ctx.cwd, env)) return;
      try {
        const details = await (options.metadata || metadata)(store, ctx.cwd, pid, Number(env.PI_SESSION_WRAPPER_PID) || undefined);
        if (generation !== epoch || !primary || !active(store, ctx.cwd, env)) return;
        if (!details.processIdentity?.start || !details.hostStart) throw new Error('process identity unavailable; retry session start');
        info = details; cachedInfo.set(ctx.cwd, details); refreshIdentity(); registration();
        const requested = identity(store, skey, env, info.processIdentity, true);
        if (!current.assigned && requested.assigned && requested.bootstrap) {
          await admitBootstrap(store, skey, requested.id, () => {
            if (generation !== epoch || !primary || !active(store, ctx.cwd, env)) return;
            admittedEnv = true; admissionError = ''; refreshIdentity(); registration();
          }, options.processStart, options.alive);
        }
        if (generation === epoch && primary && active(store, ctx.cwd, env)) { refreshIdentity(); heartbeat(); safelyScan(); }
      } catch (error: any) {
        if (generation !== epoch || !primary || !active(store, ctx.cwd, env)) return;
        admissionError = error.message; admittedEnv = false; refreshIdentity(); registration();
        ctx.ui.notify(`orch: ${error.message}`, 'error');
      }
    };
    if (options.defer) options.defer(fill); else setImmediate(() => { void fill(); });
  });
  pi.on('session_shutdown', (_event, ctx) => { if (ctx?.hasUI === false) return; stop(); if (primary) removeHeartbeat(); primary = false; });
  pi.on('agent_start', (_event, ctx) => { if (isPrimary(ctx)) { state = 'working'; heartbeat(); } });
  pi.on('agent_end', (_event, ctx) => { if (isPrimary(ctx)) { state = 'idle'; lastTurnEndAt = new Date(clock()).toISOString(); heartbeat(); safelyScan(); } });
  pi.on('before_agent_start', (_event, ctx) => {
    if (!isPrimary(ctx)) return;
    refreshIdentity();
    const signature = JSON.stringify(current);
    if (!current.assigned || promptIdentity === signature) return;
    promptIdentity = signature;
    return { message: { customType: 'orch-role', content: `Orch role ${current.role} (${current.id}). Orders arrive as messages; use order_ack/orch_status. Owners reconcile at session start.`, display: false } };
  });
  pi.on('tool_call', (event, ctx) => {
    notifyConfig(ctx);
    if (!['bash', 'job_start', 'job_watch'].includes(event.toolName)) return;
    const scoped = active(store, ctx.cwd, env);
    const guarded = scoped ? actor() : identity(store, skey, env, info.processIdentity || null);
    if (!scoped && !guarded.assigned && !guarded.pending) return;
    const input = event.input as Record<string, unknown>;
    for (const command of [input.command, input.check]) if (typeof command === 'string') {
      const phaseReason = scoped ? phaseGuard(command, config(store).phaseWindow, guarded.id, clock()) : undefined;
      if (phaseReason) return { block: true, reason: phaseReason };
      if (!guarded.assigned && !guarded.pending && !env.PI_ORCH_ID) continue;
      // Pending bootstrap identities receive restrictions, never owner privileges.
      const kind = guarded.pending || !guarded.assigned ? 'lane' : guarded.role!;
      const own = [...new Set([guarded.id, skey, `R-${guarded.repo}`])].flatMap(box => store.messages(box));
      const reason = guard(command, kind, ctx.hasUI !== false, guarded.repo, holds(own, guarded.repo));
      if (reason) return { block: true, reason };
    }
  });
  function register(name: string, properties: Record<string, unknown>, required: string[], execute: (p: any, ctx: ExtensionContext) => unknown) {
    pi.registerTool({ name, defaultActive: false, label: name, description: name.replaceAll('_', ' '), parameters: { type: 'object', properties, required, additionalProperties: false } as any,
      async execute(_callId, p, _signal, _update, ctx) { if (!isPrimary(ctx)) throw new Error('orders belong to the primary session'); refreshIdentity(); return result(execute(p, ctx)); } });
  }
  function registerTools() {
    if (toolsRegistered) return; toolsRegistered = true;
    for (const [name, receipt, field] of [['order_ack', 'acked', 'plan'], ['order_decline', 'declined', 'reason'], ['order_done', 'done', 'evidence']]) {
      register(name, { id: string, [field]: string }, ['id', field], p => {
        const entry = entries().find(e => e.message.id === p.id);
        if (!entry) throw new Error(`message not in own inbox: ${p.id}`);
        store.record(entry.box, p.id, receipt, field === 'evidence' ? { evidence: p[field] } : { text: p[field] }); heartbeat(); return { id: p.id, state: receipt };
      });
    }
    register('orch_send', { to: string, kind: string, subject: string, body: string, requiresAck: { type: 'boolean' }, deadlineMin: { type: 'number', exclusiveMinimum: 0 } }, ['to', 'kind', 'subject', 'body'], p => store.send({ from: current.id, to: p.to, kind: p.kind, subject: p.subject, body: p.body, requiresAck: p.requiresAck ?? false, ackDeadlineMin: p.deadlineMin ?? 30 }));
    register('orch_status', { repo: string }, [], p => ({ ...status(store, current.id, p.repo || current.repo), unacked: unacked() }));
  }
}
