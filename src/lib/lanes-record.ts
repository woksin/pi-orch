// Launch record for `lanes who`: byte-compatible with pi-setup `lanes register` (<LANES_DIR>/.state/roster/<id>.json).
import { randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { canonical } from './paths.ts';
import { pidAlive, piCwds } from './process-probe.ts';

export interface LaunchRecord { id: string; pid: number; cwd: string; startedAt: string; retiredAt?: string }
export interface Target { id: string; path: string; dir: string }
export interface Owned extends Target { pid: number; startedAt: string }
export interface RecordOptions {
  alive?: (pid: number) => boolean;
  /** cwds of running pi processes; undefined when the listing failed (treated as alive). May be async. */
  procs?: () => string[] | undefined | Promise<string[] | undefined>;
  now?: () => Date;
}
interface Self { cwd: string; pid: number }
interface Ctx { t: Target; self: Self; opts: RecordOptions; probed?: { cwds: string[] | undefined } }

const ID = /^(?:[A-Z][A-Z0-9]*[a-z]?|[A-Z][A-Z0-9]*(?:-[A-Z][A-Z0-9]*)+)$/;
export const validLaneId = (id: string): boolean => id.length <= 32 && ID.test(id);
const parseable = (v: unknown): boolean => typeof v === 'string' && Number.isFinite(Date.parse(v));
const strings = (v: any): boolean => typeof v.id === 'string' && typeof v.cwd === 'string';
const positiveInt = (n: unknown): boolean => Number.isInteger(n) && (n as number) > 0;
const validTimes = (v: any): boolean => parseable(v.startedAt) && (v.retiredAt === undefined || parseable(v.retiredAt));
const isObject = (v: unknown): boolean => Boolean(v) && typeof v === 'object';
export function validRecord(v: any): v is LaunchRecord {
  return isObject(v) && strings(v) && positiveInt(v.pid) && validTimes(v);
}
const real = (p: string): string => { try { return canonical(p); } catch { return p; } };
const stamp = (opts: RecordOptions): string => (opts.now?.() ?? new Date()).toISOString();
const line = (value: object): string => `${JSON.stringify(value)}\n`;

function regularDir(path: string): boolean | undefined {
  try { const s = lstatSync(path); return s.isDirectory() && !s.isSymbolicLink(); }
  catch (e: any) { if (e.code === 'ENOENT') return undefined; throw e; }
}
/** Both state directories must be real directories (or absent); the reader refuses anything else. */
function safeDirs(t: Target): boolean {
  const state = join(t.dir, '..');
  return regularDir(state) !== false && regularDir(t.dir) !== false;
}
type Existing = { kind: 'none' | 'unsafe' | 'invalid' | 'unreadable' } | { kind: 'record'; record: LaunchRecord };
const absent = (e: any): boolean => e.code === 'ENOENT';
function readText(path: string): string | Existing {
  try {
    if (!lstatSync(path).isFile()) return { kind: 'unsafe' };
    return readFileSync(path, 'utf8');
  } catch (e: any) { return { kind: absent(e) ? 'none' : 'unreadable' }; } // Only ENOENT means absent.
}
function readExisting(path: string): Existing {
  const text = readText(path);
  if (typeof text !== 'string') return text;
  try {
    const value = JSON.parse(text);
    return validRecord(value) ? { kind: 'record', record: value } : { kind: 'invalid' };
  } catch { return { kind: 'invalid' }; }
}
const sameDir = (a: string, b: string): boolean => real(a) === real(b);
const piRunsIn = (cwd: string, cwds: string[] | undefined): boolean => cwds === undefined || cwds.some(c => sameDir(c, cwd));
type Liveness = 'live' | 'dead' | 'probe';
function liveness(record: LaunchRecord, ctx: Ctx): Liveness {
  if (record.retiredAt || !(ctx.opts.alive || pidAlive)(record.pid)) return 'dead';
  if (sameDir(record.cwd, ctx.self.cwd)) return 'live'; // Same cwd: we are a pi there, so the holder is plausibly live.
  if (!ctx.probed) return 'probe';
  return piRunsIn(record.cwd, ctx.probed.cwds) ? 'live' : 'dead';
}
type Verdict = { kind: 'write' | 'skip' | 'probe' } | { kind: 'ours'; startedAt: string };
const OTHER: Record<Liveness, Verdict> = { live: { kind: 'skip' }, dead: { kind: 'write' }, probe: { kind: 'probe' } };
function decide(ctx: Ctx): Verdict {
  const existing = readExisting(ctx.t.path);
  if (existing.kind === 'unsafe' || existing.kind === 'unreadable') return { kind: 'skip' };
  if (existing.kind !== 'record' || existing.record.retiredAt) return { kind: 'write' };
  if (existing.record.pid === ctx.self.pid) return { kind: 'ours', startedAt: existing.record.startedAt };
  return OTHER[liveness(existing.record, ctx)];
}
function atomicWrite(t: Target, content: string, guard: () => boolean = () => true): boolean {
  mkdirSync(t.dir, { recursive: true });
  const tmp = join(t.dir, `.${t.id}-${randomUUID()}.tmp`);
  try {
    writeFileSync(tmp, content, { flag: 'wx' });
    if (!guard()) { unlinkSync(tmp); return false; }
    renameSync(tmp, t.path);
    return true;
  } catch (e) { try { unlinkSync(tmp); } catch { /* best effort */ } throw e; }
}
function targetFor(env: NodeJS.ProcessEnv): Target | undefined {
  const { PI_ORCH_ID: id, LANES_DIR: lanes } = env;
  if (env.PI_ORCH_OPTOUT === '1' || !id || !lanes) return undefined;
  if (!validLaneId(id)) return undefined;
  const dir = join(resolve(lanes), '.state', 'roster');
  return { id, dir, path: join(dir, `${id}.json`) };
}
const proceeds = (v: Verdict): boolean => v.kind === 'write' || v.kind === 'ours';
async function probe(opts: RecordOptions): Promise<string[] | undefined> {
  try { return await (opts.procs || piCwds)(); } catch { return undefined; } // Failure means "treat as live".
}
function commit(ctx: Ctx): Owned | undefined {
  const { t, self, opts } = ctx;
  if (!safeDirs(t)) return undefined;
  const verdict = decide(ctx);
  if (!proceeds(verdict)) return undefined;
  if (verdict.kind === 'ours') return { ...t, pid: self.pid, startedAt: verdict.startedAt };
  const record: LaunchRecord = { id: t.id, pid: self.pid, cwd: self.cwd, startedAt: stamp(opts) };
  const recheck = () => safeDirs(t) && proceeds(decide(ctx));
  return atomicWrite(t, line(record), recheck) ? { ...t, pid: self.pid, startedAt: record.startedAt } : undefined;
}
async function probeThenCommit(ctx: Ctx, isCurrent: () => boolean): Promise<Owned | undefined> {
  ctx.probed = { cwds: await probe(ctx.opts) }; // At most once; the pre-rename recheck reuses it.
  return isCurrent() ? commit(ctx) : undefined;
}
/**
 * Write this process's record. Returns ownership (or undefined) synchronously, except when a live
 * holder of another pid sits in a different cwd: then the process probe runs asynchronously.
 * isCurrent lets a caller discard an obsolete probe before it can write.
 */
export function writeLaunchRecord(env: NodeJS.ProcessEnv, cwd: string, pid: number, opts: RecordOptions = {}, isCurrent: () => boolean = () => true): Owned | undefined | Promise<Owned | undefined> {
  const t = targetFor(env);
  if (!t || !safeDirs(t)) return undefined;
  const ctx: Ctx = { t, self: { cwd, pid }, opts };
  return decide(ctx).kind === 'probe' ? probeThenCommit(ctx, isCurrent) : commit(ctx);
}
const stillOurs = (r: LaunchRecord, o: Owned): boolean => r.pid === o.pid && r.id === o.id && r.startedAt === o.startedAt && !r.retiredAt;
/** Set retiredAt, but only on a record that is still ours (id, pid and startedAt) and not yet retired. */
export function retireLaunchRecord(owned: Owned, opts: RecordOptions = {}): boolean {
  if (!safeDirs(owned)) return false;
  const existing = readExisting(owned.path);
  if (existing.kind !== 'record' || !stillOurs(existing.record, owned)) return false;
  return atomicWrite(owned, line({ ...existing.record, retiredAt: stamp(opts) }));
}
