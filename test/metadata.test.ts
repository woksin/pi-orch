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

test('process start probe is independent of the caller locale and timezone', async () => {
  const { execFileSync } = await import('node:child_process');
  const { processStart, processStartAsync } = await import('../src/lib/metadata.ts');
  const local = processStart(process.pid);
  assert.ok(local);
  assert.equal(await processStartAsync(process.pid), local);
  const script = `import { processStart } from ${JSON.stringify(new URL('../src/lib/metadata.ts', import.meta.url).href)}; process.stdout.write(processStart(${process.pid}) ?? '');`;
  const foreign = execFileSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', env: { ...process.env, LC_ALL: 'nb_NO.UTF-8', LANG: 'nb_NO.UTF-8', TZ: 'Asia/Tokyo' } });
  assert.equal(foreign, local);
});
