'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fresh, reconcile, applyChanges, validRecord } = require('../src/core');
const { mark, isIgnored, lineStatus, needsReview, ReviewHistory } = require('../src/review');
const { nextTarget } = require('../src/project');
const { buildFileTree } = require('../src/tree');
const { ReviewStore } = require('../src/storage');
function reviewed(text) { const record = fresh(text); mark(record, record.hashes.map((_, i) => i), true, text, true); return record; }

test('review checkpoint survives edits and advances only after complete review', () => {
  const before = reviewed('one\ntwo\nthree');
  const next = reconcile(before, 'one\nchanged\nthree');
  assert.equal(next.baseline.text, 'one\ntwo\nthree');
  assert.equal(lineStatus(next, 1), 'recheck');
  mark(next, [1], true, 'one\nchanged\nthree');
  assert.equal(next.baseline.text, 'one\nchanged\nthree');
  assert.equal(next.baseline.complete, true);
});
test('first partial snapshot is explicitly incomplete and not overwritten by later partial reviews', () => {
  const record = fresh('a\nb\nc');
  mark(record, [0], true, 'a\nb\nc');
  assert.equal(record.baseline.complete, false);
  const next = reconcile(record, 'a\nnew b\nc');
  mark(next, [1], true, 'a\nnew b\nc');
  assert.equal(next.baseline.text, 'a\nb\nc');
  assert.equal(next.baseline.complete, false);
});
test('new insertions are separate from modifications to reviewed code', () => {
  const next = reconcile(reviewed('one\ntwo\nthree'), 'inserted\none\nchanged\nthree');
  assert.equal(lineStatus(next, 0), 'new');
  assert.equal(lineStatus(next, 2), 'recheck');
  assert.ok(needsReview(next, 'new')); assert.ok(needsReview(next, 'recheck'));
});
test('deletions stay pending after all remaining lines are reviewed', () => {
  const next = reconcile(reviewed('one\ntwo\nthree'), 'one\nthree');
  assert.ok(next.reviewed.every(Boolean)); assert.equal(next.pendingDeleted, true);
  mark(next, [0, 1], true, 'one\nthree');
  assert.equal(next.baseline.text, 'one\ntwo\nthree');
  assert.ok(needsReview(next, 'recheck'));
  mark(next, [0, 1], true, 'one\nthree', true);
  assert.equal(next.pendingDeleted, false);
});
test('deleting unreviewed code present in a partial checkpoint also remains pending', () => {
  const record = fresh('one\ntwo\nthree'); mark(record, [0], true, 'one\ntwo\nthree');
  assert.equal(reconcile(record, 'one\nthree').pendingDeleted, true);
});
test('ignored folders match path boundaries and do not include siblings', () => {
  assert.equal(isIgnored('file:///p/vendor/a.js', new Set(['file:///p/vendor'])), true);
  assert.equal(isIgnored('file:///p/vendors/a.js', new Set(['file:///p/vendor'])), false);
});
test('project next-range navigation crosses files and wraps', () => {
  const a = fresh('one\ntwo\nthree'); a.reviewed[1] = true;
  const b = fresh('another'); const inventory = new Map([['a', a], ['b', b]]);
  assert.deepEqual(nextTarget(inventory, 'a', 0), { key: 'a', start: 2, end: 2 });
  assert.deepEqual(nextTarget(inventory, 'a', 2), { key: 'b', start: 0, end: 0 });
  assert.deepEqual(nextTarget(inventory, 'b', 0), { key: 'a', start: 0, end: 0 });
});
test('folder progress includes fully reviewed siblings hidden from pending tree', () => {
  const root = { uri: { toString: () => 'file:///p' }, name: 'p' };
  const inventory = new Map([['file:///p/src/done.js', reviewed('one\ntwo\nthree')], ['file:///p/src/todo.js', fresh('four')]]);
  const tree = buildFileTree(inventory, () => root);
  assert.equal(tree.roots[0].children.length, 1);
  assert.equal(tree.roots[0].stats.percent, 75);
  assert.equal(tree.roots[0].stats.pending, 1);
  assert.equal(tree.roots[0].stats.files, 2);
});
test('status filters prune folders but keep the same progress denominator', () => {
  const root = { uri: { toString: () => 'file:///p' } };
  const record = reconcile(reviewed('one\ntwo'), 'one\nchanged');
  const inventory = new Map([['file:///p/changed/a', record], ['file:///p/new/b', fresh('new')]]);
  const tree = buildFileTree(inventory, () => root, false, 'recheck');
  assert.deepEqual(tree.roots.map(node => node.label), ['changed']);
  assert.equal(tree.totals.total, 3);
});
test('history snapshots are independent and capped', () => {
  const history = new ReviewHistory(); const record = reviewed('one');
  for (let i = 0; i < 40; i++) history.push('file:///p/a', record);
  record.reviewed[0] = false;
  assert.equal(history.entries.length, 30);
  history.rename('file:///p', 'file:///new');
  assert.equal(history.pop().before.reviewed[0], true);
  assert.equal(history.pop().key, 'file:///new/a');
});
test('old local state migrates without losing marks and new metadata round-trips', async () => {
  let state = { version: 1, files: [['file:///p/a', { hashes: fresh('a').hashes, reviewed: [true] }]] };
  const memento = { get: () => state, update: async (_, next) => { state = next; } };
  const store = new ReviewStore(memento); assert.equal(store.files.get('file:///p/a').reviewed[0], true);
  const record = reviewed('a');
  store.files.set('file:///p/a', record); store.ignored.add('file:///p/vendor');
  await store.save(); assert.equal(state.version, 2);
  const restored = new ReviewStore(memento);
  assert.equal(restored.files.get('file:///p/a').reviewed[0], true);
  assert.ok(restored.ignored.has('file:///p/vendor'));
});
test('malformed snapshots and statuses are rejected', () => {
  const record = reviewed('a'); assert.ok(validRecord(record));
  assert.equal(validRecord({ ...record, recheck: ['true'] }), false);
  assert.equal(validRecord({ ...record, baseline: { text: 12 } }), false);
});
test('legacy annotations are discarded on load without losing review marks', async () => {
  const record = reviewed('a'); record.notes = [{ text: 'legacy annotation' }];
  let state = { version: 2, files: [['file:///p/a', record]], ignored: ['file:///p/vendor'] };
  const store = new ReviewStore({ get: () => state, update: async (_, value) => { state = value; } });
  assert.equal(store.files.get('file:///p/a').reviewed[0], true);
  assert.equal(needsReview(store.files.get('file:///p/a')), false);
  assert.equal(store.files.get('file:///p/a').notes, undefined);
  await store.save();
  assert.ok(!JSON.stringify(state).includes('legacy annotation'));
  assert.ok(store.ignored.has('file:///p/vendor'));
});
