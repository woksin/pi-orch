import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { atomic, Store } from '../src/lib/store.ts';
import { createLaneBus } from '../src/extension/lane-bus.ts';
import { sessionKey } from '../src/lib/discovery.ts';

export function busFixture(input: { root?: string; id?: string; wrapper?: string; optout?: string; configured?: boolean; rawConfig?: string; processVersion?: string; metadata?: (...args: any[]) => any; send?: (text: string) => void } = {}) {
  const root = input.root || mkdtempSync(join(process.env.AI_WORK_OUTPUT || tmpdir(), 'orch-bus-')), store = new Store(join(root, 'home'));
  if (input.configured !== false) atomic(store.path('config.json'), { roots: [root], excludes: [] });
  if (input.rawConfig !== undefined) writeFileSync(store.path('config.json'), input.rawConfig);
  atomic(store.path('repos.json'), { Test: { slug: 'fake/Test', mainCheckout: root, integrationWorktree: join(root, 'integration'), gateCmd: 'test', batch: { min: 2, max: 8, ageHours: 24 }, expressPerDay: 1, enrolled: true } });
  const env = { ORCH_HOME: store.home, PI_ORCH_ID: input.id, PI_REPO: input.id ? 'Test' : undefined, PI_SESSION_WRAPPER_PID: input.wrapper, PI_ORCH_OPTOUT: input.optout };
  const key = sessionKey(env), handlers = new Map<string, any>(), tools = new Map<string, any>(), sent: string[] = [], errors: string[] = [];
  const timers: { fn: () => void; ms: number; closed: boolean; unref: () => void }[] = [];
  const watches: { path: string; fn: () => void; closed: boolean; close: () => void; unref: () => void }[] = [];
  let time = Date.now(), handoff = false;
  const version = input.processVersion || '2020-01-01T00:00:00.000Z', deferred: (() => Promise<void>)[] = [], statuses: (string | undefined)[] = [];
  let activeTools = ['bash'];
  const discoveryOptions = { processes: () => [], alive: () => true, start: () => version, ancestors: () => [], pid: 900001, env: {} };
  const pi: any = { on: (name: string, fn: any) => handlers.set(name, fn), registerTool: (t: any) => tools.set(t.name, t), getActiveTools: () => activeTools, setActiveTools: (names: string[]) => { activeTools = names; }, sendUserMessage: (body: string, options: any) => { if (options.deliverAs !== 'followUp') throw new Error('not followUp'); sent.push(body); input.send?.(body); } };
  createLaneBus(pi, { env, clock: () => time, handoff: () => handoff, defer: fn => deferred.push(fn), processStart: async () => version, alive: () => true, metadata: input.metadata || ((_store, cwd, pid, wrapperPid) => ({ cwd, tty: 'ttys777', branch: 'd/test', gitToplevel: root, originSlug: 'fake/Test', detectedRepo: 'Test', hostStart: version, processIdentity: { pid: wrapperPid || pid, start: version } })), interval: (fn, ms) => { const timer = { fn, ms, closed: false, unref() {} }; timers.push(timer); return timer; }, clear: (timer: any) => { timer.closed = true; }, watch: (path, fn) => { const w = { path, fn, closed: false, close() { w.closed = true; }, unref() {} }; watches.push(w); return w; } });
  const context = (id = 'main', hasUI = true, cwd = root): any => ({ hasUI, cwd, sessionManager: { getSessionId: () => id }, ui: { setStatus(_key: string, text: string | undefined) { statuses.push(text); }, notify(text: string) { errors.push(text); } } });
  let ctx = context();
  const emit = (name: string, event: any = {}, other = ctx) => handlers.get(name)?.(event, other);
  const send = (to = input.id || `S-${key}`, kind = 'order', subject = 'work', requiresAck = true, deadline = 30) => store.send({ from: 'L0', to, kind, subject, body: 'test body', requiresAck, ackDeadlineMin: deadline })[0];
  const startRaw = (id = 'main', hasUI = true, cwd = root) => { const next = context(id, hasUI, cwd); if (hasUI) ctx = next; return emit('session_start', {}, next); };
  const flush = async () => { while (deferred.length) await deferred.shift()!(); };
  return { root, store, key, env, discoveryOptions, handlers, tools, timers, watches, sent, errors, statuses, context, emit, send, startRaw, flush,
    get activeTools() { return activeTools; },
    async start(id = 'main', hasUI = true, cwd = root) { startRaw(id, hasUI, cwd); await flush(); },
    stop() { emit('session_shutdown'); },
    tick(ms = 20000) { for (const t of [...timers]) if (!t.closed && t.ms === ms) t.fn(); },
    watch(path = store.path('assignments')) { for (const w of [...watches]) if (!w.closed && w.path === path) w.fn(); },
    advance(ms: number) { time += ms; },
    setHandoff(value: boolean) { handoff = value; },
    get time() { return time; },
    tool(command: string, toolName = 'bash', field = 'command', other = ctx) { return emit('tool_call', { toolName, input: { [field]: command } }, other); },
    call(name: string, args: any) { return tools.get(name).execute('call', args, undefined, undefined, ctx); },
  };
}
