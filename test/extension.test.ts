import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type * as vscode from 'vscode';
import type { ChatPage, Scope } from '../src/model';
import type { ChatTree, TreeNode } from '../src/tree';

const mocks = vi.hoisted(() => ({
  list: vi.fn<(roots: string[] | undefined, search: string, cursor: string | null) => Promise<ChatPage>>(),
  dispose: vi.fn(),
  construct: vi.fn(),
  createTree: vi.fn<(id: string, options: vscode.TreeViewOptions<TreeNode>) => vscode.TreeView<TreeNode>>(),
  registerCommand: vi.fn<(id: string, handler: (...args: unknown[]) => unknown) => vscode.Disposable>(),
  executeCommand: vi.fn(),
  openConversation: vi.fn(),
  promptScope: vi.fn<(items: { value: Scope }[]) => Promise<{ value: Scope } | undefined>>(),
  promptSearch: vi.fn<(options: vscode.InputBoxOptions) => Promise<string | undefined>>(),
  realpath: vi.fn<(path: string) => Promise<string>>(),
  updateScope: vi.fn<(key: string, value: unknown) => Promise<void>>(),
}));
vi.mock('../src/client', () => ({ CodexClient: class {
  constructor(...args: unknown[]) { mocks.construct(...args); }
  list = mocks.list;
  dispose = mocks.dispose;
} }));
vi.mock('../src/routing', () => ({ openInCodex: mocks.openConversation }));
vi.mock('node:fs/promises', () => ({ access: async () => {}, realpath: mocks.realpath }));
vi.mock('vscode', () => ({
  env: { language: 'en' },
  workspace: {
    workspaceFolders: [{ uri: { scheme: 'file', fsPath: '/fixture' } }],
    getConfiguration: () => ({ get: () => '/fixture/codex' }),
    onDidChangeWorkspaceFolders: () => ({ dispose() {} }),
    onDidChangeConfiguration: () => ({ dispose() {} }),
  },
  window: {
    createTreeView: mocks.createTree,
    showInputBox: mocks.promptSearch,
    showQuickPick: mocks.promptScope,
    withProgress: (_options: unknown, task: () => Promise<void>) => task(),
  },
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

async function setup() {
  const context = {
    extension: { packageJSON: { version: '3.2.1' } },
    subscriptions: disposables,
    workspaceState: { get: (_key: string, fallback: unknown) => fallback, update: mocks.updateScope },
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
  expect(mocks.createTree).toHaveBeenLastCalledWith('codexProjectChats.list', expect.objectContaining({ showCollapseAll: true }));
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
    const handler = mocks.registerCommand.mock.calls.find(([id]) => id === `codexProjectChats.${command}`)?.[1];
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
  const dispose = () => disposables[0]?.dispose();
  return { api, view, tree, rendered, ready, setVisible, run, search, pick, dispose, collapsed };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-23T12:00:00Z'));
  vi.clearAllMocks();
  mocks.list.mockReset().mockResolvedValue(page('thread-default'));
  mocks.realpath.mockReset().mockImplementation(async value => value);
  mocks.registerCommand.mockReturnValue({ dispose() {} });
  mocks.updateScope.mockReset().mockResolvedValue(undefined);
});
afterEach(() => {
  for (const disposable of disposables.splice(0)) disposable.dispose();
  vi.useRealTimers();
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
  expect(fixture.api.snapshot()).toMatchObject({ ready: false, busy: false, count: 0 });
  expect(fixture.rendered).toHaveBeenCalledTimes(sent);
});

test('a slower old search cannot replace a newer result', async () => {
  const older = Promise.withResolvers<ChatPage>();
  mocks.list.mockReturnValueOnce(older.promise).mockResolvedValueOnce(page('thread-newer'));
  const fixture = await setup();
  await fixture.ready();
  void fixture.search('newer');
  await vi.advanceTimersByTimeAsync(0);
  older.resolve(page('thread-older'));
  await vi.advanceTimersByTimeAsync(0);
  const state = fixture.rendered.mock.calls.at(-1)?.[0];
  expect(state).toMatchObject({ search: 'newer', busy: false, count: 1, groups: [{ chats: [{ id: 'thread-newer' }] }] });
});

test('pagination waits for the first page and cursor of a changed search', async () => {
  const first = Promise.withResolvers<ChatPage>();
  mocks.list
    .mockResolvedValueOnce({ ...page('thread-old'), nextCursor: 'old-cursor' })
    .mockReturnValueOnce(first.promise)
    .mockResolvedValueOnce(page('thread-new-second'));
  const fixture = await setup();
  await fixture.ready();
  const pendingSearch = fixture.search('new');
  await vi.advanceTimersByTimeAsync(0);
  expect(mocks.list).toHaveBeenNthCalledWith(2, ['/fixture'], 'new', null);
  await fixture.run('loadMore');
  expect(mocks.list).toHaveBeenCalledTimes(2);
  first.resolve({ ...page('thread-new-first'), nextCursor: 'new-cursor' });
  await pendingSearch;
  await fixture.run('loadMore');
  expect(mocks.list).toHaveBeenNthCalledWith(3, ['/fixture'], 'new', 'new-cursor');
  expect(fixture.rendered.mock.calls.at(-1)?.[0]).toMatchObject({
    groups: [{ chats: [{ id: 'thread-new-first' }, { id: 'thread-new-second' }] }],
  });
});

test('a continuation uses the same resolved workspace paths as its first page', async () => {
  mocks.realpath.mockResolvedValueOnce('/original').mockResolvedValue('/retargeted');
  mocks.list
    .mockResolvedValueOnce({ ...page('thread-first'), nextCursor: 'page-two' })
    .mockResolvedValueOnce(page('thread-second'));
  const fixture = await setup();
  await fixture.ready();
  void fixture.run('loadMore');
  await vi.advanceTimersByTimeAsync(0);
  expect(mocks.list).toHaveBeenNthCalledWith(1, ['/fixture', '/original'], '', null);
  expect(mocks.list).toHaveBeenNthCalledWith(2, ['/fixture', '/original'], '', 'page-two');
  expect(mocks.realpath).toHaveBeenCalledOnce();
});

test('a failed older request cannot dispose the client serving a newer result', async () => {
  const older = Promise.withResolvers<ChatPage>();
  mocks.list.mockReturnValueOnce(older.promise).mockResolvedValueOnce(page('thread-newer'));
  const fixture = await setup();
  await fixture.ready();
  void fixture.search('newer');
  await vi.advanceTimersByTimeAsync(0);
  older.reject(new Error('old failure'));
  await vi.advanceTimersByTimeAsync(0);
  expect(mocks.dispose).not.toHaveBeenCalled();
  expect(fixture.api.snapshot()).toMatchObject({ busy: false, count: 1, error: '' });
});

test('visible history updates automatically without clearing the existing list', async () => {
  const initial: ChatPage = { chats: [...page('thread-kept').chats, ...page('thread-removed').chats], nextCursor: null };
  const response = Promise.withResolvers<ChatPage>();
  mocks.list.mockResolvedValueOnce(initial).mockReturnValueOnce(response.promise);
  const fixture = await setup();
  await fixture.ready();
  const sent = fixture.rendered.mock.calls.length;
  await vi.advanceTimersByTimeAsync(5_000);
  expect(mocks.list).toHaveBeenCalledTimes(2);
  expect(fixture.api.snapshot()).toMatchObject({ busy: false, count: 2 });
  expect(fixture.rendered).toHaveBeenCalledTimes(sent);
  const kept = { id: 'thread-kept', cwd: '/fixture', title: 'Renamed conversation', recencyAt: 20 };
  response.resolve({ chats: [kept, ...page('thread-added').chats], nextCursor: null });
  await vi.advanceTimersByTimeAsync(0);
  expect(fixture.rendered).toHaveBeenCalledTimes(sent + 1);
  expect(fixture.rendered.mock.calls.at(-1)?.[0]).toMatchObject({
    busy: false, count: 2, groups: [{ chats: [kept, { id: 'thread-added' }] }],
  });
});

test('unchanged polling does not publish state or restart the list service', async () => {
  const fixture = await setup();
  await fixture.ready();
  const sent = fixture.rendered.mock.calls.length;
  await vi.advanceTimersByTimeAsync(15_000);
  expect(mocks.list).toHaveBeenCalledTimes(4);
  expect(mocks.construct).toHaveBeenCalledOnce();
  expect(fixture.rendered).toHaveBeenCalledTimes(sent);
});

test('the native tree starts on first reveal, pauses while hidden, and catches up on return', async () => {
  const fixture = await setup();
  await vi.advanceTimersByTimeAsync(10_000);
  expect(mocks.list).not.toHaveBeenCalled();
  await fixture.ready();
  fixture.setVisible(false);
  await vi.advanceTimersByTimeAsync(10_000);
  expect(mocks.list).toHaveBeenCalledOnce();
  mocks.list.mockResolvedValueOnce(page('thread-returned'));
  fixture.setVisible(true);
  await vi.advanceTimersByTimeAsync(0);
  expect(mocks.list).toHaveBeenCalledTimes(2);
  expect(fixture.rendered.mock.calls.at(-1)?.[0]).toMatchObject({ groups: [{ chats: [{ id: 'thread-returned' }] }] });
  await vi.advanceTimersByTimeAsync(5_000);
  expect(mocks.list).toHaveBeenCalledTimes(3);
  fixture.dispose();
  fixture.setVisible(false);
  fixture.setVisible(true);
  await vi.advanceTimersByTimeAsync(15_000);
  expect(mocks.list).toHaveBeenCalledTimes(3);
});

test('a revealed tree keeps all loaded pages while visibility refresh runs', async () => {
  const first = Promise.withResolvers<ChatPage>();
  mocks.list
    .mockResolvedValueOnce({ ...page('thread-old-first'), nextCursor: 'old-second' })
    .mockResolvedValueOnce(page('thread-old-second'))
    .mockReturnValueOnce(first.promise)
    .mockResolvedValueOnce(page('thread-new-second'));
  const fixture = await setup();
  await fixture.ready();
  void fixture.run('loadMore');
  await vi.advanceTimersByTimeAsync(0);
  fixture.setVisible(false);
  fixture.setVisible(true);
  await vi.advanceTimersByTimeAsync(0);
  expect(mocks.list).toHaveBeenCalledTimes(3);
  expect(fixture.rendered.mock.calls.at(-1)?.[0]).toMatchObject({
    busy: false, count: 2, groups: [{ chats: [{ id: 'thread-old-first' }, { id: 'thread-old-second' }] }],
  });
  first.resolve({ ...page('thread-new-first'), nextCursor: 'new-second' });
  await vi.advanceTimersByTimeAsync(0);
  expect(mocks.list).toHaveBeenNthCalledWith(4, ['/fixture'], '', 'new-second');
  expect(fixture.rendered.mock.calls.at(-1)?.[0]).toMatchObject({
    count: 2, groups: [{ chats: [{ id: 'thread-new-first' }, { id: 'thread-new-second' }] }],
  });
});

test('a slow foreground load and a slow poll never start overlapping polls', async () => {
  const initial = Promise.withResolvers<ChatPage>();
  const background = Promise.withResolvers<ChatPage>();
  mocks.list.mockReturnValueOnce(initial.promise).mockReturnValueOnce(background.promise);
  const fixture = await setup();
  await fixture.ready();
  await vi.advanceTimersByTimeAsync(15_000);
  expect(mocks.list).toHaveBeenCalledOnce();
  initial.resolve(page('thread-initial'));
  await vi.advanceTimersByTimeAsync(5_000);
  expect(mocks.list).toHaveBeenCalledTimes(2);
  fixture.setVisible(false);
  fixture.setVisible(true);
  await vi.advanceTimersByTimeAsync(15_000);
  expect(mocks.list).toHaveBeenCalledTimes(2);
  background.resolve(page('thread-background'));
  await vi.advanceTimersByTimeAsync(5_000);
  expect(mocks.list).toHaveBeenCalledTimes(3);
});

test('automatic refresh rebuilds all loaded pages atomically and keeps the new pagination cursor', async () => {
  const second = Promise.withResolvers<ChatPage>();
  mocks.list
    .mockResolvedValueOnce({ ...page('thread-old-first'), nextCursor: 'old-second' })
    .mockResolvedValueOnce({ ...page('thread-old-second'), nextCursor: 'old-third' })
    .mockResolvedValueOnce({ ...page('thread-new-first'), nextCursor: 'new-second' })
    .mockReturnValueOnce(second.promise);
  const fixture = await setup();
  await fixture.ready();
  void fixture.run('loadMore');
  await vi.advanceTimersByTimeAsync(0);
  const sent = fixture.rendered.mock.calls.length;
  await vi.advanceTimersByTimeAsync(5_000);
  expect(mocks.list).toHaveBeenNthCalledWith(3, ['/fixture'], '', null);
  expect(mocks.list).toHaveBeenNthCalledWith(4, ['/fixture'], '', 'new-second');
  expect(fixture.api.snapshot()).toMatchObject({ busy: false, count: 2 });
  expect(fixture.rendered).toHaveBeenCalledTimes(sent);
  second.resolve({ ...page('thread-new-second'), nextCursor: 'new-third' });
  await vi.advanceTimersByTimeAsync(0);
  expect(fixture.rendered.mock.calls.at(-1)?.[0]).toMatchObject({
    hasMore: true, count: 2, groups: [{ chats: [{ id: 'thread-new-first' }, { id: 'thread-new-second' }] }],
  });
  void fixture.run('loadMore');
  await vi.advanceTimersByTimeAsync(0);
  expect(mocks.list).toHaveBeenLastCalledWith(['/fixture'], '', 'new-third');
});

test('a shorter refreshed history removes old pages and stops at the end of the new list', async () => {
  mocks.list
    .mockResolvedValueOnce({ ...page('thread-first'), nextCursor: 'second' })
    .mockResolvedValueOnce(page('thread-second'))
    .mockResolvedValueOnce(page('thread-only'));
  const fixture = await setup();
  await fixture.ready();
  void fixture.run('loadMore');
  await vi.advanceTimersByTimeAsync(5_000);
  expect(mocks.list).toHaveBeenCalledTimes(3);
  expect(fixture.rendered.mock.calls.at(-1)?.[0]).toMatchObject({
    hasMore: false, count: 1, groups: [{ chats: [{ id: 'thread-only' }] }],
  });
});

test('a user pagination request supersedes a slow automatic refresh', async () => {
  const background = Promise.withResolvers<ChatPage>();
  mocks.list
    .mockResolvedValueOnce({ ...page('thread-first'), nextCursor: 'second' })
    .mockReturnValueOnce(background.promise)
    .mockResolvedValueOnce(page('thread-second'));
  const fixture = await setup();
  await fixture.ready();
  await vi.advanceTimersByTimeAsync(5_000);
  void fixture.run('loadMore');
  await vi.advanceTimersByTimeAsync(0);
  expect(mocks.list).toHaveBeenLastCalledWith(['/fixture'], '', 'second');
  const sent = fixture.rendered.mock.calls.length;
  background.resolve(page('thread-stale'));
  await vi.advanceTimersByTimeAsync(0);
  expect(fixture.api.snapshot()).toMatchObject({ busy: false, count: 2 });
  expect(fixture.rendered).toHaveBeenCalledTimes(sent);
});

test('a cancelled title prompt leaves the current filter and cursor in place', async () => {
  mocks.list
    .mockResolvedValueOnce(page('thread-initial'))
    .mockResolvedValueOnce({ ...page('thread-matching'), nextCursor: 'page-two' })
    .mockResolvedValueOnce(page('thread-second'));
  const fixture = await setup();
  await fixture.ready();
  await fixture.search('matching');
  await fixture.search(undefined);
  expect(mocks.promptSearch).toHaveBeenLastCalledWith(expect.objectContaining({ value: 'matching' }));
  expect(mocks.list).toHaveBeenCalledTimes(2);
  await fixture.run('loadMore');
  expect(mocks.list).toHaveBeenLastCalledWith(['/fixture'], 'matching', 'page-two');
});

test('switching scope refreshes immediately without waiting for workspace preferences', async () => {
  const background = Promise.withResolvers<ChatPage>();
  const saved = Promise.withResolvers<void>();
  mocks.list.mockResolvedValueOnce(page('thread-current')).mockReturnValueOnce(background.promise)
    .mockResolvedValueOnce(page('thread-all'));
  mocks.updateScope.mockReturnValueOnce(saved.promise);
  const fixture = await setup();
  await fixture.ready();
  await vi.advanceTimersByTimeAsync(5_000);
  void fixture.pick('all');
  await vi.advanceTimersByTimeAsync(0);
  expect(mocks.list).toHaveBeenLastCalledWith(undefined, '', null);
  expect(fixture.rendered.mock.calls.at(-1)?.[0]).toMatchObject({
    scope: 'all', groups: [{ chats: [{ id: 'thread-all' }] }],
  });
  const sent = fixture.rendered.mock.calls.length;
  background.resolve(page('thread-stale-current'));
  saved.resolve();
  await vi.advanceTimersByTimeAsync(0);
  expect(fixture.rendered).toHaveBeenCalledTimes(sent);
  expect(mocks.list).toHaveBeenCalledTimes(3);
});

test('a failed background page preserves the entire list and retries on the next cycle', async () => {
  mocks.list
    .mockResolvedValueOnce({ ...page('thread-first'), nextCursor: 'second' })
    .mockResolvedValueOnce(page('thread-second'))
    .mockResolvedValueOnce({ ...page('thread-partial'), nextCursor: 'new-second' })
    .mockRejectedValueOnce(new Error('temporary failure'))
    .mockResolvedValueOnce(page('thread-recovered'));
  const fixture = await setup();
  await fixture.ready();
  void fixture.run('loadMore');
  await vi.advanceTimersByTimeAsync(5_000);
  expect(fixture.rendered.mock.calls.at(-1)?.[0]).toMatchObject({
    busy: false, error: 'temporary failure', count: 2,
    groups: [{ chats: [{ id: 'thread-first' }, { id: 'thread-second' }] }],
  });
  expect(mocks.dispose).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(5_000);
  expect(mocks.construct).toHaveBeenCalledTimes(2);
  expect(mocks.list).toHaveBeenLastCalledWith(['/fixture'], '', null);
  expect(fixture.rendered.mock.calls.at(-1)?.[0]).toMatchObject({
    error: '', count: 1, groups: [{ chats: [{ id: 'thread-recovered' }] }],
  });
});

test('closing during a poll prevents publication and does not schedule another poll', async () => {
  const background = Promise.withResolvers<ChatPage>();
  mocks.list.mockResolvedValueOnce(page('thread-initial')).mockReturnValueOnce(background.promise);
  const fixture = await setup();
  await fixture.ready();
  await vi.advanceTimersByTimeAsync(5_000);
  fixture.dispose();
  const sent = fixture.rendered.mock.calls.length;
  background.resolve(page('thread-late'));
  await vi.advanceTimersByTimeAsync(15_000);
  expect(mocks.list).toHaveBeenCalledTimes(2);
  expect(fixture.rendered).toHaveBeenCalledTimes(sent);
  expect(vi.getTimerCount()).toBe(0);
});

test('uses stable node identity and isolates search expansion from the saved tree', async () => {
  const fixture = await setup();
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

test('exposes conversation metadata through native rows and opens a loaded ID', async () => {
  const fixture = await setup();
  await fixture.ready();
  const group = fixture.tree.getChildren()[0]!;
  const chat = fixture.tree.getTreeItem(fixture.tree.getChildren(group)[0]!);
  expect(chat).toMatchObject({
    id: 'chat:thread-default',
    label: 'thread-default',
    tooltip: expect.stringContaining('Path: /fixture'),
    command: { command: 'codexProjectChats.openConversation', arguments: ['thread-default'] },
  });
  await fixture.run('openConversation', 'thread-default');
  await fixture.run('openConversation', 'missing');
  expect(mocks.openConversation).toHaveBeenCalledExactlyOnceWith('thread-default');
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

test('shows paths for same-named projects and exposes pagination as a native row', async () => {
  mocks.list.mockResolvedValueOnce({
    chats: [
      { id: 'thread-team', cwd: '/team/app', title: 'Team project', recencyAt: 1 },
      { id: 'thread-personal', cwd: '/personal/app', title: 'Personal project', recencyAt: 2 },
    ],
    nextCursor: 'more',
  });
  const fixture = await setup();
  await fixture.ready();
  const items = fixture.tree.getChildren().map(node => fixture.tree.getTreeItem(node));
  expect(items).toEqual([
    expect.objectContaining({ id: 'project:/personal/app', label: 'app', description: '/personal/app · 1 chat' }),
    expect.objectContaining({ id: 'project:/team/app', label: 'app', description: '/team/app · 1 chat' }),
    expect.objectContaining({ id: 'more', command: { command: 'codexProjectChats.loadMore', title: 'Load more conversations' } }),
  ]);
});
