'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const { fresh } = require('../src/core');
const { mark } = require('../src/review');
const { DEFAULT_CONFIG, calculate, badgeData, badgeSvg, markdown, writeReport, glob } = require('../src/report');
async function fixture(t, files, records = [], config = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'code-reviewed-report-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args], { cwd: root, stdio: 'pipe', encoding: 'utf8' });
  git('init', '--template=', '-b', 'main');
  const write = async (name, text) => { await fs.mkdir(path.dirname(path.join(root, name)), { recursive: true }); await fs.writeFile(path.join(root, name), text); };
  for (const [name, text] of Object.entries(files)) await write(name, text);
  await write('.code-reviewed/badge.config.json', JSON.stringify({ ...DEFAULT_CONFIG, ...config }));
  await write('.code-reviewed/review.json', JSON.stringify({ version: 2, files: records, ignored: [] }));
  const commit = () => { git('add', '-A'); git('commit', '-m', 'fixture'); };
  commit(); return { root, git, write, commit };
}
const approved = text => { const record = fresh(text); mark(record, record.hashes.map((_, i) => i), true, text, true); return record; };
test('report uses the same nonblank denominator and never exports source text', async t => {
  const record = approved('private source\n\n');
  const env = await fixture(t, { 'src/a.js': 'private source\n\n', 'src/b.js': 'unread\n \n', 'image.bin': Buffer.from([0, 1, 2]) }, [['src/a.js', record]]);
  const report = await calculate(env.root);
  assert.equal(report.complete, true); assert.equal(report.percentage, 50);
  assert.equal(report.total, 2); assert.equal(report.reviewed, 1);
  const serialized = JSON.stringify(report) + markdown(report);
  assert.ok(!serialized.includes('private source'));
  assert.match(badgeSvg(report), /50%/);
  assert.equal(report.commit, env.git('rev-parse', 'HEAD').trim());
});
test('a subsequent code commit reduces coverage without opening the extension', async t => {
  const env = await fixture(t, { 'src/a.js': 'one\ntwo\n' }, [['src/a.js', approved('one\ntwo\n')]]);
  assert.equal((await calculate(env.root)).percentage, 100);
  await env.write('src/a.js', 'one\nchanged\n'); env.commit();
  const report = await calculate(env.root);
  assert.equal(report.percentage, 50); assert.equal(report.needsReReview, 1);
});
test('oversize files and scan truncation yield incomplete, never 100%', async t => {
  const env = await fixture(t, { 'a.js': 'a', 'b.js': 'b' }, [['a.js', approved('a')]], { maxFiles: 1 });
  const report = await calculate(env.root);
  assert.equal(report.complete, false); assert.equal(report.percentage, null);
  assert.equal(badgeData(report).message, 'incomplete');
  await env.write('.code-reviewed/badge.config.json', JSON.stringify({ ...DEFAULT_CONFIG, maxFileBytes: 1 }));
  await env.write('b.js', 'too long'); env.commit();
  assert.equal((await calculate(env.root)).complete, false);
});
test('malformed saved state and dirty source fail closed', async t => {
  const env = await fixture(t, { 'a.js': 'a' }, [['a.js', approved('a')]]);
  await env.write('a.js', 'changed');
  assert.equal((await calculate(env.root)).complete, false);
  await env.write('.code-reviewed/review.json', '<<<<<<< conflict'); env.commit();
  assert.equal((await calculate(env.root)).percentage, null);
});
test('blank-only projects report n/a, while deletion counts remain visible', async t => {
  const env = await fixture(t, { 'empty.js': ' \n\t\n' }, [['gone.js', approved('removed')]]);
  const report = await calculate(env.root);
  assert.equal(report.total, 0); assert.equal(report.percentage, null);
  assert.equal(report.pendingDeletions, 1); assert.equal(badgeData(report).message, 'n/a');
});
test('symlinks are not followed outside the checkout or silently counted as complete', async t => {
  const env = await fixture(t, { 'a.js': 'a' });
  await fs.symlink('/etc/passwd', path.join(env.root, 'outside.js')); env.commit();
  const report = await calculate(env.root);
  assert.equal(report.complete, false);
  assert.ok(report.skipped.some(item => item.reason === 'Symbolic link'));
});
test('glob scope supports root and nested files and reports exclusions', async t => {
  assert.ok(glob('**/*.js').test('root.js')); assert.ok(glob('**/*.js').test('src/root.js'));
  const env = await fixture(t, { 'a.js': 'a', 'docs/readme.md': 'unreviewed docs' }, [['a.js', approved('a')]], { include: ['**/*.js'] });
  const report = await calculate(env.root);
  assert.equal(report.percentage, 100); assert.ok(report.excluded.includes('docs/readme.md'));
  const output = path.join(env.root, '.code-reviewed/report'); await writeReport(report, output);
  assert.equal(JSON.parse(await fs.readFile(path.join(output, 'badge.json'), 'utf8')).message, '100%');
});


test('large binary media are excluded before text size limits, while large text remains incomplete', async t => {
  const env = await fixture(t, { 'source.js': 'a', 'large-media.bin': Buffer.alloc(4096) }, [['source.js', approved('a')]], { maxFileBytes: 64 });
  let report = await calculate(env.root);
  assert.equal(report.complete, true); assert.equal(report.percentage, 100);
  assert.ok(report.skipped.some(item => item.path === 'large-media.bin' && item.incomplete === false));
  await env.write('large-text.js', 'a'.repeat(4096)); env.commit();
  report = await calculate(env.root);
  assert.equal(report.complete, false); assert.equal(report.percentage, null);
});
test('committed gitignore-style exclusions and exceptions use the same coverage scope', async t => {
  const env = await fixture(t, { '.code-reviewedignore': '*.svg\n!keep.svg\nvendor/\n', 'icons/a.svg': 'ignored', 'keep.svg': 'kept', 'a.js': 'code', 'vendor/a.js': 'ignored' }, [['a.js', approved('code')], ['gone.svg', approved('old')]]);
  const report = await calculate(env.root);
  assert.equal(report.complete, true); assert.equal(report.total, 2); assert.equal(report.percentage, 50);
  assert.equal(report.pendingDeletions, 0);
  assert.ok(report.excluded.includes('icons/a.svg')); assert.ok(report.excluded.includes('.code-reviewedignore'));
});
test('uncommitted or unreadable ignore rules cannot produce a complete badge', async t => {
  const env = await fixture(t, { 'a.svg': 'source' });
  await env.write('.code-reviewedignore', '*.svg');
  assert.equal((await calculate(env.root)).complete, false);
  await env.write('.code-reviewedignore', 'x'.repeat(65537)); env.commit();
  assert.equal((await calculate(env.root)).complete, false);
});
