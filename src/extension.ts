import { createLocalizer } from './i18n';
import * as vscode from 'vscode';
import { access, realpath } from 'node:fs/promises';
import path from 'node:path';
import { CodexClient } from './client';
import { findRepositories, inspectDirectory } from './git';
import { ConversationHistory, HEAD_REFRESH_MS } from './history';
import { openInCodex } from './routing';
import {
  groupChats, pathKey, selectChats, uniquePaths, type Chat, type Grouping, type Scope, type WorkspaceProjects,
} from './model';
import { ChatTree, LOAD_MORE, OPEN_CONVERSATION, VIEW_ID, type TreeNode } from './tree';

const t = createLocalizer(vscode.env.language);
const OFFICIAL_ID = 'openai.chatgpt';
const INDEX_STEP_MS = 150;
const PAGE_SIZE = 50;
const MINUTE_MS = 60_000;
const SEARCH_LIMIT = 200;
const LEGACY_CONFIG_SECTION = 'codexProjectChats';

function ownCliPath(): string | undefined {
  const setting = vscode.workspace.getConfiguration('codexChatsList').inspect<string>('cliPath');
  return setting?.workspaceFolderValue ?? setting?.workspaceValue ?? setting?.globalValue;
}

async function getBinary(): Promise<string> {
  const configured = (ownCliPath()
    ?? vscode.workspace.getConfiguration(LEGACY_CONFIG_SECTION).get<string>('cliPath', '')).trim();
  if (configured) {
    if (!path.isAbsolute(configured)) throw new Error(t('errorAbsolutePath'));
    await access(configured);
    return configured;
  }
  const official = vscode.extensions.getExtension(OFFICIAL_ID);
  if (!official) throw new Error(t('errorInstallOfficial'));
  if (process.platform === 'win32' && vscode.workspace.getConfiguration('chatgpt').get('runCodexInWindowsSubsystemForLinux')) {
    throw new Error(t('errorWsl'));
  }
  const os = { darwin: 'macos', win32: 'windows', linux: 'linux' }[process.platform as 'darwin' | 'win32' | 'linux'];
  const arch = { arm64: 'aarch64', x64: 'x86_64' }[process.arch as 'arm64' | 'x64'];
  if (!os || !arch) throw new Error(t('errorArchitecture'));
  const binary = path.join(official.extensionPath, 'bin', `${os}-${arch}`, process.platform === 'win32' ? 'codex.exe' : 'codex');
  try { await access(binary); } catch { throw new Error(t('errorBinaryMissing')); }
  return binary;
}

async function workspaceRoots(): Promise<string[]> {
  const roots = (vscode.workspace.workspaceFolders ?? [])
    .filter(folder => folder.uri.scheme === 'file' || (vscode.env.remoteName && folder.uri.scheme === 'vscode-remote'))
    .map(folder => folder.uri.fsPath);
  const resolved = await Promise.all(roots.map(async root => { try { return await realpath(root); } catch { return root; } }));
  return uniquePaths([...roots, ...resolved]);
}

class CodexChatsListView implements vscode.Disposable {
  readonly tree: ChatTree;
  private view?: vscode.TreeView<TreeNode>;
  private history?: ConversationHistory;
  private connecting?: CodexClient;
  private scope: Scope;
  private grouping: Grouping;
  private showFolders: boolean;
  private search = '';
  private chats: Chat[] = [];
  private complete = false;
  private previousRows = '';
  private projects: WorkspaceProjects = { roots: [], remotes: new Set(), gitDirectories: new Set() };
  private limit = PAGE_SIZE;
  private generation = 0;
  private workspaceGeneration = 0;
  private syncing = false;
  private forceRefresh = false;
  private opening: string | null = null;
  private error = '';
  private ready = false;
  private disposed = false;
  private autoRefreshTimer?: ReturnType<typeof setTimeout>;
  private clockTimer?: ReturnType<typeof setTimeout>;

  constructor(private readonly context: vscode.ExtensionContext) {
    const saved = context.workspaceState.get<Scope | 'repository'>('scope');
    const view = context.workspaceState.get<{ scope: Scope; grouping: Grouping; showFolders: boolean }>('historyView');
    this.scope = (view?.scope ?? saved) === 'all' ? 'all' : 'current';
    this.grouping = view ? (view.grouping === 'folder' ? 'folder' : 'repository')
      : saved && saved !== 'repository' ? 'folder' : 'repository';
    this.showFolders = view?.showFolders !== false;
    this.tree = new ChatTree(context.workspaceState);
  }

  attach(view: vscode.TreeView<TreeNode>): void {
    this.view = view;
    this.context.subscriptions.push(
      view.onDidChangeVisibility(() => this.visibilityChanged()),
      view.onDidExpandElement(({ element }) => this.tree.rememberExpansion(element, true)),
      view.onDidCollapseElement(({ element }) => this.tree.rememberExpansion(element, false)),
    );
    this.visibilityChanged();
  }

  private visibilityChanged(): void {
    clearTimeout(this.autoRefreshTimer);
    clearTimeout(this.clockTimer);
    if (!this.view?.visible || this.disposed) return;
    this.tree.refreshTimes();
    this.scheduleClock();
    if (!this.ready) void this.updateWorkspace();
    void this.sync();
  }

  private scheduleClock(): void {
    this.clockTimer = setTimeout(() => {
      if (!this.view?.visible || this.disposed) return;
      this.tree.refreshTimes();
      this.scheduleClock();
    }, MINUTE_MS - Date.now() % MINUTE_MS);
  }

  async updateWorkspace(): Promise<void> {
    const generation = ++this.workspaceGeneration;
    const roots = await workspaceRoots();
    const [remotes, directories] = await Promise.all([
      findRepositories(roots),
      Promise.all(roots.map(root => inspectDirectory(root))),
    ]);
    if (this.disposed || generation !== this.workspaceGeneration) return;
    this.projects = {
      roots,
      remotes: new Set(remotes.keys()),
      gitDirectories: new Set(directories.flatMap(dir => dir.kind === 'git' ? [pathKey(dir.common)] : [])),
    };
    this.render();
  }

  async pickScope(): Promise<void> {
    const options = (['current', 'all'] as const).map(value => ({
      value, label: t(value), description: value === this.scope ? t('selectedScope') : undefined,
    }));
    const option = await vscode.window.showQuickPick(options, { title: t('scope') });
    if (option) await this.setScope(option.value);
  }

  async setScope(scope: Scope): Promise<void> {
    if (scope === this.scope || this.disposed) return;
    this.scope = scope;
    this.resetPage();
    await this.saveView();
  }

  async pickGrouping(): Promise<void> {
    const options = (['repository', 'folder'] as const).map(value => ({
      value, label: t(value), description: value === this.grouping ? t('selectedScope') : undefined,
    }));
    const option = await vscode.window.showQuickPick(options, { title: t('grouping') });
    if (!option || option.value === this.grouping || this.disposed) return;
    this.grouping = option.value;
    this.resetPage();
    await this.saveView();
  }

  async toggleFolders(): Promise<void> {
    if (this.disposed) return;
    this.showFolders = !this.showFolders;
    this.resetPage();
    await this.saveView();
  }

  private saveView(): Thenable<void> {
    return this.context.workspaceState.update('historyView', {
      scope: this.scope, grouping: this.grouping, showFolders: this.showFolders,
    });
  }

  async promptSearch(): Promise<void> {
    const value = await vscode.window.showInputBox({
      title: t('search'), value: this.search, placeHolder: t('searchPlaceholder'),
      validateInput: input => input.length > SEARCH_LIMIT ? t('searchTooLong', { count: SEARCH_LIMIT }) : undefined,
    });
    if (value !== undefined) this.setSearch(value);
  }

  setSearch(value: string): void {
    const search = value.slice(0, SEARCH_LIMIT).trim();
    if (search === this.search || this.disposed) return;
    this.search = search;
    void vscode.commands.executeCommand('setContext', 'codexChatsList.hasSearch', Boolean(search));
    this.resetPage();
  }

  private resetPage() {
    this.limit = PAGE_SIZE;
    this.render();
  }

  async refresh(): Promise<void> {
    if (this.disposed || !this.view) return;
    this.resetPage();
    await vscode.window.withProgress({ location: { viewId: VIEW_ID } }, async () => {
      await this.updateWorkspace();
      await this.sync(true);
    });
  }

  async resetSource(): Promise<void> {
    if (!this.ready || this.disposed) return;
    this.generation++;
    this.connecting?.dispose();
    this.connecting = undefined;
    this.history?.dispose();
    this.history = undefined;
    this.syncing = false;
    this.forceRefresh = false;
    this.complete = false;
    this.previousRows = '';
    this.chats = [];
    await this.refresh();
  }

  more(): void {
    this.limit += PAGE_SIZE;
    this.render();
  }

  private async sync(force = false): Promise<void> {
    clearTimeout(this.autoRefreshTimer);
    if (this.disposed || !(force || this.view?.visible)) return;
    if (this.syncing) {
      this.forceRefresh ||= force;
      return;
    }
    const generation = this.generation;
    const current = () => !this.disposed && generation === this.generation;
    this.syncing = true;
    let changed = !this.ready;
    this.ready = true;
    if (changed) this.render();
    try {
      if (!this.history) {
        const binary = await getBinary();
        if (!current()) return;
        const client = new CodexClient(binary, this.context.extension.packageJSON.version, vscode.env.language);
        this.connecting = client;
        try {
          const history = await ConversationHistory.open(client, this.context.globalStorageUri?.fsPath);
          if (!current()) { history.dispose(); return; }
          this.history = history;
        } catch (error) { client.dispose(); throw error; }
        finally { if (this.connecting === client) this.connecting = undefined; }
        this.readHistory();
        this.render();
      }
      await this.history.step(() => current() && Boolean(force || this.view?.visible), force);
      if (current()) {
        changed ||= this.error !== '';
        this.error = '';
        changed = this.readHistory() || changed;
      }
    } catch (error) {
      if (current()) {
        const message = error instanceof Error ? error.message : t('errorReadFailed');
        changed ||= this.error !== message;
        this.error = message;
      }
    } finally {
      if (current()) {
        this.syncing = false;
        if (changed) this.render();
        const queued = this.forceRefresh;
        this.forceRefresh = false;
        if (this.view?.visible) {
          this.autoRefreshTimer = setTimeout(() => {
            void this.sync(queued);
          }, queued ? 0 : this.complete || this.error ? HEAD_REFRESH_MS : INDEX_STEP_MS);
        }
      }
    }
  }

  private readHistory(): boolean {
    if (!this.history) return false;
    const rows = this.history.rows();
    const rendered = JSON.stringify(rows);
    const rowsChanged = this.previousRows !== rendered;
    if (rowsChanged) {
      this.chats = rows;
      this.previousRows = rendered;
    }
    const complete = this.history.complete;
    const progressChanged = complete !== this.complete;
    this.complete = complete;
    return rowsChanged || progressChanged;
  }

  async open(id: string): Promise<void> {
    const chat = this.chats.find(item => item.id === id);
    const history = this.history;
    if (this.opening || !chat || !history) return;
    this.opening = id;
    this.render();
    try {
      let available = true;
      try { available = await history.verify(chat); }
      catch { /* Let the official view handle navigation if metadata validation is unavailable. */ }
      if (this.disposed || this.history !== history) return;
      this.readHistory();
      if (available) await openInCodex(id);
      else void vscode.window.showInformationMessage(t('threadUnavailable'));
    } catch {
      void vscode.window.showErrorMessage(t('errorOpenFailed'), t('copyId')).then(action => {
        if (action) void vscode.env.clipboard.writeText(id);
      });
    } finally {
      this.opening = null;
      this.render();
    }
  }

  private render(): void {
    if (!this.view || !this.ready || this.disposed) return;
    const info = [t(this.scope), t(this.grouping)];
    if (!this.showFolders) info.push(t('foldersHidden'));
    if (this.search) info.push(t('activeSearch', { query: this.search }));
    const selected = selectChats(this.chats, this.projects, this.scope, this.grouping, this.showFolders, this.search);
    const chats = selected.slice(0, this.limit);
    const count = chats.length;
    this.view.badge = count ? { value: count, tooltip: t(count === 1 ? 'loadedOne' : 'loadedOther', { count }) } : undefined;
    if (this.error) this.view.message = this.error;
    else if (this.scope === 'current' && !this.projects.roots.length) this.view.message = undefined;
    else {
      if (!this.complete) info.push(t('indexing'));
      else if (!count) info.push(t(this.search ? 'emptySearchTitle' : this.scope === 'current' ? 'emptyCurrentDetail' : 'emptyAllDetail'));
      this.view.message = info.join(' · ');
    }

    this.tree.update(groupChats(chats, this.projects.roots, this.grouping, this.projects),
      this.scope, Boolean(this.search), selected.length > chats.length, this.opening);
  }

  /** Metadata-free diagnostics used by the isolated extension-host smoke test. */
  snapshot() {
    return {
      ready: this.ready, busy: this.syncing, count: this.chats.length,
      error: this.error, scope: this.scope, grouping: this.grouping,
      indexed: this.complete, shared: Boolean(this.history?.persistent),
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    clearTimeout(this.autoRefreshTimer);
    clearTimeout(this.clockTimer);
    this.connecting?.dispose();
    this.history?.dispose();
    this.tree.dispose();
  }
}

export function activate(context: vscode.ExtensionContext) {
  const provider = new CodexChatsListView(context);
  const view = vscode.window.createTreeView(VIEW_ID, { treeDataProvider: provider.tree, showCollapseAll: true });
  context.subscriptions.push(provider,
    view,
    vscode.commands.registerCommand('codexChatsList.open', () => vscode.commands.executeCommand(`${VIEW_ID}.focus`)),
    vscode.commands.registerCommand('codexChatsList.refresh', () => provider.refresh()),
    vscode.commands.registerCommand('codexChatsList.selectScope', () => provider.pickScope()),
    vscode.commands.registerCommand('codexChatsList.selectGrouping', () => provider.pickGrouping()),
    vscode.commands.registerCommand('codexChatsList.toggleFolders', () => provider.toggleFolders()),
    vscode.commands.registerCommand('codexChatsList.showAll', () => provider.setScope('all')),
    vscode.commands.registerCommand('codexChatsList.search', () => provider.promptSearch()),
    vscode.commands.registerCommand('codexChatsList.clearSearch', () => provider.setSearch('')),
    vscode.commands.registerCommand(LOAD_MORE, () => provider.more()),
    vscode.commands.registerCommand(OPEN_CONVERSATION, (id: string) => provider.open(id)),
    vscode.workspace.onDidChangeWorkspaceFolders(() => { void provider.updateWorkspace(); }),
    vscode.workspace.onDidChangeConfiguration(event => {
      if (event.affectsConfiguration('codexChatsList.cliPath')
        || (event.affectsConfiguration(`${LEGACY_CONFIG_SECTION}.cliPath`) && ownCliPath() === undefined)) {
        void provider.resetSource();
      }
    }));
  provider.attach(view);
  return { snapshot: () => provider.snapshot() };
}
