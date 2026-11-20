# Human Review

A VS Code extension for tracking which lines you have reviewed. Mark code as reviewed, revisit it when it changes, and keep the review state in Git.

## Install

Download the `.vsix` from [Releases](https://github.com/LINQeee/human-review/releases), then run **Extensions: Install from VSIX** in VS Code. Requires VS Code 1.96 or newer.

## Review code

Open **Human Review** in the activity bar to browse pending files by folder. Select lines and mark them reviewed, or approve an entire file. Changed lines lose their approval; deleted code stays pending until acknowledged. Use **Compare with Last Review** to inspect the saved snapshot.

| Action | macOS | Windows / Linux |
| --- | --- | --- |
| Mark selected lines, then move to the next unreviewed line | `Cmd+Alt+R` | `Ctrl+Alt+R` |
| Next unreviewed line in this file | `Cmd+Alt+N` | `Ctrl+Alt+N` |
| Mark reviewed and move to the next project range | `Cmd+Alt+Enter` | `Ctrl+Alt+Enter` |
| Undo the last review action | `Cmd+Alt+Z` | `Ctrl+Alt+Z` |

Undo changes review marks, not code. The view can filter new code or code that needs another review. Blank and whitespace-only lines never count toward coverage.

## Share between computers

Run **Human Review: Enable Cross-PC Review (Git)** and commit `.code-reviewed/review.json`. Pull it on another computer and run **Reload Shared Review State**. Paths are relative to the workspace root. Concurrent changes are detected rather than silently overwritten.

The review file contains source snapshots. Keep it in the same access-controlled repository as the code.

## Ignore files

Use **Add Ignore Pattern** or **Edit Ignore Patterns** from the view's `…` menu. Rules live in `.code-reviewedignore` at the workspace root:

```gitignore
*.svg
vendor/
!important.svg
```

Rules follow gitignore syntax and are case-sensitive across platforms. Commit the file to share exclusions. Ignored files are excluded from both reviewed and total line counts; their saved review marks are retained. Use **Restore Ignored Paths** to restore files excluded through the context menu.

## GitHub badge

Run **Set Up GitHub Review Badge**, then commit the generated workflow, configuration, helpers and review state. The workflow calculates coverage on pushes and pull requests. Runs on the default branch publish a badge and report to `code-reviewed-badge`; the README badge links to that report.

Coverage counts eligible Git-tracked text, including code comments and documentation. Binary files, ignored files and blank lines are excluded. Invalid state or scan limits produce an incomplete report. This records self-reported review coverage, not a guarantee of correctness.

Existing generated CI helpers are not overwritten during setup. Review their differences when upgrading. **Repair README Badge** updates the badge placement without replacing the workflow.

## Development

Node.js 22 or newer.

```sh
npm ci
npm run check
npm test
npm run package
```

Press `F5` in VS Code to launch an Extension Development Host. Runtime code is CommonJS with no installed runtime dependencies. The gitignore parser is vendored from `node-ignore` under its MIT license.

## Compatibility

The extension ID remains `local-tools.code-reviewed`, so this release updates existing installations. Review marks and exclusions from earlier versions are retained. Review notes have been removed and are discarded when old state is loaded.

## License

MIT. See [LICENSE](LICENSE).
