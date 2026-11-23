import { createLocalizer } from './i18n';
import * as vscode from 'vscode';
import { access, realpath } from 'node:fs/promises';
import path from 'node:path';
import { CodexClient } from './client';
import { openInCodex } from './routing';
import { groupChats, uniquePaths, type Chat, type Scope } from './model';
import { ChatTree, LOAD_MORE, OPEN_CONVERSATION, VIEW_ID, type TreeNode } from './tree';

const t = createLocalizer(vscode.env.language);
const OFFICIAL_ID = 'openai.chatgpt';
const AUTO_REFRESH_MS = 5_000;
const MINUTE_MS = 60_000;
const SEARCH_LIMIT = 200;
const LEGACY_CONFIG_SECTION = 'codexProjectChats';
type LoadMode = 'replace' | 'append' | 'poll';

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
  private client?: CodexClient;
  private binary?: string;
  private scope: Scope;
  private search = '';
  private chats: Chat[] = [];
  private roots: string[] = [];
  private cursor: string | null = null;
  private loadedPages = 1;
  private generation = 0;
  private loading = false;
  private busy = false;
  private opening: string | null = null;
  private error = '';
  private ready = false;
  private disposed = false;
  private autoRefreshTimer?: ReturnType<typeof setTimeout>;
  private clockTimer?: ReturnType<typeof setTimeout>;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.scope = context.workspaceState.get<Scope>('scope', 'current');
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
    this.clearAutoRefresh();
    clearTimeout(this.clockTimer);
    this.clockTimer = undefined;
    if (!this.view?.visible || this.disposed) return;
    this.tree.refreshTimes();
    this.scheduleClock();
    if (this.ready) void this.autoRefresh();
    else void this.refresh();
  }

  private scheduleClock(): void {
    this.clockTimer = setTimeout(() => {
      if (!this.view?.visible || this.disposed) return;
      this.tree.refreshTimes();
      this.scheduleClock();
    }, MINUTE_MS - Date.now() % MINUTE_MS);
  }

  private isCurrent(generation: number): boolean {
    return generation === this.generation && !this.disposed && this.ready && this.view !== undefined;
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
    await Promise.all([this.refresh(), this.context.workspaceState.update('scope', this.scope)]);
  }

  async promptSearch(): Promise<void> {
    const value = await vscode.window.showInputBox({
      title: t('search'), value: this.search, placeHolder: t('searchPlaceholder'),
      validateInput: input => input.length > SEARCH_LIMIT ? t('searchTooLong', { count: SEARCH_LIMIT }) : undefined,
    });
    if (value !== undefined) await this.setSearch(value);
  }

  async setSearch(value: string): Promise<void> {
    const search = value.slice(0, SEARCH_LIMIT).trim();
    if (search === this.search || this.disposed) return;
    this.search = search;
    void vscode.commands.executeCommand('setContext', 'codexChatsList.hasSearch', Boolean(search));
    await this.refresh();
  }

  async refresh(): Promise<void> {
    if (this.disposed || !this.view) return;
    this.ready = true;
    await this.loadWithProgress('replace');
  }

  async refreshIfLoaded(): Promise<void> {
    if (this.ready) await this.refresh();
  }

  async more(): Promise<void> {
    if (!this.busy && this.cursor) await this.loadWithProgress('append');
  }

  private async loadWithProgress(mode: 'replace' | 'append'): Promise<void> {
    const load = this.load(mode);
    await vscode.window.withProgress({ location: { viewId: VIEW_ID } }, () => load);
  }

  private clearAutoRefresh(): void {
    clearTimeout(this.autoRefreshTimer);
    this.autoRefreshTimer = undefined;
  }

  /** Poll stored metadata only while visible; this client owns a separate app-server. */
  private async autoRefresh(): Promise<void> {
    if (!this.view?.visible || !this.ready || this.disposed || this.loading) return;
    await this.load('poll');
  }

  private scheduleAutoRefresh(): void {
    this.clearAutoRefresh();
    if (!this.view?.visible || !this.ready || this.disposed) return;
    this.autoRefreshTimer = setTimeout(() => {
      this.autoRefreshTimer = undefined;
      void this.autoRefresh();
    }, AUTO_REFRESH_MS);
  }

  private async load(mode: LoadMode): Promise<void> {
    if (this.disposed || !this.view || !this.ready) return;
    const append = mode === 'append';
    const background = mode === 'poll';
    const { scope, search } = this;
    this.clearAutoRefresh();
    const generation = ++this.generation;
    this.loading = true;
    this.busy = !background;
    let changed = false;
    if (!background) {
      this.error = '';
      if (mode === 'replace') { this.chats = []; this.cursor = null; this.loadedPages = 1; }
      this.render();
    }
    try {
      // A continuation must use the workspace paths that produced its cursor.
      const roots = append ? this.roots : await workspaceRoots();
      if (!this.isCurrent(generation)) return;
      const chatsById = new Map<string, Chat>(append ? this.chats.map(chat => [chat.id, chat]) : []);
      let cursor = append ? this.cursor : null;
      let pages = 0;
      if (scope !== 'current' || roots.length) {
        const binary = await getBinary();
        if (!this.isCurrent(generation)) return;
        if (!this.client || binary !== this.binary) { this.client?.dispose(); this.client = new CodexClient(binary, this.context.extension.packageJSON.version, vscode.env.language); this.binary = binary; }
        // Rebuild every loaded page so removals and changed ordering cannot leave a stale tail.
        const pageLimit = background ? this.loadedPages : 1;
        do {
          const page = await this.client.list(scope === 'current' ? roots : undefined, search, cursor);
          if (!this.isCurrent(generation)) return;
          for (const chat of page.chats) chatsById.set(chat.id, chat);
          cursor = page.nextCursor;
          pages++;
        } while (cursor && pages < pageLimit);
      }
      const chats = [...chatsById.values()];
      changed = this.error !== '' || cursor !== this.cursor || roots.length !== this.roots.length
        || roots.some((root, index) => root !== this.roots[index]) || chats.length !== this.chats.length
        || chats.some((chat, index) => {
          const previous = this.chats[index];
          return !previous || chat.id !== previous.id || chat.title !== previous.title
            || chat.cwd !== previous.cwd || chat.recencyAt !== previous.recencyAt;
        });
      this.roots = roots;
      this.chats = chats;
      this.cursor = cursor;
      this.loadedPages = append ? this.loadedPages + pages : Math.max(1, pages);
      this.error = '';
    } catch (error) {
      if (this.isCurrent(generation)) {
        const message = error instanceof Error ? error.message : t('errorReadFailed');
        changed = this.error !== message;
        this.error = message;
        this.client?.dispose(); this.client = undefined;
      }
    } finally {
      if (this.isCurrent(generation)) {
        this.loading = false; this.busy = false;
        if (!background || changed) this.render();
        this.scheduleAutoRefresh();
      }
    }
  }

  async open(id: string): Promise<void> {
    if (this.opening || !this.chats.some(chat => chat.id === id)) return;
    this.opening = id;
    this.render();
    try {
      await openInCodex(id);
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
    const scope = t(this.scope);
    const summary = this.search ? `${scope} · ${t('activeSearch', { query: this.search })}` : scope;
    const count = this.chats.length;
    this.view.badge = count ? { value: count, tooltip: t(count === 1 ? 'loadedOne' : 'loadedOther', { count }) } : undefined;
    this.view.message = this.error || (count ? summary : this.emptyMessage(summary));
    this.tree.update(groupChats(this.chats, this.roots), this.scope, Boolean(this.search),
      Boolean(this.cursor && !this.busy && !this.error), this.opening);
  }

  private emptyMessage(summary: string): string | undefined {
    if (this.busy) return t('reading');
    if (this.scope === 'current' && !this.roots.length) return undefined;
    if (this.search) return [summary, t('emptySearchTitle'), t('emptySearchDetail')].join('\n');
    return t(this.scope === 'current' ? 'emptyCurrentDetail' : 'emptyAllDetail');
  }

  /** Metadata-free diagnostics used by the isolated extension-host smoke test. */
  snapshot() { return { ready: this.ready, busy: this.busy, count: this.chats.length, error: this.error, scope: this.scope }; }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.ready = false;
    this.loading = false;
    this.busy = false;
    this.view = undefined;
    this.clearAutoRefresh();
    clearTimeout(this.clockTimer);
    this.client?.dispose();
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
    vscode.commands.registerCommand('codexChatsList.showAll', () => provider.setScope('all')),
    vscode.commands.registerCommand('codexChatsList.search', () => provider.promptSearch()),
    vscode.commands.registerCommand('codexChatsList.clearSearch', () => provider.setSearch('')),
    vscode.commands.registerCommand(LOAD_MORE, () => provider.more()),
    vscode.commands.registerCommand(OPEN_CONVERSATION, (id: string) => provider.open(id)),
    vscode.workspace.onDidChangeWorkspaceFolders(() => { void provider.refreshIfLoaded(); }),
    vscode.workspace.onDidChangeConfiguration(event => {
      if (event.affectsConfiguration('codexChatsList.cliPath')
        || (event.affectsConfiguration(`${LEGACY_CONFIG_SECTION}.cliPath`) && ownCliPath() === undefined)) {
        void provider.refreshIfLoaded();
      }
    }));
  provider.attach(view);
  return { snapshot: () => provider.snapshot() };
}
