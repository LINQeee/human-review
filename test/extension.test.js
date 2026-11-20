'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const { createRequire } = require('node:module');
const path = require('node:path');

async function harness(saved) {
  const events = {};
  const commands = new Map();
  const disposable = { dispose() {} };
  const on = name => fn => { (events[name] ||= []).push(fn); return disposable; };
  const emit = (name, value) => { for (const fn of events[name] || []) fn(value); };
  class Uri {
    constructor(value) { this.value = value; this.scheme = value.split(':')[0]; }
    toString() { return this.value; }
    static parse(value) { return new Uri(value); }
    static joinPath(uri, ...parts) { return new Uri(uri.value + '/' + parts.join('/')); }
  }
  class Position { constructor(line, character) { this.line = line; this.character = character; } }
  class Range { constructor(start, end) { this.start = start; this.end = end; } }
  class Selection extends Range { constructor(start, end) { super(start, end); this.active = end; } }
  const doc = {
    uri: new Uri('file:///project/a.js'), isUntitled: false, text: 'first\nsecond\nthird',
    get lineCount() { return this.text.split('\n').length; }, getText() { return this.text; },
    lineAt(i) { return { range: new Range(new Position(i, 0), new Position(i, this.text.split('\n')[i].length)) }; }
  };
  const editor = {
    document: doc, selections: [new Selection(new Position(1, 0), new Position(1, 0))],
    get selection() { return this.selections[0]; }, set selection(value) { this.selections = [value]; },
    setDecorations(type, ranges) { if (type.recheck) this.rechecks = ranges; else this.ranges = ranges; }, revealRange() {}
  };
  let state = saved;
  const messages = [];
  const reveals = [];
  const picks = [], inputs = [], executed = [];
  const providers = new Map();
  const status = { ...disposable, show() {}, hide() {} };
  const vscode = {
    Uri, Position, Range, Selection,
    ThemeColor: class {}, ThemeIcon: class {}, TreeItem: class { constructor(label) { this.label = label; } },
    EventEmitter: class { event = () => disposable; fire() {} dispose() {} },
    TreeItemCollapsibleState: { Collapsed: 1 }, StatusBarAlignment: { Left: 1 }, OverviewRulerLane: { Left: 1 }, DecorationRangeBehavior: { ClosedClosed: 1 }, TextEditorRevealType: { InCenterIfOutsideViewport: 1 },
    commands: { registerCommand(name, fn) { commands.set(name, fn); return disposable; }, async executeCommand(name, ...args) { executed.push({ name, args }); if (commands.has(name)) return commands.get(name)(...args); } },
    window: {
      activeTextEditor: editor, visibleTextEditors: [editor],
      createOutputChannel: () => ({ ...disposable, appendLine() {} }), createStatusBarItem: () => status,
      createTextEditorDecorationType: options => ({ ...disposable, recheck: options.gutterIconPath?.toString().endsWith('recheck.svg') }),
      createTreeView: (_, options) => { vscode.tree = options.treeDataProvider; return { ...disposable, visible: true, reveal: async (node, options) => reveals.push({ node, options }), onDidChangeVisibility: on('viewVisible') }; },
      registerTreeDataProvider: (_, tree) => { vscode.tree = tree; return disposable; },
      onDidChangeActiveTextEditor: on('active'), onDidChangeVisibleTextEditors: on('visible'),
      showTextDocument: async (document, options) => { editor.document = document; editor.selection = new Selection(options.selection.start, options.selection.end); return editor; },
      showQuickPick: async options => { const pick = picks.shift(); return typeof pick === 'function' ? pick(options) : pick; },
      showInputBox: async () => inputs.shift(),
      showInformationMessage: message => messages.push(message), showWarningMessage: message => messages.push(message), showErrorMessage: message => messages.push(message)
    },
    workspace: {
      registerTextDocumentContentProvider: (scheme, provider) => { providers.set(scheme, provider); return disposable; },
      textDocuments: [doc], getWorkspaceFolder: uri => uri.toString().startsWith('file:///project/') ? { uri: new Uri('file:///project'), name: 'project' } : undefined,
      getConfiguration: () => ({ get: (_, fallback) => fallback }), asRelativePath: uri => uri.toString(),
      openTextDocument: async () => doc,
      onDidOpenTextDocument: on('open'), onDidChangeTextDocument: on('change'), onDidChangeConfiguration: on('config'),
      onDidRenameFiles: on('rename'), onDidDeleteFiles: on('delete'),
      createFileSystemWatcher: () => ({ ...disposable, onDidChange: on('watchChange'), onDidCreate: on('watchCreate') })
    }
  };
  const entry = path.resolve(__dirname, '../src/extension.js');
  const localRequire = createRequire(entry);
  const context = { module: { exports: {} }, require: name => name === 'vscode' ? vscode : localRequire(name), setTimeout, clearTimeout };
  vm.runInNewContext(fs.readFileSync(entry, 'utf8'), context, { filename: entry });
  await context.module.exports.activate({ subscriptions: [], extensionUri: new Uri('file:///extension'), workspaceState: { get: key => key === 'codeReviewed.state.v1' ? state : undefined, update: async (key, value) => { if (key === 'codeReviewed.state.v1') state = value; } } });
  return { doc, editor, emit, vscode, messages, reveals, picks, inputs, executed, providers, status, state: () => state, run: (name, ...args) => commands.get('codeReviewed.' + name)(...args), stop: () => context.module.exports.deactivate() };
}

test('extension marks current line, persists and decorates it', async () => {
  const h = await harness();
  try {
    await h.run('mark');
    assert.deepEqual(h.state().files[0][1].reviewed, [false, true, false]);
    assert.equal(h.editor.ranges.length, 1);
    assert.equal(h.editor.ranges[0].range.start.line, 1);
    assert.match(h.status.text, /1\/3/);
    assert.equal(h.editor.selection.active.line, 2);
    h.editor.selection = new h.vscode.Selection(new h.vscode.Position(1, 0), new h.vscode.Position(1, 0));
    await h.run('unmark');
    assert.equal(h.editor.ranges.length, 0);
  } finally { await h.stop(); }
});
test('live edits invalidate only affected lines and survive reactivation', async () => {
  const h = await harness();
  await h.run('file');
  h.doc.text = 'first\nchanged\nthird';
  h.emit('change', { document: h.doc, contentChanges: [{ rangeOffset: 6, range: { start: { line: 1, character: 0 }, end: { line: 1, character: 6 } }, text: 'changed' }] });
  assert.equal(h.editor.ranges.length, 2);
  await h.stop();
  const restored = await harness(h.state());
  restored.doc.text = h.doc.text;
  restored.emit('open', restored.doc);
  try {
    assert.equal(restored.editor.ranges.length, 2);
  } finally { await restored.stop(); }
});
test('next command navigates to unreviewed line and clear resets file', async () => {
  const h = await harness();
  try {
    await h.run('file');
    await h.run('unmark');
    await h.run('next');
    assert.equal(h.editor.selection.active.line, 1);
    await h.run('clear');
    assert.equal(h.editor.ranges.length, 0);
  } finally { await h.stop(); }
});
test('rename follows file and deletion retains a reviewable snapshot', async () => {
  const h = await harness();
  try {
    await h.run('file');
    const oldUri = h.doc.uri;
    const newUri = h.vscode.Uri.parse('file:///project/renamed.js');
    h.doc.uri = newUri;
    h.emit('rename', { files: [{ oldUri, newUri }] });
    await h.run('mark');
    assert.equal(h.state().files[0][0], newUri.toString());
    h.emit('delete', { files: [newUri] });
  } finally { await h.stop(); }
  assert.equal(h.state().files.length, 1);
  assert.equal(h.state().files[0][1].deletedFile, true);
  assert.equal(h.state().files[0][1].baseline.text, h.doc.text);
});
test('git historical documents cannot be marked', async () => {
  const h = await harness();
  try {
    h.doc.uri = h.vscode.Uri.parse('git:///project/a.js');
    await h.run('file');
    assert.equal(h.editor.ranges.length, 0);
    assert.match(h.messages[0], /saved file inside a workspace/);
  } finally { await h.stop(); }
});


test('project view removes reviewed files and restores them after edits', async () => {
  const h = await harness();
  try {
    assert.equal(h.vscode.tree.getChildren().length, 1);
    await h.run('file');
    assert.equal(h.vscode.tree.getChildren().length, 0);
    h.doc.text = 'first\nchanged\nthird';
    h.emit('change', { document: h.doc, contentChanges: [{ rangeOffset: 6, range: { start: { line: 1, character: 0 }, end: { line: 1, character: 6 } }, text: 'changed' }] });
    const files = h.vscode.tree.getChildren();
    assert.equal(files.length, 1);
    const ranges = h.vscode.tree.getChildren(files[0]);
    assert.equal(ranges.length, 1);
    assert.equal(ranges[0].start, 1);
    assert.equal(h.vscode.tree.getTreeItem(ranges[0]).command.command, 'codeReviewed.openRange');
  } finally { await h.stop(); }
});


test('active file is revealed without stealing editor focus', async () => {
  const h = await harness();
  try {
    h.emit('active', h.editor);
    assert.equal(h.reveals.at(-1).node.key, h.doc.uri.toString());
    assert.equal(h.reveals.at(-1).options.focus, false);
    assert.equal(h.reveals.at(-1).options.select, true);
    assert.match(h.vscode.tree.getTreeItem(h.vscode.tree.getChildren()[0]).description, /current/);
  } finally { await h.stop(); }
});

test('review Undo restores flags without modifying code', async () => {
  const h = await harness();
  try {
    await h.run('file');
    await h.run('undo');
    assert.deepEqual(h.state().files[0][1].reviewed, [false, false, false]);
    assert.equal(h.doc.text, 'first\nsecond\nthird');
  } finally { await h.stop(); }
});
test('Undo reconciles intervening code edits rather than reapproving changed lines', async () => {
  const h = await harness();
  try {
    await h.run('file'); await h.run('clear');
    h.doc.text = 'first\nchanged\nthird';
    h.emit('change', { document: h.doc, contentChanges: [{ rangeOffset: 6, range: { start: { line: 1, character: 0 }, end: { line: 1, character: 6 } }, text: 'changed' }] });
    await h.run('undo');
    assert.deepEqual(h.state().files[0][1].reviewed, [true, false, true]);
    assert.equal(h.state().files[0][1].recheck[1], true);
  } finally { await h.stop(); }
});
test('diff uses the retained review snapshot rather than current code', async () => {
  const h = await harness();
  try {
    await h.run('file');
    h.doc.text = 'first\nchanged\nthird';
    h.emit('open', h.doc);
    await h.run('diff');
    const diff = h.executed.find(item => item.name === 'vscode.diff');
    assert.ok(diff);
    assert.equal(h.providers.get('code-reviewed-snapshot').provideTextDocumentContent(diff.args[0]), 'first\nsecond\nthird');
    assert.equal(diff.args[1].toString(), h.doc.uri.toString());
    assert.match(diff.args[2], /Last completed review/);
  } finally { await h.stop(); }
});
test('deleted file has a diff, explicit acknowledgement, and review Undo', async () => {
  const h = await harness();
  try {
    await h.run('file'); h.emit('delete', { files: [h.doc.uri] });
    const file = h.vscode.tree.getChildren()[0];
    assert.ok(h.vscode.tree.getChildren(file).some(child => child.kind === 'deletion'));
    await h.run('diff', file);
    const diff = h.executed.find(item => item.name === 'vscode.diff');
    assert.equal(h.providers.get('code-reviewed-snapshot').provideTextDocumentContent(diff.args[1]), '');
    await h.run('acceptDeletion', file);
    assert.equal(h.vscode.tree.getChildren().length, 0);
    await h.run('undo');
    assert.equal(h.vscode.tree.getChildren().length, 1);
  } finally { await h.stop(); }
});
test('ignored paths are persisted and removed from the tree and decorations', async () => {
  const h = await harness();
  try {
    await h.run('mark');
    await h.run('ignore', { kind: 'file', key: h.doc.uri.toString() });
    assert.equal(h.vscode.tree.getChildren().length, 0);
    assert.equal(h.editor.ranges.length, 0);
    assert.deepEqual(h.state().ignored, [h.doc.uri.toString()]);
    h.picks.push(options => [options[0]]);
    await h.run('restoreIgnored');
    h.emit('open', h.doc);
    assert.equal(h.vscode.tree.getChildren().length, 1);
    assert.equal(h.editor.ranges.length, 1);
  } finally { await h.stop(); }
});
test('filter separates re-review from never-reviewed lines', async () => {
  const h = await harness();
  try {
    await h.run('file'); h.doc.text = 'first\nchanged\nthird'; h.emit('open', h.doc);
    h.picks.push({ value: 'new' }); await h.run('filter');
    assert.equal(h.vscode.tree.getChildren().length, 0);
    h.picks.push({ value: 'recheck' }); await h.run('filter');
    assert.equal(h.vscode.tree.getChildren().length, 1);
    const range = h.vscode.tree.getChildren(h.vscode.tree.getChildren()[0])[0];
    assert.equal(h.vscode.tree.getTreeItem(range).description, 'needs re-review');
    assert.equal(h.editor.rechecks.length, 1);
  } finally { await h.stop(); }
});
test('mark-and-next approves the current range then opens another file', async () => {
  const h = await harness();
  try {
    const second = { ...h.doc, uri: h.vscode.Uri.parse('file:///project/b.js'), text: 'another', lineCount: 1 };
    h.vscode.workspace.textDocuments.push(second);
    h.vscode.workspace.openTextDocument = async uri => uri.toString() === second.uri.toString() ? second : h.doc;
    h.emit('open', second);
    await h.run('markNext');
    const record = h.state().files.find(([key]) => key === h.doc.uri.toString())[1];
    assert.ok(record.reviewed.every(Boolean));
    assert.equal(h.editor.document.uri.toString(), second.uri.toString());
    assert.equal(h.editor.selection.start.line, 0);
  } finally { await h.stop(); }
});


test('ordinary marking advances within this file, wraps, and stays when complete', async () => {
  const h = await harness();
  try {
    await h.run('mark');
    assert.equal(h.editor.selection.active.line, 2);
    await h.run('mark');
    assert.equal(h.editor.selection.active.line, 0);
    await h.run('mark');
    assert.equal(h.editor.selection.active.line, 0);
    assert.equal(h.editor.document.uri.toString(), h.doc.uri.toString());
    assert.ok(h.state().files[0][1].reviewed.every(Boolean));
  } finally { await h.stop(); }
});
test('marking skips already reviewed lines while whole-file marking does not move cursor', async () => {
  const h = await harness();
  try {
    await h.run('file');
    assert.equal(h.editor.selection.active.line, 1);
    await h.run('unmark');
    h.editor.selection = new h.vscode.Selection(new h.vscode.Position(0, 0), new h.vscode.Position(0, 0));
    await h.run('unmark');
    h.editor.selection = new h.vscode.Selection(new h.vscode.Position(1, 0), new h.vscode.Position(1, 0));
    await h.run('mark');
    assert.equal(h.editor.selection.active.line, 0);
  } finally { await h.stop(); }
});

test('blank lines receive no decorations and cannot be unmarked or counted', async () => {
  const h = await harness();
  try {
    h.doc.text = 'one\n \nthree\n'; h.emit('open', h.doc);
    await h.run('file');
    assert.equal(h.editor.ranges.length, 2);
    assert.match(h.status.text, /2\/2/);
    h.editor.selection = new h.vscode.Selection(new h.vscode.Position(1, 0), new h.vscode.Position(1, 0));
    await h.run('unmark');
    assert.equal(h.editor.ranges.length, 2);
    assert.equal(h.state().files[0][1].reviewed[1], true);
    await h.run('clear');
    assert.match(h.status.text, /0\/2/);
    await h.run('mark');
    assert.equal(h.editor.selection.active.line, 2);
    assert.equal(h.editor.ranges.length, 0);
  } finally { await h.stop(); }
});
