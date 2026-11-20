'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fresh, fingerprints, reconcile, applyChanges, selectedLines, nextUnreviewed, validRecord } = require('../src/core');
const { ReviewStore } = require('../src/storage');
function reviewed(text, flags) { const result = fresh(text); result.reviewed = flags || result.hashes.map(() => true); return result; }
function edit(sl, sc, el, ec, text, offset = 0) { return { range: { start: { line: sl, character: sc }, end: { line: el, character: ec } }, rangeOffset: offset, text }; }

test('fingerprints store hashes only and normalize line endings', () => {
  assert.deepEqual(fingerprints('secret\r\nnext'), fingerprints('secret\nnext'));
  assert.equal(fingerprints('secret')[0].length, 64);
  assert.notEqual(fingerprints('secret')[0], 'secret');
});
test('fresh files start unreviewed', () => assert.deepEqual(fresh('a\nb').reviewed, [false, false]));
test('unchanged reload preserves partial review including duplicates', () => {
  assert.deepEqual(reconcile(reviewed('a\na\nb', [true, false, true]), 'a\na\nb').reviewed, [true, false, true]);
});
test('external insertion shifts unique reviewed lines', () => {
  assert.deepEqual(reconcile(reviewed('a\nb\nc'), 'inserted\na\nb\nc').reviewed, [false, true, true, true]);
});
test('external replacement resets only changed unique lines', () => {
  assert.deepEqual(reconcile(reviewed('a\nb\nc'), 'a\nnew\nc').reviewed, [true, false, true]);
});
test('external deletion removes corresponding marks', () => {
  assert.deepEqual(reconcile(reviewed('a\nb\nc'), 'a\nc').reviewed, [true, true]);
});
test('unknown edits never transfer review to ambiguous repeated lines', () => {
  assert.deepEqual(reconcile(reviewed('a\nx\nx\nb', [true, true, false, true]), 'a\nx\nb').reviewed, [true, false, true]);
});
test('insertion at start of line preserves exact duplicate occurrences', () => {
  assert.deepEqual(applyChanges(reviewed('x\nx\ny', [true, false, true]), 'new\nx\nx\ny', [edit(0, 0, 0, 0, 'new\n')]).reviewed, [false, true, false, true]);
});
test('mid-line edit resets the affected line', () => {
  assert.deepEqual(applyChanges(reviewed('abc\ndef'), 'aXbc\ndef', [edit(0, 1, 0, 1, 'X', 1)]).reviewed, [false, true]);
});
test('newline insertion within a line invalidates both fragments', () => {
  assert.deepEqual(applyChanges(reviewed('abc\ndef'), 'a\nbc\ndef', [edit(0, 1, 0, 1, '\n', 1)]).reviewed, [false, false, true]);
});
test('complete line deletion preserves next line at column zero', () => {
  assert.deepEqual(applyChanges(reviewed('a\nb\nc'), 'a\nc', [edit(1, 0, 2, 0, '', 2)]).reviewed, [true, true]);
});
test('joining lines invalidates the merged line', () => {
  assert.deepEqual(applyChanges(reviewed('abc\ndef\nghi'), 'abcdef\nghi', [edit(0, 3, 1, 0, '', 3)]).reviewed, [false, true]);
});
test('multicursor edits are applied in original-coordinate descending order', () => {
  assert.deepEqual(applyChanges(reviewed('a\nb\nc\nd'), 'X\na\nb!\nc\nd', [edit(0, 0, 0, 0, 'X\n', 0), edit(1, 1, 1, 1, '!', 3)]).reviewed, [false, true, false, true, true]);
});
test('undo does not silently reapprove an edited line', () => {
  const modified = applyChanges(reviewed('abc\ndef'), 'abX\ndef', [edit(0, 2, 0, 3, 'X', 2)]);
  assert.deepEqual(applyChanges(modified, 'abc\ndef', [edit(0, 2, 0, 3, 'c', 2)]).reviewed, [false, true]);
});
test('selection excludes a following line selected only at column zero', () => {
  assert.deepEqual(selectedLines([{ start: { line: 1, character: 2 }, end: { line: 3, character: 0 } }], 5), [1, 2]);
});
test('empty selection marks cursor line and multicursor selections deduplicate', () => {
  const selection = { start: { line: 1, character: 0 }, end: { line: 1, character: 0 } };
  assert.deepEqual(selectedLines([selection, selection], 3), [1]);
});
test('next unreviewed wraps and detects completion', () => {
  assert.equal(nextUnreviewed(reviewed('a\nb\nc', [false, true, true]), 2), 0);
  assert.equal(nextUnreviewed(reviewed('a\nb'), 0), -1);
});
test('invalid stored data is rejected', () => {
  assert.equal(validRecord({ hashes: ['source'], reviewed: [true] }), false);
  assert.equal(validRecord({ hashes: fingerprints('a'), reviewed: [] }), false);
  assert.ok(validRecord(reviewed('a')));
});
test('stored marks survive reconstruction', async () => {
  let state;
  const memento = { get: () => state, update: async (_, next) => { state = next; } };
  const first = new ReviewStore(memento);
  first.files.set('file:///project/a', reviewed('a\nb', [true, false]));
  await first.save();
  const second = new ReviewStore(memento);
  assert.deepEqual(second.files.get('file:///project/a').reviewed, [true, false]);
  assert.equal(JSON.stringify(state).includes('a\\nb'), false);
});
test('writes are serialized and snapshots cannot be mutated after save', async () => {
  const writes = [];
  const store = new ReviewStore({ get: () => undefined, update: async (_, value) => { await new Promise(resolve => setTimeout(resolve, 5)); writes.push(value); } });
  const record = reviewed('a');
  store.files.set('file:///a', record);
  const first = store.save();
  record.reviewed[0] = false;
  const second = store.save();
  await Promise.all([first, second]);
  assert.equal(writes[0].files[0][1].reviewed[0], true);
  assert.equal(writes[1].files[0][1].reviewed[0], false);
});
test('failed saves report errors and subsequent saves can recover', async () => {
  let attempts = 0, errors = 0;
  const store = new ReviewStore({ get: () => undefined, update: async () => { if (++attempts === 1) throw Error('disk full'); } }, () => errors++);
  await assert.rejects(store.save(), /disk full/);
  await store.save();
  assert.equal(errors, 1);
  assert.equal(attempts, 2);
});
test('folder rename and delete preserve unrelated siblings', () => {
  const store = new ReviewStore({ get: () => undefined });
  store.files.set('file:///a/one', reviewed('a'));
  store.files.set('file:///ab/two', reviewed('b'));
  store.rename('file:///a', 'file:///new');
  assert.ok(store.files.has('file:///new/one'));
  store.remove('file:///new');
  assert.deepEqual([...store.files.keys()], ['file:///ab/two']);
});
test('large reconciliation remains bounded', () => {
  const text = Array.from({ length: 20000 }, (_, i) => `unique line ${i}`).join('\n');
  const result = reconcile(reviewed(text), `inserted\n${text}`);
  assert.equal(result.reviewed.filter(Boolean).length, 20000);
});

test('whole-buffer replacement preserves unique unchanged lines', () => {
  assert.deepEqual(applyChanges(reviewed('a\nb\nc'), 'a\nnew\nc', [edit(0, 0, 2, 1, 'a\nnew\nc')]).reviewed, [true, false, true]);
});
test('line-ending-only buffer replacement preserves review', () => {
  assert.deepEqual(applyChanges(reviewed('a\nb'), 'a\r\nb', [edit(0, 0, 1, 1, 'a\r\nb')]).reviewed, [true, true]);
});
test('external changes preserve unchanged repeated runs between anchors', () => {
  const before = 'function a() {\n  first();\n}\nfunction b() {\n  second();\n}\nfunction c() {\n  third();\n}';
  const after = before.replace('second()', 'updated()');
  const record = reconcile(reviewed(before), after);
  assert.deepEqual(record.reviewed, [true, true, true, true, false, true, true, true, true]);
});
test('full-buffer replacements preserve partial marks in unchanged repeated runs', () => {
  const before = 'a\nx\nx\nb\ny\nc\nx\nx\nd';
  const flags = [true, true, false, true, true, true, false, true, true];
  const record = applyChanges(reviewed(before, flags), before.replace('y', 'changed'), [edit(0, 0, 8, 1, before.replace('y', 'changed'))]);
  assert.deepEqual(record.reviewed, [true, true, false, true, false, true, false, true, true]);
});
