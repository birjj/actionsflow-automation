import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluate, validateSnapshot } from '../engine/diff.ts';
import type { Data, Item, Options, State, WatchEvent } from '../engine/types.ts';

const snap = <DataType extends Data>(items: Item<DataType>[], complete = true) => ({ complete, items });
function item(id: string): Item<Record<string, unknown>>;
function item<DataType extends Data>(id: string, data: DataType, title?: string): Item<DataType>;
function item<DataType extends Data = Data>(id: string, data: DataType = {} as DataType, title: string = id): Item<DataType> {
  return { id, title, url: `https://x/${id}`, data };
}
const run = <DataType extends Data>(state: State<DataType> | null, snapshot: ReturnType<typeof snap>, options?: Options) =>
  evaluate({ key: 't', state, snapshot, options, now: new Date('2026-01-01') });
const stateOf = <DataType extends Data>(items: Item<DataType>[]): State<DataType> => run<DataType>(null, snap(items)).state;

/** The event at `index`, narrowed to its type (fails the test if absent or of another type). */
function ofType<T extends WatchEvent['type']>(events: WatchEvent[], type: T, index = 0): Extract<WatchEvent, { type: T }> {
  const e = events[index];
  assert.ok(e, `expected an event at index ${index}, got ${events.length} event(s)`);
  assert.equal(e.type, type);
  return e as Extract<WatchEvent, { type: T }>;
}

test('first run baselines silently by default', () => {
  const r = run(null, snap([item('a'), item('b')]));
  assert.equal(r.isBaseline, true);
  assert.deepEqual(r.events, []);
  assert.deepEqual(Object.keys(r.state.items), ['a', 'b']);
  assert.equal(r.persist, true);
});

test('first run can emit everything as added', () => {
  const r = run(null, snap([item('a'), item('b')]), { firstRun: 'emit' });
  assert.deepEqual(r.events.map((e) => e.type), ['added', 'added']);
});

test('first run with an incomplete snapshot does not persist a baseline', () => {
  const r = run(null, snap([item('a')], false));
  assert.equal(r.persist, false);
});

test('added events carry key, id, title, url, data, summary', () => {
  const state = stateOf([item('a')]);
  const e = ofType(run(state, snap([item('a'), item('b', { age: 3 }, 'Mimi')])).events, 'added');
  assert.equal(e.key, 't');
  assert.equal(e.id, 'b');
  assert.equal(e.title, 'Mimi');
  assert.equal(e.url, 'https://x/b');
  assert.deepEqual(e.data, { age: 3 });
  assert.equal(e.summary, 'Mimi appeared');
});

test('unchanged snapshot produces no events', () => {
  const items = [item('a', { s: 1 })];
  assert.deepEqual(run(stateOf(items), snap(items), { changed: ['*'], removed: true }).events, []);
});

test('watch-added can be disabled', () => {
  const state = stateOf([item('a')]);
  assert.deepEqual(run(state, snap([item('a'), item('b')]), { added: false }).events, []);
});

test('changed: specific path only fires for that path', () => {
  const state = stateOf([item('svc', { status: 'up', latency: 10 })]);
  const none = run(state, snap([item('svc', { status: 'up', latency: 99 })]), { changed: ['status'] });
  assert.deepEqual(none.events, []);
  const e = ofType(run(state, snap([item('svc', { status: 'down', latency: 99 })]), { changed: ['status'] }).events, 'changed');
  assert.deepEqual(e.changes, [{ path: 'status', from: 'up', to: 'down' }]);
  assert.deepEqual(e.before, { status: 'up', latency: 10 });
  assert.deepEqual(e.data, { status: 'down', latency: 99 });
  assert.equal(e.summary, 'svc: status: up → down');
});

test('changed: nested paths and "*" wildcard', () => {
  const state = stateOf([item('a', { addr: { city: 'X', zip: '1' }, tags: ['a'] })]);
  const next = snap([item('a', { addr: { city: 'Y', zip: '1' }, tags: ['a', 'b'] })]);
  const nested = ofType(run(state, next, { changed: ['addr.city'] }).events, 'changed');
  assert.deepEqual(nested.changes, [{ path: 'addr.city', from: 'X', to: 'Y' }]);
  const all = ofType(run(state, next, { changed: ['*'] }).events, 'changed');
  assert.deepEqual(all.changes.map((c) => c.path).sort(), ['addr.city', 'tags']);
});

test('ignore removes volatile fields (also under *, and as a prefix)', () => {
  const state = stateOf([item('a', { status: 'up', meta: { fetched_at: 1 } })]);
  const next = snap([item('a', { status: 'up', meta: { fetched_at: 2 } })]);
  assert.equal(run(state, next, { changed: ['*'] }).events.length, 1);
  assert.equal(run(state, next, { changed: ['*'], ignore: ['meta'] }).events.length, 0);
  assert.equal(run(state, next, { changed: ['meta.fetched_at'], ignore: ['meta'] }).events.length, 0);
});

test('a field appearing counts as a change from null; missing equals null', () => {
  const state = stateOf([item('a', {})]);
  const e = ofType(run(state, snap([item('a', { status: 'x' })]), { changed: ['status'] }).events, 'changed');
  assert.deepEqual(e.changes, [{ path: 'status', from: null, to: 'x' }]);
  const s2 = stateOf([item('a', { v: null })]);
  assert.equal(run(s2, snap([item('a', {})]), { changed: ['*'] }).events.length, 0);
});

test('removed fires only when enabled and the snapshot is complete', () => {
  const state = stateOf([item('a'), item('b')]);
  assert.equal(run(state, snap([item('a')])).events.length, 0);
  const e = ofType(run(state, snap([item('a')]), { removed: true }).events, 'removed');
  assert.equal(e.id, 'b');
  assert.equal(run(state, snap([item('a')], false), { removed: true }).events.length, 0);
});

test('incomplete snapshot keeps unseen items in state (no later "added" flood)', () => {
  const state = stateOf([item('a'), item('b')]);
  const partial = run(state, snap([item('a')], false));
  assert.deepEqual(Object.keys(partial.state.items).sort(), ['a', 'b']);
  assert.equal(run(partial.state, snap([item('a'), item('b')])).events.length, 0);
});

test('complete snapshot drops removed items from state, so reappearing counts as added', () => {
  const s1 = run(stateOf([item('a'), item('b')]), snap([item('a')])).state;
  assert.deepEqual(Object.keys(s1.items), ['a']);
  ofType(run(s1, snap([item('a'), item('b')])).events, 'added');
});

test('state tracks latest data even when no watched field changed', () => {
  const state = stateOf([item('a', { x: 1, status: 'up' })]);
  const r = run(state, snap([item('a', { x: 2, status: 'up' })]), { changed: ['status'] });
  assert.equal(r.events.length, 0);
  assert.equal(r.state.items.a?.data.x, 2);
});

test('ids like "__proto__" or "constructor" are safe', () => {
  const state = stateOf([item('constructor'), item('__proto__')]);
  assert.deepEqual(Object.keys(state.items).sort(), ['__proto__', 'constructor']);
  assert.equal(run(state, snap([item('constructor'), item('__proto__')]), { changed: ['*'] }).events.length, 0);
});

test('validateSnapshot rejects malformed fetcher output', () => {
  assert.throws(() => validateSnapshot([]), /must be an object/);
  assert.throws(() => validateSnapshot({}), /items must be an array/);
  assert.throws(() => validateSnapshot({ items: [{ id: '' }] }), /non-empty string/);
  assert.throws(() => validateSnapshot({ items: [{ id: 'a' }, { id: 'a' }] }), /duplicate item id "a"/);
  assert.throws(() => validateSnapshot({ items: [], complete: 'yes' }), /complete/);
  assert.equal(validateSnapshot({ items: [{ id: 7 }] }).items[0]?.id, '7');
});

test('firstRun option is validated', () => {
  assert.throws(() => run(null, snap([]), { firstRun: 'nope' as Options['firstRun'] }), /firstRun/);
});
