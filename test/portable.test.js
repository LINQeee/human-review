'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { PortableState, decode, validPath } = require('../src/portable');
const { fresh, reconcile } = require('../src/core');
class Uri {
  constructor(value) { this.value = value; }
  toString() { return this.value; }
  static parse(value) { return new Uri(value); }
  static joinPath(root, ...parts) { return new Uri(root.toString() + '/' + parts.map(encodeURIComponent).join('/')); }
}
function machine(root, disk = new Map()) {
  const folder = { uri: new Uri(root) };
  const missing = () => Object.assign(Error('missing'), { code: 'FileNotFound' });
  const workspace = {
    workspaceFolders: [folder], getWorkspaceFolder: () => folder,
    fs: {
      stat: async uri => { if (!disk.has(uri.toString())) throw missing(); return { size: disk.get(uri.toString()).length }; },
      readFile: async uri => { if (!disk.has(uri.toString())) throw missing(); return disk.get(uri.toString()); },
      createDirectory: async () => {}, writeFile: async (uri, bytes) => disk.set(uri.toString(), bytes)
    }
  };
  return { portable: new PortableState(workspace, Uri), folder, disk };
}
test('portable state transfers from macOS to Windows paths with no machine identifiers', async () => {
  const a = machine('file:///Users/alice/project');
  const record = fresh('first\nsecond'); record.reviewed[0] = true;
  await a.portable.enable(a.folder, new Map([['file:///Users/alice/project/src/a%20b.js', record]]));
  const data = [...a.disk.values()][0];
  assert.ok(!data.toString().includes('/Users/'));
  const b = machine('file:///c%3A/work/project');
  b.disk.set(b.portable.uri(b.folder).toString(), data);
  const files = new Map(); await b.portable.load(b.folder, files);
  const restored = files.get('file:///c%3A/work/project/src/a%20b.js');
  assert.deepEqual(restored.reviewed, [true, false]);
  assert.deepEqual(reconcile(restored, 'new\nfirst\nsecond').reviewed, [false, true, false]);
});
test('unmark and clear survive transfer instead of reviving local flags', async () => {
  const a = machine('file:///project'); const record = fresh('a');
  const files = new Map([['file:///project/a', record]]);
  await a.portable.enable(a.folder, files);
  const old = fresh('a'); old.reviewed[0] = true;
  files.set('file:///project/a', old);
  await a.portable.load(a.folder, files);
  assert.equal(files.get('file:///project/a').reviewed[0], false);
});
test('external modifications are never silently overwritten', async () => {
  const a = machine('file:///project'); const files = new Map();
  await a.portable.enable(a.folder, files);
  const uri = a.portable.uri(a.folder).toString();
  a.disk.set(uri, Buffer.from('{"version":1,"files":[]}'));
  await assert.rejects(a.portable.save(files), /changed on disk/);
  assert.equal(a.disk.get(uri).toString(), '{"version":1,"files":[]}');
  await a.portable.load(a.folder, files); await a.portable.save(files);
});
test('invalid files and Git conflicts leave local marks intact', async () => {
  const a = machine('file:///project'); const files = new Map([['file:///project/a', fresh('a')]]);
  a.disk.set(a.portable.uri(a.folder).toString(), Buffer.from('<<<<<<< HEAD'));
  await assert.rejects(a.portable.load(a.folder, files));
  assert.equal(files.size, 1);
});
test('portable file paths cannot escape the project or reference the review store', () => {
  for (const path of ['../secret', '/secret', 'a/../../secret', 'C:/secret', 'a\\b', '.code-reviewed/review.json']) assert.equal(validPath(path), false);
  assert.throws(() => decode(JSON.stringify({ version: 1, files: [['../a', fresh('a')]] })));
});
test('local mode does not create project files until enabled', async () => {
  const a = machine('file:///project'); await a.portable.save(new Map()); assert.equal(a.disk.size, 0);
});

test('v2 portable snapshots, statuses and exclusions survive a second PC', async () => {
  const { mark } = require('../src/review');
  const a = machine('file:///mac/repo');
  const record = fresh('original\ncode'); mark(record, [0, 1], true, 'original\ncode', true);
  const changed = reconcile(record, 'original\nchanged');
  await a.portable.enable(a.folder, new Map([['file:///mac/repo/src/a', changed]]), new Set(['file:///mac/repo/vendor']));
  const b = machine('file:///c%3A/work/repo');
  b.disk.set(b.portable.uri(b.folder).toString(), [...a.disk.values()][0]);
  const files = new Map(), ignored = new Set();
  await b.portable.load(b.folder, files, ignored);
  const restored = files.get('file:///c%3A/work/repo/src/a');
  assert.equal(restored.baseline.text, 'original\ncode');
  assert.equal(restored.recheck[1], true);
  assert.ok(ignored.has('file:///c%3A/work/repo/vendor'));
});
test('shared legacy annotations are removed while approvals survive', async () => {
  const a = machine('file:///project');
  const record = fresh('a'); record.reviewed[0] = true; record.notes = [{ text: 'old note' }];
  const files = new Map([['file:///project/a', record]]);
  await a.portable.enable(a.folder, files);
  const b = machine('file:///other');
  b.disk.set(b.portable.uri(b.folder).toString(), [...a.disk.values()][0]);
  const loaded = new Map(); await b.portable.load(b.folder, loaded);
  assert.equal(loaded.get('file:///other/a').reviewed[0], true);
  assert.equal(loaded.get('file:///other/a').notes, undefined);
});
