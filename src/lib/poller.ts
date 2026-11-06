import { closeSync, constants, fstatSync, openSync, readSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { ownerId, pruneAssignments } from './discovery.ts';
import type { DiscoveryOptions } from './discovery.ts';
import { gh } from './candidates.ts';
import { overdue } from './decisions.ts';
import { atomic, files, key, lock, now, pidAlive, readJson, Store } from './store.ts';
import { sameBinding, validateRole } from './identity.ts';
import type { Assignment } from './identity.ts';
import { processStart } from './metadata.ts';

export function rollup(checks: any[]): string {
  if (!checks?.length) return 'UNKNOWN';
  const states = checks.map(c => String(c.conclusion || c.state || c.status || '').toUpperCase());
  if (states.some(s => ['FAILURE', 'FAIL', 'ERROR', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED', 'STALE', 'STARTUP_FAILURE'].includes(s))) return 'FAILURE';
  return states.every(s => ['SUCCESS', 'NEUTRAL', 'SKIPPED'].includes(s)) ? 'SUCCESS' : 'PENDING';
}
export const acquirePollLock = (store: Store) => lock(store.path('poller.lock'));
function recipientIds(store: Store): string[] {
  try { return readdirSync(store.path('inbox'), { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name); }
  catch (e: any) { if (e.code === 'ENOENT') return []; throw e; }
}
function notify(store: Store, to: string, kind: string, subject: string, body: string) {
  store.send({ from: 'L0', to, kind, subject, body, requiresAck: false, ackDeadlineMin: 30 });
}
function ownerAssignment(a: Assignment, repo: string, id: string) {
  if (a.id !== id) return false;
  if (a.role !== 'owner' || a.repo !== repo) return false;
  try { validateRole(a.id, a.role, a.repo); return true; } catch { return false; }
}
function liveOwner(store: Store, repo: string, options: DiscoveryOptions) {
  const id = ownerId(store, repo);
  return store.list<Assignment>('assignments').some(a => {
    if (!ownerAssignment(a, repo, id) || !a.binding?.start) return false;
    return (options.alive || pidAlive)(a.binding.pid) && (options.start || processStart)(a.binding.pid) === a.binding.start;
  });
}
interface HealthEdge { fingerprint: string; episode: string }
const safeId = (id: unknown): id is string => typeof id === 'string' && /^(?!.*\.\.)[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(id);
function parking(id: unknown, time: number, env: NodeJS.ProcessEnv): 'parked' | 'ordinary' | 'uncertain' {
  if (!safeId(id)) return 'uncertain';
  const root = env.LANE_STATUS_DIR || (env.INBOX_DIR ? join(env.INBOX_DIR, 'status') : join(homedir(), '.pi', 'agent', 'lane-status'));
  let fd: number | undefined;
  try {
    fd = openSync(join(root, `${id}.status`), constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 4096) return 'uncertain';
    const buffer = Buffer.alloc(4096), size = readSync(fd, buffer, 0, buffer.length, 0), line = buffer.toString('utf8', 0, size).split('\n')[0];
    if (line === 'parked') return 'parked';
    const match = /^(?:waiting-on|barred-by) ".*" until (\S+)$/.exec(line);
    if (match) return Date.parse(match[1]) > time ? 'parked' : 'uncertain';
    return ['working', 'running', 'idle'].includes(line) || /^closed(?: at .+)?$/.test(line) ? 'ordinary' : 'uncertain';
  } catch (error: any) { return error.code === 'ENOENT' ? 'ordinary' : 'uncertain'; }
  finally { if (fd !== undefined) closeSync(fd); }
}
// Capture before assignment pruning: notification tracking itself never removes leases or heartbeats.
function healthSnapshot(store: Store) {
  return { sessions: store.list<any>('sessions'), assignments: store.list<any>('assignments'),
    heartbeats: files(store.path('heartbeats')).map(file => ({ key: file.slice(0, -5), hb: readJson<any>(store.path('heartbeats', file)) })) };
}
type HealthSnapshot = ReturnType<typeof healthSnapshot>;
interface HealthContext { snapshot: HealthSnapshot; repos: ReturnType<Store['repos']>; options: DiscoveryOptions; time: number }
interface HealthIncident { key: string; target: string; edge: HealthEdge; subject: Record<string, unknown>; text: string }
function healthProcess(s: any, options: DiscoveryOptions) {
  const alive = options.alive || pidAlive, host = alive(s.pid), wrapper = !!s.wrapperPid && alive(s.wrapperPid);
  const dead = !host && !wrapper, binding = s.processIdentity;
  if (dead || !binding?.start || binding.pid !== (s.wrapperPid || s.pid)) return { dead, verified: false };
  const matchingHost = !host || !!s.hostStart && options.start!(s.pid) === s.hostStart;
  return { dead, verified: matchingHost && options.start!(binding.pid) === binding.start };
}
function matchingRegistration(s: any, hb: any) {
  if (!s || s.pid !== hb.pid || s.wrapperPid !== hb.wrapperPid || s.id !== hb.id) return false;
  if (hb.key && s.key !== hb.key) return false;
  return sameBinding(s.processIdentity, s.processIdentity);
}
function registeredIdentity(s: any, options: DiscoveryOptions) {
  if (!s.assigned) return undefined;
  const admitted = s.admittedEnv && s.envId === s.id;
  if (!admitted && !healthProcess(s, options).dead) return undefined;
  return { id: s.id, role: s.kind, repo: s.repo };
}
function healthIdentity(s: any, hb: any, ctx: HealthContext) {
  if (!matchingRegistration(s, hb)) return undefined;
  const a = ctx.snapshot.assignments.find(a => a.key === s.key);
  if (a && !sameBinding(a.binding, s.processIdentity)) return undefined;
  if (a && s.assigned && (a.role !== s.kind || a.repo !== s.repo)) return undefined;
  const identity = a || registeredIdentity(s, ctx.options);
  if (!identity || identity.id !== s.id) return undefined;
  if (ctx.snapshot.assignments.filter(a => a.id === identity.id).length > 1) return undefined;
  try { validateRole(identity.id, identity.role, identity.repo); } catch { return undefined; }
  if (identity.role !== 'l0' && (!safeId(identity.repo) || !ctx.repos[identity.repo])) return undefined;
  return identity;
}
function healthOwnerLive(repo: string, ctx: HealthContext) {
  const owners = ctx.snapshot.sessions.filter(s => s.id === `R-${repo}`);
  if (owners.length !== 1) return false;
  const s = owners[0], identity = healthIdentity(s, s, ctx);
  return identity?.role === 'owner' && identity.repo === repo && healthProcess(s, ctx.options).verified;
}
function healthClass(hb: any, live: ReturnType<typeof healthProcess>, identity: any, ctx: HealthContext) {
  if (live.dead) return 'dead';
  const at = Date.parse(hb.at), status = parking(hb.id, ctx.time, ctx.options.env || process.env);
  if (!live.verified || !identity || !Number.isFinite(at) || at > ctx.time || status === 'uncertain') return 'uncertain';
  if (status === 'parked' || ctx.time - at <= 600000) return undefined;
  return 'stale';
}
function healthTarget(identity: any, live: ReturnType<typeof healthProcess>, ctx: HealthContext) {
  // Unknown/reused bindings cannot route using an old repo claim. Dead processes may retain matching snapshot attribution.
  if (identity?.role !== 'lane' || !live.verified && !live.dead) return 'L0';
  return healthOwnerLive(identity.repo, ctx) ? `R-${identity.repo}` : 'L0';
}
function healthIncident(observation: HealthSnapshot['heartbeats'][number], ctx: HealthContext): HealthIncident | undefined {
  const { key, hb } = observation, registrations = ctx.snapshot.sessions.filter(s => s.key === key), s = registrations.length === 1 ? registrations[0] : undefined;
  const identity = healthIdentity(s, hb, ctx), live = healthProcess(s || hb, ctx.options), classification = healthClass(hb, live, identity, ctx);
  if (!classification) return undefined;
  const target = healthTarget(identity, live, ctx), binding = s?.processIdentity;
  const processId = binding?.start ? { pid: binding.pid, start: binding.start, hostPid: hb.pid } : { key, pid: hb.pid };
  const edge = { fingerprint: JSON.stringify({ processId, classification, target }), episode: `${key}:${ctx.time}` };
  const subject = { key, id: hb.id, processIdentity: processId, classification, episode: edge.episode };
  const reasons = { dead: 'no observed live host/wrapper process (parked intent does not prove liveness)', stale: 'matching process is live but heartbeat is over ten minutes old; not proof of death', uncertain: 'status, timestamp, process binding or attribution could not be verified' };
  return { key, target, edge, subject, text: `${hb.id || key}: ${classification}; ${reasons[classification]}.` };
}
function healthGroups(ctx: HealthContext, health: Record<string, HealthEdge>) {
  const observed = new Set<string>(), groups = new Map<string, HealthIncident[]>();
  for (const observation of ctx.snapshot.heartbeats) {
    observed.add(observation.key);
    const incident = healthIncident(observation, ctx);
    if (!incident) { delete health[observation.key]; continue; }
    if (health[incident.key]?.fingerprint === incident.edge.fingerprint) continue;
    const group = groups.get(incident.target) || []; group.push(incident); groups.set(incident.target, group);
  }
  for (const key of Object.keys(health)) if (!observed.has(key)) delete health[key];
  return groups;
}
function healthNotices(store: Store, ctx: HealthContext, state: { health: Record<string, HealthEdge>; commit: () => void }) {
  const errors: string[] = [];
  for (const [target, group] of healthGroups(ctx, state.health)) {
    try {
      store.send({ from: 'L0', to: target, kind: 'escalation', subject: 'Heartbeat health observation', body: group.map(e => e.text).join('\n'), requiresAck: false, ackDeadlineMin: 30, refs: { source: 'heartbeat-health', subjects: group.map(e => e.subject) } });
      for (const e of group) state.health[e.key] = e.edge;
      // Durable send precedes edge commit. A crash here can duplicate the group; there is no exactly-once transaction.
      state.commit();
    } catch (error: any) { errors.push(error.message); }
  }
  return errors;
}
export function pollOnce(store: Store, time = Date.now(), options: DiscoveryOptions = {}) {
  const starts = new Map<number, string | undefined>(), optionsStart = options.start;
  options = { ...options, start: (pid => {
    if (!starts.has(pid)) starts.set(pid, (optionsStart || processStart)(pid));
    return starts.get(pid);
  }) };
  const snapshot = healthSnapshot(store);
  pruneAssignments(store, options);
  const stateFile = store.path('poller-state.json');
  const state = readJson<any>(stateFile, { backoff: {}, staleDigestAt: 0 });
  state.backoff ||= {};
  const errors: string[] = [];
  for (const [repo, config] of Object.entries(store.repos())) {
    key(repo);
    if (!config.enrolled || time < (state.backoff[repo] || 0)) continue;
    try {
      const file = store.path('gh', `${repo}.json`), previous = readJson<any>(file, { prs: [] });
      const open = JSON.parse(gh(config, 'pr', 'list', '--author', 'woksin', '--state', 'open', '--json', 'number,headRefName,headRefOid,isDraft,labels,statusCheckRollup,mergeable'));
      const prs = open.map((p: any) => ({ ...p, state: 'OPEN', ci: rollup(p.statusCheckRollup) }));
      for (const candidate of store.candidates(repo)) {
        if (!candidate.pr || prs.some((p: any) => p.number === candidate.pr)) continue;
        const old = previous.prs.find((p: any) => p.number === candidate.pr);
        if (old && old.state !== 'OPEN') { prs.push(old); continue; }
        const p = JSON.parse(gh(config, 'pr', 'view', String(candidate.pr), '--json', 'number,state,mergedAt,headRefName,headRefOid,statusCheckRollup'));
        prs.push({ ...p, ci: p.state === 'MERGED' ? 'MERGED' : rollup(p.statusCheckRollup) });
      }
      for (const c of store.candidates(repo)) {
        const p = prs.find((p: any) => p.number === c.pr), old = previous.prs.find((p: any) => p.number === c.pr);
        if (!p || p.ci === old?.ci || !['SUCCESS', 'FAILURE', 'MERGED'].includes(p.ci)) continue;
        const subject = `${c.name}: ${p.ci}`, body = `PR #${p.number} at ${p.headRefOid}: ${p.ci}`;
        notify(store, ownerId(store, repo), 'ci', subject, body);
        if (p.ci === 'FAILURE' && !liveOwner(store, repo, options)) notify(store, 'L0', 'ci', subject, body);
      }
      atomic(file, { at: new Date(time).toISOString(), prs }); delete state.backoff[repo];
    } catch (e: any) { errors.push(`${repo}: ${e.message}`); if (/\b(?:403|429)\b/.test(e.message)) state.backoff[repo] = time + 600000; }
  }
  for (const id of recipientIds(store)) for (const m of store.unacked(id)) {
    if (overdue(m, time, 15) && store.record(id, m.id, 'escalated')) {
      notify(store, 'L0', 'escalation', `Unacknowledged: ${id} · ${m.subject}`, `${m.id} from ${m.from} is past deadline + 15 minutes.`);
    }
  }
  state.health ||= {};
  errors.push(...healthNotices(store, { snapshot, repos: store.repos(), options, time }, { health: state.health, commit: () => atomic(stateFile, state) }));
  atomic(stateFile, state);
  return { at: now(), errors };
}
