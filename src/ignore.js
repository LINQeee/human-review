'use strict';
// node-ignore 7.0.16, MIT; see vendor/ignore.LICENSE.
const createIgnore = require('./vendor/ignore');
const { relativeKey } = require('./portable');
const IGNORE_FILE = '.code-reviewedignore';
function patterns(text = '') { return createIgnore({ ignorecase: false }).add(text); }
class ProjectIgnore {
  constructor(workspace, Uri) { this.workspace = workspace; this.Uri = Uri; this.rules = new Map(); }
  async load() {
    const next = new Map();
    for (const folder of this.workspace.workspaceFolders || []) {
      let text = '';
      try {
        const uri = this.Uri.joinPath(folder.uri, IGNORE_FILE);
        const stat = await this.workspace.fs.stat(uri);
        if (stat.size > 65536) throw Error(`${IGNORE_FILE} exceeds 64 KiB.`);
        text = new TextDecoder('utf-8', { fatal: true }).decode(await this.workspace.fs.readFile(uri));
      } catch (error) { if (!['ENOENT', 'FileNotFound'].includes(error.code)) throw error; }
      next.set(folder.uri.toString(), patterns(text));
    }
    this.rules = next;
  }
  ignores(key) {
    const folder = this.workspace.getWorkspaceFolder(this.Uri.parse(key));
    if (!folder) return false;
    const name = relativeKey(folder.uri, key);
    return !!name && (name === IGNORE_FILE || !!this.rules.get(folder.uri.toString())?.ignores(name));
  }
}
function registerIgnoreCommands({ vscode, command }) {
  async function file() {
    const folders = vscode.workspace.workspaceFolders || [];
    const active = vscode.window.activeTextEditor?.document.uri;
    let folder = active && vscode.workspace.getWorkspaceFolder(active);
    if (!folder) folder = folders.length === 1 ? folders[0] : (await vscode.window.showQuickPick(folders.map(folder => ({ label: folder.name, folder })), { placeHolder: 'Choose the project for ignore patterns' }))?.folder;
    if (!folder) return;
    const uri = vscode.Uri.joinPath(folder.uri, IGNORE_FILE);
    try { await vscode.workspace.fs.stat(uri); }
    catch (error) {
      if (!['ENOENT', 'FileNotFound'].includes(error.code)) throw error;
      await vscode.workspace.fs.writeFile(uri, Buffer.from('# Human Review exclusions (gitignore syntax)\n'));
    }
    return vscode.workspace.openTextDocument(uri);
  }
  command('editIgnorePatterns', async () => { const doc = await file(); if (doc) await vscode.window.showTextDocument(doc); });
  command('addIgnorePattern', async () => {
    const pattern = await vscode.window.showInputBox({ prompt: 'Ignore pattern (gitignore syntax)', placeHolder: '*.svg', validateInput: value => !value.trim() || /[\r\n\0]/.test(value) ? 'Enter one nonempty pattern.' : undefined });
    if (!pattern || !pattern.trim() || /[\r\n\0]/.test(pattern)) return;
    const doc = await file(); if (!doc) return;
    const text = doc.getText();
    const edit = new vscode.WorkspaceEdit();
    edit.insert(doc.uri, doc.positionAt(text.length), `${text && !text.endsWith('\n') ? '\n' : ''}${pattern}\n`);
    if (!await vscode.workspace.applyEdit(edit) || !await doc.save()) throw Error('Could not save ignore patterns.');
    await vscode.window.showTextDocument(doc);
  });
}
module.exports = { IGNORE_FILE, patterns, ProjectIgnore, registerIgnoreCommands };
