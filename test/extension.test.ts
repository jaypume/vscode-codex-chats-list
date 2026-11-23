import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type * as vscode from 'vscode';
import type { Directory, WorkspaceRepository } from '../src/git';
import type { Chat, ChatPage, Grouping, GroupOrder, Scope } from '../src/model';
import type { ChatTree, TreeNode } from '../src/tree';

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
  promptScope: vi.fn<(items: { value: Scope | Grouping | GroupOrder }[]) => Promise<{ value: Scope | Grouping | GroupOrder } | undefined>>(),
  promptSearch: vi.fn<(options: vscode.InputBoxOptions) => Promise<string | undefined>>(),
  realpath: vi.fn<(path: string) => Promise<string>>(),
  updateScope: vi.fn<(key: string, value: unknown) => Promise<void>>(),
  cliPath: undefined as string | undefined,
  legacyCliPath: '/fixture/codex',
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
      get: () => section === 'codexProjectChats' ? mocks.legacyCliPath : false,
      inspect: () => ({ globalValue: mocks.cliPath, defaultValue: '' }),
    }),
    onDidChangeWorkspaceFolders: () => ({ dispose() {} }),
    onDidChangeConfiguration: () => ({ dispose() {} }),
  },
  window: {
    createTreeView: mocks.createTree,
    showInputBox: mocks.promptSearch,
    showQuickPick: mocks.promptScope,
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
  TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
  ThemeIcon: class {
    static readonly Folder = { id: 'folder' };
    constructor(readonly id: string) {}
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

const disposables: vscode.Disposable[] = [];
const page = (id: string): ChatPage => ({ chats: [{ id, cwd: '/fixture', title: id, recencyAt: 1 }], nextCursor: null });

async function setup(saved?: Scope | 'repository') {
  const context = {
    extension: { packageJSON: { version: '3.2.1' } },
    subscriptions: disposables,
    workspaceState: { get: (key: string, fallback: unknown) => key === 'scope' ? saved : fallback, update: mocks.updateScope },
  } as unknown as vscode.ExtensionContext;
  const visibility = new Signal<void>();
  const expanded = new Signal<{ element: TreeNode }>();
  const collapsed = new Signal<{ element: TreeNode }>();
  const view = {
    visible: false,
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
      hasMore: nodes.some(node => node.kind === 'more'),
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
  const search = (value: string | undefined) => {
    mocks.promptSearch.mockResolvedValueOnce(value);
    return run('search');
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
  return { api, view, tree, rendered, ready, setVisible, run, search, pick, group, dispose, collapsed };
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
  mocks.registerCommand.mockReturnValue({ dispose() {} });
  mocks.updateScope.mockReset().mockResolvedValue(undefined);
  mocks.cliPath = undefined;
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
    'codexChatsList.hide', 'codexChatsList.unhide', 'codexChatsList.toggleHidden', 'codexChatsList.delete',
    'codexChatsList.toggleFolders', 'codexChatsList.showAll',
    'codexChatsList.search', 'codexChatsList.clearSearch', 'codexChatsList.loadMore', 'codexChatsList.openConversation',
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
  await fixture.pick('all');
  expect(ids()).toContain('thread-local');
  expect(ids()).toContain('thread-unknown');
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

test('local pagination preserves cached results without touching the Codex connection', async () => {
  mocks.list.mockResolvedValueOnce({
    chats: Array.from({ length: 60 }, (_, i) => ({ ...page('thread-' + i).chats[0]!, recencyAt: i + 1 })),
    nextCursor: null,
  });
  const fixture = await setup();
  await fixture.ready();
  expect(fixture.view.badge?.value).toBe(50);
  expect(fixture.tree.getChildren().at(-1)?.kind).toBe('more');
  await fixture.run('loadMore');
  expect(fixture.view.badge?.value).toBe(60);
  expect(mocks.list).toHaveBeenCalledOnce();
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
  const label = (node: TreeNode) => fixture.tree.getTreeItem(node).label;
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
  expect(children().map(node => fixture.tree.getTreeItem(node).label)).toEqual(['thread-keep']);
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
  expect(fixture.view.badge?.value).toBe(1);
  mocks.showWarning.mockImplementationOnce(async (_message, _options, _cancel, confirm) => confirm);
  await fixture.run('delete', root());
  expect(mocks.showWarning.mock.calls[0]?.[0]).toContain('52 conversations');
  expect(mocks.deleteThread.mock.calls.map(([id]) => id)).toEqual(chats.map(chat => chat.id).reverse());
  expect(mocks.showWarning.mock.calls.at(-1)?.[0]).toBe('Deleted 51 conversations. Could not delete 1.');
  await fixture.run('clearSearch');
  expect(fixture.api.snapshot().count).toBe(2);
  const remaining = fixture.tree.getChildren().flatMap(node => fixture.tree.getChildren(node));
  expect(remaining.map(node => fixture.tree.getTreeItem(node).label)).toEqual(['other', 'Unrelated']);
});

test('All lists every cached repository and chat, sorts groups, and pins without requerying Codex', async () => {
  const chat = (id: string, repo: string, recencyAt: number): Chat =>
    ({ id, title: id, cwd: '/repos/' + repo, repository: 'github.com/example/' + repo, recencyAt });
  mocks.list.mockResolvedValueOnce({
    chats: [
      ...Array.from({ length: 60 }, (_, i) => chat('noise-' + i, 'noise', 1000 - i)),
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
  const title = (node: TreeNode) => fixture.tree.getTreeItem(node).label;
  expect(roots()).toHaveLength(58);
  expect(roots().every(node => node.kind === 'project')).toBe(true);
  expect(fixture.view.badge?.value).toBe(118);
  const noise = roots()[0]!;
  expect(title(noise)).toBe('noise');
  expect(fixture.tree.getChildren(noise)).toHaveLength(60);
  expect(title(roots().at(-1)!)).toBe('alpha');
  mocks.promptScope.mockResolvedValueOnce({ value: 'name' });
  await fixture.run('sortProjects');
  const [alpha, beta] = roots();
  expect(roots().slice(0, 3).map(title)).toEqual(['alpha', 'beta', 'noise']);
  expect(mocks.updateScope).toHaveBeenLastCalledWith('historyView', expect.objectContaining({ order: 'name' }));
  await fixture.run('pin', beta);
  expect(roots().slice(0, 3).map(title)).toEqual(['beta', 'alpha', 'noise']);
  expect(fixture.tree.getTreeItem(roots()[0]!)).toMatchObject({ contextValue: 'pinnedProject', iconPath: { id: 'pinned' } });
  const [, old] = fixture.tree.getChildren(alpha);
  await fixture.run('pin', old);
  expect(fixture.tree.getChildren(roots()[1]!).map(title)).toEqual(['old-session', 'recent-session']);
  expect(fixture.tree.getTreeItem(fixture.tree.getChildren(roots()[1]!)[0]!)).toMatchObject({ contextValue: 'pinnedChat' });
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

test('refreshes time labels on the minute only while the tree is visible', async () => {
  const fixture = await setup();
  await fixture.ready();
  const checks = fixture.rendered.mock.calls.length;
  await vi.advanceTimersByTimeAsync(60_000);
  expect(fixture.rendered).toHaveBeenCalledTimes(checks + 1);
  fixture.setVisible(false);
  const hidden = fixture.rendered.mock.calls.length;
  await vi.advanceTimersByTimeAsync(60_000);
  expect(fixture.rendered).toHaveBeenCalledTimes(hidden);
});
