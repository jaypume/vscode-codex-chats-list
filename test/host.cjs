// Run only with VS Code's --extensionTestsPath and an isolated --user-data-dir.
const vscode = require('vscode');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

async function until(fn, timeout = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const value = await fn(); if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Extension host view did not become ready.');
}
exports.run = async () => {
  const manifest = require('../package.json');
  const extension = vscode.extensions.getExtension(`${manifest.publisher}.${manifest.name}`);
  assert(extension);
  const api = await extension.activate();
  await vscode.commands.executeCommand('codexChatsList.open');
  const state = await until(() => { const s = api.snapshot(); return s.ready && !s.busy && s; });
  assert.equal(state.error, '');
  assert.equal(state.scope, 'current');
  assert.equal(state.count, 3);
  let routingVerified = false;
  let currentWindowEditor = false;
  if (process.env.CODEX_CHATS_LIST_TEST_THREAD) {
    const { openInCodex } = require('../dist/extension/routing.js');
    await openInCodex(process.env.CODEX_CHATS_LIST_TEST_THREAD, { target: 'editor' });
    await until(() => {
      const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
      return input instanceof vscode.TabInputCustom
        && input.viewType === 'chatgpt.conversationEditor'
        && input.uri.path === `/local/${process.env.CODEX_CHATS_LIST_TEST_THREAD}`;
    });
    currentWindowEditor = true;
    routingVerified = true;
  }
  await fs.writeFile(path.join(process.env.CODEX_CHATS_LIST_TEST_WORK, 'host-result.json'), JSON.stringify({ treeReady: true, currentProjectCount: state.count, routingVerified, currentWindowEditor }));
  // Keep this isolated host available for one visual pass. The harness creates the release file afterwards.
  if (process.env.CODEX_CHATS_LIST_KEEP_HOST) await until(async () => {
    try { await fs.access(path.join(process.env.CODEX_CHATS_LIST_TEST_WORK, 'release-host')); return true; } catch { return false; }
  }, 600000);
};
