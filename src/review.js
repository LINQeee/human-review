'use strict';
const { normalize } = require('./core');
const clone = value => JSON.parse(JSON.stringify(value));
const isIgnored = (key, ignored = []) => typeof ignored === 'function' ? ignored(key) : [...ignored].some(path => key === path || key.startsWith(path + '/'));
function lineStatus(record, i) {
  return record.blank?.[i] ? 'blank' : record.reviewed[i] ? 'reviewed' : record.recheck?.[i] ? 'recheck' : 'new';
}
function needsReview(record, filter = 'all') {
  if (record.deletedFile) return (!record.deletionAcknowledged && filter !== 'new');
  if (record.pendingDeleted && filter !== 'new') return true;
  return record.reviewed.some((flag, i) => !record.blank?.[i] && !flag && (filter === 'all' || lineStatus(record, i) === filter))
   ;
}
function stats(record) {
  const reviewed = record.deletedFile ? 0 : record.reviewed.filter((flag, i) => !record.blank?.[i] && flag).length;
  const total = record.deletedFile ? 0 : record.reviewed.filter((_, i) => !record.blank?.[i]).length;
  const recheck = record.deletedFile ? 0 : record.reviewed.filter((flag, i) => !record.blank?.[i] && !flag && record.recheck?.[i]).length;
  return { reviewed, total, recheck, fresh: total - reviewed - recheck,
    pending: needsReview(record) ? 1 : 0,
    files: total || needsReview(record) ? 1 : 0, percent: total ? Math.floor(reviewed / total * 100) : 0 };
}
function mark(record, lines, value, text, whole = false) {
  Object.assign(record, normalize(record, text));
  lines = lines.filter(line => !record.blank[line]);
  if (!lines.length && !(whole && record.pendingDeleted)) return false;
  record.recheck ||= record.reviewed.map(() => false);
  if (value && !record.baseline) record.baseline = { text, at: new Date().toISOString(), complete: false };
  for (const line of lines) {
    record.reviewed[line] = value;
    record.recheck[line] = false;
  }
  if (value && (whole || (record.reviewed.every(Boolean) && !record.pendingDeleted))) {
    record.baseline = { text, at: new Date().toISOString(), complete: true };
    record.pendingDeleted = false;
  }
}
class ReviewHistory {
  constructor() { this.entries = []; }
  push(key, record) {
    const before = clone(record);
    // Bound snapshots, including source baselines, to 24 MiB in this window.
    const entry = { key, before, bytes: Buffer.byteLength(JSON.stringify(before)) };
    this.entries.push(entry);
    let bytes = this.entries.reduce((total, item) => total + item.bytes, 0);
    while (this.entries.length > 30 || bytes > 24 * 1024 * 1024) bytes -= this.entries.shift().bytes;
  }
  pop() { return this.entries.pop(); }
  clear() { this.entries = []; }
  rename(oldKey, nextKey) {
    for (const entry of this.entries) if (entry.key === oldKey || entry.key.startsWith(oldKey + '/')) entry.key = nextKey + entry.key.slice(oldKey.length);
  }
}
module.exports = { clone, isIgnored, lineStatus, needsReview, stats, mark, ReviewHistory };
