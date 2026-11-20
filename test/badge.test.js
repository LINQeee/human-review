'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const { repositoryName, updateReadme, preparePlan, checkPlan, applyPlan } = require('../src/badge');
class Uri {
  constructor(value) { this.fsPath = value; }
  toString() { return 'file://' + this.fsPath; }
  static joinPath(root, ...parts) { return new Uri(path.join(root.fsPath, ...parts)); }
}
async function workspace(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'code-reviewed-setup-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const api = { textDocuments: [], fs: {
    readFile: uri => fs.readFile(uri.fsPath), writeFile: (uri, bytes) => fs.writeFile(uri.fsPath, bytes),
    createDirectory: uri => fs.mkdir(uri.fsPath, { recursive: true }), delete: uri => fs.unlink(uri.fsPath)
  } };
  return { root, api, folder: { uri: new Uri(root) }, extension: new Uri(path.resolve(__dirname, '..')) };
}
test('repository input accepts GitHub URLs but rejects unsafe text or other hosts', () => {
  assert.equal(repositoryName('git@github.com:owner/repo.git'), 'owner/repo');
  assert.equal(repositoryName('https://github.com/owner/repo'), 'owner/repo');
  for (const value of ['owner/repo\nrun: bad', '../repo', 'https://evil.test/owner/repo', 'owner/repo;command']) assert.equal(repositoryName(value), undefined);
});
test('README updates preserve text and are idempotent', () => {
  const initial = '# Project\n\nKeep my content.\n';
  const updated = updateReadme(initial, 'owner/repo');
  assert.ok(updated.startsWith('# Project\n\n<!-- code-reviewed:badge:start -->'));
  assert.ok(updated.includes('Keep my content.'));
  assert.match(updated, /\]\(\/\.\.\/code-reviewed-badge\/badge\.svg\)/);
  assert.ok(!updated.includes('raw.githubusercontent.com'));
  assert.equal(updateReadme(updated, 'owner/repo'), updated);
  assert.throws(() => updateReadme('<!-- code-reviewed:badge:start -->', 'owner/repo'), /malformed/);
});
test('setup creates a runnable standalone reporter inside an ESM repository', async t => {
  const env = await workspace(t);
  await fs.writeFile(path.join(env.root, 'package.json'), '{"type":"module"}');
  await fs.writeFile(path.join(env.root, 'README.md'), '# Existing project\n');
  const plan = await preparePlan(env.api, Uri, env.extension, env.folder, 'owner/repo');
  const before = await checkPlan(env.api, Uri, env.folder, plan);
  await applyPlan(env.api, Uri, env.folder, plan, before);
  const git = (...args) => execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args], { cwd: env.root, encoding: 'utf8', stdio: 'pipe' });
  git('init', '--template=', '-b', 'main');
  await fs.writeFile(path.join(env.root, '.code-reviewed/review.json'), '{"version":2,"files":[],"ignored":[]}');
  git('add', '-A'); git('commit', '-m', 'setup');
  const stdout = execFileSync(process.execPath, ['.code-reviewed/ci/report.cjs', '--output', '.code-reviewed/report'], { cwd: env.root, encoding: 'utf8' });
  assert.match(stdout, /human reviewed: 0%/);
  const report = JSON.parse(await fs.readFile(path.join(env.root, '.code-reviewed/report/report.json'), 'utf8'));
  assert.equal(report.complete, true); assert.equal(report.percentage, 0);
  const next = await preparePlan(env.api, Uri, env.extension, env.folder, 'owner/repo');
  await applyPlan(env.api, Uri, env.folder, next, await checkPlan(env.api, Uri, env.folder, next));
  assert.equal(await fs.readFile(path.join(env.root, 'README.md'), 'utf8'), plan.files.get('README.md'));
});
test('setup refuses customized workflows and unsaved README without changing them', async t => {
  const env = await workspace(t);
  const plan = await preparePlan(env.api, Uri, env.extension, env.folder, 'owner/repo');
  await fs.mkdir(path.join(env.root, '.github/workflows'), { recursive: true });
  await fs.writeFile(path.join(env.root, '.github/workflows/code-reviewed.yml'), 'custom workflow');
  await assert.rejects(checkPlan(env.api, Uri, env.folder, plan), /differs/);
  assert.equal(await fs.readFile(path.join(env.root, '.github/workflows/code-reviewed.yml'), 'utf8'), 'custom workflow');
  await fs.unlink(path.join(env.root, '.github/workflows/code-reviewed.yml'));
  env.api.textDocuments.push({ uri: new Uri(path.join(env.root, 'README.md')), isDirty: true });
  await assert.rejects(checkPlan(env.api, Uri, env.folder, plan), /Save README/);
});
test('setup rolls back earlier created files on a later write failure', async t => {
  const env = await workspace(t);
  const plan = await preparePlan(env.api, Uri, env.extension, env.folder, 'owner/repo');
  const before = await checkPlan(env.api, Uri, env.folder, plan);
  const write = env.api.fs.writeFile; let writes = 0;
  env.api.fs.writeFile = (uri, bytes) => { if (++writes === 3) throw Error('disk full'); return write(uri, bytes); };
  await assert.rejects(applyPlan(env.api, Uri, env.folder, plan, before), /disk full/);
  await assert.rejects(fs.readFile(path.join(env.root, '.github/workflows/code-reviewed.yml')), /ENOENT/);
});
test('workflow isolates read-only calculation from default-branch publication', async () => {
  const text = await fs.readFile(path.resolve(__dirname, '../templates/code-reviewed.yml'), 'utf8');
  assert.match(text, /branches-ignore: \[code-reviewed-badge\]/);
  assert.match(text, /github.event_name != 'pull_request'/);
  assert.match(text, /persist-credentials: false/);
  assert.ok(!text.includes('pull_request_target'));
  assert.match(text, /for file in badge.svg badge.json report.json report.md/);
  assert.ok(!text.includes('git push --force'));
  assert.match(text, /if: steps.coverage.outcome == 'failure'/);
});

test('setup command enables shared state and writes its reviewed plan without pushing', async t => {
  const { registerBadgeSetup } = require('../src/badge');
  const env = await workspace(t);
  env.api.workspaceFolders = [env.folder]; env.api.isTrusted = true;
  let handler, enabled = false; const opened = [];
  registerBadgeSetup({ vscode: { workspace: env.api, Uri,
    window: { showInputBox: async () => 'owner/repo', showInformationMessage: async () => {} },
    commands: { executeCommand: async (...args) => opened.push(args) } },
    context: { extensionUri: env.extension }, command: (name, fn) => { if (name === 'setupBadge') handler = fn; },
    enableShared: async () => { enabled = true; }
  });
  await handler();
  assert.equal(enabled, true);
  assert.match(await fs.readFile(path.join(env.root, 'README.md'), 'utf8'), /owner\/repo/);
  assert.equal(opened[0][0], 'vscode.open');
});


test('legacy footer badge moves below the title without duplicating or changing the report link', () => {
  const current = '# Project\n\nIntro.\n\n## Usage\n\nDetails.\n\n<!-- code-reviewed:badge:start -->\n[![Human reviewed](https://raw.githubusercontent.com/owner/repo/code-reviewed-badge/badge.svg)](https://github.com/owner/repo/blob/code-reviewed-badge/report.md)\n<!-- code-reviewed:badge:end -->\n';
  const next = updateReadme(current, 'owner/repo');
  assert.ok(next.startsWith('# Project\n\n<!-- code-reviewed:badge:start -->'));
  assert.ok(next.includes('Intro.\n\n## Usage\n\nDetails.'));
  assert.equal(next.match(/code-reviewed:badge:start/g).length, 1);
  assert.ok(next.includes('https://github.com/owner/repo/blob/code-reviewed-badge/report.md'));
  assert.equal(updateReadme(next, 'owner/repo'), next);
});
test('header placement preserves front matter and supports setext titles or no title', () => {
  const current = '---\ntitle: Docs\n---\n\nProject\n=======\n\nContent.\n';
  const next = updateReadme(current, 'owner/repo');
  assert.ok(next.startsWith('---\ntitle: Docs\n---\n\nProject\n=======\n\n<!--'));
  assert.equal(updateReadme(next, 'owner/repo'), next);
  assert.ok(updateReadme('Intro only.\n', 'owner/repo').startsWith('<!-- code-reviewed:badge:start -->'));
});
test('repair command changes only the README and does not regenerate customized CI', async t => {
  const { registerBadgeSetup } = require('../src/badge');
  const env = await workspace(t); env.api.workspaceFolders = [env.folder]; env.api.isTrusted = true;
  await fs.writeFile(path.join(env.root, 'README.md'), '# Existing\n\nContent.\n\n<!-- code-reviewed:badge:start -->\n[![Human reviewed](https://raw.githubusercontent.com/owner/repo/code-reviewed-badge/badge.svg)](https://github.com/owner/repo/blob/code-reviewed-badge/report.md)\n<!-- code-reviewed:badge:end -->\n');
  await fs.mkdir(path.join(env.root, '.github/workflows'), { recursive: true });
  await fs.writeFile(path.join(env.root, '.github/workflows/code-reviewed.yml'), 'custom workflow');
  let repair;
  registerBadgeSetup({ vscode: { workspace: env.api, Uri, window: { showInformationMessage: async () => {} } }, context: { extensionUri: env.extension }, command: (name, handler) => { if (name === 'repairBadge') repair = handler; }, enableShared: async () => { throw Error('Must not touch shared state'); } });
  await repair();
  const readme = await fs.readFile(path.join(env.root, 'README.md'), 'utf8');
  assert.ok(readme.startsWith('# Existing\n\n<!-- code-reviewed:badge:start -->'));
  assert.ok(!readme.includes('raw.githubusercontent.com'));
  assert.equal(await fs.readFile(path.join(env.root, '.github/workflows/code-reviewed.yml'), 'utf8'), 'custom workflow');
});
