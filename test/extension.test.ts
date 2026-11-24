import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type * as vscode from 'vscode';
import type { Directory, WorkspaceRepository } from '../src/git';
import type { Chat, ChatPage, Grouping, GroupOrder, Scope } from '../src/model';
import { projectCountDecorations, type ChatTree, type TreeNode } from '../src/tree';

const mocks = vi.hoisted(() => ({
  list: vi.fn<(roots: string[] | undefined, search: string, cursor: string | null) => Promise<ChatPage>>(),
  inspectDirectory: vi.fn<(cwd: string) => Promise<Directory>>(),
  checkThread: vi.fn<(id: string) => Promise<Chat | undefined>>(),
  deleteThread: vi.fn<(id: string) => Promise<void>>(),
  findRepositories: vi.fn<(roots: string[]) => Promise<Map<string, WorkspaceRepository>>>(),
  dispose: vi.fn(),
  construct: vi.fn(),
  createTree: vi.fn<(id: string, options: vscode.TreeViewOptions<TreeNode>) => vscode.TreeView<TreeNode>>(),
  registerCommand: vi.fn<(id: string, handler: (...args: unknown[]) => unknown) => vscode.Disposable>(),
  executeCommand: vi.fn(),
  showWarning: vi.fn<(message: string, options?: vscode.MessageOptions, cancel?: vscode.MessageItem, confirm?: vscode.MessageItem) => Promise<vscode.MessageItem | undefined>>(),
  openConversation: vi.fn(),
  promptScope: vi.fn<(items: { label?: string; description?: string; value?: Scope | Grouping | GroupOrder }[]) => Promise<{ value?: Scope | Grouping | GroupOrder; label?: string } | undefined>>(),
  chooseFolder: vi.fn<() => Promise<Pick<vscode.Uri, 'fsPath'>[] | undefined>>(),
  createInputBox: vi.fn<() => TestInputBox>(),
  realpath: vi.fn<(path: string) => Promise<string>>(),
  updateScope: vi.fn<(key: string, value: unknown) => Promise<void>>(),
  cliPath: undefined as string | undefined,
  legacyCliPath: '/fixture/codex',
  dateBadges: true,
}));
vi.mock('../src/client', () => ({ CodexClient: class {
  constructor(...args: unknown[]) { mocks.construct(...args); }
  list = mocks.list;
  async historySource() { return '/fixture/codex-home'; }
  checkThread = mocks.checkThread;
  deleteThread = mocks.deleteThread;
  dispose = mocks.dispose;
} }));
vi.mock('../src/routing', () => ({ openInCodex: mocks.openConversation }));
vi.mock('../src/git', async importOriginal => ({
  ...await importOriginal<typeof import('../src/git')>(),
  findRepositories: mocks.findRepositories,
  inspectDirectory: mocks.inspectDirectory,
}));
vi.mock('node:fs/promises', () => ({ access: async () => {}, realpath: mocks.realpath }));
vi.mock('vscode', () => ({
  env: { language: 'en' },
  extensions: { getExtension: () => ({ extensionPath: '/fixture/official' }) },
  workspace: {
    workspaceFolders: [{ uri: { scheme: 'file', fsPath: '/fixture' } }],
    getConfiguration: (section: string) => ({
      get: () => section === 'codexProjectChats' ? mocks.legacyCliPath
        : section === 'explorer.decorations' ? mocks.dateBadges : false,
      inspect: () => ({ globalValue: mocks.cliPath, defaultValue: '' }),
    }),
    onDidChangeWorkspaceFolders: () => ({ dispose() {} }),
    onDidChangeConfiguration: () => ({ dispose() {} }),
  },
  window: {
    createTreeView: mocks.createTree,
    registerFileDecorationProvider: () => ({ dispose() {} }),
    createInputBox: mocks.createInputBox,
    showQuickPick: mocks.promptScope,
    showOpenDialog: mocks.chooseFolder,
    showInformationMessage: vi.fn(),
    showWarningMessage: mocks.showWarning,
    withProgress: (_options: unknown, task: (progress: vscode.Progress<unknown>) => Promise<void>) => task({ report() {} }),
  },
  ProgressLocation: { Notification: 15 },
  commands: { registerCommand: mocks.registerCommand, executeCommand: mocks.executeCommand },
  EventEmitter: class<T> {
    private readonly signal = new Signal<T>();
    readonly event = this.signal.listen;
    fire(value: T) { this.signal.fire(value); }
    dispose() { this.signal.clear(); }
  },
  TreeItem: class {
    constructor(readonly label: string, readonly collapsibleState = 0) {}
  },
  Uri: {
    from: (value: unknown) => value,
    joinPath: (base: { path: string }, ...segments: string[]) => ({ path: [base.path, ...segments].join('/') }),
  },
  FileDecoration: class {
    constructor(readonly badge: string, readonly tooltip: string) {}
  },
  TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
  ThemeColor: class {
    constructor(readonly id: string) {}
  },
  ThemeIcon: class {
    static readonly Folder = { id: 'folder' };
    constructor(readonly id: string, readonly color?: vscode.ThemeColor) {}
  },
}));
import { activate } from '../src/extension';

class Signal<T> {
  private readonly listeners = new Set<(value: T) => unknown>();
  listen = (listener: (value: T) => unknown) => {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  };
  fire(value: T) { for (const listener of this.listeners) listener(value); }
  clear() { this.listeners.clear(); }
}

class TestInputBox {
  private readonly changed = new Signal<string>();
  private readonly accepted = new Signal<void>();
  private readonly hidden = new Signal<void>();
  readonly onDidChangeValue = this.changed.listen;
  readonly onDidAccept = this.accepted.listen;
  readonly onDidHide = this.hidden.listen;
  value = '';
  title = '';
  type(value: string) { this.value = value; this.changed.fire(value); }
  accept() { this.accepted.fire(); }
  hide() { this.hidden.fire(); }
  show() {}
  dispose() {}
}

const disposables: vscode.Disposable[] = [];
const page = (id: string): ChatPage => ({ chats: [{ id, cwd: '/fixture', title: id, recencyAt: 1 }], nextCursor: null });

async function setup(saved?: Scope | 'repository') {
  const context = {
    extension: { packageJSON: { version: '3.2.1' } },
    extensionUri: { path: '/extension' },
    subscriptions: disposables,
    workspaceState: { get: (key: string, fallback: unknown) => key === 'scope' ? saved : fallback, update: mocks.updateScope },
  } as unknown as vscode.ExtensionContext;
  const visibility = new Signal<void>();
  const expanded = new Signal<{ element: TreeNode }>();
  const collapsed = new Signal<{ element: TreeNode }>();
  const badgeUpdates: (vscode.ViewBadge | undefined)[] = [];
  const view = {
    visible: false,
    get badge() { return badgeUpdates.at(-1); },
    set badge(badge: vscode.ViewBadge | undefined) { badgeUpdates.push(badge); },
    onDidChangeVisibility: visibility.listen,
    onDidExpandElement: expanded.listen,
    onDidCollapseElement: collapsed.listen,
    dispose() {},
  } as unknown as vscode.TreeView<TreeNode>;
  mocks.createTree.mockReturnValue(view);
  const api = activate(context);
  const tree = mocks.createTree.mock.calls.at(-1)?.[1].treeDataProvider as ChatTree;
  expect(mocks.createTree).toHaveBeenLastCalledWith('codexChatsList.list', expect.objectContaining({ showCollapseAll: true }));
  const rendered = vi.fn();
  disposables.push(tree.onDidChangeTreeData(() => {
    const nodes = tree.getChildren();
    rendered({
      ...api.snapshot(),
      search: view.message?.split(' · Search: ')[1]?.split('\n')[0] ?? '',
      groups: nodes.flatMap(node => node.kind === 'project' ? [node.group] : []),
    });
  }));
  const run = async (command: string, ...args: unknown[]) => {
    const handler = mocks.registerCommand.mock.calls.find(([id]) => id === `codexChatsList.${command}`)?.[1];
    if (!handler) throw new Error(`Unregistered command: ${command}`);
    await handler(...args);
  };
  const setVisible = (value: boolean) => {
    Object.assign(view, { visible: value });
    visibility.fire();
  };
  const ready = async () => {
    setVisible(true);
    await vi.advanceTimersByTimeAsync(0);
  };
  const beginSearch = async () => {
    const done = run('search');
    await Promise.resolve();
    return { input: mocks.createInputBox.mock.results.at(-1)!.value, done };
  };
  const search = async (value: string | undefined) => {
    const { input, done } = await beginSearch();
    if (value === undefined) input.hide();
    else { input.type(value); input.accept(); }
    await done;
  };
  const pick = (value: Scope) => {
    mocks.promptScope.mockResolvedValueOnce({ value });
    return run('selectScope');
  };
  const group = (value: Grouping) => {
    mocks.promptScope.mockResolvedValueOnce({ value });
    return run('selectGrouping');
  };
  const dispose = () => disposables[0]?.dispose();
  return { api, view, tree, rendered, ready, setVisible, run, search, beginSearch, pick, group, dispose, collapsed, badgeUpdates };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-23T12:00:00Z'));
  vi.clearAllMocks();
  mocks.list.mockReset().mockResolvedValue(page('thread-default'));
  mocks.inspectDirectory.mockReset().mockResolvedValue({ kind: 'folder' });
  mocks.checkThread.mockReset().mockImplementation(async id => page(id).chats[0]);
  mocks.deleteThread.mockReset().mockResolvedValue(undefined);
  mocks.showWarning.mockReset().mockResolvedValue(undefined);
  mocks.findRepositories.mockReset().mockResolvedValue(new Map());
  mocks.realpath.mockReset().mockImplementation(async value => value);
  mocks.createInputBox.mockImplementation(() => new TestInputBox());
  mocks.chooseFolder.mockReset().mockResolvedValue(undefined);
  mocks.registerCommand.mockReturnValue({ dispose() {} });
  mocks.updateScope.mockReset().mockResolvedValue(undefined);
  mocks.cliPath = undefined;
  mocks.dateBadges = true;
  mocks.legacyCliPath = '/fixture/codex';
});
afterEach(() => {
  for (const disposable of disposables.splice(0)) disposable.dispose();
  vi.useRealTimers();
});

test('all commands use the fork namespace and open focuses the fork view', async () => {
  const fixture = await setup();
  expect(mocks.registerCommand.mock.calls.map(([id]) => id)).toEqual([
    'codexChatsList.open', 'codexChatsList.refresh', 'codexChatsList.selectScope',
    'codexChatsList.selectGrouping', 'codexChatsList.sortProjects', 'codexChatsList.pin', 'codexChatsList.unpin',
    'codexChatsList.hide', 'codexChatsList.unhide', 'codexChatsList.moveToRepository', 'codexChatsList.restoreRepository',
    'codexChatsList.toggleHidden', 'codexChatsList.newConversation', 'codexChatsList.rename', 'codexChatsList.delete',
    'codexChatsList.toggleFolders', 'codexChatsList.showAll', 'codexChatsList.showCurrent',
    'codexChatsList.search', 'codexChatsList.clearSearch', 'codexChatsList.openConversation',
  ]);
  await fixture.run('open');
  expect(mocks.executeCommand).toHaveBeenCalledWith('codexChatsList.list.focus');
});

test('each range, grouping, title search and folder filter uses the same indexed history', async () => {
  mocks.findRepositories.mockResolvedValue(new Map([
    ['github.com/me/app', { key: 'github.com/me/app', root: '/fixture' }],
    ['github.com/team/app', { key: 'github.com/me/app', root: '/fixture' }],
  ]));
  mocks.list.mockResolvedValueOnce({
    chats: [
      { id: 'thread-fork', cwd: '/moved/app', title: 'Fork migration', recencyAt: 2, repository: 'github.com/me/app' },
      { id: 'thread-upstream', cwd: '/retired/worktree', title: 'Upstream migration', recencyAt: 1, repository: 'github.com/team/app' },
      { id: 'thread-local', cwd: '/local', title: 'Local Git', recencyAt: 3, hasGit: true },
      { id: 'thread-folder', cwd: '/fixture', title: 'Folder session', recencyAt: 4 },
      { id: 'thread-unknown', cwd: '/unavailable', title: 'Unknown source', recencyAt: 5 },
    ],
    nextCursor: null,
  });
  mocks.inspectDirectory.mockImplementation(async cwd => cwd === '/local'
    ? { kind: 'git', root: cwd, common: '/local/.git' }
    : { kind: cwd === '/unavailable' ? 'unknown' : 'folder' });
  const fixture = await setup('repository');
  await fixture.ready();
  const ids = () => fixture.tree.getChildren().flatMap(node => node.kind === 'project' ? node.group.chats.map(chat => chat.id) : []);
  expect(fixture.api.snapshot()).toMatchObject({ scope: 'current', grouping: 'repository', indexed: true });
  expect(ids()).toEqual(['thread-folder', 'thread-fork', 'thread-upstream']);
  expect(fixture.tree.getTreeItem(fixture.tree.getChildren()[0]!).iconPath).toMatchObject({
    path: '/extension/media/current-arrow.png',
  });
  await fixture.pick('all');
  expect(ids()).toContain('thread-local');
  expect(ids()).toContain('thread-unknown');
  const unknown = fixture.tree.getChildren().find(node => node.kind === 'project' && node.group.unknown);
  expect(fixture.tree.getTreeItem(unknown!).iconPath).toMatchObject({
    id: 'symbol-folder', color: { id: 'descriptionForeground' },
  });
  await fixture.run('toggleFolders');
  expect(ids()).not.toContain('thread-folder');
  expect(ids()).toContain('thread-unknown');
  expect(ids()).toContain('thread-local');
  await fixture.search('migration');
  expect(ids()).toEqual(['thread-fork', 'thread-upstream']);
  await fixture.search(undefined);
  expect(ids()).toEqual(['thread-fork', 'thread-upstream']);
  await fixture.group('folder');
  expect(ids()).toEqual(['thread-fork', 'thread-upstream']);
  await fixture.pick('current');
  expect(ids()).toHaveLength(0);

  await fixture.run('clearSearch');
  await fixture.group('repository');
  await fixture.run('toggleFolders');
  const conversation = (id: string) => fixture.tree.getChildren().flatMap(node => fixture.tree.getChildren(node))
    .find(node => node.kind === 'chat' && node.chat.id === id);
  const groupFor = (id: string) => fixture.tree.getChildren().find(node =>
    node.kind === 'project' && node.group.chats.some(chat => chat.id === id));
  mocks.promptScope.mockImplementationOnce(async options => options.find(option => option.description === 'github.com/me/app'));
  await fixture.run('moveToRepository', conversation('thread-folder'));
  expect(groupFor('thread-folder')).toMatchObject({ group: { key: 'remote:github.com/me/app' } });
  expect(fixture.tree.getTreeItem(conversation('thread-folder')!).tooltip).toContain('Path: /fixture');
  expect(fixture.tree.getTreeItem(conversation('thread-folder')!).tooltip).toContain('Manually assigned to github.com/me/app');
  await fixture.run('delete', groupFor('thread-folder'));
  expect(mocks.showWarning.mock.calls.at(-1)?.[1]?.detail).toContain('Manually assigned conversations included: 1.');
  expect(mocks.deleteThread).not.toHaveBeenCalled();

  mocks.inspectDirectory.mockImplementationOnce(async () => ({ kind: 'git', root: '/fresh', common: '/fresh/.git' }));
  mocks.findRepositories.mockResolvedValueOnce(new Map());
  mocks.promptScope.mockImplementationOnce(async options => options[0]);
  mocks.chooseFolder.mockResolvedValueOnce([{ fsPath: '/fresh' }]);
  await fixture.run('moveToRepository', conversation('thread-folder'));
  expect(conversation('thread-folder')).toBeUndefined();
  await fixture.pick('all');
  expect(groupFor('thread-folder')).toMatchObject({ group: { key: 'git:/fresh/.git' } });
  await fixture.group('folder');
  expect(groupFor('thread-folder')).toMatchObject({ group: { cwd: '/fixture' } });
  await fixture.run('restoreRepository', conversation('thread-folder'));
  expect(fixture.tree.getTreeItem(conversation('thread-folder')!).contextValue).toBe('chat');
  await fixture.group('repository');
  expect(groupFor('thread-folder')).toMatchObject({ group: { key: '/fixture' } });
  expect(mocks.list.mock.calls).toEqual([[undefined, '', null]]);
});

test('local Git resolves Current through its common directory with the folder filter on', async () => {
  mocks.inspectDirectory.mockResolvedValue({ kind: 'git', root: '/fixture', common: '/fixture/.git' });
  mocks.list.mockResolvedValueOnce({
    chats: [{ id: 'thread-local', cwd: '/fixture/subdirectory', title: 'Local work', recencyAt: 20, hasGit: true }],
    nextCursor: null,
  });
  const fixture = await setup();
  await fixture.ready();
  await fixture.run('toggleFolders');
  const item = fixture.tree.getChildren()[0]!;
  expect(fixture.tree.getTreeItem(item)).toMatchObject({ id: 'project:git:/fixture/.git' });
  expect(item).toMatchObject({ group: { chats: [{ id: 'thread-local' }] } });
});

test.each([
  [undefined, '/fixture/codex'],
  [' /fixture/fork-codex ', '/fixture/fork-codex'],
  ['', /[\\/]official[\\/]bin[\\/]/],
])('selects the CLI when the fork setting is %j', async (setting, expectedPath) => {
  mocks.cliPath = setting;
  const fixture = await setup();
  await fixture.ready();
  expect(mocks.construct.mock.calls.at(-1)?.[0]).toEqual(
    typeof expectedPath === 'string' ? expectedPath : expect.stringMatching(expectedPath),
  );
  expect(fixture.api.snapshot().error).toBe('');
});

test('a disposed tree ignores an outstanding response and cannot publish stale state', async () => {
  const response = Promise.withResolvers<ChatPage>();
  mocks.list.mockReturnValueOnce(response.promise);
  const fixture = await setup();
  await fixture.ready();
  expect(fixture.api.snapshot().busy).toBe(true);
  fixture.dispose();
  const sent = fixture.rendered.mock.calls.length;
  response.resolve(page('thread-too-late'));
  await vi.advanceTimersByTimeAsync(0);
  expect(fixture.rendered).toHaveBeenCalledTimes(sent);
  expect(mocks.dispose).toHaveBeenCalledOnce();
});

test('unchanged polling does not publish state and hidden views pause the index', async () => {
  const fixture = await setup();
  await vi.advanceTimersByTimeAsync(10_000);
  expect(mocks.list).not.toHaveBeenCalled();
  await fixture.ready();
  const sent = fixture.rendered.mock.calls.length;
  await vi.advanceTimersByTimeAsync(15_000);
  expect(mocks.list).toHaveBeenCalledTimes(4);
  expect(fixture.rendered).toHaveBeenCalledTimes(sent);
  fixture.setVisible(false);
  await vi.advanceTimersByTimeAsync(10_000);
  expect(mocks.list).toHaveBeenCalledTimes(4);
  fixture.setVisible(true);
  await vi.advanceTimersByTimeAsync(0);
  expect(mocks.list).toHaveBeenCalledTimes(5);
});

test('Current displays all indexed conversations while older pages load in the background', async () => {
  const chats = Array.from({ length: 60 }, (_, i) => ({
    ...page('thread-' + i).chats[0]!, recencyAt: 60 - i,
  }));
  mocks.list
    .mockResolvedValueOnce({ chats: chats.slice(0, 50), nextCursor: 'older' })
    .mockResolvedValueOnce({ chats: chats.slice(50), nextCursor: null });
  const fixture = await setup();
  await fixture.ready();
  const visibleChats = () => fixture.tree.getChildren().flatMap(node => fixture.tree.getChildren(node));
  expect(visibleChats()).toHaveLength(50);
  expect(fixture.tree.getChildren()).toHaveLength(1);
  expect(fixture.api.snapshot().indexed).toBe(false);
  await vi.advanceTimersByTimeAsync(150);
  expect(visibleChats()).toHaveLength(60);
  expect(fixture.tree.getChildren()).toHaveLength(1);
  expect(fixture.api.snapshot().indexed).toBe(true);
  await fixture.search('thread-59');
  expect(visibleChats()).toMatchObject([{ kind: 'chat', chat: { id: 'thread-59' } }]);
  expect(mocks.list.mock.calls.map(args => args[2])).toEqual([null, 'older']);
});

test('hidden items can be filtered and restored without changing their pins or opening Codex', async () => {
  mocks.list.mockResolvedValueOnce({
    chats: ['thread-first', 'thread-second'].map(id => page(id).chats[0]!),
    nextCursor: null,
  });
  const fixture = await setup();
  await fixture.ready();
  const root = () => fixture.tree.getChildren()[0]!;
  const children = () => fixture.tree.getChildren(root());
  const label = (node: TreeNode) => node.kind === 'chat' ? node.chat.title : fixture.tree.getTreeItem(node).label;
  const first = children()[0]!;
  await fixture.run('pin', first);
  await fixture.run('hide', first);
  expect(children().map(label)).toEqual(['thread-second']);
  await fixture.run('toggleHidden');
  expect(children().map(label)).toEqual(['thread-first']);
  expect(fixture.tree.getTreeItem(children()[0]!)).toMatchObject({ contextValue: 'pinnedChat.hidden' });
  await fixture.run('hide', root());
  expect(children().map(label)).toEqual(['thread-first', 'thread-second']);
  expect(fixture.tree.getTreeItem(root())).toMatchObject({ contextValue: 'project.hidden' });
  await fixture.run('toggleHidden');
  expect(fixture.tree.getChildren()).toHaveLength(0);
  await fixture.run('toggleHidden');
  await fixture.run('unhide', root());
  expect(children().map(label)).toEqual(['thread-first']);
  await fixture.run('unhide', children()[0]);
  expect(fixture.tree.getChildren()).toHaveLength(0);
  await fixture.run('toggleHidden');
  expect(children().map(label)).toEqual(['thread-first', 'thread-second']);
  expect(fixture.tree.getTreeItem(children()[0]!)).toMatchObject({ contextValue: 'pinnedChat' });
  expect(mocks.list).toHaveBeenCalledOnce();
});

test('deleting an individual conversation requires modal confirmation and changes only that row', async () => {
  mocks.list.mockResolvedValueOnce({
    chats: ['thread-keep', 'thread-remove'].map(id => page(id).chats[0]!),
    nextCursor: null,
  });
  const fixture = await setup();
  await fixture.ready();
  const children = () => fixture.tree.getChildren(fixture.tree.getChildren()[0]);
  const thread = children()[1];
  await fixture.run('delete', thread);
  expect(mocks.showWarning).toHaveBeenLastCalledWith(
    expect.stringContaining('thread-remove'), expect.objectContaining({ modal: true }),
    { title: 'Cancel', isCloseAffordance: true }, { title: 'Delete Permanently' },
  );
  expect(mocks.deleteThread).not.toHaveBeenCalled();
  mocks.showWarning.mockImplementationOnce(async (_message, _options, _cancel, confirm) => confirm);
  await fixture.run('delete', thread);
  expect(mocks.deleteThread).toHaveBeenCalledExactlyOnceWith('thread-remove');
  expect(children()).toMatchObject([{ chat: { title: 'thread-keep' } }]);
});

test('repository deletion covers hidden and filtered conversations and leaves failed and unrelated rows', async () => {
  const repository = 'github.com/example/app';
  const chats = Array.from({ length: 52 }, (_, n) => ({
    id: 'thread-' + n, title: n === 51 ? 'match' : 'other', recencyAt: n + 1, cwd: '/fixture', repository,
  }));
  const unrelated = { id: 'thread-unrelated', title: 'Unrelated', cwd: '/other', recencyAt: 1, repository: 'github.com/other/app' };
  mocks.list.mockResolvedValueOnce({ chats: [...chats, unrelated], nextCursor: null });
  mocks.deleteThread.mockImplementation(async id => {
    if (id === 'thread-0') throw new Error('fixture failure');
  });
  const fixture = await setup();
  await fixture.ready();
  await fixture.pick('all');
  const root = () => fixture.tree.getChildren()[0]!;
  await fixture.run('hide', fixture.tree.getChildren(root())[1]);
  await fixture.search('match');
  expect(fixture.tree.getChildren(root())).toHaveLength(1);
  mocks.showWarning.mockImplementationOnce(async (_message, _options, _cancel, confirm) => confirm);
  await fixture.run('delete', root());
  expect(mocks.showWarning.mock.calls[0]?.[0]).toContain('52 conversations');
  expect(mocks.deleteThread.mock.calls.map(([id]) => id)).toEqual(chats.map(chat => chat.id).reverse());
  expect(mocks.showWarning.mock.calls.at(-1)?.[0]).toBe('Deleted 51 conversations. Could not delete 1.');
  await fixture.run('clearSearch');
  expect(fixture.api.snapshot().count).toBe(2);
  const remaining = fixture.tree.getChildren().flatMap(node => fixture.tree.getChildren(node));
  expect(remaining).toMatchObject([{ chat: { title: 'other' } }, { chat: { title: 'Unrelated' } }]);
});

test('All lists every cached repository and chat, sorts groups, and pins without requerying Codex', async () => {
  vi.setSystemTime(new Date(2026, 10, 23, 12));
  const yesterday = new Date(2026, 10, 22, 12).getTime() / 1000;
  const chat = (id: string, repo: string, offset: number): Chat =>
    ({ id, title: id, cwd: '/repos/' + repo, repository: 'github.com/example/' + repo, recencyAt: yesterday + offset });
  mocks.list.mockResolvedValueOnce({
    chats: [
      ...Array.from({ length: 105 }, (_, i) => chat('noise-' + i, 'noise', 1000 - i)),
      ...Array.from({ length: 55 }, (_, i) => chat('zebra-' + i, 'zebra-' + i, 900 - i)),
      chat('old-session', 'alpha', 1),
      chat('recent-session', 'alpha', 2),
      chat('middle-session', 'beta', 3),
    ],
    nextCursor: null,
  });
  const fixture = await setup('repository');
  await fixture.ready();
  await fixture.pick('all');
  const roots = () => fixture.tree.getChildren();
  const title = (node: TreeNode) => node.kind === 'chat' ? node.chat.title : fixture.tree.getTreeItem(node).label;
  expect(roots()).toHaveLength(58);
  expect(roots().every(node => node.kind === 'project')).toBe(true);
  expect(roots().flatMap(node => fixture.tree.getChildren(node))).toHaveLength(163);
  expect(fixture.badgeUpdates).toEqual([{ value: 0, tooltip: '' }, undefined]);
  const noise = roots()[0]!;
  expect(title(noise)).toBe('noise');
  expect(fixture.tree.getChildren(noise)).toHaveLength(105);
  const largeProject = fixture.tree.getTreeItem(noise);
  expect(largeProject.description).toBe('');
  expect(largeProject.tooltip).toContain('105 chats');
  expect(largeProject.accessibilityInformation?.label).toContain('105 chats');
  expect(projectCountDecorations.provideFileDecoration(largeProject.resourceUri!)?.badge).toBe('99');
  expect(fixture.tree.provideFileDecoration(largeProject.resourceUri!)?.badge).toBe('1d');
  expect(title(roots().at(-1)!)).toBe('alpha');
  await fixture.search('noise');
  expect(roots()).toHaveLength(1);
  expect(fixture.tree.getTreeItem(roots()[0]!)).toMatchObject({ collapsibleState: 1 });
  expect(fixture.tree.getChildren(roots()[0]!)).toHaveLength(105);
  await fixture.run('clearSearch');
  mocks.promptScope.mockResolvedValueOnce({ value: 'name' });
  await fixture.run('sortProjects');
  const [alpha, beta] = roots();
  expect(roots().slice(0, 3).map(title)).toEqual(['alpha', 'beta', 'noise']);
  const item = fixture.tree.getTreeItem(alpha!);
  expect(item.iconPath).toMatchObject({ id: 'symbol-folder', color: { id: 'textLink.foreground' } });
  expect(item.description).toBe('');
  expect(projectCountDecorations.provideFileDecoration(item.resourceUri!)?.badge).toBe('2');
  expect(fixture.tree.provideFileDecoration(item.resourceUri!)?.badge).toBe('1d');
  expect(item.accessibilityInformation?.label).toContain('2 chats');
  mocks.dateBadges = false;
  fixture.tree.updateBadgeSetting();
  expect(fixture.tree.getTreeItem(noise).description).toBe('105 chats · 11-22');
  expect(fixture.tree.getTreeItem(alpha!).description).toBe('2 chats · 11-22');
  expect(fixture.tree.getTreeItem(alpha!).resourceUri).toBeUndefined();
  mocks.dateBadges = true;
  fixture.tree.updateBadgeSetting();
  expect(mocks.updateScope).toHaveBeenLastCalledWith('historyView', expect.objectContaining({ order: 'name' }));
  await fixture.run('pin', beta);
  expect(roots().slice(0, 3).map(title)).toEqual(['beta', 'alpha', 'noise']);
  expect(fixture.tree.getTreeItem(roots()[0]!)).toMatchObject({
    contextValue: 'pinnedProject',
    iconPath: { path: '/extension/media/pinned-star.png' },
  });
  const [, old] = fixture.tree.getChildren(alpha);
  await fixture.run('pin', old);
  expect(fixture.tree.getChildren(roots()[1]!).map(title)).toEqual(['old-session', 'recent-session']);
  expect(fixture.tree.getTreeItem(fixture.tree.getChildren(roots()[1]!)[0]!)).toMatchObject({
    contextValue: 'pinnedChat',
    iconPath: { path: '/extension/media/pinned-star.png' },
  });
  await fixture.search('recent');
  expect(roots().map(title)).toEqual(['alpha']);
  expect(fixture.tree.getChildren(roots()[0]!).map(title)).toEqual(['recent-session']);
  await fixture.run('clearSearch');
  mocks.promptScope.mockResolvedValueOnce({ value: 'recent' });
  await fixture.run('sortProjects');
  expect(roots().slice(0, 2).map(title)).toEqual(['beta', 'noise']);
  await fixture.run('unpin', roots()[0]);
  const sessions = fixture.tree.getChildren(roots().at(-1)!);
  expect(sessions.map(title)).toEqual(['old-session', 'recent-session']);
  await fixture.run('unpin', sessions[0]);
  expect(fixture.tree.getChildren(roots().at(-1)!).map(title)).toEqual(['recent-session', 'old-session']);
  expect(mocks.list).toHaveBeenCalledOnce();
});

test('a failed background query retains indexed results and retries', async () => {
  const fixture = await setup();
  await fixture.ready();
  mocks.list.mockRejectedValueOnce(new Error('temporary failure'));
  await vi.advanceTimersByTimeAsync(5_000);
  expect(fixture.api.snapshot()).toMatchObject({ count: 1, error: 'temporary failure' });
  await vi.advanceTimersByTimeAsync(5_000);
  expect(fixture.api.snapshot()).toMatchObject({ count: 1, error: '' });
});

test('uses stable node identity and isolates search expansion from the saved tree', async () => {
  const fixture = await setup('current');
  await fixture.ready();
  const initial = fixture.tree.getChildren()[0];
  expect(fixture.tree.getTreeItem(initial!)).toMatchObject({ id: 'project:/fixture', collapsibleState: 2 });
  fixture.collapsed.fire({ element: initial! });
  expect(mocks.updateScope).toHaveBeenCalledWith('projectExpansion', { '/fixture': false });
  await fixture.search('thread');
  const filtered = fixture.tree.getChildren()[0];
  expect(fixture.tree.getTreeItem(filtered!)).toMatchObject({ id: 'filtered:project:/fixture', collapsibleState: 2 });
  fixture.collapsed.fire({ element: filtered! });
  expect(mocks.updateScope).toHaveBeenCalledOnce();
  await fixture.run('clearSearch');
  expect(fixture.tree.getTreeItem(fixture.tree.getChildren()[0]!)).toMatchObject({
    id: 'project:/fixture', collapsibleState: 1,
  });
});

test('title search debounces live matches, restores on Escape, and follows Current and All', async () => {
  const repository = 'github.com/example/app';
  mocks.findRepositories.mockResolvedValue(new Map([[repository, { key: repository, root: '/fixture' }]]));
  mocks.list.mockResolvedValueOnce({
    chats: [
      { id: 'thread-moved', title: '修复 ＡＰＩ 接口', cwd: '/old/app', recencyAt: 3, repository },
      { id: 'thread-other', title: 'Api guide', cwd: '/other', recencyAt: 2, repository: 'github.com/else/other' },
      { id: 'thread-path', title: 'Planning', cwd: '/fixture/API', recencyAt: 1, repository },
    ],
    nextCursor: null,
  });
  const fixture = await setup();
  await fixture.ready();
  const ids = () => fixture.tree.getChildren().flatMap(node =>
    node.kind === 'project' ? node.group.chats.map(chat => chat.id) : []);
  const draft = await fixture.beginSearch();
  expect(draft.input.title).toContain('Current project');
  const calls = fixture.rendered.mock.calls.length;
  draft.input.type('A');
  draft.input.type('aPi');
  await vi.advanceTimersByTimeAsync(119);
  expect(fixture.rendered).toHaveBeenCalledTimes(calls);
  await vi.advanceTimersByTimeAsync(1);
  expect(ids()).toEqual(['thread-moved']);
  draft.input.hide();
  await draft.done;
  expect(ids()).toEqual(['thread-moved', 'thread-path']);
  await fixture.search('aPi');
  expect(ids()).toEqual(['thread-moved']);
  await fixture.run('showAll');
  expect(ids()).toEqual(['thread-moved', 'thread-other']);
  expect(mocks.updateScope).toHaveBeenLastCalledWith('historyView', expect.objectContaining({ scope: 'all' }));
  await fixture.run('showCurrent');
  expect(ids()).toEqual(['thread-moved']);
  expect(mocks.updateScope).toHaveBeenLastCalledWith('historyView', expect.objectContaining({ scope: 'current' }));
  expect(mocks.promptScope).not.toHaveBeenCalled();
  await fixture.run('showAll');
  const all = await fixture.beginSearch();
  expect(all.input.title).toContain('All projects');
  all.input.type('');
  all.input.accept();
  await all.done;
  expect(ids()).toHaveLength(3);
  expect(mocks.list).toHaveBeenCalledExactlyOnceWith(undefined, '', null);
});

test('validates the selected ID before navigating and removes a confirmed archived entry', async () => {
  const fixture = await setup();
  await fixture.ready();
  const group = fixture.tree.getChildren()[0]!;
  expect(fixture.tree.getTreeItem(fixture.tree.getChildren(group)[0]!)).toMatchObject({
    id: 'chat:thread-default',
    tooltip: expect.stringContaining('Path: /fixture'),
  });
  await fixture.run('openConversation', 'thread-default');
  await fixture.run('openConversation', 'missing');
  expect(mocks.checkThread).toHaveBeenCalledExactlyOnceWith('thread-default');
  expect(mocks.openConversation).toHaveBeenCalledExactlyOnceWith('thread-default');
  mocks.checkThread.mockResolvedValueOnce(undefined);
  await fixture.run('openConversation', 'thread-default');
  expect(fixture.api.snapshot().count).toBe(0);
  expect(mocks.openConversation).toHaveBeenCalledTimes(1);
});

test('project and conversation dates use the latest visible activity and refresh at local midnight', async () => {
  vi.setSystemTime(new Date(2026, 10, 23, 23, 58));
  const preview = page('thread-default');
  preview.chats[0]!.recencyAt = new Date(2026, 10, 22, 12).getTime() / 1000;
  preview.chats.push(
    { id: 'thread-in-year', cwd: '/fixture', title: 'Earlier', recencyAt: new Date(2026, 10, 12).getTime() / 1000 },
    { id: 'thread-in-october', cwd: '/fixture', title: 'October', recencyAt: new Date(2026, 9, 19).getTime() / 1000 },
    { id: 'thread-ten-months', cwd: '/fixture', title: 'January', recencyAt: new Date(2026, 0, 23).getTime() / 1000 },
    { id: 'thread-lastyear', cwd: '/fixture', title: 'Last year', recencyAt: new Date(2025, 9, 27).getTime() / 1000 },
    { id: 'thread-undated', cwd: '/fixture', title: 'Undated', recencyAt: 0 },
  );
  mocks.list.mockResolvedValue(preview);
  const fixture = await setup();
  await fixture.ready();
  const [dated, older, october, january, lastYear, undated] = fixture.tree.getChildren(fixture.tree.getChildren()[0]);
  const item = fixture.tree.getTreeItem(dated!);
  expect(item).toMatchObject({
    label: 'thread-default',
    iconPath: { id: 'blank' },
  });
  expect(item.description).toBeUndefined();
  expect(item.tooltip).toContain('2026');
  expect(item.tooltip).toContain('12:00');
  expect(fixture.tree.provideFileDecoration(item.resourceUri!)?.badge).toBe('1d');
  const olderUri = fixture.tree.getTreeItem(older!).resourceUri!;
  expect(fixture.tree.provideFileDecoration(olderUri)?.badge).toBe('1w');
  expect(fixture.tree.provideFileDecoration(fixture.tree.getTreeItem(october!).resourceUri!)?.badge).toBe('1m');
  expect(fixture.tree.getTreeItem(january!).description).toBe('10m');
  expect(fixture.tree.getTreeItem(january!).resourceUri).toBeUndefined();
  const lastYearItem = fixture.tree.getTreeItem(lastYear!);
  expect(lastYearItem.description).toBeUndefined();
  expect(fixture.tree.provideFileDecoration(lastYearItem.resourceUri!)?.badge).toBe('1y');
  const undatedItem = fixture.tree.getTreeItem(undated!);
  expect(undatedItem.label).toBe('Undated');
  expect(undatedItem.description).toBeUndefined();
  const projectItem = () => fixture.tree.getTreeItem(fixture.tree.getChildren()[0]!);
  await fixture.run('pin', lastYear);
  expect(fixture.tree.getChildren(fixture.tree.getChildren()[0])[0]).toMatchObject({ chat: { id: 'thread-lastyear' } });
  expect(projectItem().description).toBe('Current');
  expect(projectCountDecorations.provideFileDecoration(projectItem().resourceUri!)?.badge).toBe('6');
  expect(projectItem().tooltip).toContain('Recent conversation: 11/22/2026, 12:00');
  expect(fixture.tree.provideFileDecoration(projectItem().resourceUri!)?.badge).toBe('1d');
  await fixture.search('1d');
  expect(fixture.tree.getChildren()).toEqual([]);
  await fixture.run('clearSearch');
  const checks = fixture.rendered.mock.calls.length;
  await vi.advanceTimersByTimeAsync(60_000);
  expect(fixture.rendered).toHaveBeenCalledTimes(checks);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(fixture.rendered).toHaveBeenCalledTimes(checks + 1);
  expect(fixture.tree.provideFileDecoration(fixture.tree.getTreeItem(dated!).resourceUri!)?.badge).toBe('2d');
  expect(fixture.tree.provideFileDecoration(projectItem().resourceUri!)?.badge).toBe('2d');
  mocks.dateBadges = false;
  fixture.tree.updateBadgeSetting();
  expect(fixture.tree.getTreeItem(dated!).description).toBe('11-22');
  expect(fixture.tree.getTreeItem(dated!).resourceUri).toBeUndefined();
  expect(projectItem().description).toBe('6 chats · Current · 11-22');
});
