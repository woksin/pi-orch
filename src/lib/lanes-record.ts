// Launch record for `lanes who`: byte-compatible with pi-setup `lanes register` (<LANES_DIR>/.state/roster/<id>.json).
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, readlinkSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { canonical } from './paths.ts';

export interface LaunchRecord { id: string; pid: number; cwd: string; startedAt: string; retiredAt?: string }
export interface Owned { id: string; pid: number; path: string; dir: string }
export interface RecordOptions {
  alive?: (pid: number) => boolean;
  /** cwds of running pi processes; undefined when the listing failed (treated as alive). */
  procs?: () => string[] | undefined;
  now?: () => Date;
}

const ID = /^(?:[A-Z][A-Z0-9]*[a-z]?|[A-Z][A-Z0-9]*(?:-[A-Z][A-Z0-9]*)+)$/;
export const validLaneId = (id: string): boolean => id.length <= 32 && ID.test(id);
const parseable = (v: unknown): boolean => typeof v === 'string' && Number.isFinite(Date.parse(v));
export function validRecord(v: any): v is LaunchRecord {
  if (!v || typeof v !== 'object' || typeof v.id !== 'string' || typeof v.cwd !== 'string') return false;
  if (!Number.isInteger(v.pid) || v.pid <= 0 || !parseable(v.startedAt)) return false;
  return v.retiredAt === undefined || parseable(v.retiredAt);
}
export function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (e: any) { return e.code === 'EPERM'; }
}
function cwdOf(pid: number): string | undefined {
  try {
    if (process.platform === 'linux') return readlinkSync(`/proc/${pid}/cwd`);
    const out = execFileSync('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] });
    return /^n(.+)$/m.exec(out)?.[1];
  } catch { return undefined; }
}
function piCwds(): string[] | undefined {
  try {
    const out = execFileSync('ps', ['-axo', 'pid=,comm='], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] });
    const cwds: string[] = [];
    for (const line of out.split('\n')) {
      const m = /^\s*(\d+)\s+(.+?)\s*$/.exec(line);
      if (!m || (m[2].split('/').pop() !== 'pi')) continue;
      const cwd = cwdOf(Number(m[1]));
      if (cwd === undefined) return undefined;
      cwds.push(cwd);
    }
    return cwds;
  } catch { return undefined; }
}
const real = (p: string): string => { try { return canonical(p); } catch { return p; } };
function regularDir(path: string): boolean | undefined {
  try { const s = lstatSync(path); return s.isDirectory() && !s.isSymbolicLink(); }
  catch (e: any) { if (e.code === 'ENOENT') return undefined; throw e; }
}
/** Both state directories must be real directories (or absent); the reader refuses anything else. */
function safeDirs(root: string): boolean {
  return regularDir(join(root, '.state')) !== false && regularDir(join(root, '.state', 'roster')) !== false;
}
type Existing = { kind: 'none' } | { kind: 'unsafe' } | { kind: 'record'; record: LaunchRecord } | { kind: 'invalid' };
function readExisting(path: string): Existing {
  try {
    if (!lstatSync(path).isFile()) return { kind: 'unsafe' };
    const value = JSON.parse(readFileSync(path, 'utf8'));
    return validRecord(value) ? { kind: 'record', record: value } : { kind: 'invalid' };
  } catch (e: any) { return e.code === 'ENOENT' ? { kind: 'none' } : { kind: 'invalid' }; }
}
function otherIsLive(record: LaunchRecord, cwd: string, opts: RecordOptions): boolean {
  if (record.retiredAt || !(opts.alive || pidAlive)(record.pid)) return false;
  if (real(record.cwd) === real(cwd)) return true; // We are a pi in that cwd: the holder is plausibly live.
  const cwds = (opts.procs || piCwds)();
  return cwds === undefined || cwds.map(real).includes(real(record.cwd));
}
type Verdict = 'write' | 'ours' | 'skip';
function decide(path: string, cwd: string, pid: number, opts: RecordOptions): Verdict {
  const existing = readExisting(path);
  if (existing.kind === 'unsafe') return 'skip';
  if (existing.kind !== 'record') return 'write';
  const { record } = existing;
  if (record.retiredAt) return 'write';
  if (record.pid === pid) return 'ours';
  return otherIsLive(record, cwd, opts) ? 'skip' : 'write';
}
function atomicWrite(dir: string, id: string, path: string, content: string, guard?: () => boolean): boolean {
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `.${id}-${randomUUID()}.tmp`);
  try {
    writeFileSync(tmp, content, { flag: 'wx' });
    if (guard && !guard()) { unlinkSync(tmp); return false; }
    renameSync(tmp, path);
    return true;
  } catch (e) { try { unlinkSync(tmp); } catch { /* best effort */ } throw e; }
}
/** Write this process's record; returns ownership, or undefined when nothing was (or may be) written. */
export function writeLaunchRecord(env: NodeJS.ProcessEnv, cwd: string, pid: number, opts: RecordOptions = {}): Owned | undefined {
  const id = env.PI_ORCH_ID, lanes = env.LANES_DIR;
  if (!id || !lanes || env.PI_ORCH_OPTOUT === '1' || !validLaneId(id)) return undefined;
  const root = resolve(lanes), dir = join(root, '.state', 'roster'), path = join(dir, `${id}.json`);
  if (!safeDirs(root)) return undefined;
  const owned: Owned = { id, pid, path, dir };
  const verdict = decide(path, cwd, pid, opts);
  if (verdict === 'skip') return undefined;
  if (verdict === 'ours') return owned;
  const record: LaunchRecord = { id, pid, cwd, startedAt: (opts.now?.() ?? new Date()).toISOString() };
  const recheck = () => safeDirs(root) && decide(path, cwd, pid, opts) !== 'skip';
  return atomicWrite(dir, id, path, `${JSON.stringify(record)}\n`, recheck) ? owned : undefined;
}
/** Set retiredAt, but only on a record that is still ours and not yet retired. */
export function retireLaunchRecord(owned: Owned, opts: RecordOptions = {}): boolean {
  const root = join(owned.dir, '..', '..');
  if (!safeDirs(root)) return false;
  const existing = readExisting(owned.path);
  if (existing.kind !== 'record' || existing.record.pid !== owned.pid || existing.record.id !== owned.id || existing.record.retiredAt) return false;
  const retired = { ...existing.record, retiredAt: (opts.now?.() ?? new Date()).toISOString() };
  return atomicWrite(owned.dir, owned.id, owned.path, `${JSON.stringify(retired)}\n`);
}
