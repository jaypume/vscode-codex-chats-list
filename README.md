# Codex Chats List

English · [简体中文](README.zh-CN.md)

Browse Codex conversations by project, then continue in the official Codex sidebar. Version 1.2.0 uses a native VS Code tree with project groups, title search, and pagination.

## Install and browse

1. Install and sign in to the [official Codex extension](https://marketplace.visualstudio.com/items?itemName=openai.chatgpt).
2. Search `@id:pujie.codex-chats-list` in VS Code to install **Codex Chats List**, or choose **Extensions → … → Install from VSIX** for a local package.
3. Open a project folder and select **Codex Chats List** in the Activity Bar. You can also run **Codex Chats List: Open Project Chats** from the Command Palette.
4. Expand a project and select a conversation. It opens in the existing official Codex sidebar, wherever you placed it.

[Marketplace listing](https://marketplace.visualstudio.com/items?itemName=pujie.codex-chats-list) · [Report a problem](https://github.com/jaypume/vscode-codex-chats-list/issues)

| Action | How it works |
| --- | --- |
| Choose the scope | Use **Change Conversation Scope** in the view toolbar to switch between **Current project** and **All projects**. |
| Filter by title | Use **Search Conversation Titles**, enter a keyword, and press Enter. Results stay grouped in the tree. Use **Clear Conversation Search** or submit an empty search to reset the filter. |
| See details | Each row shows the latest conversation time. Hover over a conversation for its full title, time, and project path. |
| Load and refresh | Select **Load more conversations** at the end of the tree. Use **Refresh Conversations** to reload the first page. |

The current scope matches exact working directories, including resolved workspace symlinks. Subdirectories and Git worktrees appear as separate groups. Select **All projects** to see them, or to browse when no folder is open. Projects with the same name display their paths.

Codex filters by title and directory before pagination. Each page contains up to 50 conversations. Counts describe loaded results. Recently active conversations appear first within each project. The tree shows non-archived, interactive local conversations.

The visible tree refreshes five seconds after each completed query. It keeps loaded pages on screen during background refreshes and pauses polling while hidden. The scope and project expansion are saved per workspace. Matching groups open during a title search, and clearing it restores the regular tree's expansion.

## Preview

The native VS Code sidebar below uses synthetic data. [Chinese previews](README.zh-CN.md#界面预览) show the same controls in Simplified Chinese.

| Current project | All projects |
| --- | --- |
| ![Current project conversation tree](https://raw.githubusercontent.com/jaypume/vscode-codex-chats-list/main/docs/images/current-project-en.png) | ![Native tree with projects grouped by path](https://raw.githubusercontent.com/jaypume/vscode-codex-chats-list/main/docs/images/all-projects-en.png) |

![Native tooltip showing title, recent conversation time and path](https://raw.githubusercontent.com/jaypume/vscode-codex-chats-list/main/docs/images/hover-details-en.png)

## Compatibility and privacy

The manifest requires VS Code 1.100 or newer. The extension follows the VS Code display language, with Simplified Chinese for Chinese locales and English otherwise. Conversation titles and paths retain their original text.

| Situation | Guidance |
| --- | --- |
| Empty current-project tree | The saved working directory must match a workspace root. Select **All projects** for sessions started in a subdirectory or worktree. |
| Codex binary unavailable | Enable the official extension or set `codexProjectChats.cliPath` to an absolute executable path on the current host. |
| Opening a conversation fails | Open the official Codex sidebar and retry. Include both extension versions when reporting the issue, since the navigation URI comes from the official extension. |
| WSL, SSH, or a container | Install both extensions in the remote workspace. History stays on each host. For Windows with Codex running in WSL, open the project in a WSL window. |

The extension reads conversation IDs, titles, working directories, and recent conversation times from the local bundled `codex app-server`. It uses `thread/list` with `useStateDbOnly`. When a title is missing, the server's first-message preview can supply the label. The official executable manages its internal state and logs. Navigation uses the official extension's existing `/local/<id>` URI handler.

Disable the upstream extension or its old prototype before enabling Codex Chats List to avoid duplicate views. Codex stores conversations independently.

## Development and support

Use Node.js 24.18.0 and pnpm 12.15.0 as declared in `.nvmrc` and `packageManager`.

```sh
pnpm install --frozen-lockfile
pnpm run check
pnpm run lint
pnpm run format:check
pnpm test
pnpm run package
```

The host compiles to `dist/extension/`. The VSIX contains compiled host code, icons, language resources, and public documentation. The package is generated as `release-artifact/codex-chats-list-<version>.vsix`. See [contributing](https://github.com/jaypume/vscode-codex-chats-list/blob/main/CONTRIBUTING.md) and the [release procedure](https://github.com/jaypume/vscode-codex-chats-list/blob/main/docs/releasing.md).

Report bugs in [Issues](https://github.com/jaypume/vscode-codex-chats-list/issues), and use the [security policy](https://github.com/jaypume/vscode-codex-chats-list/blob/main/SECURITY.md) for private vulnerability reports. The extension is independently maintained under the MIT license as a fork of [Codex Project Chats](https://github.com/cixiangtao/codex-project-chats).
