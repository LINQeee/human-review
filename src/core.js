'use strict';
const { createHash } = require('node:crypto');
const EMPTY_HASH = createHash('sha256').update('').digest('hex');
const blankMask = text => text.split(/\r\n|\n|\r/).map(line => line.trim().length === 0);
function normalize(record, text) {
  let blank = text === undefined ? record.blank : blankMask(text);
  if (!blank) {
    const known = new Set([EMPTY_HASH]);
    if (record.baseline) record.baseline.text.split(/\r\n|\n|\r/).forEach(line => { if (!line.trim()) known.add(fingerprints(line)[0]); });
    blank = record.hashes.map(hash => known.has(hash));
  }
  const result = { ...record, blank, reviewed: record.reviewed.map((flag, i) => blank[i] || flag),
    recheck: record.hashes.map((_, i) => !blank[i] && !!record.recheck?.[i]) };
  if (blank.every(Boolean) && !record.baseline?.text.trim()) {
    result.pendingDeleted = false;
    if (result.deletedFile) result.deletionAcknowledged = true;
  }
  if (text !== undefined && result.pendingDeleted && record.baseline && !result.deletedFile) {
    const content = value => value.split(/\r\n|\n|\r/).filter(line => line.trim()).join('\n');
    if (content(record.baseline.text) === content(text)) result.pendingDeleted = false;
  }
  delete result.notes; // Drop legacy annotations while retaining review marks.
  return result;
}

function fingerprints(text) {
  return text.split(/\r\n|\n|\r/).map(line => createHash('sha256').update(line).digest('hex'));
}
function fresh(text) {
  const hashes = fingerprints(text);
  return normalize({ hashes, reviewed: hashes.map(() => false), recheck: hashes.map(() => false) }, text);
}
function counts(values) {
  const result = new Map();
  for (const value of values) result.set(value, (result.get(value) || 0) + 1);
  return result;
}

// A bounded patience-style match: only globally unique, order-preserving lines
// are carried across an unknown edit. Repeated lines are deliberately invalidated
// rather than assigning a previous review to the wrong occurrence.
function reconcile(previous, text) {
  previous = normalize(previous);
  const hashes = fingerprints(text);
  if (hashes.length === previous.hashes.length && hashes.every((h, i) => h === previous.hashes[i])) {
    return normalize({ ...previous, hashes, reviewed: [...previous.reviewed], recheck: [...previous.recheck], deletedFile: false, deletionAcknowledged: false }, text);
  }
  const before = counts(previous.hashes);
  const after = counts(hashes);
  const oldPositions = new Map();
  previous.hashes.forEach((h, i) => { if (before.get(h) === 1) oldPositions.set(h, i); });
  const pairs = [];
  hashes.forEach((h, i) => {
    if (after.get(h) === 1 && oldPositions.has(h)) pairs.push({ old: oldPositions.get(h), next: i });
  });
  const tails = [], links = [];
  pairs.forEach((pair, i) => {
    let low = 0, high = tails.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (pairs[tails[middle]].old < pair.old) low = middle + 1;
      else high = middle;
    }
    links[i] = low ? tails[low - 1] : -1;
    tails[low] = i;
  });
  const mapping = new Map();
  for (let i = tails.length ? tails[tails.length - 1] : -1; i >= 0; i = links[i]) {
    const pair = pairs[i];
    mapping.set(pair.next, pair.old);
  }
  return evolve(previous, hashes, mapping, text);
}

// VS Code change ranges refer to the original document. Descending processing
// keeps the positions valid for multiple cursors and disjoint edits.
function applyChanges(previous, text, changes) {
  previous = normalize(previous);
  // Reloads/formatters can replace the full buffer in a single event. Use
  // conservative content matching instead of treating every line as touched.
  if (changes.length === 1) {
    const { start, end } = changes[0].range;
    if (start.line === 0 && start.character === 0 && end.line === previous.hashes.length - 1) {
      return reconcile(previous, text);
    }
  }
  const hashes = fingerprints(text);
  const mapping = new Map();
  const ordered = [...changes].sort((a, b) => b.rangeOffset - a.rangeOffset);
  previous.hashes.forEach((hash, index) => {
    let line = index;
    for (const change of ordered) {
      const { start, end } = change.range;
      const delta = change.text.split(/\r\n|\n|\r/).length - 1 - (end.line - start.line);
      if (line < start.line) continue;
      if (line > end.line || (line === end.line && end.character === 0)) line += delta;
      else { line = -1; break; }
    }
    if (line >= 0 && hashes[line] === hash) mapping.set(line, index);
  });
  return evolve(previous, hashes, mapping, text);
}
// Carry review state only through confirmed line correspondence. Gaps that
// replace previously reviewed code become recheck; pure insertions remain new.
function evolve(previous, hashes, mapping, text) {
  const blank = blankMask(text);
  const reviewed = hashes.map(() => false);
  const recheck = hashes.map(() => false);
  let pendingDeleted = !!previous.pendingDeleted;
  if (pendingDeleted && previous.baseline) {
    const content = value => value.split(/\r\n|\n|\r/).filter(line => line.trim()).join('\n');
    if (content(previous.baseline.text) === content(text)) pendingDeleted = false;
  }
  const pairs = [...mapping].sort((a, b) => a[0] - b[0]);
  let oldStart = 0, nextStart = 0;
  for (const [next, old] of [...pairs, [hashes.length, previous.hashes.length]]) {
    let wasReviewed = false;
    let oldCode = 0, newCode = 0;
    for (let i = oldStart; i < old; i++) {
      if (previous.blank[i]) continue;
      oldCode++;
      if (previous.reviewed[i] || previous.recheck?.[i]) wasReviewed = true;
    }
    for (let i = nextStart; i < next; i++) if (!blank[i]) newCode++;
    if (previous.baseline && oldCode > newCode) pendingDeleted = true;
    if (wasReviewed) {
      for (let i = nextStart; i < next; i++) recheck[i] = true;
      if (oldCode > newCode) pendingDeleted = true;
    }
    if (next < hashes.length) {
      reviewed[next] = previous.reviewed[old] === true;
      recheck[next] = !reviewed[next] && previous.recheck?.[old] === true;
    }
    oldStart = old + 1; nextStart = next + 1;
  }
  return normalize({ ...previous, hashes, reviewed, recheck, pendingDeleted, deletedFile: false, deletionAcknowledged: false }, text);
}
function selectedLines(selections, lineCount) {
  const result = new Set();
  for (const { start, end } of selections) {
    const last = end.line > start.line && end.character === 0 ? end.line - 1 : end.line;
    for (let i = Math.max(0, start.line); i <= Math.min(last, lineCount - 1); i++) result.add(i);
  }
  return [...result];
}
function nextUnreviewed(record, current) {
  for (let step = 1; step <= record.reviewed.length; step++) {
    const line = (current + step) % record.reviewed.length;
    if (!record.blank?.[line] && !record.reviewed[line]) return line;
  }
  return -1;
}
function validRecord(value) {
  const bools = (items, length) => Array.isArray(items) && items.length === length && items.every(flag => typeof flag === 'boolean');
  if (!value || !Array.isArray(value.hashes) || !value.hashes.length || value.hashes.length > 100000
    || !value.hashes.every(hash => typeof hash === 'string' && /^[a-f0-9]{64}$/.test(hash))
    || !bools(value.reviewed, value.hashes.length)) return false;
  if (value.blank !== undefined && !bools(value.blank, value.hashes.length)) return false;
  if (value.recheck !== undefined && !bools(value.recheck, value.hashes.length)) return false;
  for (const key of ['pendingDeleted', 'deletedFile', 'deletionAcknowledged']) if (value[key] !== undefined && typeof value[key] !== 'boolean') return false;
  if (value.baseline !== undefined && (!value.baseline || typeof value.baseline.text !== 'string'
    || value.baseline.text.length > 4 * 1024 * 1024 || typeof value.baseline.at !== 'string'
    || value.baseline.at.length > 64 || typeof value.baseline.complete !== 'boolean')) return false;
  return true;
}
module.exports = { normalize, blankMask, fingerprints, fresh, reconcile, applyChanges, selectedLines, nextUnreviewed, validRecord };
