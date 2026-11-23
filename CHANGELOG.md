# Changelog

## 1.13.1

### Changed

- Remove the conversation count badge from the Activity Bar icon.
- Mark the current project with ✅ and pinned projects and conversations with ⭐.

## 1.13.0

### Changed

- Display project conversation counts before activity dates in the right-hand badge area, capping the displayed count at 99.
- Show older activity as elapsed calendar months or years.

## 1.12.2

### Changed

- Show the latest conversation date in each project's right-hand badge and move the conversation count next to the project name.

## 1.12.1

### Changed

- Use theme-aware icon colors to distinguish regular, current, pinned, and unverified project rows. Pinned conversations share the project pin color.

## 1.12.0

### Changed

- Switch between Current project and All projects with one click on the view toolbar.

## 1.11.1

### Changed

- Use day and week badges for recent conversations and show full dates for conversations at least five weeks old or from another year.

## 1.11.0

### Changed

- Show conversation dates in the right-hand badge area, using relative days for the past week and month and day for earlier conversations this year.
- Include the year in the row text for conversations from other years.

## 1.10.2

### Changed

- Follow conversation titles with a short activity date and show the full timestamp on hover.

## 1.10.1

### Fixed

- Keep counts above 99 in the right-hand project badge by displaying `99`, with the exact count on hover.

## 1.10.0

### Changed

- Show conversation dates before titles in `YYYY-MM-DD` format and use native badges for project counts.
- Keep same-name projects distinguishable with shorter path qualifiers and retain full details on hover.

## 1.9.0

### Added

- Move a conversation to a repository in the project tree and restore automatic grouping from its context menu.
- Choose a known repository or select a local Git folder, including repositories with no conversation history.

## 1.8.0

### Changed

- Preview title matches as you type in the selected scope. Press Enter to keep the filter or Escape to restore the previous results.
- Reuse scoped candidates and normalized titles for local search, and keep groups collapsed when there are many matches.

## 1.7.0

### Added

- Hide and restore project groups and conversations, with a hidden-items filter.
- Permanently delete a conversation or a project's indexed conversations after confirmation.

## 1.6.0

### Added

- Group renamed or moved GitHub repositories by their confirmed repository IDs, preserving existing project pins.
- Prefer a verified local checkout in repository details and preserve the original working directory on each conversation.

### Fixed

- Open conversations in the initiating VS Code window through the workbench URI opener.

## 1.5.0

### Added

- Sort all project groups by name or last conversation.
- Pin project groups and individual conversations across windows.

### Changed

- Show all indexed conversations in All projects and load tree rows as groups expand.

## 1.4.0

### Added

- Group current or all conversations by Git repository or folder. Local Git repositories work without a remote.
- Toggle folders that are confirmed to be outside Git repositories.
- Share a persistent conversation index across windows and load historical pages once.

## 1.3.0

### Added

- Browse conversations by the workspace Git repository. Match saved remotes against `origin` or `upstream` to find conversations after moving a checkout.

## 1.2.1

### Fixed

- Use separate VS Code view, command, and setting IDs so Codex Chats List can run alongside Codex Project Chats.
- Read the previous CLI path when the new setting is unset. Update custom keybindings to use `codexChatsList.*`.

## 1.2.0

### Changed

- Browse project conversations with a native VS Code tree, scope picker, title filter, and tooltips.
- Use native commands and progress for pagination, refresh, and opening a conversation in Codex.
- Build and ship the extension host without browser assets.

## 1.1.4

### Fixed

- Keep pagination bound to its search and workspace paths.
- Restore previously loaded conversations when VS Code recreates the sidebar.
- Require Marketplace validation of the exact version before confirming a release.

### Changed

- Align the source repository, package manifest, preview assets, and release tooling with the Codex Chats List listing.
- Route support and private vulnerability reports to the fork.

Release entries below document the upstream Codex Project Chats history.

## [1.1.3](https://github.com/cixiangtao/codex-project-chats/compare/v1.1.2...5579d1cbf634423bf725ed9505d1bd8d86d2d047) (2026-11-04)

### Bug Fixes

* **conversations:** 🐛 refresh visible history automatically ([d5b29cb](https://github.com/cixiangtao/codex-project-chats/commit/d5b29cbcc35c702d7250461f5f5b4a4281af1377))

## [1.1.2](https://github.com/cixiangtao/codex-project-chats/compare/v1.1.1...v1.1.2) (2026-10-27)

### Bug Fixes

* **conversations:** 🐛 use recency for timestamps and ordering ([ac63c57](https://github.com/cixiangtao/codex-project-chats/commit/ac63c57a73919c9fd9954e92141741568dc941ce))

## [1.1.1](https://github.com/cixiangtao/codex-project-chats/compare/v1.1.0...v1.1.1) (2026-10-27)

### Bug Fixes

* **view:** 🐛 cancel work when the conversation view closes ([cc42275](https://github.com/cixiangtao/codex-project-chats/commit/cc4227519703397681d3b8e45d971fc53f624272))
* **webview:** 🐛 preserve focus and keep conversation details current ([81596ea](https://github.com/cixiangtao/codex-project-chats/commit/81596ea8ba76cfa35966e3b27ad17a96a03f63a6))
* **webview:** 🐛 recover legacy project expansion preferences ([4f846d1](https://github.com/cixiangtao/codex-project-chats/commit/4f846d17f549bbb64fe5373b7fba24c2cb886e47))

### Maintenance

- Build the React and TypeScript interface with Vite, with a synthetic-data development preview and hot updates.
- Organize Webview components, hooks, styles, and tests by responsibility; preserve the compact conversation layout and theme integration.
- Adopt pnpm, Vitest, and release-it for local development and release preparation. Marketplace uploads remain manual.
- Add Oxlint and Oxfmt checks to CI, including import, package/script, and Tailwind class sorting.

## 1.1.0

- Follow the VS Code display language with Simplified Chinese for Chinese locales and English as the fallback.
- Localize conversation lists, hover details, relative times, loading and empty states, accessibility labels, and extension-owned error messages.
- Localize Activity Bar labels, commands, and executable-path settings through native VS Code language resources.
- Preserve original conversation titles, project paths, and upstream diagnostics without translation.
- Add English sample screenshots and synchronize bilingual usage and language-switching instructions.

## 1.0.0

- Publish the first stable release and remove the Marketplace preview designation.
- Use compact single-line conversation rows with right-aligned last-update times.
- Show full titles, update timestamps, and project paths in compact hover details, keeping a clear pointer lane on the left for switching conversations.
- Support keyboard focus and Escape dismissal for conversation details.
- Refresh the store and Activity Bar icons with a Codex blossom and project-folder badge.
- Update bilingual usage instructions and sample screenshots; document the current manual Marketplace release procedure.

## 0.1.1

- Open conversations in the existing official Codex view in the current VS Code window, respecting the sidebar position instead of creating editor tabs.
- Expand search matches temporarily and restore previous collapse state when the search is cleared.
- Show paths for projects with identical folder names even while collapsed.
- Add a store icon, installation instructions, and compatibility guidance for the first Marketplace preview submission.

## 0.1.0

- Initial local prototype with working-directory grouping, current/all-project scope, title search, and pagination.
