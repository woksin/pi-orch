import { execFile, execFileSync } from 'node:child_process';
import { canonical } from './paths.ts';
import { renewLocks } from './store.ts';
import type { Store } from './store.ts';

// Pin locale and timezone: `ps -o lstart=` output depends on both, and process-identity bindings compare it across processes
// (pi sessions in a terminal vs launchd poller) — an unpinned probe would make every live binding look reused.
export const probeEnv = () => ({ ...process.env, LC_ALL: 'C', LANG: 'C', TZ: 'UTC' });
export function probe(command: string, args: string[]): string {
  renewLocks();
  try { return execFileSync(command, args, { encoding: 'utf8', timeout: 5000, maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'], env: probeEnv() }).trim(); } catch { return ''; }
  finally { renewLocks(); }
}
export function probeAsync(command: string, args: string[]): Promise<string> {
  return new Promise(resolve => execFile(command, args, { encoding: 'utf8', timeout: 5000, maxBuffer: 1024 * 1024, env: probeEnv() }, (error, stdout) => resolve(error ? '' : stdout.trim())));
}
export const processStart = (pid: number) => probe('ps', ['-o', 'lstart=', '-p', String(pid)]) || undefined;
export const processStartAsync = async (pid: number) => await probeAsync('ps', ['-o', 'lstart=', '-p', String(pid)]) || undefined;
export function originSlug(url: string): string | undefined { return url.match(/github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?\/?$/)?.[1]; }
function details(store: Store, cwd: string, top: string, origin: string, branch: string, tty: string) {
  const slug = originSlug(origin);
  const repo = Object.entries(store.repos()).find(([, r]) => slug ? r.slug.toLowerCase() === slug.toLowerCase() : top && canonical(r.mainCheckout) === canonical(top))?.[0];
  return { cwd: canonical(cwd), tty: tty || undefined, gitToplevel: top ? canonical(top) : undefined, originSlug: slug, branch: branch || undefined, detectedRepo: repo };
}
export function inspectMetadata(store: Store, cwd: string, pid: number) {
  const top = probe('git', ['-C', cwd, 'rev-parse', '--show-toplevel']);
  return details(store, cwd, top, top ? probe('git', ['-C', cwd, 'remote', 'get-url', 'origin']) : '', top ? probe('git', ['-C', cwd, 'branch', '--show-current']) : '', probe('ps', ['-o', 'tty=', '-p', String(pid)]));
}
export function createMetadataReader(run = probeAsync, clock = Date.now) {
  const cache = new Map<string, { at: number; value: Promise<Record<string, any>> }>();
  return (store: Store, cwd: string, pid: number, wrapperPid?: number) => {
    const key = JSON.stringify([store.home, cwd, pid, wrapperPid]), previous = cache.get(key);
    if (previous && clock() - previous.at < 30000) return previous.value;
    const value = (async () => {
      const [top, tty, hostStart, scopeStart] = await Promise.all([
        run('git', ['-C', cwd, 'rev-parse', '--show-toplevel']), run('ps', ['-o', 'tty=', '-p', String(pid)]),
        run('ps', ['-o', 'lstart=', '-p', String(pid)]), wrapperPid ? run('ps', ['-o', 'lstart=', '-p', String(wrapperPid)]) : Promise.resolve(''),
      ]);
      const [origin, branch] = top ? await Promise.all([run('git', ['-C', cwd, 'remote', 'get-url', 'origin']), run('git', ['-C', cwd, 'branch', '--show-current'])]) : ['', ''];
      const start = wrapperPid ? scopeStart : hostStart;
      return { ...details(store, cwd, top, origin, branch, tty), hostStart: hostStart || undefined, processIdentity: start ? { pid: wrapperPid || pid, start } : undefined };
    })();
    if (cache.size >= 128) cache.delete(cache.keys().next().value!);
    cache.set(key, { at: clock(), value }); return value;
  };
}
export const metadata = createMetadataReader();
