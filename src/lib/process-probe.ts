// Process liveness probing for the lanes launch record. Every failure is reported as "unknown" (undefined).
import { execFileSync } from 'node:child_process';
import { readlinkSync } from 'node:fs';

const run = (cmd: string, args: string[]): string =>
  execFileSync(cmd, args, { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] });

export function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (e: any) { return e.code === 'EPERM'; }
}
function cwdOf(pid: number): string | undefined {
  try {
    if (process.platform === 'linux') return readlinkSync(`/proc/${pid}/cwd`);
    return /^n(.+)$/m.exec(run('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn']))?.[1];
  } catch { return undefined; }
}
function piPids(): number[] {
  const pids: number[] = [];
  for (const line of run('ps', ['-axo', 'pid=,comm=']).split('\n')) {
    const m = /^\s*(\d+)\s+(.+?)\s*$/.exec(line);
    if (m && m[2].split('/').pop() === 'pi') pids.push(Number(m[1]));
  }
  return pids;
}
/** cwds of running pi processes; undefined when the listing or any cwd lookup failed. */
export function piCwds(): string[] | undefined {
  try {
    const cwds = piPids().map(cwdOf);
    return cwds.every((c): c is string => c !== undefined) ? cwds : undefined;
  } catch { return undefined; }
}
