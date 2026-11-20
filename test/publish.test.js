'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { execFileSync, spawnSync } = require('node:child_process');

test('workflow publisher writes only reports to its branch and rejects an outdated commit', { skip: spawnSync('jq', ['--version']).status !== 0 }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'code-reviewed-publish-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const origin = path.join(root, 'origin.git'), work = path.join(root, 'work'), runner = path.join(root, 'runner');
  await fs.mkdir(work); await fs.mkdir(path.join(runner, 'code-reviewed-report'), { recursive: true });
  const git = (...args) => execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args], { cwd: work, encoding: 'utf8', stdio: 'pipe' }).trim();
  git('init', '--bare', '--template=', origin); git('init', '--template=', '-b', 'main'); git('remote', 'add', 'origin', origin);
  await fs.mkdir(path.join(work, '.code-reviewed'));
  await fs.writeFile(path.join(work, '.code-reviewed/review.json'), 'private snapshot must stay on main');
  await fs.writeFile(path.join(work, 'source.js'), 'private code');
  git('add', '-A'); git('commit', '-m', 'source'); git('push', 'origin', 'main');
  const sha = git('rev-parse', 'HEAD');
  for (const [name, data] of Object.entries({ 'report.json': JSON.stringify({ commit: sha }), 'report.md': '# Metrics only', 'badge.svg': '<svg/>', 'badge.json': '{}' })) await fs.writeFile(path.join(runner, 'code-reviewed-report', name), data);
  const workflow = await fs.readFile(path.resolve(__dirname, '../templates/code-reviewed.yml'), 'utf8');
  const script = workflow.slice(workflow.lastIndexOf('        run: |') + '        run: |'.length).split('\n').map(line => line.startsWith('          ') ? line.slice(10) : line).join('\n');
  const environment = { ...process.env, RUNNER_TEMP: runner, DEFAULT_BRANCH: 'main', GITHUB_SHA: sha,
    GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'commit.gpgsign', GIT_CONFIG_VALUE_0: 'false', GIT_CONFIG_KEY_1: 'core.hooksPath', GIT_CONFIG_VALUE_1: '/dev/null' };
  const publish = env => execFileSync('bash', ['-c', script], { cwd: work, env, encoding: 'utf8', stdio: 'pipe' });
  publish(environment);
  assert.deepEqual(git('--git-dir=' + origin, 'ls-tree', '-r', '--name-only', 'code-reviewed-badge').split('\n'), ['badge.json', 'badge.svg', 'report.json', 'report.md']);
  assert.equal(git('--git-dir=' + origin, 'rev-parse', 'main'), sha);
  const badgeCommit = git('--git-dir=' + origin, 'rev-parse', 'code-reviewed-badge');
  assert.match(publish({ ...environment, GITHUB_SHA: '0'.repeat(40) }), /outdated report/);
  assert.equal(git('--git-dir=' + origin, 'rev-parse', 'code-reviewed-badge'), badgeCommit);
  await fs.writeFile(path.join(runner, 'code-reviewed-report/report.md'), '# Updated metrics');
  publish(environment);
  assert.notEqual(git('--git-dir=' + origin, 'rev-parse', 'code-reviewed-badge'), badgeCommit);
});
