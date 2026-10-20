import { execFileSync } from 'node:child_process';
import { existsSync, unlinkSync } from 'node:fs';
import { basename } from 'node:path';
import { atomic, key, lock, now, pidAlive, readJson, role, Store } from './store.ts';
import type { Kind } from './store.ts';
import { canonical, under } from './paths.ts';
import { guard, holds } from './decisions.ts';

export interface Config { roots: string[]; excludes: string[]; phaseWindow?: { until: string; requirePriority: 'low'; exempt?: string[] } }
export interface Assignment { key: string; id: string; role: Kind; repo?: string; assignedAt: string; by: string; rev: number }
export interface Identity { id: string; role?: Kind; repo?: string; assigned: boolean; rev: number; key?: string }
export interface PiProcess { pid: number; wrapperPid?: number; tty?: string; cwd?: string; command?: string }
export interface DiscoveryOptions { processes?: () => PiProcess[]; alive?: (pid: number) => boolean; time?: number; inspect?: (store: Store, cwd: string, pid: number) => Record<string, unknown> }
export function config(store: Store): Config { return readJson(store.path('config.json'), { roots: [], excludes: [] }); }
export function active(store: Store, cwd: string, env: NodeJS.ProcessEnv): boolean {
  if (env.PI_ORCH_OPTOUT === '1') return false;
  const c = config(store);
  return c.roots.some(r => under(cwd, r)) && !(c.excludes || []).some(r => under(cwd, r));
}
export const sessionKey = (env: NodeJS.ProcessEnv = process.env, pid = process.pid) => /^\d+$/.test(env.PI_SESSION_WRAPPER_PID || '') && Number(env.PI_SESSION_WRAPPER_PID) > 0 ? `w${env.PI_SESSION_WRAPPER_PID}` : `p${pid}`;
export function identity(store: Store, session: string, env: NodeJS.ProcessEnv = {}): Identity {
  if (env.PI_ORCH_ID) {
    const id = key(env.PI_ORCH_ID), kind = role(id);
    return { id, role: kind, repo: env.PI_REPO || (kind === 'owner' ? id.slice(2) : undefined), assigned: true, rev: 0 };
  }
  const a = readJson<Partial<Assignment>>(store.path('assignments', `${key(session)}.json`), {});
  return a.id && a.role ? { id: key(a.id), role: a.role, repo: a.repo, assigned: true, rev: a.rev || 0 } : { id: `S-${session}`, assigned: false, rev: 0 };
}
function probe(command: string, args: string[]): string {
  try { return execFileSync(command, args, { encoding: 'utf8', timeout: 5000, maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }).trim(); } catch { return ''; }
}
export function originSlug(url: string): string | undefined {
  return url.match(/github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?\/?$/)?.[1];
}
export function metadata(store: Store, cwd: string, pid = process.pid) {
  const top = probe('git', ['-C', cwd, 'rev-parse', '--show-toplevel']);
  const origin = top ? probe('git', ['-C', cwd, 'remote', 'get-url', 'origin']) : '';
  const slug = originSlug(origin), branch = top ? probe('git', ['-C', cwd, 'branch', '--show-current']) : '';
  const repo = Object.entries(store.repos()).find(([, r]) => slug ? r.slug.toLowerCase() === slug.toLowerCase() : top && canonical(r.mainCheckout) === canonical(top))?.[0];
  return { tty: probe('ps', ['-o', 'tty=', '-p', String(pid)]) || undefined, cwd: canonical(cwd), gitToplevel: top ? canonical(top) : undefined, originSlug: slug, branch: branch || undefined, detectedRepo: repo };
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
export function registeredSessions(store: Store, options: DiscoveryOptions = {}) {
  const time = options.time ?? Date.now(), alive = options.alive || pidAlive;
  return store.list<any>('sessions').map(s => {
    const k = s.key || s.id;
    const current = s.key ? identity(store, k, { PI_ORCH_ID: s.envId, PI_REPO: s.envRepo }) : { id: s.id, role: s.kind, repo: s.repo, assigned: true, rev: 0 };
    const hb = readJson<any>(store.path('heartbeats', `${key(k)}.json`), {});
    const heartbeatAgeSec = hb.at ? Math.max(0, Math.floor((time - Date.parse(hb.at)) / 1000)) : null;
    const live = heartbeatAgeSec !== null && heartbeatAgeSec <= 90 && (alive(s.pid) || !!s.wrapperPid && alive(s.wrapperPid));
    return { ...s, key: k, ...current, instrumented: true, heartbeatAgeSec, live };
  });
}
export function sessions(store: Store, all = false, options: DiscoveryOptions = {}) {
  const result = registeredSessions(store, options);
  if (all) for (const p of (options.processes || discoverProcesses)()) {
    const k = sessionKey(p.wrapperPid ? { PI_SESSION_WRAPPER_PID: String(p.wrapperPid) } : {}, p.pid);
    if (result.some(s => s.key === k || s.pid === p.pid)) continue;
    result.push({ ...(p.cwd ? (options.inspect || metadata)(store, p.cwd, p.pid) : {}), ...p, key: k, ...identity(store, k), instrumented: false, heartbeatAgeSec: null, live: (options.alive || pidAlive)(p.pid) });
  }
  return result.map(s => {
    const repo = s.repo || s.detectedRepo;
    const gh = repo ? readJson<any>(store.path('gh', `${key(repo)}.json`), {}) : {};
    return { ...s, prs: (gh.prs || []).filter((p: any) => p.state === 'OPEN' && s.branch && p.headRefName === s.branch).map((p: any) => ({ number: p.number, ci: p.ci })) };
  });
}
export function owners(store: Store, options: DiscoveryOptions = {}) {
  return registeredSessions(store, options).filter(s => s.role === 'owner' && s.live).map(s => ({ repo: s.repo, id: s.id, key: s.key, sessionId: s.sessionId, heartbeatAgeSec: s.heartbeatAgeSec }));
}
function targetSession(store: Store, target: string, options: DiscoveryOptions, allowId = false) {
  const list = sessions(store, true, options), direct = list.find(s => s.key === target);
  if (direct) return direct;
  const matching = list.filter(s => s.tty && basename(s.tty) === basename(target) || allowId && s.id === target);
  if (matching.length !== 1) throw new Error(`session not found or ambiguous: ${target}`);
  return matching[0];
}
export function enrol(store: Store, target: string, input: { id: string; role: Kind; repo?: string; rules?: string; by: string }, options: DiscoveryOptions = {}) {
  key(input.id);
  if (!['l0', 'owner', 'lane'].includes(input.role)) throw new Error('role must be lane, owner or l0');
  if (input.role !== 'l0' && !input.repo) throw new Error('repo required for owner/lane');
  if (input.repo) store.repo(input.repo);
  const release = lock(store.path('locks', 'assignments.lock'));
  try {
    const s = targetSession(store, target, options);
    if (s.envId && (s.id !== input.id || s.role !== input.role || s.repo !== input.repo)) throw new Error('PI_ORCH_ID overrides assignments; restart without it to change role');
    if (input.role === 'owner' && owners(store, options).some(o => o.repo === input.repo && o.key !== s.key)) throw new Error(`live owner already exists for ${input.repo}`);
    const previous = readJson<Partial<Assignment>>(store.path('assignments', `${s.key}.json`), {});
    const a: Assignment = { key: s.key, id: input.id, role: input.role, repo: input.repo, assignedAt: now(), by: input.by, rev: (previous.rev || 0) + 1 };
    atomic(store.path('assignments', `${s.key}.json`), a);
    store.send({ from: input.by, to: s.key, kind: 'rule', subject: `Enrolled as ${input.id} (${input.role})`, body: input.rules || `Role ${input.role}${input.repo ? ` for ${input.repo}` : ''}. Acknowledge these rules; lanes deliver to the repo owner instead of publishing.`, requiresAck: true, ackDeadlineMin: 30 });
    return a;
  } finally { release(); }
}
export function unenrol(store: Store, target: string, options: DiscoveryOptions = {}) {
  const release = lock(store.path('locks', 'assignments.lock'));
  try {
    const s = targetSession(store, target, options, true);
    if (s.envId) throw new Error('PI_ORCH_ID overrides assignments; restart without it to unenrol');
    const file = store.path('assignments', `${key(s.key)}.json`);
    if (existsSync(file)) unlinkSync(file);
    return { key: s.key, id: `S-${s.key}`, assigned: false };
  } finally { release(); }
}
// CLI children inherit wrapper identity. Without one, locate the registered host in their ancestry.
export function cliIdentity(store: Store, env: NodeJS.ProcessEnv = process.env): Identity {
  let k = sessionKey(env);
  if (!env.PI_ORCH_ID && !env.PI_SESSION_WRAPPER_PID) {
    let pid = process.ppid;
    const list = store.list<any>('sessions');
    for (let depth = 0; list.length && pid > 1 && depth < 8; depth++) {
      const host = list.find(s => s.pid === pid);
      if (host) { k = host.key || `p${pid}`; break; }
      pid = Number(probe('ps', ['-o', 'ppid=', '-p', String(pid)]));
    }
  }
  return { ...identity(store, k, env), key: k };
}
export function authorizePublication(store: Store, repo: string, command: 'push' | 'land' | 'rebuild', env: NodeJS.ProcessEnv = process.env) {
  const actor = cliIdentity(store, env);
  if (actor.role === 'owner' && actor.repo !== repo) throw new Error(`owner ${actor.id} cannot publish ${repo}`);
  const messages = [...new Set([actor.id, actor.key!, `R-${repo}`])].flatMap(box => store.messages(box));
  const reason = guard(`orch cand ${command}`, actor.role || 'unassigned', true, repo, holds(messages, repo));
  if (reason) throw new Error(reason);
}

export function ownerId(store: Store, repo: string): string { return owners(store).find(o => o.repo === repo)?.id || `R-${repo}`; }
