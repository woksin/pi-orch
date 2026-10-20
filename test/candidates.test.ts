import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { atomic, now } from '../src/lib/store.ts';
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
    gate(f.store, 'Test', c.name, f.candidateLog(c.name));
    writeFileSync(join(f.integration, 'fix'), 'fix'); git(f.integration, 'add', 'fix'); git(f.integration, 'commit', '-m', 'owner fix');
    const updated = sync(f.store, 'Test', c.name); assert.deepEqual(updated.members, [a.id]); assert.equal(updated.gateLog, undefined);
    git(f.integration, 'merge', '--no-ff', '--no-edit', b.sha); assert.throws(() => sync(f.store, 'Test', c.name), /not in members/);
    const n = notes(f.store, 'Test', c.name); assert.equal(n.label, 'patch'); assert.match(readFileSync(n.file, 'utf8'), /A fix \(#1\)/);
    const composed = composeNotes([{ ...a, intent: 'minor', notes: [{ section: 'Fixed', bullets: ['Fix (#2)'] }, { section: 'Added', bullets: ['Feature (#3)'] }] }]);
    assert.equal(composed.label, 'minor'); assert.ok(composed.body.indexOf('Added') < composed.body.indexOf('Fixed')); assert.throws(() => composeNotes([{ ...a, intent: 'major' }]), /park for woksin/);
  } finally { f.restore(); }
});

test('push/land preconditions with fake gh, once-only PR, gate head binding, reconcile idempotence', () => {
  const f = fixture(); try {
    const a = f.delivery('a'), c = build(f.store, 'Test', [a.id]);
    assert.throws(() => push(f.store, 'Test', c.name), /gate evidence/);
    gate(f.store, 'Test', c.name, f.candidateLog(c.name)); const pushed = push(f.store, 'Test', c.name); assert.equal(pushed.pr, 10);
    push(f.store, 'Test', c.name); assert.equal(readFileSync(f.ghCalls, 'utf8').split('\n').filter(l => l.includes('"create"')).length, 1);
    assert.throws(() => build(f.store, 'Test', [a.id]), /unlanded PR/);
    assert.throws(() => land(f.store, 'Test', c.name), /gh cache/);
    for (const change of [{ state: 'CLOSED' }, { headRefOid: 'wrong' }, { ci: 'PENDING' }]) {
      atomic(f.store.path('gh', 'Test.json'), { at: now(), prs: [{ number: 10, isDraft: false, labels: [{ name: 'patch' }], state: 'OPEN', headRefOid: c.headSha, ci: 'SUCCESS', ...change }] }); assert.throws(() => land(f.store, 'Test', c.name), /gh cache/);
    }
    atomic(f.store.path('gh', 'Test.json'), { at: now(), prs: [{ number: 10, isDraft: false, labels: [{ name: 'patch' }], state: 'OPEN', headRefOid: c.headSha, ci: 'SUCCESS' }] }); land(f.store, 'Test', c.name); assert.equal(f.store.status('Test', a.id)?.state, 'shipped');
    writeFileSync(f.ghData, JSON.stringify({ view: { number: 10, state: 'MERGED', mergedAt: '2026-01-01' } }));
    reconcile(f.store, 'Test'); const count = f.store.list('deliveries', 'Test').length; reconcile(f.store, 'Test'); assert.equal(f.store.list('deliveries', 'Test').length, count);
    assert.match(readFileSync(f.ghCalls, 'utf8'), /"--merge"/); assert.doesNotMatch(readFileSync(f.ghCalls, 'utf8'), /--admin|--auto/);
  } finally { f.restore(); }
});

test('rebuild drops deliveries and dependents, links replacement and closes old fake PR', () => {
  const f = fixture(); try {
    const a = f.delivery('a'), b = f.delivery('b', 'b', 'b', [a.id]), d = f.delivery('d');
    const c = build(f.store, 'Test', [a.id, b.id, d.id]); gate(f.store, 'Test', c.name, f.candidateLog(c.name)); push(f.store, 'Test', c.name);
    const next = rebuild(f.store, 'Test', c.name, [a.id]); assert.deepEqual(next.members, [d.id]); assert.notEqual(next.name, c.name);
    const calls = readFileSync(f.ghCalls, 'utf8'); assert.match(calls, /"close"/); assert.match(calls, /Replaced by candidate/); assert.equal(f.store.status('Test', b.id)?.state, 'bounced');
    assert.throws(() => rebuild(f.store, 'Test', c.name, [a.id]), /already superseded/);
  } finally { f.restore(); }
});

test('CLI exit codes: usage, precondition, partial, nothing and success', () => {
  const f = fixture(); try {
    assert.equal(main([], f.store), 1); assert.equal(main(['cand', 'plan', '--repo', 'Missing'], f.store), 2); assert.equal(main(['cand', 'plan', '--repo', 'Test'], f.store), 4);
    const a = f.delivery('a', 'base', 'a'), b = f.delivery('b', 'base', 'b');
    assert.equal(main(['cand', 'build', '--repo', 'Test', '--ids', `${a.id},${b.id}`], f.store), 3); assert.equal(main(['board', '--json'], f.store), 0);
  } finally { f.restore(); }
});

test('build dependency precondition and express quota use separate locked worktree', () => {
  const f = fixture(); try {
    const a = f.delivery('a'), b = f.delivery('b', 'b', 'b', [a.id]);
    assert.throws(() => build(f.store, 'Test', [b.id]), /dependency closure/);
    const first = build(f.store, 'Test', [a.id], true); assert.ok(first.express);
    assert.match(git(`${f.integration}-express`, 'branch', '--show-current'), /^cand\//);
    build(f.store, 'Test', [a.id, b.id], true);
    assert.throws(() => build(f.store, 'Test', [a.id], true), /expressPerDay/);
  } finally { f.restore(); }
});

test('reconcile repairs interrupted PR recording and closed status, without duplicate events', () => {
  const f = fixture(); try {
    const a = f.delivery('a'), c = build(f.store, 'Test', [a.id]);
    writeFileSync(f.ghData, JSON.stringify({ list: [{ number: 10, state: 'OPEN', headRefOid: c.headSha }] }));
    reconcile(f.store, 'Test'); assert.equal(f.store.candidate('Test', c.name).pr, 10); assert.equal(f.store.status('Test', a.id)?.state, 'in-cand');
    writeFileSync(f.ghData, JSON.stringify({ view: { number: 10, state: 'CLOSED', headRefOid: c.headSha } }));
    reconcile(f.store, 'Test'); assert.equal(f.store.status('Test', a.id)?.state, 'pending');
    const count = f.store.list('deliveries', 'Test').length; reconcile(f.store, 'Test'); assert.equal(f.store.list('deliveries', 'Test').length, count);
  } finally { f.restore(); }
});

test('push refuses a changed branch head until sync and a new gate', () => {
  const f = fixture(); try {
    const a = f.delivery('a'), c = build(f.store, 'Test', [a.id]); gate(f.store, 'Test', c.name, f.candidateLog(c.name));
    writeFileSync(join(f.integration, 'owner'), 'fix'); git(f.integration, 'add', 'owner'); git(f.integration, 'commit', '-m', 'owner fix');
    assert.throws(() => push(f.store, 'Test', c.name), /branch head/);
    sync(f.store, 'Test', c.name); assert.throws(() => push(f.store, 'Test', c.name), /gate evidence/);
    gate(f.store, 'Test', c.name, f.candidateLog(c.name)); assert.equal(push(f.store, 'Test', c.name).pr, 10);
  } finally { f.restore(); }
});


test('Cratis labels and PR body preserve bare issue refs and reject closing syntax', () => {
  const f = fixture(); try {
    const a = f.delivery('a');
    for (const intent of ['patch', 'minor', 'no-release']) assert.equal(composeNotes([{ ...a, intent }]).label, intent);
    for (const bullet of ['Closes #1', 'Fixes #1 (#1)', 'Refs #1 (#1)', 'Missing reference', 'A (#1)\n## Surprise']) {
      writeFileSync(f.notesFile, JSON.stringify([{ section: 'Fixed', bullets: [bullet] }]));
      assert.throws(() => deliver(f.store, { repo: 'Test', branch: 'a', issue: '1', notesFile: f.notesFile, intent: 'patch', gateLog: f.gateLog }), /bare/);
    }
  } finally { f.restore(); }
});

test('gate refuses delivery/old logs, invalidates on sync, and detects changed evidence', () => {
  const f = fixture(); try {
    const a = f.delivery('a'), c = build(f.store, 'Test', [a.id]);
    assert.throws(() => gate(f.store, 'Test', c.name, f.gateLog), /already used/);
    const old = f.candidateLog(c.name); const past = new Date(Date.parse(c.evidenceAfter!) - 1000); utimesSync(old, past, past);
    assert.throws(() => gate(f.store, 'Test', c.name, old), /newer/);
    const log = f.candidateLog(c.name); gate(f.store, 'Test', c.name, log); sync(f.store, 'Test', c.name);
    assert.throws(() => gate(f.store, 'Test', c.name, log), /already used/);
    const fresh = f.candidateLog(c.name); gate(f.store, 'Test', c.name, fresh); writeFileSync(fresh, 'changed\npi-phase: exit=0\n');
    assert.throws(() => push(f.store, 'Test', c.name), /evidence changed/); assert.throws(() => land(f.store, 'Test', c.name), /evidence changed/);
  } finally { f.restore(); }
});

test('land refuses stale cache, draft, major, missing gate; merge is SHA-pinned', () => {
  const f = fixture(); try {
    const a = f.delivery('a'), c = build(f.store, 'Test', [a.id]);
    const cached = (extra: any = {}, at = now()) => atomic(f.store.path('gh', 'Test.json'), { at, prs: [{ number: 10, state: 'OPEN', headRefOid: c.headSha, ci: 'SUCCESS', isDraft: false, labels: [{ name: 'patch' }], ...extra }] });
    cached(); assert.throws(() => land(f.store, 'Test', c.name), /gate evidence/);
    gate(f.store, 'Test', c.name, f.candidateLog(c.name)); push(f.store, 'Test', c.name);
    cached({}, new Date(Date.now() - 301000).toISOString()); assert.throws(() => land(f.store, 'Test', c.name), /stale/);
    for (const extra of [{ isDraft: true }, { labels: [{ name: 'major' }] }, { labels: undefined }]) { cached(extra); assert.throws(() => land(f.store, 'Test', c.name), /draft or major/); }
    cached(); land(f.store, 'Test', c.name);
    const calls = readFileSync(f.ghCalls, 'utf8').trim().split('\n').map(l => JSON.parse(l));
    assert.deepEqual(calls.find(a => a[1] === 'merge'), ['pr', 'merge', '10', '--merge', '--match-head-commit', c.headSha, '--repo', 'fake/Test']);
    const create = calls.find(a => a[1] === 'create'); assert.equal(create[create.indexOf('--label') + 1], 'patch'); assert.equal(create[create.indexOf('--assignee') + 1], 'woksin'); assert.ok(!create.includes('--reviewer'));
  } finally { f.restore(); }
});

test('worktree comparison canonicalizes symlinks, trailing slashes and macOS /var aliases', () => {
  const f = fixture(); try {
    const alias = join(mkdtempSync(join(tmpdir(), 'orch-worktree-alias-')), 'alias'); symlinkSync(f.root, alias);
    const repos = f.store.repos(); repos.Test.integrationWorktree = join(alias, 'integration') + '/'; repos.Test.mainCheckout = join(alias, 'main') + '/'; atomic(f.store.path('repos.json'), repos);
    const a = f.delivery('a'); assert.deepEqual(build(f.store, 'Test', [a.id]).members, [a.id]);
  } finally { f.restore(); }
});

test('reconcile reconstructs unknown cand branches excluding baseline/shipped deliveries', () => {
  const f = fixture(); try {
    const shipped = f.delivery('shipped'); git(f.main, 'switch', 'main'); git(f.main, 'merge', '--no-ff', '--no-edit', shipped.sha); git(f.main, 'push', 'origin', 'main');
    f.store.appendStatus('Test', shipped.id, { state: 'shipped' });
    const a = f.delivery('a'), c = build(f.store, 'Test', [a.id]); unlinkSync(f.store.path('cands', 'Test', `${c.name}.json`));
    reconcile(f.store, 'Test'); assert.deepEqual(f.store.candidate('Test', c.name).members, [a.id]);
    const before = JSON.stringify(f.store.list('deliveries', 'Test')); reconcile(f.store, 'Test'); assert.equal(JSON.stringify(f.store.list('deliveries', 'Test')), before);
  } finally { f.restore(); }
});

test('rebuild merged candidates is refused; in-cand members cannot enter an express batch', () => {
  const f = fixture(); try {
    const a = f.delivery('a'), b = f.delivery('b'), c = build(f.store, 'Test', [a.id, b.id]); gate(f.store, 'Test', c.name, f.candidateLog(c.name)); push(f.store, 'Test', c.name);
    assert.throws(() => build(f.store, 'Test', [a.id], true), /another candidate/);
    writeFileSync(f.ghData, JSON.stringify({ view: { number: 10, state: 'MERGED' } })); assert.throws(() => rebuild(f.store, 'Test', c.name, [a.id]), /merged candidate/);
  } finally { f.restore(); }
});
