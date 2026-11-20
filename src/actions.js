'use strict';
const { reconcile, selectedLines } = require('./core');
const { isIgnored } = require('./review');
const { unreviewedRanges, nextTarget } = require('./project');

function registerActions(api) {
  const { vscode, context, store, history, command, sync, notify, save, scan, getInventory, getFilter, setFilter, editReview, openRange } = api;
  const snapshots = new Map();
  let serial = 0;
  const provider = { provideTextDocumentContent: uri => snapshots.get(uri.toString()) || '' };
  context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider('code-reviewed-snapshot', provider));
  function snapshot(text, name) {
    const uri = vscode.Uri.parse(`code-reviewed-snapshot:/snapshot-${++serial}/${encodeURIComponent(name)}`);
    snapshots.set(uri.toString(), text);
    while (snapshots.size > 32) snapshots.delete(snapshots.keys().next().value);
    return uri;
  }
  if (vscode.workspace.onDidCloseTextDocument) context.subscriptions.push(vscode.workspace.onDidCloseTextDocument(doc => snapshots.delete(doc.uri.toString())));
  const keyOf = target => target?.key || (target?.scheme ? target.toString() : vscode.window.activeTextEditor?.document.uri.toString());
  async function showDiff(target) {
    const key = keyOf(target);
    if (!key) return;
    const record = store.files.get(key);
    if (!record?.baseline) {
      void vscode.window.showInformationMessage('No review snapshot exists yet. Mark lines to start a snapshot, or mark the entire file reviewed to create a completed checkpoint. Older hash-only reviews cannot reconstruct source text.');
      return;
    }
    const name = decodeURIComponent(key.split('/').pop());
    const before = snapshot(record.baseline.text, name);
    const after = record.deletedFile ? snapshot('', name) : vscode.Uri.parse(key);
    const title = `${name} · ${record.baseline.complete ? 'Last completed review' : 'Review started'} → ${record.deletedFile ? 'Deleted' : 'Current'}`;
    await vscode.commands.executeCommand('vscode.diff', before, after, title, { preview: true });
  }
  command('diff', showDiff);
  command('nextProject', async () => {
    await scan();
    const editor = vscode.window.activeTextEditor;
    const target = nextTarget(getInventory(), editor?.document.uri.toString(), editor?.selection.active.line ?? -1, getFilter());
    if (target) await openRange(target.key, target.start, target.end);
    else void vscode.window.showInformationMessage('No matching unreviewed lines remain. Check pending deletions in Human Review.');
  });
  command('markNext', async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;
    const key = editor.document.uri.toString();
    sync(editor.document);
    const record = getInventory().get(key);
    if (!record || record.deletedFile || (api.ignored ? api.ignored(key) : isIgnored(key, store.ignored))) return;
    const current = editor.selection.active.line;
    const selected = selectedLines(editor.selections, record.hashes.length);
    const hasSelection = editor.selections.some(selection => selection.start.line !== selection.end.line || selection.start.character !== selection.end.character);
    const range = unreviewedRanges(record, getFilter()).find(item => item.start <= current && item.end >= current);
    const lines = hasSelection ? selected : range ? Array.from({ length: range.end - range.start + 1 }, (_, i) => range.start + i) : [];
    if (lines.length && !(await editReview('mark', lines))) return;
    await scan();
    const target = nextTarget(getInventory(), key, lines.length ? Math.max(...lines) : current, getFilter());
    if (target) await openRange(target.key, target.start, target.end);
    else void vscode.window.showInformationMessage('No matching unreviewed lines remain. Check pending deletions in Human Review.');
  });
  command('undo', async () => {
    const entry = history.pop();
    if (!entry) { void vscode.window.showInformationMessage('No review action to undo in this window.'); return; }
    const current = store.files.get(entry.key);
    try {
      let restored;
      if (current?.deletedFile) restored = { ...entry.before, deletedFile: true, pendingDeleted: !entry.before.deletionAcknowledged };
      else {
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.parse(entry.key));
        restored = reconcile(entry.before, doc.getText());
      }
      store.files.set(entry.key, restored);
      getInventory().set(entry.key, restored);
      notify(); await save();
    } catch (error) {
      history.entries.push(entry);
      throw error;
    }
  });
  command('filter', async () => {
    const selected = await vscode.window.showQuickPick([
      { label: 'All pending', value: 'all', description: 'New code, rechecks, deletions' },
      { label: 'Never reviewed', value: 'new', description: 'New or explicitly unmarked lines' },
      { label: 'Needs re-review', value: 'recheck', description: 'Previously reviewed code that changed, plus deletions' },
    ], { title: 'Human Review: Filter' });
    if (selected) await setFilter(selected.value);
  });
  command('ignore', async target => {
    const key = keyOf(target);
    if (!key) return;
    const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.parse(key));
    if (!folder || key === folder.uri.toString()) {
      void vscode.window.showInformationMessage('Choose a file or subfolder inside a workspace.'); return;
    }
    store.ignored.add(key);
    for (const candidate of getInventory().keys()) if (isIgnored(candidate, store.ignored)) getInventory().delete(candidate);
    notify(); await save(); await scan();
  });
  command('restoreIgnored', async () => {
    const options = [...store.ignored].sort().map(key => ({ label: vscode.workspace.asRelativePath(vscode.Uri.parse(key), true), key }));
    if (!options.length) { void vscode.window.showInformationMessage('No ignored paths.'); return; }
    const selected = await vscode.window.showQuickPick(options, { canPickMany: true, title: 'Restore files or folders to review' });
    if (!selected?.length) return;
    for (const option of selected) store.ignored.delete(option.key);
    notify(); await save(); await scan();
  });
  command('acceptDeletion', async target => {
    const key = keyOf(target), record = store.files.get(key);
    if (!record?.pendingDeleted) return;
    history.push(key, record);
    if (record.deletedFile) { record.deletionAcknowledged = true; record.pendingDeleted = false; }
    else {
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.parse(key));
      sync(doc);
      const current = store.files.get(key);
      current.pendingDeleted = false;
      if (current.reviewed.every(Boolean)) current.baseline = { text: doc.getText(), at: new Date().toISOString(), complete: true };
    }
    notify(); await save();
  });
}
module.exports = { registerActions };
