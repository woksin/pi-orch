import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { atomic, Store } from '../src/lib/store.ts';
import { createLaneBus } from '../src/extension/lane-bus.ts';
import { sessionKey } from '../src/lib/discovery.ts';

export function busFixture(input: { root?: string; id?: string; wrapper?: string; optout?: string; interactive?: string; statusDir?: string; inboxDir?: string; configured?: boolean; rawConfig?: string; processVersion?: string; metadata?: (...args: any[]) => any; send?: (text: string) => unknown; notify?: (text: string) => void; setup?: (store: Store, key: string) => void } = {}) {
  const root = input.root || mkdtempSync(join(process.env.AI_WORK_OUTPUT || tmpdir(), 'orch-bus-')), store = new Store(join(root, 'home'));
  if (input.configured !== false) atomic(store.path('config.json'), { roots: [root], excludes: [] });
  if (input.rawConfig !== undefined) writeFileSync(store.path('config.json'), input.rawConfig);
  atomic(store.path('repos.json'), { Test: { slug: 'fake/Test', mainCheckout: root, integrationWorktree: join(root, 'integration'), gateCmd: 'test', batch: { min: 2, max: 8, ageHours: 24 }, expressPerDay: 1, enrolled: true } });
  const env = { ORCH_HOME: store.home, PI_ORCH_ID: input.id, PI_REPO: input.id ? 'Test' : undefined, PI_SESSION_WRAPPER_PID: input.wrapper, PI_ORCH_OPTOUT: input.optout, PI_ORCH_INTERACTIVE: input.interactive, LANE_STATUS_DIR: input.statusDir || (input.inboxDir ? undefined : join(root, 'status')), INBOX_DIR: input.inboxDir };
  const key = sessionKey(env), handlers = new Map<string, any>(), tools = new Map<string, any>(), sent: string[] = [], errors: string[] = [], deliveries: { body: string; deliverAs: string }[] = [];
  const timers: { fn: () => void; ms: number; closed: boolean; unref: () => void }[] = [];
  const watches: { path: string; fn: () => void; closed: boolean; close: () => void; unref: () => void }[] = [];
  let time = Date.now(), handoff = false;
  const version = input.processVersion || '2020-01-01T00:00:00.000Z', deferred: (() => Promise<void>)[] = [], statuses: (string | undefined)[] = [], notices: string[] = [];
  let activeTools = ['bash'];
  const toolUpdates: string[][] = [];
  input.setup?.(store, key);
  const discoveryOptions = { processes: () => [], alive: () => true, start: () => version, ancestors: () => [], pid: 900001, env: {} };
  const pi: any = { on: (name: string, fn: any) => handlers.set(name, fn), registerTool: (t: any) => tools.set(t.name, t), getActiveTools: () => activeTools, setActiveTools: (names: string[]) => { toolUpdates.push(names); activeTools = names; }, sendUserMessage: (body: string, options: any) => { assertDelivery(options.deliverAs); sent.push(body); deliveries.push({ body, deliverAs: options.deliverAs }); return input.send?.(body); } };
  createLaneBus(pi, { env, clock: () => time, handoff: () => handoff, defer: fn => deferred.push(fn), processStart: async () => version, alive: () => true, metadata: input.metadata || ((_store, cwd, pid, wrapperPid) => ({ cwd, tty: 'ttys777', branch: 'd/test', gitToplevel: root, originSlug: 'fake/Test', detectedRepo: 'Test', hostStart: version, processIdentity: { pid: wrapperPid || pid, start: version } })), interval: (fn, ms) => { const timer = { fn, ms, closed: false, unref() {} }; timers.push(timer); return timer; }, clear: (timer: any) => { timer.closed = true; }, watch: (path, fn) => { const w = { path, fn, closed: false, close() { w.closed = true; }, unref() {} }; watches.push(w); return w; } });
  const context = (id = 'main', hasUI = true, cwd = root): any => ({ hasUI, cwd, sessionManager: { getSessionId: () => id }, ui: { setStatus(_key: string, text: string | undefined) { statuses.push(text); }, notify(text: string, level: string) { (level === 'error' ? errors : notices).push(text); input.notify?.(text); } } });
  let ctx = context();
  const emit = (name: string, event: any = {}, other = ctx) => handlers.get(name)?.(event, other);
  const send = (to = input.id || `S-${key}`, kind = 'order', subject = 'work', requiresAck = true, deadline = 30) => store.send({ from: 'L0', to, kind, subject, body: 'test body', requiresAck, ackDeadlineMin: deadline })[0];
  const startRaw = (id = 'main', hasUI = true, cwd = root) => { const next = context(id, hasUI, cwd); if (hasUI) ctx = next; return emit('session_start', {}, next); };
  const flush = async () => { while (deferred.length) await deferred.shift()!(); };
  return { root, store, key, env, discoveryOptions, handlers, tools, timers, watches, sent, deliveries, errors, notices, statuses, toolUpdates, context, emit, send, startRaw, flush,
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

// Actual SDK bindings and model loop; all resources and provider responses are local.
function assertDelivery(mode: string) { if (!['steer', 'followUp'].includes(mode)) throw new Error(`invalid delivery: ${mode}`); }

export async function nativeBusFixture(input: { id?: string; interactive?: string; root?: string; holdFirst?: boolean; withoutBus?: boolean; assigned?: boolean; excludes?: string[]; bashOperations?: any; extensions?: ((pi: any) => any)[]; toolCall?: { name: string; arguments: Record<string, unknown> } } = {}) {
  const { createAgentSession, createBashTool, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } = await import('@earendil-works/pi-coding-agent');
  const { createAssistantMessageEventStream } = await import('@earendil-works/pi-ai');
  const output = process.env.AI_WORK_OUTPUT || resolve('.ai-work'); mkdirSync(output, { recursive: true });
  const root = input.root || mkdtempSync(join(output, 'orch-native-')), agentDir = join(root, 'agent'), store = new Store(join(root, 'orch'));
  mkdirSync(agentDir, { recursive: true });
  atomic(store.path('config.json'), { roots: [root], excludes: input.excludes || [] });
  atomic(store.path('repos.json'), { Test: { slug: 'fake/Test', mainCheckout: root, enrolled: true } });
  if (input.assigned) {
    const key = sessionKey({});
    atomic(store.path('assignments', `${key}.json`), { key, id: 'L9', role: 'lane', repo: 'Test', binding: { pid: process.pid, start: '2020-01-01T00:00:00.000Z' } });
  }
  const requests: string[] = [], notices: string[] = [], errors: string[] = [], intervals: (() => void)[] = [], cleared: unknown[] = [], deferred: (() => Promise<void>)[] = [], watches: { closed: boolean }[] = [];
  let entered!: () => void, release!: () => void;
  const boundary = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
  const modelRuntime = await ModelRuntime.create({ authPath: join(agentDir, 'auth.json'), modelsPath: null, refreshOnCreate: false });
  modelRuntime.registerProvider('orch-fixture', {
    api: 'openai-completions', baseUrl: 'http://fixture.invalid', apiKey: 'fixture',
    models: [{ id: 'fixture', name: 'fixture', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 32 }],
    streamSimple(model, context) {
      requests.push(JSON.stringify(context.messages));
      const stream = createAssistantMessageEventStream();
      const tool = (input.holdFirst || input.toolCall) && requests.length === 1;
      const message: any = { role: 'assistant', content: tool ? [{ type: 'toolCall', id: 'boundary-1', name: input.toolCall?.name || 'boundary_tool', arguments: input.toolCall?.arguments || {} }] : [{ type: 'text', text: 'fixture response' }], api: model.api, provider: model.provider, model: model.id, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: tool ? 'toolUse' : 'stop', timestamp: Date.now() };
      queueMicrotask(() => { stream.push({ type: 'done', reason: message.stopReason, message }); stream.end(); });
      return stream;
    }
  });
  const loader = new DefaultResourceLoader({ cwd: root, agentDir, settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    extensionFactories: [...(input.extensions || []), pi => {
      if (input.bashOperations) pi.registerTool(createBashTool(root, { operations: input.bashOperations }) as any);
      if (input.holdFirst) pi.registerTool({ name: 'boundary_tool', label: 'Boundary', description: 'Deterministic held tool boundary', parameters: { type: 'object', properties: {} } as any,
        async execute(_id, _params, signal) {
          entered(); signal?.addEventListener('abort', release, { once: true });
          try { await gate; return { content: [{ type: 'text', text: 'boundary passed' }], details: {} }; }
          finally { signal?.removeEventListener('abort', release); }
        } });
      if (input.withoutBus) return;
      return createLaneBus(pi, { env: { ORCH_HOME: store.home, PI_ORCH_ID: input.assigned ? undefined : input.id || 'L1', PI_REPO: 'Test', PI_ORCH_INTERACTIVE: input.interactive, LANE_STATUS_DIR: join(root, 'status') }, defer: fn => deferred.push(fn), handoff: () => false,
      processStart: async () => '2020-01-01T00:00:00.000Z', alive: () => true,
      metadata: (_store, cwd, pid) => ({ cwd, hostStart: '2020-01-01T00:00:00.000Z', processIdentity: { pid, start: '2020-01-01T00:00:00.000Z' } }),
      interval: fn => { intervals.push(fn); return { unref() {} }; }, clear: handle => { cleared.push(handle); }, watch: () => { const w = { closed: false, unref() {}, close() { w.closed = true; } }; watches.push(w); return w; } }); }] });
  await loader.reload();
  const { session } = await createAgentSession({ cwd: root, agentDir, settingsManager, resourceLoader: loader, modelRuntime, model: modelRuntime.getModel('orch-fixture', 'fixture'), sessionManager: SessionManager.inMemory(root), noTools: 'builtin' });
  await session.bindExtensions({ uiContext: { notify: (text: string) => { notices.push(text); }, setStatus() {} } as any, mode: 'interactive', onError: e => { errors.push(e.message); } });
  while (deferred.length) await deferred.shift()!();
  const settle = async () => { await new Promise(resolve => setImmediate(resolve)); await session.waitForIdle(); };
  return { root, store, session, requests, notices, errors, intervals, cleared, watches, boundary, release,
    scan: () => { intervals.forEach(fn => fn()); }, tick: async () => { intervals.forEach(fn => fn()); await settle(); }, settle,
    send: (kind: string, subject: string, requiresAck = false) => store.send({ from: 'L0', to: input.id || 'L1', kind, subject, body: `${subject} body`, requiresAck, ackDeadlineMin: 30 })[0],
    shutdown: async () => { release(); await session.abort(); await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'exit' }); session.dispose(); modelRuntime.unregisterProvider('orch-fixture'); }
  };
}
