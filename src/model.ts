import { createLocalizer, type Localize } from './i18n';
import path from 'node:path';
import { repositoryKey, type Directory } from './git';
import type { RepositoryPresentation } from './repositories';

/** Conversation metadata displayed in the project tree. */
export interface Chat {
  id: string;
  title: string;
  cwd: string;
  repository?: string;
  hasGit?: true;
  directory?: Directory;
  /** Codex recency timestamp in Unix seconds; 0 means unavailable. */
  recencyAt: number;
}

export interface ChatPage { chats: Chat[]; nextCursor: string | null }
export interface ProjectGroup {
  key: string;
  name: string;
  cwd: string;
  current: boolean;
  unknown?: boolean;
  repository?: string;
  pinAliases?: readonly string[];
  chats: Chat[];
}
export type Scope = 'current' | 'all';
export type Grouping = 'folder' | 'repository';
export type GroupOrder = 'recent' | 'name';
const byGroupName = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true });

export interface WorkspaceProjects {
  roots: string[];
  remotes: ReadonlySet<string>;
  gitDirectories: ReadonlySet<string>;
  repositoryView?: ReadonlyMap<string, RepositoryPresentation>;
}

/** Validate and select fields from the app-server response. */
export function parsePage(value: unknown, t: Localize = createLocalizer()): ChatPage {
  if (!isRecord(value) || !Array.isArray(value.data)) throw new Error(t('errorInvalidResponse'));
  const chats: Chat[] = [];
  for (const row of value.data) {
    if (!isRecord(row) || typeof row.id !== 'string' || !/^[a-z0-9_-]{8,128}$/i.test(row.id)
      || typeof row.cwd !== 'string' || !row.cwd) continue;
    const title = typeof row.name === 'string' && row.name.trim() ? row.name : typeof row.preview === 'string' ? row.preview : '';
    const repository = isRecord(row.gitInfo) && typeof row.gitInfo.originUrl === 'string'
      ? repositoryKey(row.gitInfo.originUrl) : undefined;
    const hasGit = isRecord(row.gitInfo) && Boolean(row.gitInfo.sha || row.gitInfo.branch || row.gitInfo.originUrl);
    chats.push({ id: row.id, title: title.replace(/\s+/g, ' ').trim() || t('untitled'), cwd: row.cwd,
      ...(repository ? { repository } : {}),
      ...(hasGit ? { hasGit: true as const } : {}),
      recencyAt: typeof row.recencyAt === 'number' && Number.isFinite(row.recencyAt) && row.recencyAt > 0 ? row.recencyAt : 0 });
  }
  return { chats, nextCursor: typeof value.nextCursor === 'string' && value.nextCursor ? value.nextCursor : null };
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Only Windows paths are case-insensitive. Keep distinct macOS/Linux paths distinct. */
export function pathKey(value: string): string {
  const windows = /^[a-z]:[\\/]/i.test(value) || value.startsWith('\\\\');
  if (windows) return path.win32.normalize(value).replace(/[\\/]+$/, '').toLowerCase();
  return path.posix.normalize(value).replace(/\/$/, '') || '/';
}

/** Query exact workspace paths and their real paths so symlinked workspaces remain usable. */
export function uniquePaths(paths: string[]): string[] {
  return [...new Map(paths.map(value => [pathKey(value), value])).values()];
}

function inWorkspace(chat: Chat, roots: ReadonlySet<string>, workspace: WorkspaceProjects, grouping: Grouping): boolean {
  if (grouping === 'repository') {
    if (chat.repository) return workspace.remotes.has(chat.repository) || Boolean(workspace.repositoryView?.get(chat.repository)?.current);
    if (chat.directory?.kind === 'git') return workspace.gitDirectories.has(pathKey(chat.directory.common));
  }
  return roots.has(pathKey(chat.cwd));
}

export function selectChats(
  chats: Chat[], workspace: WorkspaceProjects, scope: Scope, grouping: Grouping, showFolders: boolean, search: string,
): Chat[] {
  const roots = new Set(workspace.roots.map(pathKey));
  return chats.filter(chat =>
    (scope === 'all' || inWorkspace(chat, roots, workspace, grouping))
    && (showFolders || chat.repository || chat.hasGit || chat.directory?.kind !== 'folder')
    && (!search || chat.title.includes(search)))
    .sort((a, b) => b.recencyAt - a.recencyAt || a.id.localeCompare(b.id));
}

/** Group before rendering and disambiguate projects with the same folder basename. */
export function groupChats(chats: Chat[], roots: string[], grouping: Grouping = 'folder',
  workspace: WorkspaceProjects = { roots, remotes: new Set(), gitDirectories: new Set() },
  order?: GroupOrder,
): ProjectGroup[] {
  const rootKeys = new Set(workspace.roots.map(pathKey));
  const groups = new Map<string, ProjectGroup>();
  for (const chat of chats) {
    const savedRemote = grouping === 'repository' ? chat.repository : undefined;
    const repository = savedRemote ? workspace.repositoryView?.get(savedRemote) : undefined;
    const remote = repository?.remote ?? savedRemote;
    const local = grouping === 'repository' && !remote && chat.directory?.kind === 'git' ? chat.directory : undefined;
    const cwd = local?.root ?? chat.cwd;
    const key = repository?.key ?? (remote ? `remote:${remote}` : local ? `git:${pathKey(local.common)}` : pathKey(cwd));
    let group = groups.get(key);
    if (!group) {
      const normalized = (remote ?? cwd).replace(/\\/g, '/').replace(/\/$/, '');
      const unknown = grouping === 'repository' && !remote && !local && chat.directory?.kind !== 'folder' && !chat.hasGit;
      group = {
        key, name: normalized.split('/').at(-1) || cwd, cwd: repository?.checkout ?? remote ?? cwd,
        current: inWorkspace(chat, rootKeys, workspace, grouping),
        ...(remote ? { repository: remote, pinAliases: repository?.pinAliases } : {}),
        ...(unknown ? { unknown: true } : {}), chats: [],
      };
      groups.set(key, group);
    }
    group.chats.push(chat);
    if (group.unknown && (chat.hasGit || chat.directory?.kind === 'folder')) group.unknown = false;
  }
  const result = [...groups.values()];
  for (const group of result) group.chats.sort((a, b) => b.recencyAt - a.recencyAt || a.id.localeCompare(b.id));
  return result.sort((a, b) => {
    const byActivity = b.chats[0]!.recencyAt - a.chats[0]!.recencyAt;
    if (!order) return Number(b.current) - Number(a.current) || byActivity || a.cwd.localeCompare(b.cwd);
    return (order === 'recent' ? byActivity : 0) || byGroupName.compare(a.name, b.name) || a.key.localeCompare(b.key);
  });
}
