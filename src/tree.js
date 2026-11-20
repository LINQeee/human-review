'use strict';
const { stats, needsReview } = require('./review');
function buildFileTree(inventory, getFolder, showRoots = false, filter = 'all') {
  const roots = [], nodes = new Map(), files = new Map();
  function folderNode(key, label, parent) {
    const id = `folder:${key}`;
    if (nodes.has(id)) return nodes.get(id);
    const node = { kind: 'folder', key, id, label, parent, children: [] };
    nodes.set(id, node);
    (parent ? parent.children : roots).push(node);
    return node;
  }
  for (const [key, record] of inventory) {
    const workspace = getFolder(key);
    if (!workspace?.uri) continue;
    const root = workspace.uri.toString().replace(/\/$/, '');
    if (!key.startsWith(root + '/')) continue;
    const parts = key.slice(root.length + 1).split('/');
    let parent = showRoots ? folderNode(root, workspace.name || decodeURIComponent(root.split('/').pop()), undefined) : undefined;
    let directory = root;
    for (const segment of parts.slice(0, -1)) {
      directory += '/' + segment;
      parent = folderNode(directory, decodeURIComponent(segment), parent);
    }
    const node = { kind: 'file', key, id: `file:${key}`, label: decodeURIComponent(parts.at(-1)), parent,
      stats: stats(record), visible: needsReview(record, filter) };
    if (node.visible) files.set(key, node);
    (parent ? parent.children : roots).push(node);
  }
  function aggregate(children) {
    const total = { reviewed: 0, total: 0, recheck: 0, fresh: 0, pending: 0, files: 0 };
    for (const node of children) {
      if (node.children) {
        node.stats = aggregate(node.children);
        node.children = node.children.filter(child => child.visible);
        node.visible = node.children.length > 0;
      }
      for (const key of Object.keys(total)) total[key] += node.stats[key];
    }
    total.percent = total.total ? Math.floor(total.reviewed / total.total * 100) : 0;
    children.sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'folder' ? -1 : 1)
      || a.label.localeCompare(b.label, undefined, { numeric: true, sensitivity: 'base' }) || a.key.localeCompare(b.key));
    return total;
  }
  const totals = aggregate(roots);
  return { roots: roots.filter(node => node.visible), files, nodes, totals };
}
module.exports = { buildFileTree };
