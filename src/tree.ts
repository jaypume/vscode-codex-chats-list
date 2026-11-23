import * as vscode from 'vscode';

import { createLocalizer, localization } from './i18n';
import type { Chat, ProjectGroup, Scope } from './model';
import { createTimeFormatter } from './time';

export const VIEW_ID = 'codexChatsList.list';
export const OPEN_CONVERSATION = 'codexChatsList.openConversation';
export const LOAD_MORE = 'codexChatsList.loadMore';
const AUTO_EXPAND_LIMIT = 50;

type ProjectNode = {
  kind: 'project';
  group: ProjectGroup;
  duplicate: boolean;
  filtered: boolean;
  expanded: boolean;
  pinned: boolean;
  hidden: boolean;
};
type ChatFlags = { pinned: boolean; hidden: boolean; assignedRepository?: string };
export type TreeNode =
  | ProjectNode
  | ({ kind: 'chat'; chat: Chat; filtered: boolean } & ChatFlags)
  | { kind: 'more' };

const t = createLocalizer(vscode.env.language);
const { locale } = localization(vscode.env.language);
const relativeTime = createTimeFormatter(locale, t);
const exactTime = new Intl.DateTimeFormat(locale, {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

export class ChatTree implements vscode.TreeDataProvider<TreeNode>, vscode.Disposable {
  private readonly changes = new vscode.EventEmitter<TreeNode | undefined>();
  readonly onDidChangeTreeData = this.changes.event;
  private readonly expansion: Map<string, boolean>;
  private nodes: TreeNode[] = [];
  private opening: string | null = null;

  constructor(
    private readonly state: vscode.Memento,
    private readonly chatFlags: (id: string) => ChatFlags,
  ) {
    this.expansion = new Map(
      Object.entries(state.get<Record<string, boolean>>('projectExpansion', {})),
    );
  }

  update(
    groups: (ProjectGroup & { pinned: boolean; hidden: boolean })[],
    scope: Scope,
    filtered: boolean,
    more: boolean,
    opening: string | null,
  ): void {
    const counts = new Map<string, number>();
    for (const group of groups) counts.set(group.name, (counts.get(group.name) ?? 0) + 1);
    const expandFiltered =
      filtered &&
      groups.reduce((count, group) => count + group.chats.length, 0) <= AUTO_EXPAND_LIMIT;
    this.nodes = groups.map((group) => ({
      kind: 'project',
      group,
      duplicate: (counts.get(group.name) ?? 0) > 1,
      filtered,
      pinned: group.pinned,
      hidden: group.hidden,
      expanded: filtered
        ? expandFiltered
        : (this.expansion.get(group.key) ?? (scope === 'current' || group.current)),
    }));
    this.nodes.sort(
      (a, b) => Number(b.kind === 'project' && b.pinned) - Number(a.kind === 'project' && a.pinned),
    );
    if (more) this.nodes.push({ kind: 'more' });
    this.opening = opening;
    this.refreshTimes();
  }

  async rememberExpansion(node: TreeNode, expanded: boolean): Promise<void> {
    if (node.kind !== 'project' || node.filtered || this.expansion.get(node.group.key) === expanded)
      return;
    this.expansion.set(node.group.key, expanded);
    await this.state.update('projectExpansion', Object.fromEntries(this.expansion));
  }

  refreshTimes(): void {
    this.changes.fire(undefined);
  }

  getChildren(node?: TreeNode): TreeNode[] {
    if (!node) return this.nodes;
    if (node.kind !== 'project') return [];
    return node.group.chats
      .map((chat) => ({
        kind: 'chat' as const,
        chat,
        filtered: node.filtered,
        ...this.chatFlags(chat.id),
      }))
      .sort((a, b) => Number(b.pinned) - Number(a.pinned));
  }

  getTreeItem(node: TreeNode): vscode.TreeItem {
    if (node.kind === 'more') {
      const item = new vscode.TreeItem(t('more'));
      item.id = 'more';
      item.iconPath = new vscode.ThemeIcon('ellipsis');
      item.command = { command: LOAD_MORE, title: t('more') };
      return item;
    }
    const prefix = node.filtered ? 'filtered:' : '';
    const hidden = node.hidden ? '.hidden' : '';
    if (node.kind === 'project') {
      const { group } = node;
      const item = new vscode.TreeItem(
        group.name,
        node.expanded
          ? vscode.TreeItemCollapsibleState.Expanded
          : vscode.TreeItemCollapsibleState.Collapsed,
      );
      item.id = `${prefix}project:${group.key}`;
      item.iconPath = node.hidden
        ? new vscode.ThemeIcon('eye-closed')
        : node.pinned
          ? new vscode.ThemeIcon('pinned')
          : vscode.ThemeIcon.Folder;
      item.contextValue = (node.pinned ? 'pinnedProject' : 'project') + hidden;
      const count = t(group.chats.length === 1 ? 'chatsOne' : 'chatsOther', {
        count: group.chats.length,
      });
      item.description = [
        group.current && t('currentBadge'),
        group.unknown && t('unknownSource'),
        node.duplicate && group.cwd,
        count,
      ]
        .filter(Boolean)
        .join(' · ');
      item.tooltip = [
        group.repository,
        group.cwd !== group.repository && group.cwd,
        node.pinned && t('pinnedLabel'),
        node.hidden && t('hiddenLabel'),
      ]
        .filter(Boolean)
        .join('\n');
      return item;
    }
    const { chat } = node;
    const item = new vscode.TreeItem(chat.title);
    item.id = `${prefix}chat:${chat.id}`;
    item.contextValue =
      (node.pinned ? 'pinnedChat' : 'chat') + hidden + (node.assignedRepository ? '.assigned' : '');
    const time = relativeTime(chat.recencyAt);
    const opening = this.opening === chat.id;
    item.description = opening ? t('opening') : time;
    if (opening) item.iconPath = new vscode.ThemeIcon('loading~spin');
    else if (node.hidden) item.iconPath = new vscode.ThemeIcon('eye-closed');
    else if (node.pinned) item.iconPath = new vscode.ThemeIcon('pinned');
    const date = new Date(chat.recencyAt * 1000);
    const timestamp =
      chat.recencyAt > 0 && Number.isFinite(date.getTime())
        ? exactTime.format(date)
        : t('unknownTime');
    item.tooltip = [
      chat.title,
      `${t('recentConversation')}: ${timestamp}`,
      `${t('path')}: ${chat.cwd}`,
      ...(node.assignedRepository
        ? [t('assignedRepository', { repository: node.assignedRepository })]
        : []),
      ...(node.pinned ? [t('pinnedLabel')] : []),
      ...(node.hidden ? [t('hiddenLabel')] : []),
    ].join('\n');
    item.accessibilityInformation = {
      label: [
        t(opening ? 'openingLabel' : 'openLabel', { title: chat.title, time }),
        ...(node.pinned ? [t('pinnedLabel')] : []),
        ...(node.hidden ? [t('hiddenLabel')] : []),
      ].join(', '),
    };
    item.command = {
      command: OPEN_CONVERSATION,
      title: t('openConversation'),
      arguments: [chat.id],
    };
    return item;
  }

  dispose(): void {
    this.changes.dispose();
  }
}
