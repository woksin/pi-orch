import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { atomic } from '../src/lib/store.ts';
import { build, deliver, gate, git, land, notes, plan, push, rebuild, reconcile, sync } from '../src/lib/candidates.ts';
import { composeNotes, dependencyOrder, freezeSet } from '../src/lib/decisions.ts';
import { main } from '../src/cli/main.ts';
import { fixture } from './helpers.ts';

test('deliver validation: branch, ancestor SHA, gate log, notes, intent and owner notification', () => {
  const f = fixture(); try {
    const sha = f.branch('d-one', 'one', 'one');
    const p = { repo: 'Test', branch: 'd-one', issue: '1', notesFile: f.notesFile, intent: 'patch', gateLog: f.gateLog };
    assert.throws(() => deliver(f.store, { ...p, branch: 'missing' }), /git/);
    assert.throws(() => deliver(f.store, { ...p, intent: 'unknown' }), /intent/);
    const unrelated = f.branch('other', 'other', 'other'); assert.throws(() => deliver(f.store, { ...p, sha: unrelated }), /ancestor/);
    writeFileSync(f.gateLog, 'pi-phase: exit=1\n'); assert.throws(() => deliver(f.store, p), /exit=0/);
    writeFileSync(f.gateLog, 'pi-phase: exit=0\n'); writeFileSync(f.notesFile, '{}'); assert.throws(() => deliver(f.store, p), /notes/);
    writeFileSync(f.notesFile, '[{"section":"Fixed","bullets":["Fixed (#1)"]}]');
    const d = deliver(f.store, { ...p, sha: git(f.main, 'rev-parse', 'main') });
    assert.notEqual(d.sha, sha); assert.equal(f.store.status('Test', d.id)?.state, 'pending'); assert.equal(f.store.messages('R-Test').length, 1);
  } finally { f.restore(); }
});

test('freeze-set selection, dependency closure, batch age/max and plan', () => {
  const f = fixture(); try {
    const a = f.delivery('a'), b = f.delivery('b', 'b', 'b', [a.id]); const batch = f.store.repo('Test').batch;
    assert.deepEqual(dependencyOrder([a, b], [b.id]).map(d => d.id), [a.id, b.id]);
    assert.deepEqual(freezeSet([a], batch), []); assert.deepEqual(freezeSet([a, b], batch), [a.id, b.id]);
    assert.deepEqual(freezeSet([a, b], { ...batch, max: 1 }), [a.id]);
    assert.deepEqual(freezeSet([a], batch, Date.now() + 25 * 3600000), [a.id]);
    assert.throws(() => dependencyOrder([{ ...a, deps: [b.id] }, b], [a.id]), /cycle/);
    assert.throws(() => dependencyOrder([b], [b.id]), /missing/); assert.equal(plan(f.store, 'Test').suggested.length, 2);
  } finally { f.restore(); }
});

test('cand build deps-first merge order, conflict bounce + dependents and immutable manifest members', () => {
  const f = fixture(); try {
    const a = f.delivery('a', 'base', 'first\n'), b = f.delivery('b', 'base', 'conflict\n'), c = f.delivery('c', 'c', 'child\n', [b.id], 'b'), d = f.delivery('d');
    const candidate = build(f.store, 'Test', [c.id, b.id, a.id, d.id]);
    // b is merged before its dependent c; a then conflicts with b.
    assert.deepEqual(candidate.members, [b.id, c.id, d.id]); assert.equal(candidate.bounced[0].dId, a.id);
    assert.match(git(f.main, 'worktree', 'list', '--porcelain'), /locked/);
    assert.deepEqual(f.store.candidate('Test', candidate.name).members, candidate.members);
    const conflict = f.delivery('e', 'base', 'another\n'), dependent = f.delivery('e-child', 'e-child', 'x', [conflict.id]);
    const next = build(f.store, 'Test', [b.id, conflict.id, dependent.id]);
    assert.deepEqual(next.members, [b.id]); assert.deepEqual(next.bounced.map(b => b.dId), [conflict.id, dependent.id]);
    assert.equal(f.store.status('Test', dependent.id)?.reason, 'dependency conflict');
  } finally { f.restore(); }
});

test('sync refusal for out-of-members merge; fix sync invalidates gate; notes composition + label', () => {
  const f = fixture(); try {
    const a = f.delivery('a'), b = f.delivery('b'), c = build(f.store, 'Test', [a.id]);
    gate(f.store, 'Test', c.name, f.gateLog);
    writeFileSync(join(f.integration, 'fix'), 'fix'); git(f.integration, 'add', 'fix'); git(f.integration, 'commit', '-m', 'owner fix');
    const updated = sync(f.store, 'Test', c.name); assert.deepEqual(updated.members, [a.id]); assert.equal(updated.gateLog, undefined);
    git(f.integration, 'merge', '--no-ff', '--no-edit', b.sha); assert.throws(() => sync(f.store, 'Test', c.name), /not in members/);
    const n = notes(f.store, 'Test', c.name); assert.equal(n.label, 'release:patch'); assert.match(readFileSync(n.file, 'utf8'), /A fix \(#1\)/);
    const composed = composeNotes([{ ...a, intent: 'minor', notes: [{ section: 'Fixed', bullets: ['Fix (#2)'] }, { section: 'Added', bullets: ['Feature (#3)'] }] }]);
    assert.equal(composed.label, 'release:minor'); assert.ok(composed.body.indexOf('Added') < composed.body.indexOf('Fixed')); assert.throws(() => composeNotes([{ ...a, intent: 'major' }]), /park for woksin/);
  } finally { f.restore(); }
});

test('push/land preconditions with fake gh, once-only PR, gate head binding, reconcile idempotence', () => {
  const f = fixture(); try {
    const a = f.delivery('a'), c = build(f.store, 'Test', [a.id]);
    assert.throws(() => push(f.store, 'Test', c.name), /gate evidence/);
    gate(f.store, 'Test', c.name, f.gateLog); const pushed = push(f.store, 'Test', c.name); assert.equal(pushed.pr, 10);
    push(f.store, 'Test', c.name); assert.equal(readFileSync(f.ghCalls, 'utf8').split('\n').filter(l => l.includes('"create"')).length, 1);
    assert.throws(() => build(f.store, 'Test', [a.id]), /unlanded PR/);
    assert.throws(() => land(f.store, 'Test', c.name), /gh cache/);
    for (const change of [{ state: 'CLOSED' }, { headRefOid: 'wrong' }, { ci: 'PENDING' }]) {
      atomic(f.store.path('gh', 'Test.json'), { prs: [{ number: 10, state: 'OPEN', headRefOid: c.headSha, ci: 'SUCCESS', ...change }] }); assert.throws(() => land(f.store, 'Test', c.name), /gh cache/);
    }
    atomic(f.store.path('gh', 'Test.json'), { prs: [{ number: 10, state: 'OPEN', headRefOid: c.headSha, ci: 'SUCCESS' }] }); land(f.store, 'Test', c.name); assert.equal(f.store.status('Test', a.id)?.state, 'shipped');
    writeFileSync(f.ghData, JSON.stringify({ view: { number: 10, state: 'MERGED', mergedAt: '2026-01-01' } }));
    reconcile(f.store, 'Test'); const count = f.store.list('deliveries', 'Test').length; reconcile(f.store, 'Test'); assert.equal(f.store.list('deliveries', 'Test').length, count);
    assert.match(readFileSync(f.ghCalls, 'utf8'), /"--merge"/); assert.doesNotMatch(readFileSync(f.ghCalls, 'utf8'), /--admin|--auto/);
  } finally { f.restore(); }
});

test('rebuild drops deliveries and dependents, links replacement and closes old fake PR', () => {
  const f = fixture(); try {
    const a = f.delivery('a'), b = f.delivery('b', 'b', 'b', [a.id]), d = f.delivery('d');
    const c = build(f.store, 'Test', [a.id, b.id, d.id]); gate(f.store, 'Test', c.name, f.gateLog); push(f.store, 'Test', c.name);
    const next = rebuild(f.store, 'Test', c.name, [a.id]); assert.deepEqual(next.members, [d.id]); assert.notEqual(next.name, c.name);
    const calls = readFileSync(f.ghCalls, 'utf8'); assert.match(calls, /"close"/); assert.match(calls, /Replaced by candidate/); assert.equal(f.store.status('Test', b.id)?.state, 'bounced');
  } finally { f.restore(); }
});

test('CLI exit codes: usage, precondition, partial, nothing and success', () => {
  const f = fixture(); try {
    assert.equal(main([], f.store), 1); assert.equal(main(['cand', 'plan', '--repo', 'Missing'], f.store), 2); assert.equal(main(['cand', 'plan', '--repo', 'Test'], f.store), 4);
    const a = f.delivery('a', 'base', 'a'), b = f.delivery('b', 'base', 'b');
    assert.equal(main(['cand', 'build', '--repo', 'Test', '--ids', `${a.id},${b.id}`], f.store), 3); assert.equal(main(['board', '--json'], f.store), 0);
  } finally { f.restore(); }
});
