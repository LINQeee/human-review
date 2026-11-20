'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildFileTree } = require('../src/tree');
const record = { reviewed: [false] };
const folder = { uri: { toString: () => 'file:///project' }, name: 'project' };
test('nested folders preserve hierarchy, parent links, and folder-first sorting', () => {
  const inventory = new Map(['z.js', 'src/components/Button.js', 'src/index.js', 'a.js'].map(path => ['file:///project/' + path, record]));
  const tree = buildFileTree(inventory, () => folder);
  assert.deepEqual(tree.roots.map(node => node.label), ['src', 'a.js', 'z.js']);
  const src = tree.roots[0];
  assert.deepEqual(src.children.map(node => node.label), ['components', 'index.js']);
  const button = tree.files.get('file:///project/src/components/Button.js');
  assert.equal(button.parent.parent, src);
  assert.equal(button.label, 'Button.js');
});
test('fully reviewed branches disappear and duplicate filenames remain distinct', () => {
  const inventory = new Map([
    ['file:///project/a/index.js', record], ['file:///project/b/index.js', record],
    ['file:///project/done/file.js', { reviewed: [true] }]
  ]);
  const tree = buildFileTree(inventory, () => folder);
  assert.deepEqual(tree.roots.map(node => node.label), ['a', 'b']);
  assert.notEqual(tree.roots[0].children[0].id, tree.roots[1].children[0].id);
});
test('multiple workspace roots are explicit and names are decoded', () => {
  const other = { uri: { toString: () => 'file:///other' }, name: 'second' };
  const tree = buildFileTree(new Map([['file:///project/a%20b/file.js', record], ['file:///other/file.js', record]]), key => key.startsWith('file:///project/') ? folder : other, true);
  assert.deepEqual(tree.roots.map(node => node.label), ['project', 'second']);
  assert.equal(tree.roots[0].children[0].label, 'a b');
});
