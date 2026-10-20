import { existsSync, unlinkSync } from 'node:fs';
import { basename } from 'node:path';
import { atomic, files, key, lock, now, pidAlive, readJson, Store } from './store.ts';
import type { Kind } from './store.ts';
import { canonical } from './paths.ts';
import { guard, holds } from './decisions.ts';
import { active, identity, sameBinding, sessionKey, validateRole } from './identity.ts';
import type { Binding, Identity, Assignment } from './identity.ts';
import { inspectMetadata, probe, processStart, processStartAsync } from './metadata.ts';
export { active, config, identity, sessionKey } from './identity.ts';
export type { Config, Assignment, Identity, Binding } from './identity.ts';
export { metadata, originSlug } from './metadata.ts';

export interface PiProcess { pid: number; wrapperPid?: number; tty?: string; cwd?: string; command?: string }
export interface DiscoveryOptions {
  processes?: () => PiProcess[]; alive?: (pid: number) => boolean; time?: number;
  inspect?: (store: Store, cwd: string, pid: number) => Record<string, unknown>;
  start?: (pid: number) => string | undefined; ancestors?: () => number[]; pid?: number; env?: NodeJS.ProcessEnv;
}
export function discoverProcesses(): PiProcess[] {
  const rows = probe('pgrep', ['-fl', '(^|/)(pi|pi.js)( |$)|pi-coding-agent/(dist/)?cli.js']).split('\n').filter(Boolean);
  return rows.flatMap(row => {
    const match = row.match(/^\s*(\d+)\s+(.+)$/); if (!match) return [];
    const pid = Number(match[1]);
    const cwd = probe('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn']).split('\n').find(l => l.startsWith('n'))?.slice(1);
    const parent = Number(probe('ps', ['-o', 'ppid=', '-p', String(pid)]));
    const wrapperPid = /(?:^|\/)pi-session(?:\s|$)/.test(probe('ps', ['-o', 'command=', '-p', String(parent)])) ? parent : undefined;
    return [{ pid, command: match[2], cwd: cwd ? canonical(cwd) : undefined, tty: probe('ps', ['-o', 'tty=', '-p', String(pid)]) || undefined, wrapperPid }];
  });
}
function startReader(options: DiscoveryOptions) {
  const values = new Map<number, string | undefined>();
  return (pid: number) => { if (!values.has(pid)) values.set(pid, (options.start || processStart)(pid)); return values.get(pid); };
}
function staleBinding(binding: Binding | undefined, alive: (pid: number) => boolean, start: (pid: number) => string | undefined) {
  if (!binding?.pid || !binding.start) return false;
  if (!alive(binding.pid)) return true;
  const actual = start(binding.pid);
  return !!actual && actual !== binding.start;
}
export function pruneAssignments(store: Store, options: DiscoveryOptions = {}) {
  const alive = options.alive || pidAlive, start = startReader(options);
  const release = lock(store.path('locks', 'assignments.lock'));
  try {
    for (const name of files(store.path('assignments'))) {
      const file = store.path('assignments', name), assignment = readJson<Partial<Assignment>>(file, {});
      if (staleBinding(assignment.binding, alive, start)) unlinkSync(file);
    }
  } finally { release(); }
}
function removeRegistration(store: Store, s: any) {
  const path = store.path('sessions', `${key(s.key)}.json`);
  if (JSON.stringify(readJson(path, {})) !== JSON.stringify(s)) return;
  unlinkSync(path);
  const hb = store.path('heartbeats', `${s.key}.json`);
  if (existsSync(hb)) unlinkSync(hb);
}
export function registeredSessions(store: Store, options: DiscoveryOptions = {}, reserved = false) {
  const time = options.time ?? Date.now(), alive = options.alive || pidAlive, start = startReader(options);
  return store.list<any>('sessions').flatMap(s => {
    if (!s.key) return [];
    const hostAlive = alive(s.pid), wrapperAlive = !!s.wrapperPid && alive(s.wrapperPid);
    const binding = s.processIdentity as Binding | undefined;
    const actual = binding && (hostAlive || wrapperAlive) ? start(binding.pid) : undefined;
    if (!hostAlive && !wrapperAlive || binding && actual && actual !== binding.start) { removeRegistration(store, s); return []; }
    if (!s.cwd || !active(store, s.cwd, {}) || !binding || !actual || binding.pid !== (s.wrapperPid || s.pid) || actual !== binding.start) return [];
    if (hostAlive && (!s.hostStart || start(s.pid) !== s.hostStart)) return [];
    const current = identity(store, s.key, { PI_ORCH_ID: s.envId, PI_REPO: s.envRepo }, binding, s.admittedEnv === true);
    const hb = readJson<any>(store.path('heartbeats', `${key(s.key)}.json`), {});
    const heartbeatAgeSec = Number.isFinite(Date.parse(hb.at)) ? Math.max(0, Math.floor((time - Date.parse(hb.at)) / 1000)) : null;
    const live = heartbeatAgeSec !== null && heartbeatAgeSec <= 90 && (hostAlive || wrapperAlive);
    if (!reserved && !live) return [];
    return [{ ...s, ...current, instrumented: true, heartbeatAgeSec, live }];
  });
}
export function sessions(store: Store, all = false, options: DiscoveryOptions = {}) {
  pruneAssignments(store, options);
  const result = registeredSessions(store, options), start = startReader(options), alive = options.alive || pidAlive;
  if (all) for (const p of (options.processes || discoverProcesses)()) {
    if (!p.cwd || !active(store, p.cwd, {}) || !alive(p.pid)) continue;
    const k = sessionKey(p.wrapperPid ? { PI_SESSION_WRAPPER_PID: String(p.wrapperPid) } : {}, p.pid);
    if (result.some(s => s.key === k || s.pid === p.pid)) continue;
    const hostStart = start(p.pid), scopeStart = start(p.wrapperPid || p.pid);
    if (!hostStart || !scopeStart) continue;
    const processIdentity = { pid: p.wrapperPid || p.pid, start: scopeStart };
    result.push({ ...(options.inspect || inspectMetadata)(store, p.cwd, p.pid), ...p, key: k, ...identity(store, k, {}, processIdentity, false), hostStart, processIdentity, instrumented: false, heartbeatAgeSec: null, live: true });
  }
  return result.map(s => {
    const repo = s.repo || s.detectedRepo;
    const gh = repo ? readJson<any>(store.path('gh', `${key(repo)}.json`), {}) : {};
    return { ...s, prs: (gh.prs || []).filter((p: any) => p.state === 'OPEN' && s.branch && p.headRefName === s.branch).map((p: any) => ({ number: p.number, ci: p.ci })) };
  });
}
export function owners(store: Store, options: DiscoveryOptions = {}) {
  return registeredSessions(store, options).filter(s => s.role === 'owner').map(s => ({ repo: s.repo, id: s.id, key: s.key, sessionId: s.sessionId, heartbeatAgeSec: s.heartbeatAgeSec }));
}
function targetSession(store: Store, target: string, options: DiscoveryOptions, includeStale = false) {
  const list = includeStale ? registeredSessions(store, options, true) : sessions(store, true, options);
  const direct = list.find(s => s.key === target);
  const matching = list.filter(s => s.live && s.tty && basename(s.tty) === basename(target) || includeStale && s.id === target);
  const found = direct || (matching.length === 1 ? matching[0] : undefined);
  if (!found) throw new Error(`session not found or ambiguous: ${target}`);
  if (!found.instrumented) throw new Error('session is not instrumented; load the extension before enrolling');
  return found;
}
function ancestors(): number[] {
  const result: number[] = []; let pid = process.ppid;
  for (let depth = 0; pid > 1 && depth < 8; depth++) { result.push(pid); pid = Number(probe('ps', ['-o', 'ppid=', '-p', String(pid)])); }
  return result;
}
// Always inspect registered ancestry before env: a lane cannot become L0 by changing a CLI env flag.
export function cliIdentity(store: Store, env: NodeJS.ProcessEnv = process.env, options: DiscoveryOptions = {}): Identity {
  const list = store.list<any>('sessions'), pid = options.pid || process.pid;
  const chain = list.length ? [pid, ...(options.ancestors || ancestors)()] : [pid];
  const host = chain.map(p => list.find(s => s.pid === p)).find(Boolean) || (env.PI_SESSION_WRAPPER_PID ? list.find(s => s.key === sessionKey(env)) : undefined);
  if (host) {
    const start = startReader(options), binding = host.processIdentity as Binding | undefined;
    if (!binding || !host.hostStart || start(host.pid) !== host.hostStart || start(binding.pid) !== binding.start) return { id: `S-${host.key}`, key: host.key, assigned: false, rev: 0, registered: true, pending: 'registered process identity mismatch or pending' };
    return { ...identity(store, host.key, { PI_ORCH_ID: host.envId, PI_REPO: host.envRepo }, binding, host.admittedEnv === true), key: host.key, registered: true };
  }
  return { ...identity(store, sessionKey(env, pid), env, null), key: sessionKey(env, pid), registered: false };
}
function authorizeAdmin(store: Store, target: any, options: DiscoveryOptions) {
  const actor = cliIdentity(store, options.env || process.env, options);
  if (actor.pending || actor.role !== 'l0' && (actor.registered || actor.key === target.key || target.pid === (options.pid || process.pid))) throw new Error('enrol/unenrol requires L0 or an outside operator managing a different session');
  return actor.assigned ? actor.id : 'L0';
}
function assertUnique(store: Store, target: string, id: string, options: DiscoveryOptions) {
  const reserved = registeredSessions(store, options, true);
  if (reserved.some(s => s.key !== target && s.assigned && s.id === id)) throw new Error(`ID already held by a live process: ${id}`);
  // Protect a concurrently starting env-pinned session as well, before its async admission completes.
  for (const s of store.list<any>('sessions')) {
    if (s.key === target || s.envId !== id || s.admissionError || !s.cwd || !active(store, s.cwd, {})) continue;
    if (!(options.alive || pidAlive)(s.wrapperPid || s.pid)) continue;
    const assignment = readJson<any>(store.path('assignments', `${key(s.key)}.json`), {});
    if (sameBinding(assignment.binding, s.processIdentity)) continue; // Even an unenrol tombstone overrides env bootstrap.
    const current = identity(store, s.key, {}, s.processIdentity, false);
    if (!current.assigned) throw new Error(`ID already claimed by a starting session: ${id}`);
  }
}
export function enrol(store: Store, target: string, input: { id: string; role: Kind; repo?: string; rules?: string; by: string }, options: DiscoveryOptions = {}) {
  validateRole(input.id, input.role, input.repo);
  if (input.repo) store.repo(input.repo);
  const s = targetSession(store, target, options); // Discovery never holds the assignment lease.
  const by = authorizeAdmin(store, s, options);
  const release = lock(store.path('locks', 'assignments.lock'));
  try {
    const verified = registeredSessions(store, options, true).find(r => r.key === s.key);
    if (!verified || !sameBinding(verified.processIdentity, s.processIdentity)) throw new Error('target process changed; retry enrol');
    authorizeAdmin(store, s, options);
    assertUnique(store, s.key, input.id, options);
    const previous = readJson<Partial<Assignment>>(store.path('assignments', `${s.key}.json`), {});
    const a: Assignment = { key: s.key, id: input.id, role: input.role, repo: input.repo, assignedAt: now(), by, rev: (previous.rev || 0) + 1, binding: s.processIdentity };
    atomic(store.path('assignments', `${s.key}.json`), a);
    store.send({ from: by, to: s.key, kind: 'rule', subject: `Enrolled as ${input.id} (${input.role})`, body: input.rules || `Role ${input.role}${input.repo ? ` for ${input.repo}` : ''}. Acknowledge these rules; lanes deliver to the repo owner instead of publishing.`, requiresAck: true, ackDeadlineMin: 30 });
    return a;
  } finally { release(); }
}
export function unenrol(store: Store, target: string, options: DiscoveryOptions = {}) {
  // Resolve assignments first: discovery may already have removed a dead registration.
  const assignments = files(store.path('assignments')).map(name => ({ key: name.slice(0, -5), value: readJson<any>(store.path('assignments', name)) }));
  const matching = assignments.filter(a => a.value.id === target);
  const found = assignments.find(a => a.key === target) || (matching.length === 1 ? matching[0] : undefined);
  if (!found && matching.length > 1) throw new Error(`session not found or ambiguous: ${target}`);
  const registration = found ? readJson<any>(store.path('sessions', `${key(found.key)}.json`), {}) : undefined;
  const s = found ? { ...registration, key: found.key, pid: registration.pid || found.value.binding?.pid, processIdentity: found.value.binding } : targetSession(store, target, options, true);
  authorizeAdmin(store, s, options);
  const release = lock(store.path('locks', 'assignments.lock'));
  try {
    authorizeAdmin(store, s, options);
    const file = store.path('assignments', `${key(s.key)}.json`), a = readJson<any>(file, {});
    if (found ? JSON.stringify(a) !== JSON.stringify(found.value) : a.binding && !sameBinding(a.binding, s.processIdentity)) throw new Error('target process changed; retry unenrol');
    const registered = readJson<any>(store.path('sessions', `${s.key}.json`), {});
    if (!sameBinding(registered.processIdentity, s.processIdentity) || staleBinding(s.processIdentity, options.alive || pidAlive, startReader(options))) {
      if (existsSync(file)) unlinkSync(file);
    } else {
      atomic(file, { key: s.key, binding: s.processIdentity, id: null, role: null, rev: (a.rev || 0) + 1, assignedAt: now() });
    }
    return { key: s.key, id: `S-${s.key}`, assigned: false };
  } finally { release(); }
}
export async function admitBootstrap(store: Store, skey: string, id: string, commit: () => void, start = processStartAsync, alive = pidAlive) {
  const rows = store.list<any>('sessions'), values = new Map<number, string | undefined>();
  await Promise.all([...new Set<number>(rows.flatMap(s => [s.pid, s.wrapperPid].filter(Boolean)))].map(async pid => values.set(pid, await start(pid))));
  const release = lock(store.path('locks', 'assignments.lock'));
  try { assertUnique(store, skey, id, { start: pid => values.get(pid), alive }); commit(); }
  finally { release(); }
}
export function authorizePublication(store: Store, repo: string, command: 'push' | 'land' | 'rebuild', env: NodeJS.ProcessEnv = process.env, options: DiscoveryOptions = {}) {
  const actor = cliIdentity(store, env, options);
  if (actor.pending) throw new Error(actor.pending);
  if (actor.role === 'owner' && actor.repo !== repo) throw new Error(`owner ${actor.id} cannot publish ${repo}`);
  if (actor.bootstrap && ['owner', 'l0'].includes(actor.role!)) assertUnique(store, actor.key!, actor.id, options);
  const messages = [...new Set([actor.id, actor.key!, `R-${repo}`])].flatMap(box => store.messages(box));
  const reason = guard(`orch cand ${command}`, actor.role || 'unassigned', true, repo, holds(messages, repo));
  if (reason) throw new Error(reason);
}
export function ownerId(_store: Store, repo: string): string { return `R-${repo}`; }
