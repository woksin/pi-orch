// Process liveness probing for the lanes launch record. Every failure is reported as "unknown" (undefined).
import { execFile } from 'node:child_process';
import { readlink } from 'node:fs/promises';

const run = (cmd: string, args: string[]): Promise<string> => new Promise((resolve, reject) =>
  execFile(cmd, args, { encoding: 'utf8', timeout: 5000 }, (error, stdout) => error ? reject(error) : resolve(stdout)));

export function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (e: any) { return e.code === 'EPERM'; }
}
async function cwdOf(pid: number): Promise<string | undefined> {
  try {
    if (process.platform === 'linux') return await readlink(`/proc/${pid}/cwd`);
    return /^n(.+)$/m.exec(await run('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn']))?.[1];
  } catch { return undefined; }
}
async function piPids(): Promise<number[]> {
  const pids: number[] = [];
  for (const line of (await run('ps', ['-axo', 'pid=,comm='])).split('\n')) {
    const m = /^\s*(\d+)\s+(.+?)\s*$/.exec(line);
    if (m && m[2].split('/').pop() === 'pi') pids.push(Number(m[1]));
  }
  return pids;
}
/** cwds of running pi processes; undefined when the listing or any cwd lookup failed. */
export async function piCwds(): Promise<string[] | undefined> {
  try {
    const cwds = await Promise.all((await piPids()).map(cwdOf));
    return cwds.every((c): c is string => c !== undefined) ? cwds : undefined;
  } catch { return undefined; }
}
