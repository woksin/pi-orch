import { mkdtempSync, mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { atomic, Store } from '../src/lib/store.ts';
import { git, run, deliver } from '../src/lib/candidates.ts';
export function fixture() {
  const root = mkdtempSync(join(process.env.AI_WORK_OUTPUT || tmpdir(), 'orch-git-'));
  const main = join(root, 'main'), origin = join(root, 'origin.git'), home = join(root, 'home'), integration = join(root, 'integration');
  run('git', ['init', '--bare', '--initial-branch=main', origin]);
  run('git', ['init', '--initial-branch=main', main]);
  git(main, 'config', 'user.name', 'Orch test'); git(main, 'config', 'user.email', 'orch@example.invalid');
  writeFileSync(join(main, '.gitignore'), '.ai-work/\n'); writeFileSync(join(main, 'base'), 'base\n');
  git(main, 'add', '.'); git(main, 'commit', '-m', 'base'); git(main, 'remote', 'add', 'origin', origin); git(main, 'push', '-u', 'origin', 'main');
  const store = new Store(home);
  atomic(store.path('repos.json'), { Test: { slug: 'fake/Test', mainCheckout: main, integrationWorktree: integration, gateCmd: 'node --test', batch: { min: 2, max: 4, ageHours: 24 }, expressPerDay: 2, enrolled: true } });
  const gateLog = join(root, 'gate.log'), notesFile = join(root, 'notes.json');
  writeFileSync(gateLog, 'test passed\npi-phase: exit=0\n'); writeFileSync(notesFile, JSON.stringify([{ section: 'Fixed', bullets: ['A fix (#1)'] }]));
  const bin = join(root, 'bin'), ghData = join(root, 'gh-data.json'), ghCalls = join(root, 'gh-calls'); mkdirSync(bin);
  writeFileSync(ghData, JSON.stringify({ list: [], view: { number: 10, state: 'OPEN' } }));
  writeFileSync(join(bin, 'gh'), `#!/usr/bin/env node\nimport fs from 'node:fs'; const a = process.argv.slice(2); fs.appendFileSync(${JSON.stringify(ghCalls)}, JSON.stringify(a)+'\\n'); const d = JSON.parse(fs.readFileSync(${JSON.stringify(ghData)}, 'utf8')); if(d.error) { console.error(d.error); process.exit(1); } if(a[1]==='list') console.log(JSON.stringify(d.list || [])); else if(a[1]==='view') console.log(JSON.stringify(d.view)); else if(a[1]==='create') console.log('https://github.com/fake/Test/pull/10');\n`, { mode: 0o755 });
  const oldPath = process.env.PATH; process.env.PATH = `${bin}:${oldPath}`;
  const branch = (name: string, path: string, body: string, base = 'main') => {
    git(main, 'switch', '-C', name, base); writeFileSync(join(main, path), body); git(main, 'add', path); git(main, 'commit', '-m', name); return git(main, 'rev-parse', 'HEAD');
  };
  const delivery = (name: string, path = name, body = `${name}\n`, deps: string[] = [], base = 'main') => {
    branch(name, path, body, base);
    return deliver(store, { repo: 'Test', branch: name, issue: '1', notesFile, intent: 'patch', gateLog, deps });
  };
  let logCounter = 0;
  const candidateLog = (name: string) => {
    const c = store.candidate('Test', name), log = join(root, `${name}-${++logCounter}.log`);
    writeFileSync(log, `candidate ${c.headSha}\npi-phase: exit=0\n`);
    const at = new Date(Math.max(Date.now(), Date.parse(c.evidenceAfter || c.createdAt) + 1)); utimesSync(log, at, at);
    return log;
  };
  return { candidateLog, root, main, origin, store, integration, gateLog, notesFile, ghData, ghCalls, branch, delivery, restore: () => { process.env.PATH = oldPath; } };
}
