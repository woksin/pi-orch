// Launch record for `lanes who`: byte-compatible with pi-setup `lanes register` (<LANES_DIR>/.state/roster/<id>.json).
import { randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { canonical } from './paths.ts';
import { pidAlive, piCwds } from './process-probe.ts';

export interface LaunchRecord { id: string; pid: number; cwd: string; startedAt: string; retiredAt?: string }
export interface Target { id: string; path: string; dir: string }
export interface Owned extends Target { pid: number }
export interface RecordOptions {
  alive?: (pid: number) => boolean;
  /** cwds of running pi processes; undefined when the listing failed (treated as alive). */
  procs?: () => string[] | undefined;
  now?: () => Date;
}
interface Self { cwd: string; pid: number }

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
type Existing = { kind: 'none' | 'unsafe' | 'invalid' } | { kind: 'record'; record: LaunchRecord };
function readExisting(path: string): Existing {
  try {
    if (!lstatSync(path).isFile()) return { kind: 'unsafe' };
    const value = JSON.parse(readFileSync(path, 'utf8'));
    return validRecord(value) ? { kind: 'record', record: value } : { kind: 'invalid' };
  } catch (e: any) { return { kind: e.code === 'ENOENT' ? 'none' : 'invalid' }; }
}
const sameDir = (a: string, b: string): boolean => real(a) === real(b);
function piRunsIn(cwd: string, opts: RecordOptions): boolean {
  const cwds = (opts.procs || piCwds)();
  return cwds === undefined || cwds.some(c => sameDir(c, cwd));
}
function otherIsLive(record: LaunchRecord, cwd: string, opts: RecordOptions): boolean {
  if (record.retiredAt || !(opts.alive || pidAlive)(record.pid)) return false;
  return sameDir(record.cwd, cwd) || piRunsIn(record.cwd, opts); // Same cwd: we are a pi there, so the holder is plausibly live.
}
type Verdict = 'write' | 'ours' | 'skip';
function decide(t: Target, self: Self, opts: RecordOptions): Verdict {
  const existing = readExisting(t.path);
  if (existing.kind === 'unsafe') return 'skip';
  if (existing.kind !== 'record' || existing.record.retiredAt) return 'write';
  if (existing.record.pid === self.pid) return 'ours';
  return otherIsLive(existing.record, self.cwd, opts) ? 'skip' : 'write';
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
/** Write this process's record; returns ownership, or undefined when nothing was (or may be) written. */
export function writeLaunchRecord(env: NodeJS.ProcessEnv, cwd: string, pid: number, opts: RecordOptions = {}): Owned | undefined {
  const t = targetFor(env), self = { cwd, pid };
  if (!t || !safeDirs(t)) return undefined;
  const verdict = decide(t, self, opts);
  if (verdict === 'skip') return undefined;
  if (verdict === 'ours') return { ...t, pid };
  const record: LaunchRecord = { id: t.id, pid, cwd, startedAt: stamp(opts) };
  const recheck = () => safeDirs(t) && decide(t, self, opts) !== 'skip';
  return atomicWrite(t, line(record), recheck) ? { ...t, pid } : undefined;
}
const stillOurs = (r: LaunchRecord, o: Owned): boolean => r.pid === o.pid && r.id === o.id && !r.retiredAt;
/** Set retiredAt, but only on a record that is still ours and not yet retired. */
export function retireLaunchRecord(owned: Owned, opts: RecordOptions = {}): boolean {
  if (!safeDirs(owned)) return false;
  const existing = readExisting(owned.path);
  if (existing.kind !== 'record') return false;
  const { record } = existing;
  return stillOurs(record, owned) && atomicWrite(owned, line({ ...record, retiredAt: stamp(opts) }));
}
