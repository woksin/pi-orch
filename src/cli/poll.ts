import { pathToFileURL } from 'node:url';
import { acquirePollLock, pollOnce } from '../lib/poller.ts';
import { Store } from '../lib/store.ts';
export function main(argv = process.argv.slice(2)): number {
  if (argv.length === 1 && argv[0] === '--help') { console.log('usage: orch-poll [--once]'); return 0; }
  if (argv.some(a => a !== '--once') || argv.length > 1) { console.error('usage: orch-poll [--once]'); return 1; }
  const store = new Store(); let release: () => void;
  try { release = acquirePollLock(store); } catch (e: any) { console.error(`orch-poll: single instance lock unavailable: ${e.message}`); return 2; }
  const tick = () => { try { const result = pollOnce(store); result.errors.forEach(e => console.error(`orch-poll: ${e}`)); return result.errors.length ? 2 : 0; } catch (e: any) { console.error(`orch-poll: ${e.message}`); return 2; } };
  if (argv.includes('--once')) { try { return tick(); } finally { release(); } }
  tick(); const timer = setInterval(tick, 120000);
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { clearInterval(timer); release(); process.exit(0); });
  return 0;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = main();
