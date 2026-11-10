import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { retireLaunchRecord, validRecord, writeLaunchRecord } from '../src/lib/lanes-record.ts';

const tmp = () => mkdtempSync(join(process.env.AI_WORK_OUTPUT || tmpdir(), 'orch-lanes-'));
const setup = (extra: Record<string, string | undefined> = {}) => {
  const lanes = tmp(), cwd = tmp();
  return { lanes, cwd, env: { PI_ORCH_ID: 'L1', LANES_DIR: lanes, ...extra } as NodeJS.ProcessEnv, file: join(lanes, '.state/roster/L1.json') };
};
const read = (file: string) => JSON.parse(readFileSync(file, 'utf8'));
const put = (file: string, text: string) => { mkdirSync(join(file, '..'), { recursive: true }); writeFileSync(file, text); };
const rec = (o: object = {}) => `${JSON.stringify({ id: 'L1', pid: 4242, cwd: '/nowhere', startedAt: '2020-01-01T00:00:00.000Z', ...o })}\n`;
const dead = { alive: () => false }, live = { alive: () => true, procs: () => undefined };
const names = (dir: string) => readdirSync(dir).sort();

test('writes the consumer-compatible single-line record', () => {
  const { env, cwd, file } = setup();
  const owned = writeLaunchRecord(env, cwd, process.pid, { now: () => new Date('2024-05-06T07:08:09.000Z') });
  assert.ok(owned);
  const text = readFileSync(file, 'utf8');
  assert.equal(text, `${JSON.stringify({ id: 'L1', pid: process.pid, cwd, startedAt: '2024-05-06T07:08:09.000Z' })}\n`);
  assert.ok(validRecord(JSON.parse(text)));
  assert.deepEqual(names(join(file, '..')), ['L1.json']);
});

test('env gating and id validation write nothing', () => {
  const ids = ['foo', 'L'.repeat(33), 'L0/../x', '', 'l1'];
  for (const id of ids) { const s = setup({ PI_ORCH_ID: id }); assert.equal(writeLaunchRecord(s.env, s.cwd, 1), undefined, id); assert.equal(existsSync(join(s.lanes, '.state')), false, id); }
  const noDir = setup({ LANES_DIR: undefined }), emptyDir = setup({ LANES_DIR: '' }), noId = setup({ PI_ORCH_ID: undefined }), optout = setup({ PI_ORCH_OPTOUT: '1' });
  for (const s of [noDir, emptyDir, noId, optout]) assert.equal(writeLaunchRecord(s.env, s.cwd, 1), undefined);
  for (const s of [noId, optout]) assert.equal(existsSync(join(s.lanes, '.state')), false);
  assert.ok(writeLaunchRecord(setup({ PI_ORCH_ID: 'ORCH-A' }).env, tmp(), 1));
});

test('symlinked or non-directory state paths are never followed', () => {
  for (const link of ['.state', '.state/roster']) {
    const { env, cwd, lanes } = setup(), target = tmp();
    if (link === '.state') symlinkSync(target, join(lanes, '.state')); else { mkdirSync(join(lanes, '.state')); symlinkSync(target, join(lanes, '.state/roster')); }
    assert.equal(writeLaunchRecord(env, cwd, 1), undefined);
    assert.deepEqual(readdirSync(target), []);
  }
  const reg = setup(); mkdirSync(join(reg.lanes, '.state')); writeFileSync(join(reg.lanes, '.state/roster'), 'x');
  assert.doesNotThrow(() => writeLaunchRecord(reg.env, reg.cwd, 1));
  assert.equal(readFileSync(join(reg.lanes, '.state/roster'), 'utf8'), 'x');
});

test('a symlinked record file is left alone', () => {
  const { env, cwd, lanes, file } = setup(), victim = join(tmp(), 'victim');
  writeFileSync(victim, 'keep'); mkdirSync(join(lanes, '.state/roster'), { recursive: true }); symlinkSync(victim, file);
  assert.equal(writeLaunchRecord(env, cwd, 1), undefined);
  assert.equal(readFileSync(victim, 'utf8'), 'keep');
});

test('a live record of another pid is never replaced or retired', () => {
  const { env, cwd, file } = setup(), text = rec({ cwd });
  put(file, text);
  assert.equal(writeLaunchRecord(env, cwd, 1, live), undefined);
  assert.equal(readFileSync(file, 'utf8'), text);
  assert.equal(retireLaunchRecord({ id: 'L1', pid: 1, path: file, dir: join(file, '..') }), false);
  assert.equal(readFileSync(file, 'utf8'), text);
});

test('a live pid in a different cwd is kept unless no pi runs there', () => {
  const { env, cwd, file } = setup(), text = rec({ cwd: '/nowhere' });
  put(file, text);
  assert.equal(writeLaunchRecord(env, cwd, 1, { alive: () => true, procs: () => ['/nowhere'] }), undefined);
  assert.equal(writeLaunchRecord(env, cwd, 1, { alive: () => true, procs: () => undefined }), undefined);
  assert.equal(readFileSync(file, 'utf8'), text);
  assert.ok(writeLaunchRecord(env, cwd, 1, { alive: () => true, procs: () => ['/elsewhere'] }));
  assert.equal(read(file).pid, 1);
});

test('a real live child pid holds the record; a reaped one does not', async () => {
  const { env, cwd, file } = setup();
  const child = spawn(process.execPath, ['-e', 'setTimeout(()=>{},30000)'], { stdio: 'ignore' });
  try {
    put(file, rec({ pid: child.pid, cwd }));
    assert.equal(writeLaunchRecord(env, cwd, process.pid), undefined);
    child.kill(); await new Promise(r => child.once('exit', r));
    assert.ok(writeLaunchRecord(env, cwd, process.pid));
    assert.equal(read(file).pid, process.pid);
  } finally { child.kill(); }
});

test('dead, retired, malformed and empty records are replaced', () => {
  const bad = ['{', '[]', '', 'null', rec({ pid: 0 }), rec({ pid: -1 }), rec({ pid: 'x' }), rec({ pid: 1.5 }), rec({ startedAt: undefined }), rec({ startedAt: 'nope' }), rec({ retiredAt: 'nope' }), rec({ cwd: 3 })];
  const cases: [string, object][] = [[rec(), dead], [rec({ retiredAt: '2021-01-01T00:00:00.000Z' }), live], ...bad.map(b => [b, live] as [string, object])];
  for (const [text, opts] of cases) {
    const { env, cwd, file } = setup(); put(file, text);
    assert.ok(writeLaunchRecord(env, cwd, 7, opts), text);
    assert.equal(read(file).pid, 7); assert.ok(validRecord(read(file))); assert.equal(read(file).retiredAt, undefined);
    assert.deepEqual(names(join(file, '..')), ['L1.json']);
  }
});

test('a live record of our own pid is not rewritten and stays ours', () => {
  const { env, cwd, file } = setup(); put(file, rec({ pid: 9, cwd }));
  utimesSync(file, 1000, 1000); const before = readFileSync(file, 'utf8');
  assert.ok(writeLaunchRecord(env, cwd, 9, live));
  assert.equal(readFileSync(file, 'utf8'), before); assert.equal(statSync(file).mtimeMs, 1000000);
});

test('retire sets retiredAt, keeps fields and is idempotent', () => {
  const { env, cwd, file } = setup(), owned = writeLaunchRecord(env, cwd, 5)!, start = read(file);
  assert.ok(retireLaunchRecord(owned, { now: () => new Date('2025-01-02T03:04:05.000Z') }));
  assert.deepEqual(read(file), { ...start, retiredAt: '2025-01-02T03:04:05.000Z' });
  assert.deepEqual(Object.keys(read(file)), ['id', 'pid', 'cwd', 'startedAt', 'retiredAt']);
  const once = readFileSync(file, 'utf8');
  assert.equal(retireLaunchRecord(owned), false); assert.equal(readFileSync(file, 'utf8'), once);
  assert.deepEqual(names(join(file, '..')), ['L1.json']);
});

test('retire leaves records that changed owner, vanished or became unsafe', () => {
  const { env, cwd, file } = setup(), owned = writeLaunchRecord(env, cwd, 5)!;
  const other = rec({ pid: 6 }); put(file, other);
  assert.equal(retireLaunchRecord(owned), false); assert.equal(readFileSync(file, 'utf8'), other);
  const gone = setup(), o2 = writeLaunchRecord(gone.env, gone.cwd, 5)!;
  const dir = join(gone.file, '..'); writeFileSync(join(dir, 'x'), ''); unlinkAll(dir);
  assert.equal(retireLaunchRecord(o2), false); assert.deepEqual(names(dir), []);
  const sl = setup(), o3 = writeLaunchRecord(sl.env, sl.cwd, 5)!, target = tmp();
  writeFileSync(join(target, 'L1.json'), rec({ pid: 5 }));
  renameSync(join(sl.lanes, '.state/roster'), join(sl.lanes, '.state/old')); symlinkSync(target, join(sl.lanes, '.state/roster'));
  assert.equal(retireLaunchRecord(o3), false); assert.equal(read(join(target, 'L1.json')).retiredAt, undefined);
});

test('output satisfies the consumer registration predicate', () => {
  const { env, cwd, file } = setup(); writeLaunchRecord(env, cwd, process.pid);
  const v = read(file);
  assert.ok(typeof v.id === 'string' && typeof v.cwd === 'string' && Number.isInteger(v.pid) && v.pid > 0 && Number.isFinite(Date.parse(v.startedAt)));
});

function unlinkAll(dir: string) { for (const n of readdirSync(dir)) rmSync(join(dir, n), { force: true }); }
