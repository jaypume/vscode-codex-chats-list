import * as vscode from 'vscode';

import { createLocalizer, localization } from './i18n';
import type { Chat, ProjectGroup, Scope } from './model';
import { formatConversationDate } from './time';

export const VIEW_ID = 'codexChatsList.list';
export const OPEN_CONVERSATION = 'codexChatsList.openConversation';
export const LOAD_MORE_CONVERSATIONS = 'codexChatsList.loadMoreConversations';
const AUTO_EXPAND_LIMIT = 50;
const DATE_SCHEME = 'codex-chats-list-date';
const PROJECT_ACTIVITY_PATH = '/project/';
const MAX_BADGE_COUNT = 99;
const mutedIconColor = new vscode.ThemeColor('descriptionForeground');
// A folder-shaped codicon keeps rendering when a synthetic resource supplies the date badge.
const folderIcon = new vscode.ThemeIcon(
  'symbol-folder',
  new vscode.ThemeColor('textLink.foreground'),
);
const unknownFolderIcon = new vscode.ThemeIcon('symbol-folder', mutedIconColor);
const hiddenProjectIcon = new vscode.ThemeIcon('eye-closed', mutedIconColor);
const blankIcon = new vscode.ThemeIcon('blank');

type ProjectNode = {
  kind: 'project';
  group: ProjectGroup;
  latestConversationAt: number;
  visibleLimit?: number;
  qualifier?: string;
  filtered: boolean;
  expanded: boolean;
  pinned: boolean;
  hidden: boolean;
};
type ChatFlags = { pinned: boolean; hidden: boolean; assignedRepository?: string };
export type MoreNode = { kind: 'more'; projectKey: string };
export type TreeNode =
  | ProjectNode
  | MoreNode
  | ({ kind: 'chat'; chat: Chat; filtered: boolean } & ChatFlags);

const t = createLocalizer(vscode.env.language);
const { locale } = localization(vscode.env.language);
const exactTime = new Intl.DateTimeFormat(locale, {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

function conversationCount(count: number): string {
  return t(count === 1 ? 'chatsOne' : 'chatsOther', { count });
}

export const projectCountDecorations = {
  provideFileDecoration(uri: vscode.Uri) {
    if (uri.scheme !== DATE_SCHEME || !uri.path.startsWith(PROJECT_ACTIVITY_PATH)) return undefined;
    const count = Number(uri.path.slice(PROJECT_ACTIVITY_PATH.length));
    if (!Number.isSafeInteger(count) || count < 1) return undefined;
    return new vscode.FileDecoration(String(Math.min(count, MAX_BADGE_COUNT)));
  },
} satisfies vscode.FileDecorationProvider;

function projectQualifiers(groups: ProjectGroup[]): Map<string, string> {
  const byName = new Map<string, ProjectGroup[]>();
  for (const group of groups) {
    const matches = byName.get(group.name);
    if (matches) matches.push(group);
    else byName.set(group.name, [group]);
  }

  const qualifiers = new Map<string, string>();
  for (const matches of byName.values()) {
    if (matches.length < 2) continue;
    const parents = matches.map((group) =>
      (group.repository ?? group.cwd).replace(/\\/g, '/').split('/').filter(Boolean).slice(0, -1),
    );
    for (const [index, group] of matches.entries()) {
      const parts = parents[index]!;
      let qualifier = group.repository ?? group.cwd;
      for (let depth = 1; depth <= parts.length; depth++) {
        const suffix = parts.slice(-depth).join('/');
        if (parents.every((other, i) => i === index || other.slice(-depth).join('/') !== suffix)) {
          qualifier = suffix;
          break;
        }
      }
      qualifiers.set(group.key, qualifier);
    }
  }
  return qualifiers;
}

export class ChatTree
  implements vscode.TreeDataProvider<TreeNode>, vscode.FileDecorationProvider, vscode.Disposable
{
  private readonly changes = new vscode.EventEmitter<TreeNode | undefined>();
  readonly onDidChangeTreeData = this.changes.event;
  private readonly expansion: Map<string, boolean>;
  private readonly currentIcon: vscode.Uri;
  private readonly pinnedIcon: vscode.Uri;
  private nodes: ProjectNode[] = [];
  private opening: string | null = null;
  private showBadges = true;

  constructor(
    private readonly state: vscode.Memento,
    extensionUri: vscode.Uri,
    private readonly chatFlags: (id: string) => ChatFlags,
  ) {
    this.expansion = new Map(
      Object.entries(state.get<Record<string, boolean>>('projectExpansion', {})),
    );
    this.currentIcon = vscode.Uri.joinPath(extensionUri, 'media', 'current-arrow.png');
    this.pinnedIcon = vscode.Uri.joinPath(extensionUri, 'media', 'pinned-star.png');
    this.updateBadgeSetting();
  }

  update(
    groups: (ProjectGroup & {
      pinned: boolean;
      hidden: boolean;
      latestConversationAt: number;
      visibleLimit?: number;
    })[],
    scope: Scope,
    filtered: boolean,
    opening: string | null,
  ): void {
    const qualifiers = projectQualifiers(groups);
    const expandFiltered =
      filtered &&
      groups.reduce((count, group) => count + group.chats.length, 0) <= AUTO_EXPAND_LIMIT;
    this.nodes = groups.map((group) => ({
      kind: 'project',
      group,
      latestConversationAt: group.latestConversationAt,
      visibleLimit: group.visibleLimit,
      qualifier: qualifiers.get(group.key),
      filtered,
      pinned: group.pinned,
      hidden: group.hidden,
      expanded: filtered
        ? expandFiltered
        : (this.expansion.get(group.key) ?? (scope === 'current' || group.current)),
    }));
    this.nodes.sort((a, b) => Number(b.pinned) - Number(a.pinned));
    this.opening = opening;
    this.refresh();
  }

  async rememberExpansion(node: TreeNode, expanded: boolean): Promise<void> {
    if (node.kind !== 'project' || node.filtered || this.expansion.get(node.group.key) === expanded)
      return;
    this.expansion.set(node.group.key, expanded);
    await this.state.update('projectExpansion', Object.fromEntries(this.expansion));
  }

  refresh(): void {
    this.changes.fire(undefined);
  }

  updateBadgeSetting(): void {
    const enabled = vscode.workspace.getConfiguration('explorer.decorations').get('badges', true);
    if (enabled === this.showBadges) return;
    this.showBadges = enabled;
    this.refresh();
  }

  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    if (uri.scheme !== DATE_SCHEME || !/^(?:[0-7]d|[1-4]w|[1-9][my])$/.test(uri.query)) {
      return undefined;
    }
    return new vscode.FileDecoration(uri.query);
  }

  private setActivityBadges(item: vscode.TreeItem, recencyAt: number, chatCount?: number) {
    const date = new Date(recencyAt > 0 ? recencyAt * 1000 : NaN);
    const activity = formatConversationDate(date);
    const relative = this.showBadges ? activity?.relative : undefined;
    const badge = relative?.length === 2 ? relative : undefined;
    if (this.showBadges && (badge || chatCount !== undefined)) {
      item.resourceUri = vscode.Uri.from({
        scheme: DATE_SCHEME,
        path: chatCount === undefined ? '/conversation' : PROJECT_ACTIVITY_PATH + chatCount,
        query: badge ?? '',
      });
    }
    return {
      inlineDate: badge ? undefined : (relative ?? activity?.text),
      timestamp: activity ? exactTime.format(date) : undefined,
    };
  }

  getChildren(node?: TreeNode): TreeNode[] {
    if (!node) return this.nodes;
    if (node.kind !== 'project') return [];
    const chats = node.group.chats
      .map((chat) => ({
        kind: 'chat' as const,
        chat,
        filtered: node.filtered,
        ...this.chatFlags(chat.id),
      }))
      .sort((a, b) => Number(b.pinned) - Number(a.pinned));
    const limit = node.visibleLimit;
    if (limit === undefined || chats.length <= limit) return chats;
    return [...chats.slice(0, limit), { kind: 'more', projectKey: node.group.key }];
  }

  getTreeItem(node: TreeNode): vscode.TreeItem {
    if (node.kind === 'more') {
      const item = new vscode.TreeItem(t('loadMore'));
      item.id = `more:${node.projectKey}`;
      item.iconPath = new vscode.ThemeIcon('ellipsis');
      item.command = { command: LOAD_MORE_CONVERSATIONS, title: t('loadMore'), arguments: [node] };
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
      const projectIcon = group.current
        ? this.currentIcon
        : group.unknown
          ? unknownFolderIcon
          : folderIcon;
      item.iconPath = node.hidden ? hiddenProjectIcon : node.pinned ? this.pinnedIcon : projectIcon;
      item.contextValue = (node.pinned ? 'pinnedProject' : 'project') + hidden;
      const count = conversationCount(group.chats.length);
      const { inlineDate, timestamp } = this.setActivityBadges(
        item,
        node.latestConversationAt,
        group.chats.length,
      );
      const latestConversation = timestamp && `${t('recentConversation')}: ${timestamp}`;
      item.description = [
        !this.showBadges && count,
        node.qualifier,
        group.current && t('currentBadge'),
        group.unknown && t('unknownSource'),
        inlineDate,
      ]
        .filter(Boolean)
        .join(' · ');
      item.tooltip = [
        group.repository,
        group.cwd !== group.repository && group.cwd,
        count,
        latestConversation,
        node.pinned && t('pinnedLabel'),
        node.hidden && t('hiddenLabel'),
      ]
        .filter(Boolean)
        .join('\n');
      item.accessibilityInformation = {
        label: [
          group.name,
          count,
          latestConversation,
          node.qualifier,
          group.current && t('currentBadge'),
          group.unknown && t('unknownSource'),
          node.pinned && t('pinnedLabel'),
          node.hidden && t('hiddenLabel'),
        ]
          .filter(Boolean)
          .join(', '),
      };
      return item;
    }
    const { chat } = node;
    const item = new vscode.TreeItem(chat.title);
    item.id = `${prefix}chat:${chat.id}`;
    item.contextValue =
      (node.pinned ? 'pinnedChat' : 'chat') + hidden + (node.assignedRepository ? '.assigned' : '');
    const opening = this.opening === chat.id;
    const activity = this.setActivityBadges(item, chat.recencyAt);
    item.description = opening ? t('opening') : activity.inlineDate;
    if (opening) item.iconPath = new vscode.ThemeIcon('loading~spin');
    else if (node.hidden) item.iconPath = new vscode.ThemeIcon('eye-closed');
    else if (node.pinned) item.iconPath = this.pinnedIcon;
    else item.iconPath = blankIcon;
    const timestamp = activity.timestamp ?? t('unknownTime');
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
        t(opening ? 'openingLabel' : 'openLabel', { title: chat.title, time: timestamp }),
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
