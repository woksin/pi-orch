import { randomBytes } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export type Kind = 'l0' | 'owner' | 'lane';
export const messageKinds = ['order', 'info', 'question', 'report', 'idle', 'rule', 'hold', 'release', 'ci', 'escalation'];
export type Block = 'push' | 'pr-create' | 'pr-merge';
export interface Message { id: string; from: string; to: string; kind: string; subject: string; body: string; requiresAck: boolean; ackDeadlineMin: number; createdAt: string; blocks?: Block[]; repo?: string; refs?: Record<string, unknown> }
export interface Receipt { msgId: string; state: string; at: string; by: string; text?: string; evidence?: string }
export interface Repo { slug: string; mainCheckout: string; integrationWorktree: string; gateCmd: string; batch: { min: number; max: number; ageHours: number }; expressPerDay: number; enrolled: boolean }
export interface Note { section: string; bullets: string[] }
export interface Delivery { id: string; repo: string; issue: number; branch: string; sha: string; author: string; createdAt: string; deps: string[]; gateLog: string; notes: Note[]; intent: string; paths?: string[] }
export interface DeliveryStatus { state: string; at: string; cand?: string; pr?: number; reason?: string }
export interface Candidate { name: string; repo: string; base: string; branch: string; createdAt: string; members: string[]; bounced: { dId: string; reason: string }[]; express: boolean; headSha: string; gateLog?: string; gateSha?: string; pr?: number; landedAt?: string }
export const role = (id: string): Kind => id === 'L0' ? 'l0' : id.startsWith('R-') ? 'owner' : 'lane';
export const now = () => new Date().toISOString();
export function key(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(value) || value.includes('..')) throw new Error(`invalid id: ${value}`);
  return value;
}
export function factId(from: string, date = new Date()): string {
  return `${date.toISOString().replace(/[-:]/g, '').slice(0, 15)}-${key(from)}-${randomBytes(2).toString('hex')}`;
}
export function readJson<T>(file: string, fallback?: T): T {
  try { return JSON.parse(readFileSync(file, 'utf8')); }
  catch (error: any) { if (error.code === 'ENOENT' && fallback !== undefined) return fallback; throw error; }
}
export function lock(file: string): () => void {
  mkdirSync(dirname(file), { recursive: true });
  const fd = openSync(file, 'wx', 0o600);
  writeFileSync(fd, JSON.stringify({ pid: process.pid, at: now() }));
  return () => { closeSync(fd); unlinkSync(file); };
}
export function atomic(file: string, value: unknown, immutable = false): boolean {
  mkdirSync(dirname(file), { recursive: true });
  const release = lock(`${file}.lock`);
  const tmp = `${file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    if (immutable && existsSync(file)) return false;
    const fd = openSync(tmp, 'wx', 0o600);
    try { writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(tmp, file);
    return true;
  } finally { if (existsSync(tmp)) unlinkSync(tmp); release(); }
}
export function files(dir: string): string[] {
  try { return readdirSync(dir).filter(f => f.endsWith('.json')).sort(); }
  catch (error: any) { if (error.code === 'ENOENT') return []; throw error; }
}
export class Store {
  home: string;
  constructor(home = process.env.ORCH_HOME || '/Volumes/sourcecode/repos/cratis/.ai-work/orch') { this.home = home; }
  path(...parts: string[]) { return join(this.home, ...parts); }
  repos(): Record<string, Repo> { return readJson(this.path('repos.json'), {}); }
  repo(name: string): Repo { const r = this.repos()[key(name)]; if (!r) throw new Error(`repo not configured: ${name}`); return r; }
  list<T>(...parts: string[]): T[] { return files(this.path(...parts)).map(f => readJson<T>(this.path(...parts, f))); }
  messages(id: string): Message[] { return this.list<Message>('inbox', key(id)).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)); }
  receipt(id: string, msgId: string, state: string): Receipt | undefined { return readJson<Receipt | undefined>(this.path('receipts', key(id), `${key(msgId)}.${key(state)}.json`), undefined as any); }
  has(id: string, msgId: string, state: string): boolean { return existsSync(this.path('receipts', key(id), `${key(msgId)}.${key(state)}.json`)); }
  record(id: string, msgId: string, state: string, extra: Partial<Receipt> = {}) {
    return atomic(this.path('receipts', key(id), `${key(msgId)}.${key(state)}.json`), { ...extra, msgId, state, at: now(), by: id }, true);
  }
  unacked(id: string): Message[] { return this.messages(id).filter(m => m.requiresAck && !['acked', 'declined', 'done'].some(s => this.has(id, m.id, s))); }
  send(input: Omit<Message, 'id' | 'createdAt' | 'to'> & { to: string }): Message[] {
    if (!messageKinds.includes(input.kind)) throw new Error(`invalid message kind: ${input.kind}`);
    if (!Number.isFinite(input.ackDeadlineMin) || input.ackDeadlineMin <= 0) throw new Error('deadline must be positive');
    if (input.blocks?.some(b => !['push', 'pr-create', 'pr-merge'].includes(b))) throw new Error('invalid blocks');
    if (['hold', 'release'].includes(input.kind) && (!input.repo || !input.blocks?.length)) throw new Error('hold/release requires repo and blocks');
    const sessions = this.list<any>('sessions');
    const recipients = ['ALL', 'owners', 'lanes'].includes(input.to)
      ? sessions.filter(s => input.to === 'ALL' || role(s.id) === (input.to === 'owners' ? 'owner' : 'lane')).map(s => s.id)
      : [key(input.to)];
    return [...new Set<string>(recipients)].map(to => {
      const message = { ...input, to, id: factId(input.from), createdAt: now() };
      atomic(this.path('inbox', to, `${message.id}.json`), message, true);
      return message;
    });
  }
  deliveries(repo: string): Delivery[] { return files(this.path('deliveries', key(repo))).filter(f => !f.includes('.status.')).map(f => readJson(this.path('deliveries', repo, f))); }
  status(repo: string, id: string): DeliveryStatus | undefined {
    const prefix = `${key(id)}.status.`;
    const fs = files(this.path('deliveries', key(repo))).filter(f => f.startsWith(prefix)).sort((a, b) => Number(a.slice(prefix.length, -5)) - Number(b.slice(prefix.length, -5)));
    return fs.length ? readJson(this.path('deliveries', repo, fs.at(-1)!)) : undefined;
  }
  appendStatus(repo: string, id: string, event: Omit<DeliveryStatus, 'at'>) {
    const release = lock(this.path('deliveries', key(repo), `${key(id)}.status.lock`));
    try {
      const previous = this.status(repo, id);
      if (previous && Object.entries(event).every(([k, v]) => (previous as any)[k] === v)) return;
      const ns = files(this.path('deliveries', repo)).filter(f => f.startsWith(`${id}.status.`)).map(f => Number(f.slice(`${id}.status.`.length, -5)));
      atomic(this.path('deliveries', repo, `${id}.status.${Math.max(0, ...ns) + 1}.json`), { ...event, at: now() }, true);
    } finally { release(); }
  }
  candidates(repo: string): Candidate[] { return this.list<Candidate>('cands', key(repo)); }
  candidate(repo: string, name: string): Candidate { return readJson(this.path('cands', key(repo), `${key(name)}.json`)); }
  saveCandidate(c: Candidate) { atomic(this.path('cands', key(c.repo), `${key(c.name)}.json`), c); }
}
