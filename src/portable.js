'use strict';
const { validRecord, normalize } = require('./core');
const STATE_PATH = ['.code-reviewed', 'review.json'];
function relativeKey(root, uri) {
  const prefix = root.toString().replace(/\/$/, '') + '/';
  if (!uri.startsWith(prefix)) return undefined;
  const value = uri.slice(prefix.length).split('/').map(decodeURIComponent).join('/');
  return validPath(value) ? value : undefined;
}
function validPath(value) {
  return typeof value === 'string' && value.length > 0 && !value.includes('\\') && !value.includes('\0')
    && !value.includes(':') && value.split('/').every(part => part && part !== '.' && part !== '..')
    && value !== '.code-reviewed' && !value.startsWith('.code-reviewed/');
}
function decodeState(text) {
  if (Buffer.byteLength(text) > 32 * 1024 * 1024) throw Error('Review file exceeds 32 MiB.');
  const value = JSON.parse(text);
  if (![1, 2].includes(value?.version) || !Array.isArray(value.files)) throw Error('Unsupported review file format.');
  const seen = new Set();
  for (const entry of value.files) {
    if (!Array.isArray(entry) || entry.length !== 2 || !validPath(entry[0]) || !validRecord(entry[1]) || seen.has(entry[0])) {
      throw Error('Invalid review file entry.');
    }
    seen.add(entry[0]);
  }
  const ignored = value.ignored || [];
  if (!Array.isArray(ignored) || ignored.length > 10000 || !ignored.every(validPath)) throw Error('Invalid ignored paths.');
  return { files: value.files, ignored };

}
function decode(text) { return decodeState(text).files; }
class PortableState {
  constructor(workspace, Uri) {
    this.workspace = workspace;
    this.Uri = Uri;
    this.loaded = new Map();
  }
  uri(folder) { return this.Uri.joinPath(folder.uri, ...STATE_PATH); }
  async read(folder) {
    try {
      const stat = await this.workspace.fs.stat(this.uri(folder));
      if (stat.size > 32 * 1024 * 1024) throw Error('Review file exceeds 32 MiB.');
      return Buffer.from(await this.workspace.fs.readFile(this.uri(folder))).toString('utf8');
    } catch (error) {
      if (error.code === 'FileNotFound' || error.code === 'ENOENT') return undefined;
      throw error;
    }
  }
  async load(folder, files, ignored = new Set()) {
    const text = await this.read(folder);
    if (text === undefined) return false;
    const state = decodeState(text);
    const entries = state.files; // Validate everything before replacing local state.
    const owns = key => this.workspace.getWorkspaceFolder(this.Uri.parse(key))?.uri.toString() === folder.uri.toString();
    for (const key of files.keys()) if (relativeKey(folder.uri, key) !== undefined && owns(key)) files.delete(key);
    for (const key of ignored) if (relativeKey(folder.uri, key) !== undefined && owns(key)) ignored.delete(key);
    for (const key of state.ignored) {
      const uri = this.Uri.joinPath(folder.uri, ...key.split('/')).toString();
      if (owns(uri)) ignored.add(uri);
    }
    for (const [key, record] of entries) {
      const uri = this.Uri.joinPath(folder.uri, ...key.split('/')).toString();
      if (owns(uri)) files.set(uri, normalize(record));
    }
    this.loaded.set(folder.uri.toString(), text);
    return true;
  }
  async enable(folder, files, ignored = new Set()) {
    if (await this.load(folder, files, ignored)) return;
    this.loaded.set(folder.uri.toString(), undefined);
    await this.saveFolder(folder, files, ignored);
  }
  async saveFolder(folder, files, ignored = new Set()) {
    const id = folder.uri.toString();
    if (!this.loaded.has(id)) return;
    const entries = [];
    for (const [uri, record] of files) {
      const key = relativeKey(folder.uri, uri);
      // Nested workspace roots own their records independently.
      const owner = this.workspace.getWorkspaceFolder(this.Uri.parse(uri));
      if (key !== undefined && owner?.uri.toString() === id) entries.push([key, record]);
    }
    entries.sort((a, b) => a[0].localeCompare(b[0], 'en'));
    const paths = [...ignored].filter(key => this.workspace.getWorkspaceFolder(this.Uri.parse(key))?.uri.toString() === id).map(key => relativeKey(folder.uri, key)).filter(Boolean).sort();
    const text = JSON.stringify({ version: 2, files: entries, ignored: paths }, null, 2) + '\n';
    if (Buffer.byteLength(text) > 32 * 1024 * 1024) throw Error('Review file exceeds 32 MiB.');
    const current = await this.read(folder);
    if (current !== this.loaded.get(id)) throw Error('Shared review state changed on disk. Use Human Review: Reload Shared Review State before saving again. Local marks remain in this window.');
    if (text === current) return;
    await this.workspace.fs.createDirectory(this.Uri.joinPath(folder.uri, '.code-reviewed'));
    await this.workspace.fs.writeFile(this.uri(folder), Buffer.from(text));
    this.loaded.set(id, text);
  }
  async save(files, ignored = new Set()) {
    for (const folder of this.workspace.workspaceFolders || []) await this.saveFolder(folder, files, ignored);
  }
}
module.exports = { PortableState, relativeKey, validPath, decode, decodeState };
