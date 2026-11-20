'use strict';
const { IGNORE_FILE, patterns } = require('./ignore');
// This module is also shipped as .code-reviewed/ci/report.cjs. No npm install,
// VS Code, project build, or source execution is needed to calculate coverage.
const fs = require('node:fs/promises');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { fresh, reconcile, normalize } = require('./core');
const { stats, isIgnored } = require('./review');
const { decodeState, validPath } = require('./portable');
const DEFAULT_CONFIG = {
  version: 1, include: ['**/*'],
  exclude: ['**/.git/**', '**/node_modules/**', '**/.code-reviewed/**', '**/.venv/**', '**/venv/**', '**/dist/**', '**/build/**', '**/coverage/**', '.github/workflows/code-reviewed.yml'],
  maxFiles: 10000, maxFileLines: 20000, maxFileBytes: 4194304
};
const STATE_FILE = '.code-reviewed/review.json';
const CONFIG_FILE = '.code-reviewed/badge.config.json';
function glob(pattern) {
  let output = '^';
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i];
    if (char === '*' && pattern[i + 1] === '*') {
      i++;
      if (pattern[i + 1] === '/') { i++; output += '(?:.*/)?'; } else output += '.*';
    } else if (char === '*') output += '[^/]*';
    else if (char === '?') output += '[^/]';
    else output += char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(output + '$');
}
function configFor(value) {
  const result = { ...DEFAULT_CONFIG, ...value };
  if (result.version !== 1) throw Error('Unsupported badge configuration.');
  for (const key of ['include', 'exclude']) {
    if (!Array.isArray(result[key]) || result[key].length > 100 || !result[key].every(item => typeof item === 'string' && item.length > 0 && item.length <= 300 && !item.includes('\\') && !item.startsWith('/') && !item.split('/').includes('..'))) throw Error('Invalid badge file patterns.');
  }
  if (!result.include.length) throw Error('At least one include pattern is required.');
  for (const [key, max] of [['maxFiles', 100000], ['maxFileLines', 100000], ['maxFileBytes', 4194304]]) {
    if (!Number.isInteger(result[key]) || result[key] < 1 || result[key] > max) throw Error(`Invalid ${key}.`);
  }
  return result;
}
function git(root, args) { return execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }).trimEnd(); }
async function readBounded(root, relative, limit, detectBinary = false) {
  const parts = relative.split('/');
  if (parts.some(item => item === '..' || item === '.' || !item) || path.isAbsolute(relative)) throw Error('Unsafe file path.');
  // Do not follow a symlink directory/file out of the repository.
  let file = root;
  for (const part of parts) { file = path.join(file, part); if ((await fs.lstat(file)).isSymbolicLink()) throw Error('Symbolic link'); }
  const stat = await fs.stat(file);
  if (!stat.isFile()) throw Error('Not a regular file');
  if (stat.size > limit) {
    // Classify large media before applying the text-size limit. A bounded probe
    // cannot prove text, so large/unknown text still makes the report incomplete.
    if (detectBinary) {
      const handle = await fs.open(file, 'r');
      try {
        const buffer = Buffer.alloc(8192);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        const sample = buffer.subarray(0, bytesRead);
        let binary = sample.includes(0);
        try { new TextDecoder('utf-8', { fatal: true }).decode(sample, { stream: true }); } catch { binary = true; }
        if (binary) throw Object.assign(Error('Binary or non-UTF-8 (outside text scope)'), { code: 'BINARY_FILE' });
      } finally { await handle.close(); }
    }
    throw Error('File size limit');
  }
  const bytes = await fs.readFile(file);
  if (bytes.length > limit) throw Error('File size limit');
  return bytes;
}
async function calculate(root) {
  root = path.resolve(root);
  const report = { schemaVersion: 1, commit: null, generatedAt: new Date().toISOString(), complete: false,
    methodology: 'Self-reported human review of nonblank lines in eligible Git-tracked UTF-8 text files; exact content reconciliation, not proof of correctness or identity.',
    reviewed: 0, total: 0, needsReReview: 0, pendingDeletions: 0, percentage: null,
    files: [], excluded: [], skipped: [], issues: [], config: null };
  let state = { files: [], ignored: [] }, config;
  try {
    report.commit = git(root, ['rev-parse', 'HEAD']);
    if (!/^[a-f0-9]{40,64}$/.test(report.commit)) throw Error('Invalid commit identifier');
    const top = await fs.realpath(git(root, ['rev-parse', '--show-toplevel']));
    if (top !== await fs.realpath(root)) throw Error('Run the reporter from the repository root.');
    config = configFor(JSON.parse((await readBounded(root, CONFIG_FILE, 65536)).toString('utf8')));
    report.config = config;
    const bytes = await readBounded(root, STATE_FILE, 32 * 1024 * 1024);
    state = decodeState(bytes.toString('utf8'));
    report.stateDigest = createHash('sha256').update(bytes).digest('hex');
  } catch (error) { report.issues.push(`Configuration or review state unavailable: ${error.message}`); }
  if (!config) return finish(report);
  let tracked;
  try {
    // No shell expansion; -z preserves spaces and other legal filename bytes.
    tracked = git(root, ['ls-files', '-z']).split('\0').filter(Boolean);
    if (!tracked.includes(STATE_FILE) || !tracked.includes(CONFIG_FILE)) report.issues.push('Review state and badge configuration must both be committed.');
    try { git(root, ['diff', '--quiet', 'HEAD', '--']); }
    catch { report.issues.push('Working tree differs from the reported commit.'); }
  } catch (error) { report.issues.push(`Cannot enumerate tracked files: ${error.message}`); return finish(report); }
  let ignorePatterns = patterns();
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(await readBounded(root, IGNORE_FILE, 65536));
    ignorePatterns = patterns(text);
    if (!tracked.includes(IGNORE_FILE)) report.issues.push('Ignore patterns must be committed.');
  } catch (error) { if (error.code !== 'ENOENT') report.issues.push(`Ignore patterns unavailable: ${error.message}`); }
  const include = config.include.map(glob), exclude = config.exclude.map(glob);
  const inScope = name => name !== IGNORE_FILE && !ignorePatterns.ignores(name) && !name.startsWith('.code-reviewed/') && !name.startsWith('.git/')
    && include.some(pattern => pattern.test(name)) && !exclude.some(pattern => pattern.test(name)) && !isIgnored(name, state.ignored);
  const records = new Map(state.files), trackedSet = new Set(tracked);
  const candidates = [];
  for (const name of tracked.sort()) {
    if (inScope(name)) candidates.push(name);
    else report.excluded.push(name);
  }
  report.ignoredPaths = state.ignored;
  if (candidates.length > config.maxFiles) report.issues.push(`File limit reached: ${candidates.length} candidates, maximum ${config.maxFiles}.`);
  for (const name of candidates.slice(0, config.maxFiles)) {
    if (!validPath(name)) { report.skipped.push({ path: name, reason: 'Unsupported path', incomplete: true }); continue; }
    try {
      const bytes = await readBounded(root, name, config.maxFileBytes, true);
      let text;
      try {
        if (bytes.includes(0)) throw Error('binary');
        text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      } catch { report.skipped.push({ path: name, reason: 'Binary or non-UTF-8 (outside text scope)', incomplete: false }); continue; }
      if (text.split(/\r\n|\n|\r/).length > config.maxFileLines) throw Error('Line limit');
      const record = records.has(name) ? reconcile(records.get(name), text) : fresh(text);
      const count = stats(record);
      report.reviewed += count.reviewed; report.total += count.total;
      report.needsReReview += count.recheck;
      if (record.pendingDeleted) report.pendingDeletions++;
      report.files.push({ path: name, reviewed: count.reviewed, total: count.total, needsReReview: count.recheck,
        pendingDeletion: !!record.pendingDeleted });
    } catch (error) { report.skipped.push({ path: name, reason: error.message, incomplete: error.code !== 'BINARY_FILE' }); }
  }
  for (const [name, saved] of records) {
    const record = normalize({ ...saved, deletedFile: true });
    if (!trackedSet.has(name) && inScope(name) && record.baseline) {
      if (!record.deletionAcknowledged) report.pendingDeletions++;
      if (!record.deletionAcknowledged) report.files.push({ path: name, reviewed: 0, total: 0, needsReReview: 0, pendingDeletion: !record.deletionAcknowledged, deleted: true });
    }
  }
  return finish(report);
}
function finish(report) {
  report.complete = !report.issues.length && !report.skipped.some(item => item.incomplete);
  report.percentage = report.complete && report.total ? Math.floor(report.reviewed / report.total * 100) : null;
  return report;
}
function badgeData(report) {
  const message = !report.complete ? 'incomplete' : report.percentage === null ? 'n/a' : `${report.percentage}%${report.pendingDeletions ? ' · deletions pending' : ''}`;
  const color = !report.complete || report.percentage === null ? '9f9f9f' : report.pendingDeletions ? 'dfb317' : report.percentage === 100 ? '4c1' : report.percentage >= 70 ? '97ca00' : 'dfb317';
  return { schemaVersion: 1, label: 'human reviewed', message, color };
}
const xml = text => String(text).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[char]));
function badgeSvg(report) {
  const badge = badgeData(report), left = 112, right = Math.max(44, badge.message.length * 7 + 16), width = left + right;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="20" role="img" aria-label="${xml(badge.label + ': ' + badge.message)}"><title>${xml(badge.label + ': ' + badge.message)}</title><rect width="${width}" height="20" rx="3" fill="#555"/><path fill="#${badge.color}" d="M${left} 0h${right - 3}a3 3 0 0 1 3 3v14a3 3 0 0 1-3 3H${left}z"/><g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" font-size="11"><text x="${left / 2}" y="14">human reviewed</text><text x="${left + right / 2}" y="14">${xml(badge.message)}</text></g></svg>\n`;
}
const md = value => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\|/g, '&#124;').replace(/`/g, '&#96;').replace(/[\r\n]/g, ' ');
function markdown(report) {
  const lines = ['# Human review coverage', '', `**${md(badgeData(report).message)}** · ${report.reviewed}/${report.total} nonblank lines reviewed.`, '',
    `Commit: \`${md(report.commit || 'unknown')}\` · Generated: ${md(report.generatedAt)}`, '', report.methodology, '',
    `Needs re-review: ${report.needsReReview} lines. Pending deletions: ${report.pendingDeletions} files.`, '',
    'Blank and whitespace-only lines never contribute. Comments and documentation do count when their files are in scope. No source snapshots are included in this report.', '',
    '## Scope', '', '```json', JSON.stringify(report.config, null, 2), '```', '', '## Files', '', '| Path | Reviewed | Nonblank lines | Needs re-review | Deleted code pending |', '| --- | ---: | ---: | ---: | --- |'];
  for (const file of report.files) lines.push(`| ${md(file.path)} | ${file.reviewed} | ${file.total} | ${file.needsReReview} | ${file.pendingDeletion ? 'yes' : 'no'} |`);
  lines.push('', '## Incomplete checks', '');
  for (const issue of report.issues) lines.push(`- ${md(issue)}`);
  if (!report.issues.length) lines.push('None.');
  lines.push('', '## Skipped files', '');
  for (const item of report.skipped) lines.push(`- ${md(item.path)} — ${md(item.reason)}`);
  lines.push('', '## Excluded paths', '');
  for (const item of report.excluded) lines.push(`- ${md(item)}`);
  lines.push('', '## User exclusions', '');
  for (const item of report.ignoredPaths || []) lines.push(`- ${md(item)}`);
  return lines.join('\n') + '\n';
}
async function writeReport(report, destination) {
  await fs.mkdir(destination, { recursive: true });
  for (const [name, text] of Object.entries({ 'report.json': JSON.stringify(report, null, 2) + '\n', 'report.md': markdown(report), 'badge.json': JSON.stringify(badgeData(report)) + '\n', 'badge.svg': badgeSvg(report) })) {
    await fs.writeFile(path.join(destination, name), text);
  }
}
async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== '--output') throw Error('Usage: node .code-reviewed/ci/report.cjs --output OUTPUT_DIRECTORY (from repository root)');
  const report = await calculate(process.cwd());
  await writeReport(report, path.resolve(args[1]));
  if (process.env.GITHUB_STEP_SUMMARY) await fs.appendFile(process.env.GITHUB_STEP_SUMMARY, `## Human reviewed\n\n${badgeData(report).message} · ${report.reviewed}/${report.total} nonblank lines.\n\nCommit: ${report.commit || 'unknown'}. Download the human-review-report artifact for scope, exclusions and pending work.\n`);
  process.stdout.write(`human reviewed: ${badgeData(report).message} (${report.reviewed}/${report.total} nonblank lines)\n`);
}
if (require.main === module) main().catch(error => { process.stderr.write(`Human Review report failed: ${error.message}\n`); process.exitCode = 1; });
module.exports = { DEFAULT_CONFIG, configFor, glob, calculate, badgeData, badgeSvg, markdown, writeReport };
