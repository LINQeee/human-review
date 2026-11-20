'use strict';
const { DEFAULT_CONFIG } = require('./report');
const START = '<!-- code-reviewed:badge:start -->';
const END = '<!-- code-reviewed:badge:end -->';
function repositoryName(value) {
  if (typeof value !== 'string') return undefined;
  const name = value.trim().replace(/^https:\/\/github\.com\//, '').replace(/^git@github\.com:/, '').replace(/\/$/, '').replace(/\.git$/, '');
  return /^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(name) ? name : undefined;
}
function badgeSnippet(repository) {
  if (!repositoryName(repository) || repositoryName(repository) !== repository) throw Error('Enter a GitHub repository as owner/repo.');
  return `${START}\n[![Human reviewed](/../code-reviewed-badge/badge.svg)](https://github.com/${repository}/blob/code-reviewed-badge/report.md)\n${END}`;
}
function updateReadme(current, repository) {
  const snippet = badgeSnippet(repository);
  const start = current.indexOf(START), end = current.indexOf(END);
  let body = current;
  if (start >= 0 || end >= 0) {
    if (start < 0 || end < start || current.indexOf(START, start + 1) >= 0 || current.indexOf(END, end + 1) >= 0) throw Error('README has malformed Human Review badge markers; repair them before setup.');
    const before = current.slice(0, start).trimEnd();
    const after = current.slice(end + END.length).replace(/^[ \t\r\n]+/, '');
    body = before + (before && after ? '\n\n' : '') + after;
  }
  // Keep YAML front matter first and put the badge immediately after the title.
  const front = body.match(/^(?:\uFEFF)?---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/)?.[0] || '';
  const offset = front.length;
  const leading = body.slice(offset).match(/^[ \t\r\n]*/)[0].length;
  const rest = body.slice(offset + leading);
  const title = rest.match(/^#[ \t]+[^\r\n]+(?:\r?\n|$)/)?.[0]
    || rest.match(/^[^\r\n]+\r?\n=+[ \t]*(?:\r?\n|$)/)?.[0];
  const insertion = title ? offset + leading + title.length : offset;
  const before = body.slice(0, insertion).trimEnd();
  const after = body.slice(insertion).replace(/^[ \t\r\n]+/, '').trimEnd();
  return (before ? before + '\n\n' : '') + snippet + (after ? '\n\n' + after : '') + '\n';
}
function setupGuide(repository) {
  return `# GitHub review badge

1. Commit this directory, the workflow, README and any .code-reviewedignore rules.
2. Push to GitHub. The workflow calculates coverage on pushes and pull requests.
3. Runs on the default branch publish the badge and report to code-reviewed-badge.

Report: https://github.com/${repository}/blob/code-reviewed-badge/report.md
Workflow: https://github.com/${repository}/actions/workflows/code-reviewed.yml

## Coverage

The report counts eligible Git-tracked text at the checked-out commit. Blank lines,
binary files and ignored paths do not count. Code comments and documentation do.
Configure include/exclude in badge.config.json with *, ** and ? patterns;
.code-reviewedignore uses gitignore syntax. Manual review exclusions also apply.

Changed lines lose approval. Invalid state, unreadable text, a dirty checkout or
scan limits produce an incomplete report. Empty scope displays n/a. Coverage is
self-reported review progress, not a guarantee of correctness.

Reports contain counts, paths, scope and the commit SHA. Source snapshots stay in
review.json; keep that file under the same access controls as the source code.
Private repository badges require repository access. Images may be cached;
check the report commit for freshness.

## Permissions

Calculation and pull requests have read-only access. A separate publishing job
uses GITHUB_TOKEN with contents:write. Repository policies must allow writes to
the generated branch. No personal token is needed. This workflow targets github.com.

## Local report

With Node.js 22+, run from the repository root:

    node .code-reviewed/ci/report.cjs --output .code-reviewed/report

No dependency installation or project execution is required. Commit configuration
and state first. Generated CI helpers are versioned with the project; setup will
not overwrite differing files. Review helper changes when upgrading.
`;
}
async function preparePlan(workspace, Uri, extensionUri, folder, repository) {
  const files = new Map();
  const readAsset = async name => Buffer.from(await workspace.fs.readFile(Uri.joinPath(extensionUri, ...name.split('/')))).toString('utf8');
  files.set('.github/workflows/code-reviewed.yml', await readAsset('templates/code-reviewed.yml'));
  files.set('.code-reviewed/badge.config.json', JSON.stringify(DEFAULT_CONFIG, null, 2) + '\n');
  files.set('.code-reviewed/ci/package.json', '{"private":true,"type":"commonjs"}\n');
  for (const name of ['core', 'review', 'portable', 'report', 'ignore']) files.set(`.code-reviewed/ci/${name === 'report' ? 'report.cjs' : name + '.js'}`, await readAsset(`src/${name}.js`));
  for (const name of ['ignore.js', 'ignore.LICENSE']) files.set(`.code-reviewed/ci/vendor/${name}`, await readAsset(`src/vendor/${name}`));
  files.set('.code-reviewed/BADGE.md', setupGuide(repository));
  // Preserve a repository's existing README casing and unrelated content.
  const names = ['README.md', 'readme.md', 'Readme.md'];
  let readme = 'README.md', current = '';
  for (const name of names) {
    const text = await readOptional(workspace, Uri.joinPath(folder.uri, name));
    if (text !== undefined) { readme = name; current = text; break; }
  }
  files.set(readme, updateReadme(current, repository));
  return { files, readme };
}
async function readOptional(workspace, uri) {
  try { return Buffer.from(await workspace.fs.readFile(uri)).toString('utf8'); }
  catch (error) { if (error.code === 'FileNotFound' || error.code === 'ENOENT') return undefined; throw error; }
}
async function checkPlan(workspace, Uri, folder, plan) {
  const before = new Map();
  for (const [name, text] of plan.files) {
    const uri = Uri.joinPath(folder.uri, ...name.split('/'));
    if (workspace.textDocuments.some(doc => doc.uri.toString() === uri.toString() && doc.isDirty)) throw Error(`Save ${name} before setting up the badge.`);
    const existing = await readOptional(workspace, uri);
    if (name !== plan.readme && existing !== undefined && existing !== text) throw Error(`Existing ${name} differs from generated content. It was not overwritten; review or move it before running setup again.`);
    before.set(name, existing);
  }
  return before;
}
async function applyPlan(workspace, Uri, folder, plan, before) {
  const written = [];
  try {
    for (const [name, text] of plan.files) {
      const uri = Uri.joinPath(folder.uri, ...name.split('/'));
      if (await readOptional(workspace, uri) !== before.get(name)) throw Error(`${name} changed during setup. Retry after saving it.`);
      if (before.get(name) === text) continue;
      await workspace.fs.createDirectory(Uri.joinPath(folder.uri, ...name.split('/').slice(0, -1)));
      written.push(name);
      await workspace.fs.writeFile(uri, Buffer.from(text));
    }
  } catch (error) {
    for (const name of written.reverse()) {
      const uri = Uri.joinPath(folder.uri, ...name.split('/'));
      try {
        if (await readOptional(workspace, uri) !== plan.files.get(name)) continue;
        if (before.get(name) === undefined) await workspace.fs.delete(uri);
        else await workspace.fs.writeFile(uri, Buffer.from(before.get(name)));
      } catch { /* Original error is reported; never erase a concurrent edit. */ }
    }
    throw error;
  }
}
function registerBadgeSetup({ vscode, context, command, enableShared }) {
  command('repairBadge', async () => {
    if (vscode.workspace.isTrusted === false) throw Error('Trust the workspace before editing the README.');
    const folders = vscode.workspace.workspaceFolders || [];
    if (!folders.length) throw Error('Open the repository root first.');
    const folder = folders.length === 1 ? folders[0] : (await vscode.window.showQuickPick(folders.map(folder => ({ label: folder.name, folder })), { title: 'Repair README badge' }))?.folder;
    if (!folder) return;
    let readme, current;
    for (const name of ['README.md', 'readme.md', 'Readme.md']) {
      const content = await readOptional(vscode.workspace, vscode.Uri.joinPath(folder.uri, name));
      if (content !== undefined) { readme = name; current = content; break; }
    }
    if (!readme || !current.includes(START)) throw Error('No configured badge found. Run Set Up GitHub Review Badge first.');
    let repository = repositoryName(current.match(/https:\/\/github\.com\/([^/]+\/[^/]+)\/blob\/code-reviewed-badge\/report\.md/)?.[1]);
    if (!repository) {
      const input = await vscode.window.showInputBox({ title: 'GitHub repository for the badge', prompt: 'owner/repo', validateInput: value => repositoryName(value) ? undefined : 'Enter owner/repo.' });
      if (input === undefined) return;
      repository = repositoryName(input);
    }
    if (!repository) throw Error('Invalid GitHub repository.');
    const plan = { readme, files: new Map([[readme, updateReadme(current, repository)]]) };
    const before = await checkPlan(vscode.workspace, vscode.Uri, folder, plan);
    await applyPlan(vscode.workspace, vscode.Uri, folder, plan, before);
    await vscode.window.showInformationMessage('README badge repaired and moved below the project title. Commit and push the README to update GitHub.');
  });
  command('setupBadge', async () => {
    if (vscode.workspace.isTrusted === false) throw Error('Trust the workspace before generating a GitHub workflow.');
    const folders = vscode.workspace.workspaceFolders || [];
    if (!folders.length) throw Error('Open the repository root as a workspace folder first.');
    const folder = folders.length === 1 ? folders[0] : (await vscode.window.showQuickPick(folders.map(folder => ({ label: folder.name, folder })), { title: 'Repository root for the review badge' }))?.folder;
    if (!folder) return;
    let suggested;
    const gitExtension = vscode.extensions?.getExtension('vscode.git');
    if (gitExtension) {
      try {
        const git = (await gitExtension.activate()).getAPI(1);
        const repo = git.repositories.find(repo => repo.rootUri.toString() === folder.uri.toString());
        suggested = repositoryName(repo?.state.remotes.find(remote => remote.name === 'origin')?.fetchUrl);
        if (!repo && git.repositories.some(repo => folder.uri.toString().startsWith(repo.rootUri.toString() + '/'))) throw Error('Open the Git repository root, not a subfolder, before badge setup.');
      } catch (error) { if (error.message?.startsWith('Open the Git repository root')) throw error; }
    }
    const input = await vscode.window.showInputBox({ title: 'Set Up GitHub Review Badge', prompt: 'GitHub repository: owner/repo. Creates a workflow, report helpers and README badge; does not push.', value: suggested || '', validateInput: value => repositoryName(value) ? undefined : 'Enter owner/repo or a github.com repository URL.' });
    if (input === undefined) return;
    const repository = repositoryName(input);
    if (!repository) throw Error('Invalid GitHub repository.');
    const plan = await preparePlan(vscode.workspace, vscode.Uri, context.extensionUri, folder, repository);
    const before = await checkPlan(vscode.workspace, vscode.Uri, folder, plan);
    await enableShared(folder);
    await applyPlan(vscode.workspace, vscode.Uri, folder, plan, before);
    await vscode.window.showInformationMessage('GitHub review badge configured. Commit the generated files and .code-reviewed/review.json, then push. The default-branch workflow publishes the badge.');
    await vscode.commands.executeCommand('vscode.open', vscode.Uri.joinPath(folder.uri, '.code-reviewed', 'BADGE.md'));
  });
}
module.exports = { repositoryName, badgeSnippet, updateReadme, preparePlan, checkPlan, applyPlan, registerBadgeSetup };
