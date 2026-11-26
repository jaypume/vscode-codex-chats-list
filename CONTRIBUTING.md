# Contributing

Thanks for helping improve Codex Chats List. Keep changes focused on project grouping, search, and navigation back to the official Codex view. Discuss larger changes in an issue before implementing them.

## Setup and checks

Use Node.js 24.18.0 (`.nvmrc`) and pnpm 12.15.0 (`packageManager`). From the repository root:

```sh
pnpm install --frozen-lockfile
pnpm run check
pnpm run lint
pnpm run format:check
pnpm test
pnpm run package
```

With nvm, run `nvm install` and `nvm use` to select the development runtime. Corepack users can run `corepack pnpm` in place of `pnpm`. If your global pnpm is older, `npx --yes pnpm@12.15.0 <command>` runs the pinned version without changing the global installation. Build-script permissions and dependency overrides are declared in `pnpm-workspace.yaml`.

The extension host compiles to CommonJS in `dist/extension/`. `pnpm run check` type-checks the extension and tests. Vitest runs the source against generated fixtures, including mocks for native VS Code commands, the tree, and the app-server. The package check inspects the compiled host, tree contribution, language resources, and public files. One POSIX executable fixture is skipped on Windows.

The source lives in `src/`, with the native presentation in `src/tree.ts` and query lifecycle in `src/extension.ts`. See [architecture](ARCH.md) and [design](DESIGN.md). `pnpm run package` writes to `release-artifact/`. Use `python3 scripts/verify-vsix.py` to inspect the default package, and retain the inspected release under its version directory when preparing a Marketplace upload.

Use a separate VS Code profile and a disposable workspace to verify the native sidebar. For documentation screenshots, use synthetic conversation metadata and capture the actual tree, scope and tooltip in both languages.

## Optional integration tests

`test/live.mjs` reads real local metadata only when `CODEX_LIVE_BINARY` is explicitly set. It prints aggregate counts, not titles, paths, IDs, or transcripts. Run it only when you intend to grant access to that host's conversation history. It is not part of CI.

`test/host.cjs` is an opt-in VS Code extension-host harness. It expects a separately prepared user-data directory at `CODEX_CHATS_LIST_TEST_WORK/vscode-user`, a configured metadata fixture returning three current-project conversations, and an output directory at `CODEX_CHATS_LIST_TEST_WORK`. Invoke it through VS Code's `--extensionTestsPath` with both this extension and the official extension available. Set `CODEX_CHATS_LIST_TEST_THREAD` only to intentionally test a real local conversation route. The harness checks official logs and asserts that no conversation editor tab is created. Never use your normal profile or publish its logs. This harness is not a self-contained CI launcher. It retains `.cjs` because the VS Code test-host entry point loads its `run` export through CommonJS.

## Pull requests

- Explain the user-visible problem, the change, and the checks you ran.
- Keep behavior, refactoring, and unrelated formatting in separate changes.
- Open conversations in the official Codex editor of the initiating VS Code window.
- Never include real transcripts, conversation IDs, personal paths, credentials, or account details in fixtures or screenshots.
- Update both README entry points when usage or compatibility changes. English is canonical; `README.zh-CN.md` is the maintained Chinese companion. The product interface follows the VS Code display language, with Simplified Chinese and English translations.
- Use Conventional Commit subjects, for example `fix(routing): 🐛 preserve the existing Codex view`.

## Release boundary

`package.json` owns the extension version. The app-server client receives that version from the installed extension manifest. release-it updates the manifest and generates `CHANGELOG.md` from Conventional Commits. pnpm's lockfile tracks dependencies, not the root extension version. `pnpm run release:check` validates the version files and release configuration.

Follow the [Marketplace release procedure](docs/releasing.md): run `pnpm run release:dry patch` to preview a release and `pnpm run release:prepare patch` on a clean branch to prepare it. Inspect the generated changelog, submit the changes through a PR, and upload the inspected VSIX manually after required CI passes. Record the version tag only after verifying the public Marketplace payload. release-it does not commit, tag, push, publish to npm, or create a GitHub Release.

An uploaded package awaiting Marketplace validation is not yet a public release. Repository documentation changes can remain ahead of the last store package until a separately approved version update.
