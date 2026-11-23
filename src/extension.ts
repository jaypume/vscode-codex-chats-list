import { createLocalizer } from './i18n';
import * as vscode from 'vscode';
import { access, realpath } from 'node:fs/promises';
import path from 'node:path';
import { RepositoryAssignments } from './assignments';
import { CodexClient } from './client';
import { findRepositories, inspectDirectory, type RepositoryTarget, type WorkspaceRepository } from './git';
import { ConversationHistory, HEAD_REFRESH_MS } from './history';
import { ItemFlags } from './item-flags';
import { RepositoryCatalog } from './repositories';
import { openInCodex } from './routing';
import {
  filterTitles, groupChats, pathKey, selectChats, uniquePaths, type Chat, type Grouping, type GroupOrder, type Scope, type WorkspaceProjects,
} from './model';
import { ChatTree, OPEN_CONVERSATION, projectCountDecorations, VIEW_ID, type TreeNode } from './tree';

const t = createLocalizer(vscode.env.language);
const OFFICIAL_ID = 'openai.chatgpt';
const INDEX_STEP_MS = 150;
const SEARCH_LIMIT = 200;
const SEARCH_DELAY_MS = 120;
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
  private readonly pins: ItemFlags;
  private readonly hidden: ItemFlags;
  private readonly repositories: RepositoryCatalog;
  private view?: vscode.TreeView<TreeNode>;
  private history?: ConversationHistory;
  private assignments?: RepositoryAssignments;
  private connecting?: CodexClient;
  private scope: Scope;
  private grouping: Grouping;
  private order: GroupOrder;
  private showFolders: boolean;
  private hiddenOnly = false;
  private search = '';
  private searchInput?: vscode.InputBox;
  private chats: Chat[] = [];
  private complete = false;
  private previousRows = '';
  private projects: WorkspaceProjects = { roots: [], remotes: new Set(), gitDirectories: new Set() };
  private repositoryProjects?: WorkspaceProjects;
  private candidates?: {
    source: Chat[];
    projects: WorkspaceProjects;
    scope: Scope;
    grouping: Grouping;
    showFolders: boolean;
    rows: Chat[];
  };
  private workspaceRepositories = new Map<string, WorkspaceRepository>();
  private checkingRepositories = false;
  private repositoryRefreshQueued = false;
  private forceRepositoryPaths = false;
  private repositoryRenderTimer?: ReturnType<typeof setTimeout>;
  private generation = 0;
  private workspaceGeneration = 0;
  private syncing = false;
  private forceRefresh = false;
  private opening: string | null = null;
  private deleting = false;
  private error = '';
  private ready = false;
  private disposed = false;
  private autoRefreshTimer?: ReturnType<typeof setTimeout>;
  private dateRefreshTimer?: ReturnType<typeof setTimeout>;

  constructor(private readonly context: vscode.ExtensionContext) {
    const saved = context.workspaceState.get<Scope | 'repository'>('scope');
    const view = context.workspaceState.get<{
      scope: Scope; grouping: Grouping; showFolders: boolean; order?: GroupOrder;
    }>('historyView');
    this.scope = (view?.scope ?? saved) === 'all' ? 'all' : 'current';
    this.grouping = view ? (view.grouping === 'folder' ? 'folder' : 'repository')
      : saved && saved !== 'repository' ? 'folder' : 'repository';
    this.showFolders = view?.showFolders !== false;
    this.order = view?.order === 'name' ? 'name' : 'recent';
    const storage = context.globalStorageUri?.fsPath;
    this.pins = new ItemFlags(storage, 'pins-v1');
    this.hidden = new ItemFlags(storage, 'hidden-v1');
    this.repositories = new RepositoryCatalog(context.globalStorageUri?.fsPath);
    this.tree = new ChatTree(context.workspaceState, context.extensionUri, id => ({
      pinned: this.pins.has('chat', id),
      hidden: this.hidden.has('chat', id),
      assignedRepository: this.assignmentLabel(id),
    }));
  }

  attach(view: vscode.TreeView<TreeNode>): void {
    this.view = view;
    this.updateScopeContext();
    this.context.subscriptions.push(
      view.onDidChangeVisibility(() => this.visibilityChanged()),
      view.onDidExpandElement(({ element }) => this.tree.rememberExpansion(element, true)),
      view.onDidCollapseElement(({ element }) => this.tree.rememberExpansion(element, false)),
    );
    this.visibilityChanged();
  }

  private visibilityChanged(): void {
    clearTimeout(this.autoRefreshTimer);
    clearTimeout(this.dateRefreshTimer);
    if (!this.view?.visible || this.disposed) return;
    this.refreshDates();
    if (!this.ready) void this.updateWorkspace();
    void this.sync();
  }

  private refreshDates(): void {
    this.tree.refresh();
    const now = new Date();
    const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
    this.dateRefreshTimer = setTimeout(() => this.refreshDates(), tomorrow.getTime() - now.getTime());
  }

  async updateWorkspace(forcePaths = false): Promise<void> {
    const generation = ++this.workspaceGeneration;
    const roots = await workspaceRoots();
    const [remotes, directories] = await Promise.all([
      findRepositories(roots),
      Promise.all(roots.map(root => inspectDirectory(root))),
    ]);
    if (this.disposed || generation !== this.workspaceGeneration) return;
    this.workspaceRepositories = remotes;
    this.repositoryProjects = undefined;
    this.projects = {
      roots,
      remotes: new Set(remotes.keys()),
      gitDirectories: new Set(directories.flatMap(dir => dir.kind === 'git' ? [pathKey(dir.common)] : [])),
    };
    this.render();
    this.refreshRepositories(forcePaths);
  }

  private refreshRepositories(forcePaths = false): void {
    const active = () => !this.disposed && Boolean(this.view?.visible) && this.grouping === 'repository';
    if (!active()) return;
    this.forceRepositoryPaths ||= forcePaths;
    if (this.checkingRepositories) {
      this.repositoryRefreshQueued = true;
      return;
    }
    this.checkingRepositories = true;
    const force = this.forceRepositoryPaths;
    this.forceRepositoryPaths = false;
    const updated = () => {
      this.repositoryProjects = undefined;
      if (this.repositoryRenderTimer) return;
      this.repositoryRenderTimer = setTimeout(() => {
        this.repositoryRenderTimer = undefined;
        if (active()) this.render();
      }, INDEX_STEP_MS);
    };
    void this.repositories.refresh(this.chats, this.workspaceRepositories, active, updated, force, this.assignmentRemotes())
      .catch(() => {})
      .finally(() => {
        this.checkingRepositories = false;
        if (this.repositoryRefreshQueued) {
          this.repositoryRefreshQueued = false;
          this.refreshRepositories();
        }
      });
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
    this.updateScopeContext();
    this.render();
    await this.saveView();
  }

  private updateScopeContext(): void {
    void vscode.commands.executeCommand('setContext', 'codexChatsList.allProjects', this.scope === 'all');
  }

  async pickOrder(): Promise<void> {
    if (this.scope !== 'all' || this.disposed) return;
    const options = (['recent', 'name'] as const).map(value => ({
      value, label: t(value === 'recent' ? 'sortByActivity' : 'sortByName'),
      description: value === this.order ? t('selectedScope') : undefined,
    }));
    const option = await vscode.window.showQuickPick(options, { title: t('sortProjects') });
    if (!option || option.value === this.order || this.disposed) return;
    this.order = option.value;
    this.render();
    await this.saveView();
  }

  async setFlag(node: TreeNode | undefined, flag: 'pinned' | 'hidden', enabled: boolean): Promise<void> {
    if (!node || this.disposed) return;
    const store = flag === 'pinned' ? this.pins : this.hidden;
    try {
      await store.set(node.kind, node.kind === 'project' ? node.group.key : node.chat.id, enabled);
      if (!enabled && node.kind === 'project') {
        await Promise.all((node.group.preferenceAliases ?? []).map(key => store.set('project', key, false)));
      }
      this.render();
    } catch {
      void vscode.window.showErrorMessage(t(flag === 'pinned' ? 'errorSavePin' : 'errorSaveHidden'));
    }
  }

  toggleHidden(): void {
    if (this.disposed) return;
    this.hiddenOnly = !this.hiddenOnly;
    this.render();
  }

  private assignmentLabel(id: string): string | undefined {
    const target = this.assignments?.targets.get(id);
    if (target?.kind === 'git') return target.root;
    if (target?.kind === 'remote') {
      return this.repositoryProjects?.repositoryView?.get(target.githubKey ?? target.remote)?.remote ?? target.remote;
    }
    return undefined;
  }

  private assignmentRemotes(): string[] {
    return [...(this.assignments?.targets.values() ?? [])].flatMap(target =>
      target.kind === 'remote' ? [target.remote] : []);
  }

  async moveConversation(node?: TreeNode): Promise<void> {
    const assignments = this.assignments;
    if (this.disposed || !assignments || node?.kind !== 'chat') return;
    const view = this.repositories.presentation(this.chats, this.workspaceRepositories, this.assignmentRemotes());
    const remoteTarget = (remote: string): RepositoryTarget => {
      const match = view.get(remote);
      return {
        kind: 'remote', remote: match?.remote ?? remote,
        githubKey: match?.key.startsWith('github:') ? match.key : undefined,
      };
    };
    const choices = new Map<string, vscode.QuickPickItem & { target: RepositoryTarget }>();
    const add = (target: RepositoryTarget) => {
      const identity = target.kind === 'remote' ? target.githubKey ?? `remote:${target.remote}` : `git:${pathKey(target.common)}`;
      const location = target.kind === 'remote' ? target.remote : target.root;
      const label = location.replace(/\\/g, '/').split('/').at(-1) || location;
      choices.set(identity, { label, description: location, target });
    };
    for (const repo of this.workspaceRepositories.values()) add(remoteTarget(repo.key));
    for (const chat of this.chats) {
      if (chat.repository) add(remoteTarget(chat.repository));
      else if (chat.directory?.kind === 'git') add(chat.directory);
    }
    for (const target of assignments.targets.values()) add(target);
    const options: (vscode.QuickPickItem & { target?: RepositoryTarget })[] = [
      { label: t('chooseRepositoryFolder'), alwaysShow: true },
      ...[...choices.values()].sort((a, b) => a.label.localeCompare(b.label)
        || (a.description ?? '').localeCompare(b.description ?? '')),
    ];
    const selected = await vscode.window.showQuickPick(options, { title: t('moveRepository'), matchOnDescription: true });
    if (!selected || this.disposed || this.assignments !== assignments) return;
    let target = selected.target;
    if (!target) {
      const [folder] = await vscode.window.showOpenDialog({
        title: t('chooseRepositoryFolder'), canSelectFolders: true, canSelectFiles: false,
        defaultUri: vscode.workspace.workspaceFolders?.[0]?.uri,
      }) ?? [];
      if (!folder) return;
      const directory = await inspectDirectory(folder.fsPath);
      if (directory.kind !== 'git') {
        void vscode.window.showWarningMessage(t('chooseGitRepository'));
        return;
      }
      const remotes = await findRepositories([folder.fsPath]);
      const remote = remotes.values().next().value;
      target = remote ? remoteTarget(remote.key) : directory;
    }
    await this.saveAssignment(assignments, node.chat.id, target);
  }

  async restoreAssignment(node?: TreeNode): Promise<void> {
    if (node?.kind === 'chat' && this.assignments?.targets.has(node.chat.id)) {
      await this.saveAssignment(this.assignments, node.chat.id);
    }
  }

  private async saveAssignment(assignments: RepositoryAssignments, id: string, target?: RepositoryTarget): Promise<void> {
    if (this.disposed || assignments !== this.assignments || !this.chats.some(chat => chat.id === id)) return;
    try {
      await assignments.set(id, target);
      if (this.disposed || assignments !== this.assignments) return;
      this.repositoryProjects = undefined;
      this.render();
      this.refreshRepositories();
      if (target) void vscode.window.showInformationMessage(t('repositoryMoved', { repository: this.assignmentLabel(id) ?? '' }));
    } catch {
      void vscode.window.showErrorMessage(t('saveAssignmentFailed'));
    }
  }

  async deleteConversations(node: TreeNode | undefined): Promise<void> {
    const history = this.history;
    if (!node || !history || this.disposed || this.deleting) return;
    if (node.kind === 'project' && !history.complete) {
      void vscode.window.showInformationMessage(t('deleteWaitingForIndex'));
      return;
    }
    const rows = history.rows();
    const group = node.kind === 'project'
      ? groupChats(rows, this.projects.roots, this.grouping, this.viewProjects(rows))
        .find(item => item.key === node.group.key) : undefined;
    const chats = node.kind === 'chat' ? rows.filter(chat => chat.id === node.chat.id) : group?.chats ?? [];
    if (!chats.length) return;
    const message = group ? t('deleteProjectPrompt', { name: group.name, count: chats.length })
      : t('deleteChatPrompt', { title: chats[0]!.title });
    const detailLines = group ? [group.repository ?? group.cwd, t('deleteProjectDetail')] : [chats[0]!.cwd];
    if (group && this.grouping === 'repository') {
      const count = chats.filter(chat => this.assignments?.targets.has(chat.id)).length;
      if (count) detailLines.push(t('deleteAssignedDetail', { count }));
    }
    const detail = detailLines.concat(t('deleteDetail')).join('\n\n');
    this.deleting = true;
    try {
      const cancel = { title: t('deleteCancel'), isCloseAffordance: true };
      const button = { title: t('deleteConfirm') };
      const confirm = await vscode.window.showWarningMessage(message, { modal: true, detail }, cancel, button);
      if (confirm !== button || this.disposed || this.history !== history) return;
      let deleted = 0;
      let unsupported = false;
      await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: t('deleting') }, async progress => {
        for (const chat of chats) {
          if (this.disposed || this.history !== history) break;
          try {
            await history.deleteThread(chat);
            deleted++;
          } catch (error) {
            if ((error as { code?: unknown } | null)?.code === -32601) {
              unsupported = true;
              break;
            }
          }
          progress.report({ increment: 100 / chats.length });
        }
      });
      if (this.disposed || this.history !== history) return;
      this.readHistory();
      this.render();
      if (unsupported) void vscode.window.showErrorMessage(t('deleteUnsupported'));
      else if (deleted < chats.length) {
        void vscode.window.showWarningMessage(t('deletePartial', { deleted, failed: chats.length - deleted }));
      } else {
        void vscode.window.showInformationMessage(t('deleteDone', { count: deleted }));
      }
    } finally {
      this.deleting = false;
    }
  }

  async pickGrouping(): Promise<void> {
    const options = (['repository', 'folder'] as const).map(value => ({
      value, label: t(value), description: value === this.grouping ? t('selectedScope') : undefined,
    }));
    const option = await vscode.window.showQuickPick(options, { title: t('grouping') });
    if (!option || option.value === this.grouping || this.disposed) return;
    this.grouping = option.value;
    this.render();
    this.refreshRepositories();
    await this.saveView();
  }

  async toggleFolders(): Promise<void> {
    if (this.disposed) return;
    this.showFolders = !this.showFolders;
    this.render();
    await this.saveView();
  }

  private saveView(): Thenable<void> {
    return this.context.workspaceState.update('historyView', {
      scope: this.scope, grouping: this.grouping, showFolders: this.showFolders, order: this.order,
    });
  }

  async promptSearch(): Promise<void> {
    if (this.disposed || this.searchInput) return;
    if (!this.view?.visible) await vscode.commands.executeCommand(`${VIEW_ID}.focus`);
    if (this.disposed || this.searchInput) return;

    const input = vscode.window.createInputBox();
    this.searchInput = input;
    const previousSearch = this.search;
    input.title = `${t('search')} · ${t(this.scope)}`;
    input.placeholder = t('searchPlaceholder');
    input.value = previousSearch;

    await new Promise<void>(resolve => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let accepted = false;
      const edit = input.onDidChangeValue(value => {
        clearTimeout(timer);
        input.validationMessage = value.length > SEARCH_LIMIT
          ? t('searchTooLong', { count: SEARCH_LIMIT }) : undefined;
        if (value.length <= SEARCH_LIMIT) timer = setTimeout(() => this.setSearch(value), SEARCH_DELAY_MS);
      });
      const accept = input.onDidAccept(() => {
        if (input.value.length > SEARCH_LIMIT) return;
        accepted = true;
        this.setSearch(input.value);
        input.hide();
      });
      const hide = input.onDidHide(() => {
        clearTimeout(timer);
        this.searchInput = undefined;
        edit.dispose();
        accept.dispose();
        hide.dispose();
        input.dispose();
        if (!accepted) this.setSearch(previousSearch);
        resolve();
      });
      input.show();
    });
  }

  setSearch(value: string): void {
    const search = value.slice(0, SEARCH_LIMIT).trim();
    if (this.disposed || search === this.search) return;
    if (Boolean(search) !== Boolean(this.search)) {
      void vscode.commands.executeCommand('setContext', 'codexChatsList.hasSearch', Boolean(search));
    }
    this.search = search;
    this.render();
  }

  async refresh(): Promise<void> {
    if (this.disposed || !this.view) return;
    await vscode.window.withProgress({ location: { viewId: VIEW_ID } }, async () => {
      await this.updateWorkspace(true);
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
    this.assignments = undefined;
    this.syncing = false;
    this.forceRefresh = false;
    this.complete = false;
    this.previousRows = '';
    this.chats = [];
    this.repositoryProjects = undefined;
    this.render();
    await this.refresh();
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
      const flags = await Promise.all([this.pins, this.hidden].map(store => store.reload().catch(() => false)));
      if (await this.assignments?.reload().catch(() => false) && current()) {
        this.repositoryProjects = undefined;
        changed = true;
      }
      if (flags.some(Boolean) && current()) this.render();
      if (!current()) return;
      if (!this.history) {
        const binary = await getBinary();
        if (!current()) return;
        const client = new CodexClient(binary, this.context.extension.packageJSON.version, vscode.env.language);
        this.connecting = client;
        try {
          const history = await ConversationHistory.open(client, this.context.globalStorageUri?.fsPath);
          if (!current()) { history.dispose(); return; }
          this.history = history;
          this.assignments = new RepositoryAssignments(this.context.globalStorageUri?.fsPath, history.sourceKey);
          await this.assignments.reload().catch(() => false);
          if (!current()) return;
          this.repositoryProjects = undefined;
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
        this.refreshRepositories();
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
      this.repositoryProjects = undefined;
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
    if (this.hiddenOnly) info.push(t('hiddenOnly'));
    if (this.search) info.push(t('activeSearch', { query: this.search }));
    const projects = this.viewProjects();
    const selected = filterTitles(this.viewCandidates(projects), this.search);
    const order = this.scope === 'all' ? this.order : undefined;
    const groups = groupChats(selected, projects.roots, this.grouping, projects, order).flatMap(group => {
      const hidden = this.hidden.has('project', group.key, group.preferenceAliases);
      const chats = hidden ? (this.hiddenOnly ? group.chats : [])
        : group.chats.filter(chat => this.hidden.has('chat', chat.id) === this.hiddenOnly);
      const pinned = this.pins.has('project', group.key, group.preferenceAliases);
      return chats.length ? [{ ...group, chats, pinned, hidden, latestConversationAt: chats[0]!.recencyAt }] : [];
    });
    if (this.error) this.view.message = this.error;
    else if (this.scope === 'current' && !this.projects.roots.length) this.view.message = undefined;
    else {
      if (!this.complete) info.push(t('indexing'));
      else if (!groups.length) info.push(t(this.hiddenOnly ? 'emptyHidden' : this.search ? 'emptySearchTitle' : this.scope === 'current' ? 'emptyCurrentDetail' : 'emptyAllDetail'));
      this.view.message = info.join(' · ');
    }

    this.tree.update(groups, this.scope, Boolean(this.search) || this.hiddenOnly, this.opening);
  }

  private viewProjects(chats = this.chats): WorkspaceProjects {
    if (this.grouping !== 'repository') return this.projects;
    if (chats === this.chats && this.repositoryProjects) return this.repositoryProjects;
    const projects = {
      ...this.projects, assignments: this.assignments?.targets,
      repositoryView: this.repositories.presentation(chats, this.workspaceRepositories, this.assignmentRemotes()),
    };
    if (chats === this.chats) this.repositoryProjects = projects;
    return projects;
  }

  private viewCandidates(projects: WorkspaceProjects): Chat[] {
    const cached = this.candidates;
    if (cached?.source === this.chats && cached.projects === projects && cached.scope === this.scope
      && cached.grouping === this.grouping && cached.showFolders === this.showFolders) return cached.rows;
    const rows = selectChats(this.chats, projects, this.scope, this.grouping, this.showFolders, '');
    this.candidates = {
      source: this.chats, projects, scope: this.scope, grouping: this.grouping, showFolders: this.showFolders, rows,
    };
    return rows;
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
    clearTimeout(this.dateRefreshTimer);
    clearTimeout(this.repositoryRenderTimer);
    this.searchInput?.hide();
    this.connecting?.dispose();
    this.history?.dispose();
    this.tree.dispose();
  }
}

export function activate(context: vscode.ExtensionContext) {
  const provider = new CodexChatsListView(context);
  const view = vscode.window.createTreeView(VIEW_ID, { treeDataProvider: provider.tree, showCollapseAll: true });
  // The workbench can retain a previous badge across extension host restarts.
  // Set a hidden zero first so the host forwards the subsequent clear.
  view.badge = { value: 0, tooltip: '' };
  view.badge = undefined;
  context.subscriptions.push(provider,
    view,
    vscode.window.registerFileDecorationProvider(provider.tree),
    // VS Code joins decoration text in reverse registration order, with the count first.
    vscode.window.registerFileDecorationProvider(projectCountDecorations),
    vscode.commands.registerCommand('codexChatsList.open', () => vscode.commands.executeCommand(`${VIEW_ID}.focus`)),
    vscode.commands.registerCommand('codexChatsList.refresh', () => provider.refresh()),
    vscode.commands.registerCommand('codexChatsList.selectScope', () => provider.pickScope()),
    vscode.commands.registerCommand('codexChatsList.selectGrouping', () => provider.pickGrouping()),
    vscode.commands.registerCommand('codexChatsList.sortProjects', () => provider.pickOrder()),
    vscode.commands.registerCommand('codexChatsList.pin', (node?: TreeNode) => provider.setFlag(node, 'pinned', true)),
    vscode.commands.registerCommand('codexChatsList.unpin', (node?: TreeNode) => provider.setFlag(node, 'pinned', false)),
    vscode.commands.registerCommand('codexChatsList.hide', (node?: TreeNode) => provider.setFlag(node, 'hidden', true)),
    vscode.commands.registerCommand('codexChatsList.unhide', (node?: TreeNode) => provider.setFlag(node, 'hidden', false)),
    vscode.commands.registerCommand('codexChatsList.moveToRepository', (node?: TreeNode) => provider.moveConversation(node)),
    vscode.commands.registerCommand('codexChatsList.restoreRepository', (node?: TreeNode) => provider.restoreAssignment(node)),
    vscode.commands.registerCommand('codexChatsList.toggleHidden', () => provider.toggleHidden()),
    vscode.commands.registerCommand('codexChatsList.delete', (node?: TreeNode) => provider.deleteConversations(node)),
    vscode.commands.registerCommand('codexChatsList.toggleFolders', () => provider.toggleFolders()),
    vscode.commands.registerCommand('codexChatsList.showAll', () => provider.setScope('all')),
    vscode.commands.registerCommand('codexChatsList.showCurrent', () => provider.setScope('current')),
    vscode.commands.registerCommand('codexChatsList.search', () => provider.promptSearch()),
    vscode.commands.registerCommand('codexChatsList.clearSearch', () => provider.setSearch('')),
    vscode.commands.registerCommand(OPEN_CONVERSATION, (id: string) => provider.open(id)),
    vscode.workspace.onDidChangeWorkspaceFolders(() => { void provider.updateWorkspace(); }),
    vscode.workspace.onDidChangeConfiguration(event => {
      if (event.affectsConfiguration('explorer.decorations.badges')) provider.tree.updateBadgeSetting();
      if (event.affectsConfiguration('codexChatsList.cliPath')
        || (event.affectsConfiguration(`${LEGACY_CONFIG_SECTION}.cliPath`) && ownCliPath() === undefined)) {
        void provider.resetSource();
      }
    }));
  provider.attach(view);
  return { snapshot: () => provider.snapshot() };
}
