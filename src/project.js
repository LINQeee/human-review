'use strict';
const { fresh, reconcile, normalize } = require('./core');
const { isIgnored, lineStatus } = require('./review');
const EXCLUDE = '**/{.git,node_modules,.code-reviewed,.venv,venv,dist,build,coverage}/**';
function unreviewedRanges(record, filter = 'all') {
  const result = [];
  if (record.deletedFile) return result;
  const matches = i => !record.blank?.[i] && !record.reviewed[i] && (filter === 'all' || lineStatus(record, i) === filter);
  for (let i = 0; i < record.reviewed.length; i++) {
    if (!matches(i)) continue;
    const start = i, status = lineStatus(record, i);
    while (i + 1 < record.reviewed.length && matches(i + 1) && lineStatus(record, i + 1) === status) i++;
    result.push({ start, end: i });
  }
  return result;
}
function nextTarget(inventory, key, line, filter = 'all') {
  const keys = [...inventory.keys()].sort();
  const ranges = candidate => unreviewedRanges(inventory.get(candidate), filter).map(range => ({ key: candidate, ...range }));
  const same = inventory.has(key) ? ranges(key) : [];
  const following = same.find(range => range.start > line);
  if (following) return following;
  const index = keys.indexOf(key);
  for (let i = 1; i <= keys.length; i++) {
    const candidate = keys[(index + i + keys.length) % keys.length];
    if (candidate === key) continue;
    const range = ranges(candidate)[0];
    if (range) return range;
  }
  return same[0];
}
async function scanProject(workspace, tracked, limit, cancelled = () => false, ignored = new Set(), parseUri = key => ({ toString: () => key })) {
  const uris = await workspace.findFiles('**/*', EXCLUDE, 10001);
  const files = new Map();
  let skipped = 0;
  const queue = uris.filter(uri => !isIgnored(uri.toString(), ignored)).slice(0, 10000);
  let index = 0;
  async function worker() {
    while (index < queue.length && !cancelled()) {
      const uri = queue[index++];
      try {
        const opened = workspace.textDocuments.find(doc => doc.uri.toString() === uri.toString());
        let text;
        if (opened) text = opened.getText();
        else {
          const stat = await workspace.fs.stat(uri);
          if (stat.size > 4 * 1024 * 1024) { skipped++; continue; }
          const bytes = await workspace.fs.readFile(uri);
          if (bytes.includes(0)) { skipped++; continue; }
          text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        }
        if (text.length > 4 * 1024 * 1024 || text.split(/\r\n|\n|\r/).length > limit) { skipped++; continue; }
        const previous = tracked.get(uri.toString());
        files.set(uri.toString(), previous ? reconcile(previous, text) : fresh(text));
      } catch { skipped++; }
    }
  }
  await Promise.all([worker(), worker(), worker(), worker()]);
  // Deletions must remain reviewable, even when the entire file has vanished.
  for (const [key, record] of tracked) {
    if (cancelled()) break;
    if (files.has(key) || isIgnored(key, ignored) || !record.baseline) continue;
    try { await workspace.fs.stat(parseUri(key)); }
    catch (error) {
      if (error.code === 'FileNotFound' || error.code === 'ENOENT') {
        files.set(key, normalize({ ...record, deletedFile: true, pendingDeleted: !record.deletionAcknowledged }));
      }
    }
  }
  return { files, skipped, truncated: uris.length > 10000 };
}
module.exports = { unreviewedRanges, scanProject, nextTarget };
