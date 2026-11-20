'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { patterns, ProjectIgnore } = require('../src/ignore');
const { scanProject } = require('../src/project');
const { fresh } = require('../src/core');
test('gitignore syntax: basename, root, directories, negation, globstar and escaping', () => {
  const rule = patterns('*.svg\n!keep.svg\n/root.js\nvendor/\n!vendor/keep.js\nsrc/**/test?.[jt]s\n\\#literal\n\\!literal\nspace\\ \n');
  for (const name of ['a.svg', 'icons/a.svg', 'root.js', 'vendor/a.js', 'vendor/keep.js', 'src/test1.js', 'src/a/b/test2.ts', '#literal', '!literal', 'space ']) assert.equal(rule.ignores(name), true, name);
  for (const name of ['keep.svg', 'icons/keep.svg', 'src/root.js', 'vendor.js', 'src/test10.js', 'space', 'a.SVG']) assert.equal(rule.ignores(name), false, name);
});
test('per-root patterns reload, delete and exclude tracked tombstones without removing stored reviews', async () => {
  const uri = value => ({ toString: () => value });
  const Uri = { parse: uri, joinPath: (root, name) => uri(root.toString() + '/' + name) };
  const roots = ['file:///one', 'file:///two'].map(value => ({ uri: uri(value) }));
  const data = new Map([['file:///one/.code-reviewedignore', '*.svg'], ['file:///one/a.svg', 'svg'], ['file:///two/a.svg', 'svg']]);
  const missing = () => { throw Object.assign(Error('missing'), { code: 'FileNotFound' }); };
  const workspace = { workspaceFolders: roots, getWorkspaceFolder: target => roots.find(root => target.toString().startsWith(root.uri.toString() + '/')), textDocuments: [],
    findFiles: async () => [...data.keys()].map(uri), fs: {
      stat: async target => data.has(target.toString()) ? { size: data.get(target.toString()).length } : missing(),
      readFile: async target => data.has(target.toString()) ? Buffer.from(data.get(target.toString())) : missing()
    } };
  const rules = new ProjectIgnore(workspace, Uri); await rules.load();
  assert.equal(rules.ignores('file:///one/a.svg'), true);
  assert.equal(rules.ignores('file:///two/a.svg'), false);
  const record = fresh('old'); record.baseline = { text: 'old', at: '', complete: true };
  const tracked = new Map([['file:///one/gone.svg', record]]);
  const result = await scanProject(workspace, tracked, 1000, () => false, key => rules.ignores(key), uri);
  assert.deepEqual([...result.files.keys()], ['file:///two/a.svg']);
  assert.equal(tracked.size, 1);
  data.set('file:///one/.code-reviewedignore', '*.svg\n!a.svg'); await rules.load();
  assert.equal(rules.ignores('file:///one/a.svg'), false);
  data.delete('file:///one/.code-reviewedignore'); await rules.load();
  assert.equal(rules.ignores('file:///one/gone.svg'), false);
});
