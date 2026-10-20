import { test } from 'node:test';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { atomic, factId, lock, Store } from '../src/lib/store.ts';

test('store atomicity + id format + immutable receipts + highest status', () => {
  const home = mkdtempSync(join(tmpdir(), 'orch-store-')); const s = new Store(home);
  const id = factId('R-Studio'); assert.match(id, /^\d{8}T\d{6}-R-Studio-[a-f0-9]{4}$/);
  const file = s.path('test.json'); atomic(file, { n: 1 }); assert.equal(atomic(file, { n: 2 }, true), false);
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { n: 1 }); atomic(file, { n: 3 });
  assert.deepEqual(readdirSync(home), ['test.json']);
  s.record('L1', id, 'delivered'); assert.equal(s.record('L1', id, 'delivered'), false);
  assert.equal(s.has('L1', id, 'delivered'), true);
  s.appendStatus('Test', id, { state: 'pending' }); s.appendStatus('Test', id, { state: 'bounced' });
  assert.equal(s.status('Test', id)?.state, 'bounced');
  assert.throws(() => s.messages('../outside'), /invalid id/);
});

test('stale locks recover dead and expired owners without an old release deleting a new lease', () => {
  const home = mkdtempSync(join(tmpdir(), 'orch-lock-')), file = join(home, 'lease.lock');
  writeFileSync(file, JSON.stringify({ pid: 2147483647, at: new Date().toISOString() }));
  const release = lock(file); assert.throws(() => lock(file), /EEXIST/);
  const old = new Date(Date.now() - 61000); utimesSync(file, old, old);
  const replacement = lock(file); release(); assert.ok(existsSync(file)); replacement(); assert.equal(existsSync(file), false);
});

test('concurrent immutable writers publish one complete fact without per-file locks', async () => {
  const home = mkdtempSync(join(tmpdir(), 'orch-race-')), file = join(home, 'fact.json');
  const source = new URL('../src/lib/store.ts', import.meta.url).href;
  const results = await Promise.all(Array.from({ length: 6 }, (_, i) => new Promise<string>((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', `import {atomic} from ${JSON.stringify(source)}; console.log(atomic(${JSON.stringify(file)}, {writer:${i}, body:'x'.repeat(10000)}, true));`]);
    let out = ''; let err = ''; child.stdout.on('data', b => out += b); child.stderr.on('data', b => err += b);
    child.on('error', reject); child.on('exit', code => code === 0 ? resolve(out.trim()) : reject(new Error(err)));
  })));
  assert.equal(results.filter(r => r === 'true').length, 1); assert.equal(JSON.parse(readFileSync(file, 'utf8')).body.length, 10000);
  assert.deepEqual(readdirSync(home), ['fact.json']);
});
