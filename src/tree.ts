import * as vscode from 'vscode';

import { createLocalizer, localization } from './i18n';
import type { Chat, ProjectGroup, Scope } from './model';
import { formatConversationDate } from './time';

export const VIEW_ID = 'codexChatsList.list';
export const OPEN_CONVERSATION = 'codexChatsList.openConversation';
export const LOAD_MORE = 'codexChatsList.loadMore';
const AUTO_EXPAND_LIMIT = 50;
const COUNT_SCHEME = 'codex-chats-list-count';
const DATE_SCHEME = 'codex-chats-list-date';
const MAX_BADGE_COUNT = 99;
// A folder-shaped codicon keeps rendering when a synthetic resource supplies the count badge.
const folderIcon = new vscode.ThemeIcon('symbol-folder');
const blankIcon = new vscode.ThemeIcon('blank');

type ProjectNode = {
  kind: 'project';
  group: ProjectGroup;
  qualifier?: string;
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
  private nodes: TreeNode[] = [];
  private opening: string | null = null;
  private showBadges = true;

  constructor(
    private readonly state: vscode.Memento,
    private readonly chatFlags: (id: string) => ChatFlags,
  ) {
    this.expansion = new Map(
      Object.entries(state.get<Record<string, boolean>>('projectExpansion', {})),
    );
    this.updateBadgeSetting();
  }

  update(
    groups: (ProjectGroup & { pinned: boolean; hidden: boolean })[],
    scope: Scope,
    filtered: boolean,
    more: boolean,
    opening: string | null,
  ): void {
    const qualifiers = projectQualifiers(groups);
    const expandFiltered =
      filtered &&
      groups.reduce((count, group) => count + group.chats.length, 0) <= AUTO_EXPAND_LIMIT;
    this.nodes = groups.map((group) => ({
      kind: 'project',
      group,
      qualifier: qualifiers.get(group.key),
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
    if (uri.scheme === DATE_SCHEME) {
      return /^(?:[0-7]d|[1-4]w)$/.test(uri.query)
        ? new vscode.FileDecoration(uri.query)
        : undefined;
    }
    if (uri.scheme !== COUNT_SCHEME) return undefined;
    const count = Number(uri.query);
    if (!Number.isSafeInteger(count) || count < 1) return undefined;
    return new vscode.FileDecoration(
      String(Math.min(count, MAX_BADGE_COUNT)),
      conversationCount(count),
    );
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
          : folderIcon;
      item.contextValue = (node.pinned ? 'pinnedProject' : 'project') + hidden;
      const count = conversationCount(group.chats.length);
      const badge = this.showBadges;
      if (badge) {
        item.resourceUri = vscode.Uri.from({
          scheme: COUNT_SCHEME,
          path: `/${group.name}`,
          query: String(group.chats.length),
        });
      }
      item.description = [
        !badge && count,
        node.qualifier,
        group.current && t('currentBadge'),
        group.unknown && t('unknownSource'),
      ]
        .filter(Boolean)
        .join(' · ');
      item.tooltip = [
        group.repository,
        group.cwd !== group.repository && group.cwd,
        count,
        node.pinned && t('pinnedLabel'),
        node.hidden && t('hiddenLabel'),
      ]
        .filter(Boolean)
        .join('\n');
      item.accessibilityInformation = {
        label: [
          group.name,
          count,
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
    const date = new Date(chat.recencyAt > 0 ? chat.recencyAt * 1000 : NaN);
    const displayDate = formatConversationDate(date);
    const item = new vscode.TreeItem(chat.title);
    item.id = `${prefix}chat:${chat.id}`;
    item.contextValue =
      (node.pinned ? 'pinnedChat' : 'chat') + hidden + (node.assignedRepository ? '.assigned' : '');
    const opening = this.opening === chat.id;
    const badge = this.showBadges ? displayDate?.badge : undefined;
    if (badge) {
      item.resourceUri = vscode.Uri.from({
        scheme: DATE_SCHEME,
        path: '/conversation',
        query: badge,
      });
    }
    item.description = opening ? t('opening') : badge ? undefined : displayDate?.text;
    if (opening) item.iconPath = new vscode.ThemeIcon('loading~spin');
    else if (node.hidden) item.iconPath = new vscode.ThemeIcon('eye-closed');
    else if (node.pinned) item.iconPath = new vscode.ThemeIcon('pinned');
    else item.iconPath = blankIcon;
    const timestamp = displayDate ? exactTime.format(date) : t('unknownTime');
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
