import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
function workspace() {
  const output = process.env.AI_WORK_OUTPUT || join(root, '.ai-work');
  mkdirSync(output, { recursive: true });
  return mkdtempSync(join(output, 'orch-package-'));
}
function run(command: string, args: string[], env = process.env) {
  const result = spawnSync(command, args, { cwd: root, env, encoding: 'utf8', timeout: 20000 });
  assert.equal(result.error, undefined, `${command}: ${result.error}`);
  assert.equal(result.status, 0, `${command} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
  return result.stdout;
}
function help(bin: string, home: string) {
  // No PATH node: both launchers must honor ORCH_NODE, including via npm's symlinks.
  const env = { ...process.env, PATH: '/usr/bin:/bin', ORCH_NODE: process.execPath, ORCH_HOME: home };
  for (const name of ['orch', 'orch-poll']) assert.match(run(join(bin, name), ['--help'], env), new RegExp(`usage: ${name} `));
}

test('packed CLIs run as JavaScript from a global node_modules install', () => {
  const temp = workspace();
  try {
    mkdirSync(join(root, 'dist'), { recursive: true });
    writeFileSync(join(root, 'dist', 'stale-package-test.js'), 'throw new Error("stale build");\n');
    run('npm', ['pack', '--pack-destination', temp]);
    assert.equal(existsSync(join(root, 'dist')), false, 'postpack must remove checkout dist');
    const tarballs = readdirSync(temp).filter(name => name.endsWith('.tgz'));
    assert.equal(tarballs.length, 1);
    const prefix = join(temp, 'prefix with spaces');
    // The CLI graph needs no peers. Do not fetch pi or run dependency scripts for this smoke test.
    run('npm', ['install', '--global', '--prefix', prefix, '--ignore-scripts', '--legacy-peer-deps', '--no-audit', '--no-fund', join(temp, tarballs[0])]);
    const installed = join(prefix, 'lib/node_modules/@woksin/pi-orch');
    for (const entry of ['cli/main.js', 'cli/poll.js', 'lib/store.js']) assert.ok(existsSync(join(installed, 'dist', entry)), entry);
    assert.equal(existsSync(join(installed, 'dist', 'stale-package-test.js')), false, 'prepack must clear stale output');
    const extension = 'src/extension/lane-bus.ts';
    assert.equal(readFileSync(join(installed, extension), 'utf8'), readFileSync(join(root, extension), 'utf8'));
    help(join(prefix, 'bin'), join(temp, 'home'));
  } finally { rmSync(temp, { recursive: true, force: true }); }
});

test('symlinked checkout launchers run source even when stale dist exists', () => {
  const temp = workspace();
  try {
    const checkout = join(temp, 'checkout-node_modules-suffix'), bin = join(temp, 'bin');
    mkdirSync(checkout); mkdirSync(bin);
    for (const name of ['src', 'bin', 'package.json']) cpSync(join(root, name), join(checkout, name), { recursive: true });
    for (const name of ['orch', 'orch-poll']) symlinkSync(join(checkout, 'bin', name), join(bin, name));
    help(bin, join(temp, 'home'));
    mkdirSync(join(checkout, 'dist', 'cli'), { recursive: true });
    for (const entry of ['main.js', 'poll.js']) writeFileSync(join(checkout, 'dist', 'cli', entry), 'throw new Error("stale build");\n');
    help(bin, join(temp, 'home'));
  } finally { rmSync(temp, { recursive: true, force: true }); }
});
