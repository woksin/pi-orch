import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { board, boardMarkdown } from '../lib/status.ts';
import { key, lock, Store } from '../lib/store.ts';
import { build, deliver, gate, land, notes, OrchError, plan, push, rebuild, reconcile, sync } from '../lib/candidates.ts';

const allowed: Record<string, string[]> = {
  send: ['kind', 'subject', 'ack', 'deadline', 'repo', 'blocks', 'body-file'], board: ['json'], deliver: ['repo', 'branch', 'issue', 'notes-file', 'intent', 'gate-log', 'sha', 'deps', 'paths'],
  plan: ['repo'], build: ['repo', 'ids', 'express'], sync: ['repo', 'cand'], gate: ['repo', 'cand', 'log'], notes: ['repo', 'cand'], push: ['repo', 'cand'], land: ['repo', 'cand'], rebuild: ['repo', 'cand', 'drop'], reconcile: ['repo'],
};
function parse(args: string[], command: string) {
  const flags: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const flag = args[i].replace(/^--/, '');
    if (!args[i].startsWith('--') || !allowed[command]?.includes(flag) || flag in flags) throw new OrchError(`invalid option: ${args[i]}`, 1);
    if (['ack', 'json', 'express'].includes(flag)) flags[flag] = 'true';
    else {
      if (!args[i + 1] || args[i + 1].startsWith('--')) throw new OrchError(`missing value: --${flag}`, 1);
      flags[flag] = args[++i];
      if (flag === 'paths') while (args[i + 1] && !args[i + 1].startsWith('--')) flags[flag] += `,${args[++i]}`;
    }
  }
  return flags;
}
export function main(argv = process.argv.slice(2), store = new Store()): number {
  try {
    let [command, ...args] = argv;
    if (command === 'cand') { command = args.shift()!; if (!['plan', 'build', 'sync', 'gate', 'notes', 'push', 'land', 'rebuild'].includes(command)) throw new OrchError('usage: orch cand plan|build|sync|gate|notes|push|land|rebuild', 1); }
    else if (!['send', 'board', 'deliver', 'reconcile'].includes(command)) throw new OrchError('usage: orch send|board|deliver|cand|reconcile', 1);
    const to = command === 'send' ? args.shift() : undefined;
    const f = parse(args, command);
    const need = (name: string) => { if (!f[name]) throw new OrchError(`required: --${name}`, 1); return f[name]; };
    const csv = (name: string) => f[name]?.split(',').filter(Boolean) || [];
    let data: unknown;
    if (command === 'send') {
      if (!to || to.startsWith('--')) throw new OrchError('required: recipient', 1);
      data = store.send({ to, from: process.env.PI_ORCH_ID || 'L0', kind: need('kind'), subject: need('subject'), body: readFileSync(f['body-file'] || 0, 'utf8'), requiresAck: !!f.ack, ackDeadlineMin: Number(f.deadline || 30), ...(f.repo ? { repo: f.repo } : {}), ...(f.blocks ? { blocks: csv('blocks') as any } : {}) });
    } else if (command === 'board') { const b = board(store); console.log(f.json ? JSON.stringify(b, null, 2) : boardMarkdown(b)); return 0; }
    else {
      const repo = need('repo'); key(repo); store.repo(repo);
      const release = lock(store.path('locks', `${repo}.lock`));
      try {
        switch (command) {
          case 'deliver': data = deliver(store, { repo, branch: need('branch'), issue: need('issue'), notesFile: need('notes-file'), intent: need('intent'), gateLog: need('gate-log'), sha: f.sha, deps: csv('deps'), paths: csv('paths') }); break;
          case 'plan': data = plan(store, repo); if (!(data as any).pending.length) { console.log(JSON.stringify(data)); return 4; } break;
          case 'build': data = build(store, repo, need('ids').split(','), !!f.express); console.log(`Gate command (run with job_start/pi-phase): ${store.repo(repo).gateCmd}`); break;
          case 'sync': data = sync(store, repo, need('cand')); break;
          case 'gate': data = gate(store, repo, need('cand'), need('log')); break;
          case 'notes': data = notes(store, repo, need('cand')); console.log((data as any).label); break;
          case 'push': data = push(store, repo, need('cand')); break;
          case 'land': data = land(store, repo, need('cand')); break;
          case 'rebuild': data = rebuild(store, repo, need('cand'), need('drop').split(',')); break;
          case 'reconcile': data = reconcile(store, repo); break;
        }
      } finally { release(); }
    }
    console.log(JSON.stringify(data, null, 2));
    return (data as any)?.bounced?.length ? 3 : Array.isArray(data) && !data.length ? 4 : 0;
  } catch (error: any) { console.error(`orch: ${error.message}`); return error instanceof OrchError ? error.code : 2; }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = main();
