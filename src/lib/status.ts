import { readJson, Store } from './store.ts';
import { holds, overdue } from './decisions.ts';
export function repoStatus(store: Store, repo: string) {
  return { repo, holds: holds(store.messages(`R-${repo}`), repo), deliveries: store.deliveries(repo).map(d => ({ ...d, status: store.status(repo, d.id) })), candidates: store.candidates(repo), gh: readJson(store.path('gh', `${repo}.json`), {}) };
}
export function status(store: Store, id: string, repo?: string) {
  return { unacked: store.unacked(id), ...(repo ? repoStatus(store, repo) : {}) };
}
export function board(store: Store, time = Date.now()) {
  return {
    sessions: store.list<any>('sessions').map(s => {
      const hb = readJson<any>(store.path('heartbeats', `${s.id}.json`), {});
      const unacked = store.unacked(s.id);
      return { ...s, heartbeatAgeSec: hb.at ? Math.floor((time - Date.parse(hb.at)) / 1000) : null, state: hb.state || 'unknown', unacked: unacked.length, overdue: unacked.filter(m => overdue(m, time)).length };
    }),
    repos: Object.keys(store.repos()).map(repo => ({ ...repoStatus(store, repo), pending: store.deliveries(repo).filter(d => store.status(repo, d.id)?.state === 'pending').map(d => ({ id: d.id, ageHours: (time - Date.parse(d.createdAt)) / 3600000 })) })),
  };
}
export function boardMarkdown(data: ReturnType<typeof board>) {
  const lines = ['# Orch board', '', '| Session | Kind | Repo | HB age (s) | State | Unacked / overdue |', '|---|---|---|---:|---|---|'];
  for (const s of data.sessions) lines.push(`| ${s.id} | ${s.kind} | ${s.repo || '-'} | ${s.heartbeatAgeSec ?? 'missing'} | ${s.state} | ${s.unacked} / ${s.overdue} |`);
  for (const r of data.repos) {
    lines.push('', `## ${r.repo}`, `Holds: ${r.holds.join(', ') || 'none'}`, ...r.pending.map(d => `- pending ${d.id} (${d.ageHours.toFixed(1)}h)`));
    for (const c of r.candidates) lines.push(`- cand ${c.name}: ${c.members.join(', ')} · PR ${c.pr || '-'} · CI ${(r.gh as any).prs?.find((p: any) => p.number === c.pr)?.ci || 'unknown'}`);
  }
  return lines.join('\n');
}
