import { readdirSync } from 'node:fs';
import { ownerId } from './discovery.ts';
import { gh } from './candidates.ts';
import { overdue } from './decisions.ts';
import { atomic, key, lock, now, readJson, Store } from './store.ts';

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
export function pollOnce(store: Store, time = Date.now()) {
  const stateFile = store.path('poller-state.json');
  const state = readJson<any>(stateFile, { backoff: {}, staleDigestAt: 0 });
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
        if (p && p.ci !== old?.ci && ['SUCCESS', 'FAILURE', 'MERGED'].includes(p.ci)) notify(store, ownerId(store, repo), 'ci', `${c.name}: ${p.ci}`, `PR #${p.number} at ${p.headRefOid}: ${p.ci}`);
      }
      atomic(file, { at: new Date(time).toISOString(), prs }); delete state.backoff[repo];
    } catch (e: any) { errors.push(`${repo}: ${e.message}`); if (/\b(?:403|429)\b/.test(e.message)) state.backoff[repo] = time + 600000; }
  }
  for (const id of recipientIds(store)) for (const m of store.unacked(id)) {
    if (overdue(m, time, 15) && store.record(id, m.id, 'escalated')) {
      notify(store, 'L0', 'escalation', `Unacknowledged: ${id} · ${m.subject}`, `${m.id} from ${m.from} is past deadline + 15 minutes.`);
    }
  }
  const stale = store.list<any>('heartbeats').filter(h => time - Date.parse(h.at) > 600000);
  if (stale.length && time - state.staleDigestAt >= 1800000) {
    notify(store, 'L0', 'escalation', 'Stale heartbeats', stale.map(h => `${h.id}: ${h.at} (pid ${h.pid}; stale regardless of liveness)`).join('\n'));
    state.staleDigestAt = time;
  }
  atomic(stateFile, state);
  return { at: now(), errors };
}
