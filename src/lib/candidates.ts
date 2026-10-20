import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { composeNotes, dependencyOrder, dependents, freezeSet, intents, parseNotes } from './decisions.ts';
import { atomic, factId, key, now, readJson, Store } from './store.ts';
import type { Candidate, Delivery, Repo } from './store.ts';

export class OrchError extends Error { code: number; constructor(message: string, code = 2) { super(message); this.code = code; } }
export function run(command: string, args: string[], cwd?: string): string {
  try { return execFileSync(command, args, { cwd, encoding: 'utf8', timeout: 30000, maxBuffer: 4 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }).trim(); }
  catch (e: any) { throw new OrchError(`${command} ${args.slice(0, 3).join(' ')}: ${e.stderr?.toString().trim() || e.message}`); }
}
export const git = (cwd: string, ...args: string[]) => run('git', ['-C', cwd, ...args]);
export const gh = (repo: Repo, ...args: string[]) => run('gh', [...args, '--repo', repo.slug]);
export function successLog(file: string) {
  const last = readFileSync(file, 'utf8').trimEnd().split('\n').at(-1) || '';
  if (!/pi-phase:.*\bexit=0(?:\s|$)/.test(last)) throw new OrchError(`gate log must end with pi-phase exit=0: ${file}`);
}
const clean = (cwd: string) => { if (git(cwd, 'status', '--porcelain', '--untracked-files=no')) throw new OrchError(`worktree not clean: ${cwd}`); };
function ancestry(cwd: string, ancestor: string, tip: string): boolean {
  try { git(cwd, 'merge-base', '--is-ancestor', ancestor, tip); return true; } catch { return false; }
}
export function deliver(store: Store, p: { repo: string; branch: string; issue: string; notesFile: string; intent: string; gateLog: string; sha?: string; deps?: string[]; paths?: string[] }) {
  const r = store.repo(p.repo);
  if (!intents.includes(p.intent)) throw new OrchError('invalid intent');
  if (!/^\d+$/.test(p.issue) || Number(p.issue) <= 0) throw new OrchError('issue must be a positive number');
  const branchTip = git(r.mainCheckout, 'rev-parse', '--verify', `refs/heads/${p.branch}^{commit}`);
  const sha = p.sha ? git(r.mainCheckout, 'rev-parse', '--verify', `${p.sha}^{commit}`) : branchTip;
  if (!ancestry(r.mainCheckout, sha, branchTip)) throw new OrchError('SHA must be branch tip or ancestor');
  successLog(p.gateLog);
  const notes = parseNotes(readFileSync(p.notesFile, 'utf8'));
  const deps = p.deps || [];
  for (const id of deps) if (!store.deliveries(p.repo).some(d => d.id === id)) throw new OrchError(`missing dependency: ${id}`);
  const d: Delivery = { id: factId(process.env.PI_ORCH_ID || 'L0'), repo: p.repo, issue: Number(p.issue), branch: p.branch, sha, author: process.env.PI_ORCH_ID || 'L0', createdAt: now(), deps, gateLog: resolve(p.gateLog), notes, intent: p.intent, ...(p.paths ? { paths: p.paths } : {}) };
  atomic(store.path('deliveries', key(p.repo), `${d.id}.json`), d, true);
  store.appendStatus(p.repo, d.id, { state: 'pending' });
  store.send({ from: d.author, to: `R-${p.repo}`, kind: 'info', subject: `Delivery ${d.id}`, body: `${d.branch} ${sha} (#${d.issue})`, requiresAck: false, ackDeadlineMin: 30 });
  return d;
}
export function plan(store: Store, repo: string) {
  const all = store.deliveries(repo), pending = all.filter(d => store.status(repo, d.id)?.state === 'pending');
  const shipped = all.filter(d => store.status(repo, d.id)?.state === 'shipped').map(d => d.id);
  return { pending: pending.map(d => ({ id: d.id, ageHours: (Date.now() - Date.parse(d.createdAt)) / 3600000, deps: d.deps, closure: dependencyOrder(all, [d.id], shipped).map(d => d.id) })), suggested: freezeSet(pending, store.repo(repo).batch, Date.now(), shipped) };
}
export function worktree(r: Repo, c: Pick<Candidate, 'express'>) { return c.express ? `${r.integrationWorktree}-express` : r.integrationWorktree; }
function assertHead(r: Repo, c: Candidate) {
  const cwd = worktree(r, c);
  if (git(cwd, 'branch', '--show-current') !== c.branch || git(cwd, 'rev-parse', 'HEAD') !== c.headSha) throw new OrchError('branch head != headSha; run orch cand sync');
  clean(cwd); return cwd;
}
export function build(store: Store, repo: string, ids: string[], express = false, replacing?: string): Candidate {
  const r = store.repo(repo), all = store.deliveries(repo), previous = store.candidates(repo);
  const cache = readJson<any>(store.path('gh', `${repo}.json`), { prs: [] });
  if (!ids.length || new Set(ids).size !== ids.length) throw new OrchError('ids must be nonempty and unique');
  if (!express && previous.some(c => c.name !== replacing && !c.supersededBy && !c.express && c.pr && !c.landedAt && cache.prs?.find((p: any) => p.number === c.pr)?.state !== 'CLOSED')) throw new OrchError('another non-express candidate has an unlanded PR');
  if (express && previous.filter(c => c.express && c.createdAt.slice(0, 10) === now().slice(0, 10)).length >= r.expressPerDay) throw new OrchError('expressPerDay exhausted');
  const shipped = all.filter(d => store.status(repo, d.id)?.state === 'shipped').map(d => d.id);
  const ordered = dependencyOrder(all, ids, shipped);
  if (ids.some(id => !all.some(d => d.id === id) || shipped.includes(id))) throw new OrchError('ids must name unshipped deliveries');
  if (ordered.some(d => !ids.includes(d.id))) throw new OrchError('ids must include dependency closure');
  const cwd = worktree(r, { express });
  if (existsSync(cwd)) clean(cwd);
  git(r.mainCheckout, 'fetch', 'origin');
  if (!existsSync(cwd)) git(r.mainCheckout, 'worktree', 'add', '--detach', cwd, 'origin/main');
  const listed = git(r.mainCheckout, 'worktree', 'list', '--porcelain');
  const entry = listed.split('\n\n').find(e => e.startsWith(`worktree ${resolve(cwd)}\n`));
  if (!entry) throw new OrchError(`not an integration worktree: ${cwd}`);
  if (!entry.split('\n').some(l => l === 'locked' || l.startsWith('locked '))) git(r.mainCheckout, 'worktree', 'lock', cwd);
  const stamp = now().replace(/[-:]/g, '').replace('T', '-').slice(0, 13);
  let name = `${key(repo)}-${stamp}`, suffix = 1;
  while (previous.some(c => c.name === name)) name = `${repo}-${stamp}-${suffix++}`;
  const branch = `cand/${name}`, base = git(cwd, 'rev-parse', 'origin/main');
  git(cwd, 'switch', '-c', branch, base);
  const members: string[] = [], bounced: Candidate['bounced'] = [], excluded = new Set<string>();
  for (const d of ordered) {
    if (excluded.has(d.id)) { bounced.push({ dId: d.id, reason: 'dependency conflict' }); store.appendStatus(repo, d.id, { state: 'bounced', cand: name, reason: 'dependency conflict' }); continue; }
    try { git(cwd, 'merge', '--no-ff', '--no-edit', d.sha); members.push(d.id); }
    catch (e) {
      if (!existsSync(join(git(cwd, 'rev-parse', '--absolute-git-dir'), 'MERGE_HEAD'))) throw e;
      git(cwd, 'merge', '--abort');
      dependents(ordered, [d.id]).forEach(id => excluded.add(id));
      bounced.push({ dId: d.id, reason: 'conflict' }); store.appendStatus(repo, d.id, { state: 'bounced', cand: name, reason: 'conflict' });
    }
  }
  const c: Candidate = { name, repo, base, branch, createdAt: now(), members, bounced, express, headSha: git(cwd, 'rev-parse', 'HEAD') };
  store.saveCandidate(c); return c;
}
export function sync(store: Store, repo: string, name: string) {
  const r = store.repo(repo), c = store.candidate(repo, name), cwd = worktree(r, c);
  if (git(cwd, 'branch', '--show-current') !== c.branch) throw new OrchError('wrong candidate branch');
  clean(cwd);
  const head = git(cwd, 'rev-parse', 'HEAD');
  if (!ancestry(cwd, c.headSha, head)) throw new OrchError('sync requires headSha ancestor');
  const parents = git(cwd, 'rev-list', '--merges', '--parents', `${c.headSha}..${head}`).split('\n').flatMap(l => l.split(' ').slice(2));
  const excluded = store.deliveries(repo).filter(d => !c.members.includes(d.id));
  if (parents.some(parent => excluded.some(d => d.sha === parent || ancestry(cwd, d.sha, parent) && !ancestry(cwd, d.sha, c.headSha)))) throw new OrchError('new merge parent contains delivery not in members');
  c.headSha = head; delete c.gateLog; delete c.gateSha; store.saveCandidate(c); return c;
}
export function gate(store: Store, repo: string, name: string, log: string) {
  const c = store.candidate(repo, name); assertHead(store.repo(repo), c); successLog(log);
  c.gateLog = resolve(log); c.gateSha = c.headSha; store.saveCandidate(c); return c;
}
export function notes(store: Store, repo: string, name: string) {
  const c = store.candidate(repo, name), r = store.repo(repo);
  const selected = c.members.map(id => { const d = store.deliveries(repo).find(d => d.id === id); if (!d) throw new OrchError(`missing delivery: ${id}`); return d; });
  const composed = composeNotes(selected), file = join(worktree(r, c), '.ai-work', `cand-${key(name)}-body.md`);
  mkdirSync(join(worktree(r, c), '.ai-work'), { recursive: true }); writeFileSync(file, composed.body);
  return { ...composed, file };
}
export function push(store: Store, repo: string, name: string) {
  const c = store.candidate(repo, name), r = store.repo(repo), cwd = assertHead(r, c);
  if (!c.gateLog || c.gateSha !== c.headSha) throw new OrchError('gate evidence required at current headSha');
  successLog(c.gateLog);
  const body = notes(store, repo, name);
  git(cwd, 'push', 'origin', c.branch);
  if (!c.pr) {
    const url = gh(r, 'pr', 'create', '--head', c.branch, '--base', 'main', '--title', `Candidate ${c.name}`, '--body-file', body.file, '--label', body.label, '--assignee', 'woksin');
    const match = url.match(/\/pull\/(\d+)\s*$/); if (!match) throw new OrchError('gh pr create did not return a PR URL; run orch reconcile');
    c.pr = Number(match[1]); store.saveCandidate(c);
  }
  for (const id of c.members) store.appendStatus(repo, id, { state: 'in-cand', cand: name, pr: c.pr });
  return c;
}
export function land(store: Store, repo: string, name: string) {
  const c = store.candidate(repo, name), r = store.repo(repo);
  const cache = readJson<any>(store.path('gh', `${key(repo)}.json`), {});
  const pr = cache.prs?.find((p: any) => p.number === c.pr);
  if (!pr || pr.state !== 'OPEN' || pr.headRefOid !== c.headSha || pr.ci !== 'SUCCESS') throw new OrchError('gh cache requires PR open, head == headSha, all checks success');
  gh(r, 'pr', 'merge', String(c.pr), '--merge');
  c.landedAt = now(); store.saveCandidate(c);
  for (const id of c.members) store.appendStatus(repo, id, { state: 'shipped', cand: name, pr: c.pr });
  return c;
}
export function rebuild(store: Store, repo: string, name: string, drop: string[]) {
  const old = store.candidate(repo, name), r = store.repo(repo);
  if (!drop.length || drop.some(id => !old.members.includes(id))) throw new OrchError('drop must name candidate members');
  let state = '';
  if (old.pr) { state = JSON.parse(gh(r, 'pr', 'view', String(old.pr), '--json', 'state')).state; if (state === 'MERGED') throw new OrchError('cannot rebuild merged candidate'); }
  const excluded = dependents(store.deliveries(repo), drop), ids = old.members.filter(id => !excluded.includes(id));
  if (!ids.length) throw new OrchError('nothing to rebuild', 4);
  // Only this old candidate is exempted; its manifest stays intact during the build.
  const next = build(store, repo, ids, old.express, old.name);
  if (old.pr) {
    const comment = `Replaced by candidate ${next.name}: https://github.com/${r.slug}/tree/${next.branch}`;
    if (state === 'CLOSED') gh(r, 'pr', 'comment', String(old.pr), '--body', comment);
    else gh(r, 'pr', 'close', String(old.pr), '--comment', comment);
  }
  old.supersededBy = next.name; store.saveCandidate(old);
  for (const id of excluded.filter(id => old.members.includes(id))) store.appendStatus(repo, id, { state: 'bounced', cand: next.name, reason: 'dropped during rebuild' });
  return next;
}
export function reconcile(store: Store, repo: string) {
  const r = store.repo(repo);
  const branches = git(r.mainCheckout, 'for-each-ref', '--format=%(refname:short)', 'refs/heads/cand/').split('\n').filter(Boolean);
  for (const branch of branches) {
    const name = branch.slice(5); if (!name.startsWith(`${repo}-`) || store.candidates(repo).some(c => c.name === name)) continue;
    const headSha = git(r.mainCheckout, 'rev-parse', branch);
    const members = store.deliveries(repo).filter(d => ancestry(r.mainCheckout, d.sha, headSha)).map(d => d.id);
    store.saveCandidate({ name, repo, branch, headSha, base: git(r.mainCheckout, 'merge-base', 'origin/main', headSha), createdAt: now(), members, bounced: [], express: false });
  }
  for (const c of store.candidates(repo)) {
    let pr: any;
    if (c.pr) pr = JSON.parse(gh(r, 'pr', 'view', String(c.pr), '--json', 'number,state,mergedAt,headRefOid'));
    else {
      const prs = JSON.parse(gh(r, 'pr', 'list', '--head', c.branch, '--state', 'all', '--json', 'number,state,mergedAt,headRefOid'));
      pr = prs[0];
    }
    if (!pr) continue;
    c.pr = pr.number;
    if (pr.state === 'MERGED') c.landedAt ||= pr.mergedAt || now();
    store.saveCandidate(c);
    for (const id of c.members) {
      const current = store.status(repo, id);
      if (pr.state === 'CLOSED') {
        if (current?.state === 'in-cand' && current.cand === c.name && !c.supersededBy) store.appendStatus(repo, id, { state: 'pending', cand: c.name, reason: 'PR closed without merge' });
      } else if (pr.state === 'MERGED' || !current?.cand || current.cand === c.name) {
        store.appendStatus(repo, id, { state: pr.state === 'MERGED' ? 'shipped' : 'in-cand', cand: c.name, pr: c.pr });
      }
    }
  }
  return store.candidates(repo);
}
