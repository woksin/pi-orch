import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMetadataReader } from '../src/lib/metadata.ts';
import { fixture } from './helpers.ts';

test('B1: async metadata coalesces probes, caches new/resume reads, and refreshes after TTL', async () => {
  const f = fixture(); let calls = 0, time = 0;
  try {
    const read = createMetadataReader(async (command, args) => { calls++; if (args.includes('--show-toplevel')) return f.main; if (args.includes('get-url')) return 'git@github.com:fake/Test.git'; if (args.includes('--show-current')) return 'd/task'; return command === 'ps' ? '2020-01-01T00:00:00.000Z' : ''; }, () => time);
    const first = read(f.store, f.main, 1), second = read(f.store, f.main, 1); assert.equal(first, second);
    const info = await first; assert.equal(info.detectedRepo, 'Test'); assert.equal(info.processIdentity.pid, 1); const count = calls;
    await read(f.store, f.main, 1); assert.equal(calls, count); time += 30001; await read(f.store, f.main, 1); assert.ok(calls > count);
  } finally { f.restore(); }
});
