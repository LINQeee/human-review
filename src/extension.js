'use strict';
const { ProjectIgnore, registerIgnoreCommands } = require('./ignore');
const vscode = require('vscode');
const { fresh, reconcile, normalize, applyChanges, selectedLines, nextUnreviewed } = require('./core');
const { ReviewStore } = require('./storage');
const { PortableState } = require('./portable');
const { unreviewedRanges, scanProject } = require('./project');
const { buildFileTree } = require('./tree');
const { isIgnored, lineStatus, stats, mark, ReviewHistory } = require('./review');
const { registerActions } = require('./actions');
const { registerBadgeSetup } = require('./badge');
let flushOnDeactivate;

async function activate(context) {
  const output = vscode.window.createOutputChannel('Human Review');
  let warned = false;
  const portable = new PortableState(vscode.workspace, vscode.Uri);
  const store = new ReviewStore(context.workspaceState, error => {
    output.appendLine(`Could not save review state: ${String(error)}`);
    if (!warned) {
      warned = true;
      void vscode.window.showErrorMessage(`Human Review could not save your review state: ${String(error)}`);
    }
  }, portable);
  for (const folder of vscode.workspace.workspaceFolders || []) {
    try { await portable.load(folder, store.files, store.ignored); }
    catch (error) { void vscode.window.showErrorMessage(`Human Review: could not load shared review state. ${String(error)}`); }
  }
  const ignoreRules = new ProjectIgnore(vscode.workspace, vscode.Uri);
  try { await ignoreRules.load(); } catch (error) { void vscode.window.showErrorMessage(String(error)); }
  const ignored = key => isIgnored(key, store.ignored) || ignoreRules.ignores(key);
  const changed = new vscode.EventEmitter();
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 10);
  status.command = 'codeReviewed.overview';
  let decoration, recheckDecoration;
  const history = new ReviewHistory();
  let filter = context.workspaceState.get('codeReviewed.filter') || 'all';
  if (!['all', 'new', 'recheck'].includes(filter)) filter = 'all';
  let timer;
  let disposed = false;
  let inventory = new Map();
  let hierarchy = { roots: [], files: new Map() };
  let scanGeneration = 0;
  let scanTimer;
  let scanStatus = "Scanning project…";
  const subscriptions = context.subscriptions;
  subscriptions.push(output, changed, status);
  const config = () => vscode.workspace.getConfiguration('codeReviewed');
  const supported = doc => !doc.isUntitled && !['git', 'output', 'vscode-notebook-cell', 'code-reviewed-snapshot'].includes(doc.uri.scheme)
    && !!vscode.workspace.getWorkspaceFolder(doc.uri)
    && !doc.uri.path?.includes('/.code-reviewed/') && !ignored(doc.uri.toString());
  const withinLimit = doc => doc.lineCount <= config().get('maxFileLines', 20000) && doc.getText().length <= 4 * 1024 * 1024;
  function saveSoon() {
    clearTimeout(timer);
    timer = setTimeout(() => { void store.save().catch(() => {}); }, 150);
  }
  function recordFor(doc, create = false) {
    if (!supported(doc) || !withinLimit(doc)) return undefined;
    const key = doc.uri.toString();
    let record = store.files.get(key);
    if (!record && create) {
      record = fresh(doc.getText());
      store.files.set(key, record);
    }
    return record?.deletedFile ? undefined : record;
  }
  function summary(record) {
    const value = stats(record);
    return { count: value.reviewed, total: value.total, percent: value.percent };
  }
  function paint() {
    if (disposed) return;
    for (const editor of vscode.window.visibleTextEditors) {
      const record = recordFor(editor.document);
      const ranges = [];
      if (record) record.reviewed.forEach((reviewed, i) => {
        if (reviewed && !record.blank?.[i] && i < editor.document.lineCount) ranges.push({ range: editor.document.lineAt(i).range, hoverMessage: 'Reviewed · changes to this line require review again' });
      });
      editor.setDecorations(decoration, ranges);
      const rechecks = [];
      if (record) record.reviewed.forEach((reviewed, i) => {
        if (!record.blank?.[i] && !reviewed && record.recheck?.[i] && i < editor.document.lineCount) rechecks.push({ range: editor.document.lineAt(i).range, hoverMessage: 'Needs re-review · previously reviewed code changed' });
      });
      editor.setDecorations(recheckDecoration, rechecks);
    }
    const active = vscode.window.activeTextEditor;
    if (!active || !supported(active.document)) { status.hide(); return; }
    if (!withinLimit(active.document)) {
      status.text = '$(shield) Review: file too large';
      status.tooltip = 'Review tracking is paused. Limit: configured line count or 4 MiB of text. Existing marks are invalidated on changes.';
    } else {
      const record = recordFor(active.document);
      const stats = summary(record || fresh(active.document.getText()));
      status.text = stats.total ? `$(check) Reviewed ${stats.count}/${stats.total} · ${stats.percent}%` : '$(check) No nonblank lines';
      status.tooltip = 'Human Review: show tracked files. Select lines and use Mark Selected Lines Reviewed to record your review.';
    }
    status.show();
  }
  function notify() {
    scanGeneration++;
    for (const [key, record] of store.files) if (inventory.has(key)) inventory.set(key, record);
    for (const key of inventory.keys()) if (ignored(key)) inventory.delete(key);
    hierarchy = buildFileTree(inventory, key => vscode.workspace.getWorkspaceFolder(vscode.Uri.parse(key)),
      (vscode.workspace.workspaceFolders?.length || 0) > 1, filter);
    projectView.description = `${hierarchy.totals.total ? `${hierarchy.totals.percent}% reviewed` : 'No nonblank lines'} · ${hierarchy.totals.pending} files left`;
    projectView.message = `${scanStatus} · Filter: ${filter === 'all' ? 'All pending' : filter === 'new' ? 'Never reviewed' : 'Needs re-review'}`;
    paint(); changed.fire();
  }
  async function scan() {
    if (!vscode.workspace.findFiles) return; // API test doubles can omit project discovery.
    const generation = ++scanGeneration;
    try { await ignoreRules.load(); } catch (error) { void vscode.window.showErrorMessage(String(error)); return; }
    if (disposed || generation !== scanGeneration) return;
    const result = await scanProject(vscode.workspace, store.files, config().get('maxFileLines', 20000), () => disposed || generation !== scanGeneration, ignored, key => vscode.Uri.parse(key));
    if (disposed || generation !== scanGeneration) return;
    inventory = result.files;
    let recordsChanged = false;
    for (const [key, record] of inventory) {
      const old = store.files.get(key);
      if (old && JSON.stringify(old) !== JSON.stringify(record)) {
        store.files.set(key, record);
        recordsChanged = true;
      }
    }
    if (recordsChanged) saveSoon();
    scanStatus = `${inventory.size} text files scanned${result.skipped ? ` · ${result.skipped} binary, large or unavailable files skipped` : ''}${result.truncated ? ' · limited to first 10,000 files' : ''}`;
    projectView.message = scanStatus;
    notify();
    revealActive();
  }
  function scanSoon() {
    clearTimeout(scanTimer);
    scanTimer = setTimeout(() => { void scan().catch(error => output.appendLine(String(error))); }, 500);
  }
  function resetDecoration() {
    decoration?.dispose();
    recheckDecoration?.dispose();
    decoration = vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      backgroundColor: config().get('showBackground', true) ? new vscode.ThemeColor('codeReviewed.reviewedBackground') : undefined,
      gutterIconPath: vscode.Uri.joinPath(context.extensionUri, 'media', 'reviewed.svg'),
      gutterIconSize: 'contain',
      overviewRulerColor: new vscode.ThemeColor('codeReviewed.reviewedMarker'),
      overviewRulerLane: vscode.OverviewRulerLane.Left,
      rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed
    });
    recheckDecoration = vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      gutterIconPath: vscode.Uri.joinPath(context.extensionUri, 'media', 'recheck.svg'),
      gutterIconSize: 'contain',
      overviewRulerColor: new vscode.ThemeColor('editorWarning.foreground'),
      overviewRulerLane: vscode.OverviewRulerLane.Left,
      rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed
    });
  }
  resetDecoration();
  subscriptions.push({ dispose: () => { decoration.dispose(); recheckDecoration.dispose(); } });
  function sync(doc, changes) {
    const key = doc.uri.toString();
    const previous = store.files.get(key);
    if (!supported(doc)) return;
    if (previous?.deletedFile) { inventory.set(key, previous); notify(); return; }
    if (withinLimit(doc)) inventory.set(key, previous || fresh(doc.getText()));
    else inventory.delete(key);
    if (!previous) { notify(); return; }
    if (!withinLimit(doc)) {
      // Never resurrect marks after a tracked file grows beyond our processing cap.
      store.files.delete(key);
    } else {
      const next = changes?.length ? applyChanges(previous, doc.getText(), changes) : reconcile(previous, doc.getText());
      if (!next.baseline && next.reviewed.every(Boolean) && previous.hashes.length === next.hashes.length && previous.hashes.every((hash, i) => hash === next.hashes[i])) {
        next.baseline = { text: doc.getText(), at: new Date().toISOString(), complete: true };
      }
      store.files.set(key, next);
    }
    saveSoon();
    notify();
  }
  async function refreshUri(uri) {
    if (!store.files.has(uri.toString()) || disposed) return;
    try {
      const doc = await vscode.workspace.openTextDocument(uri);
      if (!disposed) sync(doc);
    } catch (error) {
      // Keep the record on transient IO errors or atomic file replacement.
      output.appendLine(`Could not refresh ${vscode.workspace.asRelativePath(uri)}: ${String(error)}`);
    }
  }
  async function refreshAll() {
    for (const key of [...store.files.keys()]) {
      if (disposed) break;
      await refreshUri(vscode.Uri.parse(key));
    }
    notify();
  }
  const tree = {
    onDidChangeTreeData: changed.event,
    getParent: element => ['range', 'deletion'].includes(element.kind) ? hierarchy.files.get(element.key) : element.parent,
    getChildren: element => {
      if (element?.kind === 'folder') return hierarchy.nodes.get(element.id)?.children || [];
      if (element?.kind === 'file') {
        const record = inventory.get(element.key);
        if (!record) return [];
        const children = unreviewedRanges(record, filter).map(range => ({ kind: 'range', key: element.key, ...range }));
        if (record.pendingDeleted && filter !== 'new') children.push({ kind: 'deletion', key: element.key });
        return children;
      }
      if (element) return [];
      return hierarchy.roots;
    },
    getTreeItem: element => {
      const uri = vscode.Uri.parse(element.key);
      if (element.kind === 'folder') {
        const item = new vscode.TreeItem(element.label, vscode.TreeItemCollapsibleState.Collapsed);
        item.id = element.id;
        item.resourceUri = uri;
        item.iconPath = vscode.ThemeIcon.Folder;
        item.contextValue = 'reviewFolder';
        item.description = `${element.stats.total ? `${element.stats.percent}%` : 'n/a'} · ${element.stats.pending} files left`;
        item.tooltip = `${vscode.workspace.asRelativePath(uri, true)}\n${element.stats.reviewed}/${element.stats.total} lines reviewed across ${element.stats.files} files. ${element.stats.recheck} lines need re-review.`;
        return item;
      }
      const record = inventory.get(element.key);
      if (element.kind === 'deletion') {
        const item = new vscode.TreeItem(record.deletedFile ? 'Deleted file · review changes' : 'Deleted code · review changes');
        item.id = `deletion:${element.key}`;
        item.contextValue = 'reviewDeletion';
        item.iconPath = new vscode.ThemeIcon('diff-removed');
        item.command = { command: 'codeReviewed.diff', title: 'Review Deletions', arguments: [element] };
        return item;
      }
      if (element.kind === 'range') {
        const label = element.start === element.end ? `Line ${element.start + 1}` : `Lines ${element.start + 1}–${element.end + 1}`;
        const item = new vscode.TreeItem(label);
        item.contextValue = 'reviewRange';
        item.description = lineStatus(record, element.start) === 'recheck' ? 'needs re-review' : 'never reviewed';
        item.iconPath = new vscode.ThemeIcon(lineStatus(record, element.start) === 'recheck' ? 'warning' : 'circle-outline');
        item.command = { command: 'codeReviewed.openRange', title: 'Review Code', arguments: [element.key, element.start, element.end] };
        return item;
      }
      const counts = stats(record);
      const item = new vscode.TreeItem(element.label, vscode.TreeItemCollapsibleState.Collapsed);
      item.id = element.id;
      item.contextValue = record.deletedFile ? 'reviewDeletedFile' : 'reviewFile';
      item.resourceUri = uri;
      item.description = `${vscode.window.activeTextEditor?.document.uri.toString() === element.key ? 'current · ' : ''}${record.deletedFile ? 'deleted' : counts.total ? `${counts.total - counts.reviewed} unreviewed · ${counts.percent}% reviewed` : 'no nonblank lines'}${counts.recheck ? ` · ${counts.recheck} recheck` : ''}`;
      item.tooltip = `${vscode.workspace.asRelativePath(uri, true)}\n${counts.reviewed} of ${counts.total} lines reviewed. Expand to jump to unreviewed ranges.`;
      item.iconPath = vscode.ThemeIcon.File;
      const first = record.reviewed.findIndex(flag => !flag);
      item.command = record.deletedFile ? { command: 'codeReviewed.diff', title: 'Review Deletion', arguments: [element] } : { command: 'codeReviewed.openRange', title: 'Review File', arguments: [element.key, Math.max(0, first), Math.max(0, first)] };
      return item;
    }
  };
  const projectView = vscode.window.createTreeView
    ? vscode.window.createTreeView('codeReviewed.files', { treeDataProvider: tree, showCollapseAll: true })
    : vscode.window.registerTreeDataProvider('codeReviewed.files', tree);
  projectView.message = scanStatus;
  subscriptions.push(projectView);
  function revealActive() {
    const key = vscode.window.activeTextEditor?.document.uri.toString();
    const node = hierarchy.files.get(key);
    if (!disposed && node && projectView.visible && projectView.reveal) {
      // Reveal expands ancestors without stealing focus from the editor.
      void projectView.reveal(node, { select: true, focus: false, expand: false }).catch(() => {});
    }
  }
  if (projectView.onDidChangeVisibility) subscriptions.push(projectView.onDidChangeVisibility(event => {
    if (event.visible) revealActive();
  }));
  async function editReview(mode, explicitLines) {
    const editor = vscode.window.activeTextEditor;
    if (!editor || !supported(editor.document)) {
      void vscode.window.showInformationMessage('Open a saved file inside a workspace folder to review it.');
      return;
    }
    if (!withinLimit(editor.document)) {
      void vscode.window.showWarningMessage('This file exceeds the review tracking limit (configured line count or 4 MiB of text).');
      return;
    }
    sync(editor.document);
    const record = recordFor(editor.document, true);
    if (!record) { void vscode.window.showInformationMessage('Save the restored file and refresh the project before reviewing it.'); return false; }
    const lines = explicitLines || (mode === 'file' || mode === 'clear'
      ? record.hashes.map((_, i) => i) : selectedLines(editor.selections, record.hashes.length));
    const codeLines = lines.filter(line => !record.blank?.[line]);
    if (!codeLines.length && !(mode === 'file' && record.pendingDeleted)) return true;
    history.push(editor.document.uri.toString(), record);
    mark(record, codeLines, mode === 'mark' || mode === 'file', editor.document.getText(), mode === 'file');
    notify();
    clearTimeout(timer);
    await store.save();
    return true;
  }
  const command = (name, fn) => subscriptions.push(vscode.commands.registerCommand(`codeReviewed.${name}`, async (...args) => {
    try { return await fn(...args); } catch (error) { void vscode.window.showErrorMessage(`Human Review: ${String(error)}`); return false; }
  }));
  for (const mode of ['unmark', 'file', 'clear']) command(mode, () => editReview(mode));
  command('mark', async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return editReview('mark');
    const selections = [...editor.selections];
    const version = editor.document.version;
    const lines = selectedLines(selections, editor.document.lineCount);
    if (!(await editReview('mark'))) return false;
    // Saving can yield: do not override a newer cursor position, edit or tab.
    if (vscode.window.activeTextEditor !== editor || editor.document.version !== version
      || editor.selections.length !== selections.length
      || editor.selections.some((selection, i) => ['start', 'end', 'active'].some(edge => selection[edge].line !== selections[i][edge].line || selection[edge].character !== selections[i][edge].character))) return true;
    const record = recordFor(editor.document);
    if (!record) return true;
    const line = nextUnreviewed(record, Math.max(...lines));
    if (line < 0) return true;
    const position = new vscode.Position(line, 0);
    editor.selection = new vscode.Selection(position, position);
    editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
    return true;
  });
  command('next', () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor || !supported(editor.document) || !withinLimit(editor.document)) return;
    sync(editor.document);
    const record = recordFor(editor.document) || fresh(editor.document.getText());
    const line = nextUnreviewed(record, editor.selection.active.line);
    if (line === -1) { void vscode.window.showInformationMessage('Every line in this file is reviewed.'); return; }
    const position = new vscode.Position(line, 0);
    editor.selection = new vscode.Selection(position, position);
    editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
  });
  command('overview', () => vscode.commands.executeCommand('codeReviewed.files.focus'));
  async function openRange(key, start, end) {
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.parse(key));
    const first = Math.max(0, Math.min(start, doc.lineCount - 1));
    const last = Math.max(first, Math.min(end, doc.lineCount - 1));
    await vscode.window.showTextDocument(doc, { selection: new vscode.Range(new vscode.Position(first, 0), doc.lineAt(last).range.end) });
  }
  command('openRange', openRange);
  command('refresh', async () => { await refreshAll(); await scan(); });
  async function sharedState(enable) {
    clearTimeout(timer);
    await store.pending;
    const folders = vscode.workspace.workspaceFolders || [];
    if (!folders.length) { void vscode.window.showInformationMessage('Open a project folder first.'); return; }
    try {
      for (const folder of folders) {
        if (enable) await portable.enable(folder, store.files, store.ignored);
        else await portable.load(folder, store.files, store.ignored);
      }
      warned = false;
      history.clear();
      await refreshAll();
      await scan();
      await store.save();
      void vscode.window.showInformationMessage(enable
        ? 'Cross-PC review enabled. Commit .code-reviewed/review.json with your code and pull it on your other computer.'
        : 'Shared review state reloaded and checked against current code.');
    } catch (error) { void vscode.window.showErrorMessage(`Human Review: ${String(error)}`); }
  }
  command('enableShared', () => sharedState(true));
  command('reloadShared', () => sharedState(false));
  registerBadgeSetup({ vscode, context, command, enableShared: async folder => {
    clearTimeout(timer);
    await store.pending;
    if (!portable.loaded.has(folder.uri.toString())) await portable.enable(folder, store.files, store.ignored);
    await store.save();
    notify();
  } });
  registerIgnoreCommands({ vscode, command });
  registerActions({ ignored, vscode, context, store, history, command, sync, notify,
    save: async () => { clearTimeout(timer); await store.save(); }, scan,
    getInventory: () => inventory, getFilter: () => filter,
    setFilter: async value => { filter = value; notify(); await context.workspaceState.update('codeReviewed.filter', value); revealActive(); },
    editReview, openRange, supported, withinLimit });
  subscriptions.push(
    vscode.workspace.onDidOpenTextDocument(doc => sync(doc)),
    vscode.workspace.onDidChangeTextDocument(event => {
      if (event.contentChanges.length) { sync(event.document, event.contentChanges); scanGeneration++; scanSoon(); }
    }),
    vscode.window.onDidChangeActiveTextEditor(editor => { if (editor) sync(editor.document); notify(); revealActive(); }),
    vscode.window.onDidChangeVisibleTextEditors(editors => { for (const editor of editors) sync(editor.document); paint(); }),
    vscode.workspace.onDidChangeConfiguration(event => {
      if (event.affectsConfiguration('codeReviewed')) { resetDecoration(); paint(); }
    }),
    vscode.workspace.onDidRenameFiles(event => {
      for (const file of event.files) { store.rename(file.oldUri.toString(), file.newUri.toString()); history.rename(file.oldUri.toString(), file.newUri.toString()); }
      saveSoon(); notify(); void refreshAll(); scanSoon();
    }),
    vscode.workspace.onDidDeleteFiles(event => {
      for (const uri of event.files) for (const [key, record] of store.files) {
        if (key !== uri.toString() && !key.startsWith(uri.toString() + '/')) continue;
        if (record.baseline) {
          record.deletedFile = true; record.pendingDeleted = true; record.deletionAcknowledged = false;
          Object.assign(record, normalize(record));
        } else store.files.delete(key);
      }
      saveSoon(); notify(); scanSoon();
    })
  );
  const watcher = vscode.workspace.createFileSystemWatcher('**/*');
  subscriptions.push(watcher,
    watcher.onDidChange(uri => { void refreshUri(uri); scanSoon(); }),
    watcher.onDidCreate(uri => { void refreshUri(uri); scanSoon(); }));
  if (watcher.onDidDelete) subscriptions.push(watcher.onDidDelete(scanSoon));
  if (vscode.workspace.onDidChangeWorkspaceFolders) subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(scanSoon));
  flushOnDeactivate = () => {
    disposed = true;
    scanGeneration++;
    clearTimeout(scanTimer);
    clearTimeout(timer);
    return store.save().catch(() => {});
  };
  for (const doc of vscode.workspace.textDocuments) sync(doc);
  paint();
  void refreshAll().then(scan).catch(error => output.appendLine(String(error)));
}
function deactivate() { return flushOnDeactivate?.(); }
module.exports = { activate, deactivate };
