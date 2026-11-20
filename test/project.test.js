'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { scanProject, unreviewedRanges } = require('../src/project');
const { fresh } = require('../src/core');
test('unreviewed ranges coalesce adjacent lines', () => {
  assert.deepEqual(unreviewedRanges({ reviewed: [false, false, true, false, true, false] }), [{ start: 0, end: 1 }, { start: 3, end: 3 }, { start: 5, end: 5 }]);
});
test('project discovery includes untracked text, excludes binary and reconciles reviewed files', async () => {
  const data = new Map([['a', Buffer.from('one\ntwo')], ['b', Buffer.from('new file')], ['image', Buffer.from([0, 1, 2])]]);
  const uri = key => ({ toString: () => key });
  const workspace = {
    textDocuments: [], findFiles: async () => [...data.keys()].map(uri),
    fs: { stat: async key => ({ size: data.get(key.toString()).length }), readFile: async key => data.get(key.toString()) }
  };
  const record = fresh('one\nold'); record.reviewed.fill(true);
  const result = await scanProject(workspace, new Map([['a', record]]), 20000);
  assert.equal(result.files.size, 2); assert.equal(result.skipped, 1);
  assert.deepEqual(result.files.get('a').reviewed, [true, false]);
  assert.deepEqual(result.files.get('b').reviewed, [false]);
});
test('project scan uses unsaved editor content', async () => {
  const uri = { toString: () => 'a' };
  const result = await scanProject({ findFiles: async () => [uri], textDocuments: [{ uri, getText: () => 'unsaved\ncontent' }] }, new Map(), 20000);
  assert.equal(result.files.get('a').hashes.length, 2);
});

test('scan retains a deleted reviewed file as a pending diff', async () => {
  const { mark } = require('../src/review');
  const record = fresh('deleted code'); mark(record, [0], true, 'deleted code', true);
  const workspace = { textDocuments: [], findFiles: async () => [], fs: { stat: async () => { throw Object.assign(Error('gone'), { code: 'FileNotFound' }); } } };
  const result = await scanProject(workspace, new Map([['file:///p/deleted.js', record]]), 20000);
  assert.equal(result.files.get('file:///p/deleted.js').deletedFile, true);
  assert.equal(result.files.get('file:///p/deleted.js').pendingDeleted, true);
  assert.equal(result.files.get('file:///p/deleted.js').baseline.text, 'deleted code');
});
test('ignore removes files from discovery and progress without dropping saved marks', async () => {
  const data = { toString: () => 'file:///p/vendor/a' };
  const tracked = new Map([[data.toString(), fresh('one')]]);
  const result = await scanProject({ findFiles: async () => [data], textDocuments: [] }, tracked, 20000, () => false, new Set(['file:///p/vendor']));
  assert.equal(result.files.size, 0); assert.equal(tracked.size, 1);
});
