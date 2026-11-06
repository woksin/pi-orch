import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nativeBusFixture } from './bus-harness.ts';

for (const id of ['L0', 'R-Test', 'L1']) for (const interactive of [undefined, '1']) {
  test(`SDK 1.3: ${id}/${interactive || 'ordinary'} FYI survives shutdown and enters one real run`, async () => {
    const first = await nativeBusFixture({ id, interactive });
    const m = first.send('info', 'durable FYI sentinel');
    try {
      await first.tick(); await first.tick(); assert.equal(first.requests.length, 0);
      assert.equal(first.store.has(id, m.id, 'delivered'), false);
    } finally { await first.shutdown(); }
    const h = await nativeBusFixture({ id, interactive, root: first.root });
    try {
      await h.tick(); assert.equal(h.requests.length, 0);
      await h.session.prompt('legitimate user turn');
      assert.equal(h.requests.length, 1); assert.match(h.requests[0], /durable FYI sentinel body/);
      assert.ok(h.store.has(id, m.id, 'delivered')); assert.equal(h.store.has(id, m.id, 'acked'), false);
      const contexts = () => h.session.sessionManager.getEntries().filter((e: any) => e.type === 'custom_message' && e.customType === 'orch-maintenance');
      assert.equal(contexts().length, 1); assert.equal((contexts()[0] as any).display, false);
      assert.match((contexts()[0] as any).content, /Orch role/);
      await h.session.prompt('another real turn'); assert.equal(contexts().length, 1); assert.equal(h.requests.length, 2);
      assert.deepEqual(h.errors, []);
    } finally { await h.shutdown(); }
    for (const f of [first, h]) { assert.equal(f.cleared.length, f.intervals.length); assert.ok(f.watches.every(w => w.closed)); }
  });
}

test('SDK idle actionable burst makes one provider request containing all IDs', async () => {
  const h = await nativeBusFixture();
  try {
    const items = ['ci', 'report', 'idle'].map(kind => h.send(kind, `native ${kind}`));
    await h.tick(); assert.equal(h.requests.length, 1);
    items.forEach(m => { assert.ok(h.requests[0].includes(m.id)); assert.ok(h.store.has('L1', m.id, 'delivered')); });
    await h.tick(); assert.equal(h.requests.length, 1); assert.deepEqual(h.errors, []);
  } finally { await h.shutdown(); }
});

test('SDK busy urgent steering is visible at the next model boundary', async () => {
  const h = await nativeBusFixture({ holdFirst: true });
  try {
    const running = h.session.prompt('original run');
    await Promise.race([h.boundary, running.then(() => { throw new Error(`tool boundary was not reached: ${JSON.stringify(h.session.messages)}`); })]);
    const m = h.send('question', 'urgent boundary sentinel'); h.scan();
    assert.ok(h.store.has('L1', m.id, 'delivered')); assert.equal(h.requests.length, 1);
    h.release(); await running; await h.settle();
    assert.equal(h.requests.length, 2); assert.match(h.requests[1], /urgent boundary sentinel body/); assert.ok(h.requests[1].includes(m.id));
    await h.tick(); assert.equal(h.requests.length, 2); assert.deepEqual(h.errors, []);
  } finally { await h.shutdown(); }
});

test('SDK busy FYI neither queues nor extends a run and waits for a new legitimate run', async () => {
  const h = await nativeBusFixture({ holdFirst: true });
  try {
    const running = h.session.prompt('working');
    await Promise.race([h.boundary, running.then(() => { throw new Error('tool boundary was not reached'); })]);
    const m = h.send('info', 'busy receipt sentinel'); h.scan();
    assert.equal(h.store.has('L1', m.id, 'delivered'), false); assert.equal(h.requests.length, 1);
    h.release(); await running; await h.settle(); assert.equal(h.requests.length, 2); assert.doesNotMatch(h.requests[1], /busy receipt sentinel/);
    await h.session.prompt('next legitimate run'); assert.equal(h.requests.length, 3); assert.match(h.requests[2], /busy receipt sentinel body/);
    assert.ok(h.store.has('L1', m.id, 'delivered')); assert.deepEqual(h.errors, []);
  } finally { await h.shutdown(); }
});

test('SDK abort/shutdown never replays claimed waking batches', async () => {
  const h = await nativeBusFixture({ holdFirst: true });
  const items = [h.send('order', 'abort batch A', true), h.send('report', 'abort batch B')];
  try {
    h.scan(); await Promise.race([h.boundary, h.settle().then(() => { throw new Error(`tool boundary was not reached: ${JSON.stringify(h.session.messages)}`); })]); await h.session.abort(); await h.settle();
    const count = h.requests.length; await h.tick(); assert.equal(h.requests.length, count);
    items.forEach(m => assert.ok(h.store.has('L1', m.id, 'delivered')));
  } finally { await h.shutdown(); }
  const next = await nativeBusFixture({ root: h.root });
  try { await next.tick(); assert.equal(next.requests.length, 0); } finally { await next.shutdown(); }
  for (const f of [h, next]) { assert.equal(f.cleared.length, f.intervals.length); assert.ok(f.watches.every(w => w.closed)); }
});
