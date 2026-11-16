import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { GuardStore, emptyState } from '../src/runtime-guard-store.mjs';

const normalize = state => {
  if (state.schemaVersion !== 1 || !Number.isSafeInteger(state.revision) || state.revision < 0 || !Array.isArray(state.rules) || state.rules.length > 32 || Buffer.byteLength(JSON.stringify(state)) > 4096) throw new TypeError('invalid state');
  return state;
};
function fixture(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'guard-store-'));
  try { fn(join(dir, 'store.sqlite')); } finally { rmSync(dir, { recursive: true, force: true }); }
}

test('snapshot of absent store does not create a database', () => fixture(path => {
  const store = new GuardStore({ path, normalize });
  assert.deepEqual(store.snapshot(['a', 'b']), [emptyState(), emptyState()]);
  assert.deepEqual(store.versions(['a', 'b']), [0, 0]);
  assert.throws(() => statSync(path), { code: 'ENOENT' });
  store.close();
}));

test('two connections serialize updates and reject stale revisions', () => fixture(path => {
  const a = new GuardStore({ path, normalize });
  const b = new GuardStore({ path, normalize });
  const first = a.mutate('x', 0, state => ({ ...state, rules: ['one'] }));
  assert.equal(first.state.revision, 1);
  assert.throws(() => b.mutate('x', 0, state => state), /expected 0, actual 1/);
  assert.deepEqual(b.snapshot(['x']), [first.state]);
  assert.deepEqual(b.versions(['x', 'missing', 'x']), [1, 0, 1]);
  a.close(); b.close();
}));

test('identical rules do not increment revision; callback failures roll back', () => fixture(path => {
  const store = new GuardStore({ path, normalize });
  store.mutate('x', 0, state => ({ ...state, rules: ['one'] }));
  assert.deepEqual(store.mutate('x', 1, state => ({ ...state, revision: 99 })).changed, false);
  assert.throws(() => store.mutate('x', 1, () => { throw Error('callback'); }), /callback/);
  assert.throws(() => store.mutate('x', 1, state => ({ ...state, rules: Array(33).fill('x') })), /invalid state/);
  assert.equal(store.snapshot(['x'])[0].revision, 1);
  const inPlace = store.mutate('x', 1, state => { state.rules.push('two'); return state; });
  assert.deepEqual(inPlace, { changed: true, state: { schemaVersion: 1, revision: 2, rules: ['one', 'two'] } });
  store.close();
}));

test('an opened store disappearing is not interpreted as an empty policy', () => fixture(path => {
  const store = new GuardStore({ path, normalize });
  store.mutate('x', 0, state => ({ ...state, rules: ['one'] }));
  rmSync(path);
  assert.throws(() => store.versions(['x']), /disappeared/);
  assert.throws(() => store.snapshot(['x']), /disappeared/);
  store.close();
}));

test('unsupported schema is rejected and valid state survives reopen', () => fixture(path => {
  const store = new GuardStore({ path, normalize });
  store.mutate('x', 0, state => ({ ...state, rules: ['persisted'] }));
  store.close();
  const reopened = new GuardStore({ path, normalize });
  assert.deepEqual(reopened.snapshot(['x'])[0].rules, ['persisted']);
  reopened.close();
  const db = new DatabaseSync(path);
  db.exec('PRAGMA user_version=9');
  db.close();
  assert.throws(() => new GuardStore({ path, normalize }).snapshot(['x']), /Unsupported guard store schema version 9/);
}));
