'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fresh, reconcile, applyChanges, nextUnreviewed, normalize } = require('../src/core');
const { mark, stats, needsReview } = require('../src/review');
const { unreviewedRanges } = require('../src/project');
const { buildFileTree } = require('../src/tree');

test('empty and whitespace-only lines are implicitly reviewed but never counted', () => {
  const record = fresh('\n  \n\t\ncode\n');
  assert.deepEqual(record.blank, [true, true, true, false, true]);
  assert.deepEqual(record.reviewed, [true, true, true, false, true]);
  assert.equal(stats(record).total, 1); assert.equal(stats(record).reviewed, 0);
  assert.equal(nextUnreviewed(record, 0), 3);
  assert.deepEqual(unreviewedRanges(record), [{ start: 3, end: 3 }]);
  mark(record, [0, 1, 2, 4], false, '\n  \n\t\ncode\n');
  assert.deepEqual(record.reviewed, [true, true, true, false, true]);
  assert.equal(record.baseline, undefined);
});
test('clearing or marking a file never changes blank approvals or percentage denominator', () => {
  const text = 'one\n\n  \ntwo\n'; const record = fresh(text);
  mark(record, [0, 1, 2, 3, 4], true, text, true);
  assert.equal(stats(record).reviewed, 2); assert.equal(stats(record).percent, 100);
  mark(record, [0, 1, 2, 3, 4], false, text);
  assert.deepEqual(record.reviewed, [false, true, true, false, true]);
  assert.equal(stats(record).total, 2);
});
test('blank-only files have no pending review or statistical contribution', () => {
  const record = fresh(' \n\t\n');
  assert.equal(needsReview(record), false);
  assert.equal(stats(record).files, 0); assert.equal(stats(record).total, 0);
  assert.equal(nextUnreviewed(record, 0), -1);
});
test('code typed on a formerly blank line requires review, not inherited blank approval', () => {
  const record = fresh('\nother');
  const next = applyChanges(record, 'new code\nother', [{ rangeOffset: 0, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }, text: 'new code' }]);
  assert.equal(next.reviewed[0], false); assert.equal(next.recheck[0], false);
  assert.equal(stats(next).total, 2);
});
test('adding and deleting blank lines never creates a pending deletion', () => {
  const record = fresh('one\n\n \ntwo'); mark(record, [0, 3], true, 'one\n\n \ntwo', true);
  const next = reconcile(record, 'one\ntwo');
  assert.equal(next.pendingDeleted, false);
  assert.equal(stats(next).percent, 100);
  const added = reconcile(next, '\none\n\t\ntwo\n');
  assert.equal(stats(added).total, 2); assert.equal(stats(added).percent, 100);
});
test('replacing reviewed code with whitespace keeps deletion pending but does not count the blank line', () => {
  const record = fresh('one\ntwo'); mark(record, [0, 1], true, 'one\ntwo', true);
  const next = reconcile(record, 'one\n   ');
  assert.equal(next.pendingDeleted, true); assert.equal(next.reviewed[1], true);
  assert.equal(next.recheck[1], false); assert.equal(stats(next).total, 1);
});
test('old hashes and baseline migrate whitespace without losing nonblank marks', () => {
  const record = fresh('one\n \n'); delete record.blank;
  record.reviewed = [true, false, false];
  record.baseline = { text: 'one\n \n', at: '2026', complete: true };
  const restored = normalize(record);
  assert.deepEqual(restored.reviewed, [true, true, true]);
  assert.equal(stats(restored).total, 1);
});
test('folder totals exclude whitespace-only lines and files', () => {
  const one = fresh('a\n\n'); mark(one, [0], true, 'a\n\n');
  const inventory = new Map([['file:///p/src/one', one], ['file:///p/src/two', fresh('b\n\n')], ['file:///p/src/empty', fresh(' \n')]]);
  const tree = buildFileTree(inventory, () => ({ uri: { toString: () => 'file:///p' } }));
  assert.equal(tree.totals.total, 2); assert.equal(tree.totals.percent, 50);
  assert.equal(tree.totals.files, 2);
});

test('legacy blank-only deletion markers are cleared on reconciliation', () => {
  const old = fresh('one\ntwo'); mark(old, [0, 1], true, 'one\ntwo', true);
  old.baseline.text = 'one\n \ntwo'; old.pendingDeleted = true;
  const next = reconcile(old, 'one\ntwo');
  assert.equal(next.pendingDeleted, false);
  const deleted = normalize({ ...fresh(' \n'), deletedFile: true, pendingDeleted: true });
  assert.equal(needsReview(deleted), false);
  assert.equal(deleted.pendingDeleted, false);
});
