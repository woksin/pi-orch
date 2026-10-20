import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { atomic, now, readJson } from '../src/lib/store.ts';
import { acquirePollLock, pollOnce, rollup } from '../src/lib/poller.ts';
import { fixture } from './helpers.ts';

test('poller rollup decisions: pending, success, failure and no checks', () => {
  assert.equal(rollup([]), 'UNKNOWN'); assert.equal(rollup([{ status: 'IN_PROGRESS' }]), 'PENDING');
  assert.equal(rollup([{ conclusion: 'SUCCESS' }, { state: 'SUCCESS' }, { conclusion: 'SKIPPED' }]), 'SUCCESS');
  assert.equal(rollup([{ conclusion: 'SUCCESS' }, { conclusion: 'FAILURE' }]), 'FAILURE');
});

test('poller transitions + closed PR view + escalation + stale digest + rate backoff + single instance', () => {
  const f = fixture(); try {
    const s = f.store, time = Date.now();
    s.saveCandidate({ name: 'Test-poll', repo: 'Test', branch: 'cand/Test-poll', base: 'base', headSha: 'head', createdAt: now(), members: [], bounced: [], express: false, pr: 10 });
    const release = acquirePollLock(s); assert.throws(() => acquirePollLock(s), /EEXIST/); release(); const again = acquirePollLock(s); again();
    const pr = { number: 10, headRefName: 'cand/Test-poll', headRefOid: 'head', statusCheckRollup: [{ conclusion: 'SUCCESS' }] };
    writeFileSync(f.ghData, JSON.stringify({ list: [pr] })); assert.deepEqual(pollOnce(s, time).errors, []);
    assert.equal(s.messages('R-Test').filter(m => m.kind === 'ci').length, 1); pollOnce(s, time + 120000); assert.equal(s.messages('R-Test').length, 1);
    writeFileSync(f.ghData, JSON.stringify({ list: [{ ...pr, statusCheckRollup: [{ conclusion: 'FAILURE' }] }] })); pollOnce(s, time + 240000); assert.equal(s.messages('R-Test').length, 2);
    writeFileSync(f.ghData, JSON.stringify({ list: [], view: { ...pr, state: 'MERGED' } })); pollOnce(s, time + 360000); assert.equal(s.messages('R-Test').length, 3);
    const viewCalls = readFileSync(f.ghCalls, 'utf8').split('\n').filter(l => l.includes('"view"')).length; pollOnce(s, time + 480000); assert.equal(readFileSync(f.ghCalls, 'utf8').split('\n').filter(l => l.includes('"view"')).length, viewCalls);
    const [m] = s.send({ from: 'L0', to: 'L1', kind: 'order', subject: 'late', body: 'work', requiresAck: true, ackDeadlineMin: 1 });
    const [acked] = s.send({ from: 'L0', to: 'L2', kind: 'order', subject: 'acked', body: 'work', requiresAck: true, ackDeadlineMin: 1 }); s.record('L2', acked.id, 'acked');
    const [declined] = s.send({ from: 'L0', to: 'L3', kind: 'order', subject: 'declined', body: 'work', requiresAck: true, ackDeadlineMin: 1 }); s.record('L3', declined.id, 'declined');
    atomic(s.path('heartbeats', 'L1.json'), { id: 'L1', at: new Date(time - 700000).toISOString(), pid: process.pid });
    pollOnce(s, time + 17 * 60000); assert.ok(s.has('L1', m.id, 'escalated')); assert.equal(s.messages('L0').length, 2);
    pollOnce(s, time + 18 * 60000); assert.equal(s.messages('L0').length, 2); pollOnce(s, time + 48 * 60000); assert.equal(s.messages('L0').length, 3);
    writeFileSync(f.ghData, JSON.stringify({ error: 'HTTP 429 too many requests' })); assert.equal(pollOnce(s, time + 49 * 60000).errors.length, 1);
    const count = readFileSync(f.ghCalls, 'utf8').split('\n').length; pollOnce(s, time + 50 * 60000); assert.equal(readFileSync(f.ghCalls, 'utf8').split('\n').length, count);
    assert.equal(readJson<any>(s.path('poller-state.json')).backoff.Test, time + 59 * 60000);
  } finally { f.restore(); }
});
