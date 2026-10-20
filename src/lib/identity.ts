import { key, pidAlive, readJson, role } from './store.ts';
import type { Kind, Store } from './store.ts';
import { under } from './paths.ts';

export interface Binding { pid: number; start: string }
export interface Config { roots: string[]; excludes: string[]; phaseWindow?: { until: string; requirePriority: 'low'; exempt?: string[] }; error?: string }
export interface Assignment { key: string; id: string; role: Kind; repo?: string; assignedAt: string; by: string; rev: number; binding: Binding }
export interface Identity { id: string; role?: Kind; repo?: string; assigned: boolean; rev: number; key?: string; registered?: boolean; pending?: string; bootstrap?: boolean }
export function config(store: Store): Config {
  try {
    const c = readJson<any>(store.path('config.json'), { roots: [], excludes: [] });
    const paths = (v: unknown) => Array.isArray(v) && v.every(p => typeof p === 'string' && p.length);
    if (!c || !paths(c.roots) || c.excludes !== undefined && !paths(c.excludes)) throw new Error('roots/excludes must be path arrays');
    const w = c.phaseWindow;
    if (w && (!Number.isFinite(Date.parse(w.until)) || w.requirePriority !== 'low' || w.exempt !== undefined && !paths(w.exempt))) throw new Error('invalid phaseWindow');
    return { ...c, excludes: c.excludes || [] };
  } catch (e: any) { return { roots: [], excludes: [], error: `invalid config.json: ${e.message}` }; }
}
export function active(store: Store, cwd: string, env: NodeJS.ProcessEnv): boolean {
  if (env.PI_ORCH_OPTOUT === '1') return false;
  const c = config(store);
  return c.roots.some(r => under(cwd, r)) && !c.excludes.some(r => under(cwd, r));
}
export const sessionKey = (env: NodeJS.ProcessEnv = process.env, pid = process.pid) => /^\d+$/.test(env.PI_SESSION_WRAPPER_PID || '') && Number(env.PI_SESSION_WRAPPER_PID) > 0 ? `w${env.PI_SESSION_WRAPPER_PID}` : `p${pid}`;
export const sameBinding = (a?: Binding | null, b?: Binding | null) => !!a?.start && a.pid > 0 && a.pid === b?.pid && a.start === b.start;
export function validateRole(id: string, kind: Kind, repo?: string) {
  key(id);
  if (role(id) !== kind || kind === 'owner' && id !== `R-${repo}` || kind !== 'l0' && !repo || kind === 'l0' && repo) throw new Error('id/role mismatch: R-<Repo> is owner of that repo; L0 is l0; other IDs are lanes');
}
export function identity(store: Store, session: string, env: NodeJS.ProcessEnv = {}, expected?: Binding | null, allowEnv = true): Identity {
  const fallback: Identity = { id: `S-${session}`, assigned: false, rev: 0 };
  const record = readJson<any>(store.path('sessions', `${key(session)}.json`), {});
  const binding = expected === undefined ? record.processIdentity : expected;
  const a = readJson<Partial<Assignment>>(store.path('assignments', `${session}.json`), {});
  if (a.id && expected === null) return { ...fallback, pending: 'process identity pending' };
  if (sameBinding(a.binding, binding)) {
    if (!a.id) return fallback;
    try { validateRole(a.id, a.role!, a.repo); }
    catch (e: any) { return { ...fallback, pending: e.message }; }
    return { id: a.id, role: a.role, repo: a.repo, assigned: true, rev: a.rev || 0 };
  }
  // A verified enrolment is authoritative; env is only a bootstrap identity without one.
  if (env.PI_ORCH_ID && allowEnv) {
    const id = env.PI_ORCH_ID, kind = role(id), repo = kind === 'l0' ? undefined : env.PI_REPO || (kind === 'owner' ? id.slice(2) : undefined);
    try { validateRole(id, kind, repo); } catch (e: any) { return { ...fallback, pending: e.message }; }
    return { id, role: kind, repo, assigned: true, rev: 0, bootstrap: true };
  }
  return fallback;
}
// Broadcasts use fresh instrumented registrations only, without spawning on the send hot path.
export function broadcastSessions(store: Store, time = Date.now()) {
  return store.list<any>('sessions').filter(s => {
    if (!s.key || !s.processIdentity?.start || !s.cwd || !active(store, s.cwd, {})) return false;
    const hb = readJson<any>(store.path('heartbeats', `${key(s.key)}.json`), {});
    return Number.isFinite(Date.parse(hb.at)) && time - Date.parse(hb.at) <= 90000 && (pidAlive(s.pid) || !!s.wrapperPid && pidAlive(s.wrapperPid));
  }).map(s => ({ ...s, ...identity(store, s.key, { PI_ORCH_ID: s.envId, PI_REPO: s.envRepo }, s.processIdentity, s.admittedEnv === true) }));
}
