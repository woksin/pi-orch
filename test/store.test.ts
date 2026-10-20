import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { atomic, factId, Store } from '../src/lib/store.ts';

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
