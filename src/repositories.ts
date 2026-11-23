import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import { findRepositories, type WorkspaceRepository } from './git';
import { isRecord, type Chat } from './model';

const exec = promisify(execFile);
const DAY = 86_400_000;
const CHECKOUT_TTL = 5 * 60_000;
const GITHUB_REPO = /^github\.com\/([a-z0-9_.-]+)\/([a-z0-9_.-]+)$/;

interface GitHubIdentity {
  id: number;
  remote: string;
}

interface CachedIdentity {
  remote: string;
  checkedAt: number;
  resolvedAt?: number;
  identity?: GitHubIdentity;
}

export interface RepositoryPresentation {
  key: string;
  remote: string;
  checkout?: string;
  current: boolean;
  preferenceAliases?: readonly string[];
}

function githubMetadata(value: unknown): GitHubIdentity | undefined {
  if (
    !isRecord(value) ||
    typeof value.id !== 'number' ||
    !Number.isSafeInteger(value.id) ||
    value.id <= 0 ||
    typeof value.full_name !== 'string'
  )
    return undefined;
  const remote = `github.com/${value.full_name.toLowerCase()}`;
  if (GITHUB_REPO.test(remote)) return { id: value.id, remote };
  return undefined;
}

async function lookupGitHub(remote: string): Promise<GitHubIdentity | undefined> {
  const match = GITHUB_REPO.exec(remote);
  if (!match || match.slice(1).some((segment) => segment === '.' || segment === '..')) return;
  const endpoint = `repos/${match[1]}/${match[2]}`;
  try {
    const { stdout } = await exec(
      'gh',
      ['api', '--hostname', 'github.com', '--method', 'GET', endpoint, '--jq', '{id, full_name}'],
      {
        timeout: 5_000,
        maxBuffer: 32 * 1024,
        windowsHide: true,
        env: { ...process.env, GH_PROMPT_DISABLED: '1' },
      },
    );
    return githubMetadata(JSON.parse(stdout));
  } catch (error) {
    const { code, stderr } = error as { code?: unknown; stderr?: unknown };
    if (code !== 'ENOENT' && !(typeof stderr === 'string' && stderr.includes('gh auth login')))
      return;
  }
  const response = await fetch(`https://api.github.com/${endpoint}`, {
    headers: { Accept: 'application/vnd.github+json' },
    signal: AbortSignal.timeout(5_000),
  });
  if (response.ok) return githubMetadata(await response.json());
  return undefined;
}

function identityFile(remote: string): string {
  return `${createHash('sha256').update(remote).digest('hex')}.json`;
}

function parseIdentity(text: string): CachedIdentity | undefined {
  const value: unknown = JSON.parse(text);
  if (
    !isRecord(value) ||
    typeof value.remote !== 'string' ||
    !GITHUB_REPO.test(value.remote) ||
    typeof value.checkedAt !== 'number' ||
    !Number.isFinite(value.checkedAt)
  )
    return undefined;
  const saved = isRecord(value.identity) ? value.identity : undefined;
  const identity =
    typeof saved?.remote === 'string' && GITHUB_REPO.test(saved.remote)
      ? githubMetadata({ id: saved.id, full_name: saved.remote.slice('github.com/'.length) })
      : undefined;
  const resolvedAt = typeof value.resolvedAt === 'number' ? value.resolvedAt : value.checkedAt;
  return { remote: value.remote, checkedAt: value.checkedAt, identity, resolvedAt };
}

async function collect<T>(
  values: Iterable<T>,
  active: () => boolean,
  inspect: (value: T) => Promise<void>,
) {
  const iterator = values[Symbol.iterator]();
  await Promise.all(
    Array.from({ length: 4 }, async () => {
      while (active()) {
        const next = iterator.next();
        if (next.done) return;
        await inspect(next.value);
      }
    }),
  );
}

/** Enrich the indexed remotes and paths independently of Codex history sync. */
export class RepositoryCatalog {
  private readonly identities = new Map<string, CachedIdentity>();
  private readonly checkouts = new Map<
    string,
    { checkedAt: number; remotes: Map<string, WorkspaceRepository> }
  >();
  private readonly directory?: string;
  private loaded?: Promise<void>;

  constructor(storage?: string) {
    if (storage) this.directory = path.join(storage, 'repository-identities-v1');
  }

  private async load(directory: string): Promise<void> {
    const files = await readdir(directory).catch(() => []);
    await collect(
      files,
      () => true,
      async (file) => {
        if (!/^[a-f0-9]{64}\.json$/.test(file)) return;
        try {
          const entry = parseIdentity(await readFile(path.join(directory, file), 'utf8'));
          if (entry && file === identityFile(entry.remote))
            this.identities.set(entry.remote, entry);
        } catch {
          /* A malformed or unavailable cache entry can be rebuilt. */
        }
      },
    );
  }

  private async save(entry: CachedIdentity): Promise<void> {
    if (!this.directory) return;
    const target = path.join(this.directory, identityFile(entry.remote));
    const temporary = `${target}.${randomUUID()}.tmp`;
    try {
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      await writeFile(temporary, JSON.stringify(entry), { mode: 0o600, flag: 'wx' });
      await rename(temporary, target);
    } catch {
      await rm(temporary, { force: true }).catch(() => {});
    }
  }

  async refresh(
    chats: readonly Chat[],
    workspace: ReadonlyMap<string, WorkspaceRepository>,
    active: () => boolean,
    changed: () => void,
    forcePaths: boolean,
  ): Promise<void> {
    const remotes = new Set(workspace.keys());
    const paths = new Set<string>();
    for (const chat of chats) {
      if (!chat.repository) continue;
      remotes.add(chat.repository);
      paths.add(chat.cwd);
    }
    if (this.directory && !this.loaded) {
      this.loaded = this.load(this.directory);
      await this.loaded;
      if (active() && this.identities.size) changed();
    }
    await Promise.all([
      collect(remotes, active, async (remote) => {
        if (!GITHUB_REPO.test(remote)) return;
        const previous = this.identities.get(remote);
        if (previous && Date.now() - previous.checkedAt < (previous.identity ? 7 * DAY : DAY / 24))
          return;
        // Persist only on installed hosts with global storage. Unit hosts have no network cache.
        if (!this.directory) return;
        const resolved = await lookupGitHub(remote).catch(() => undefined);
        const identity = resolved ?? previous?.identity;
        const now = Date.now();
        const entry = {
          remote,
          checkedAt: now,
          identity,
          resolvedAt: resolved ? now : previous?.resolvedAt,
        };
        this.identities.set(remote, entry);
        if (
          active() &&
          (identity?.id !== previous?.identity?.id ||
            identity?.remote !== previous?.identity?.remote)
        )
          changed();
        await this.save(entry);
      }),
      collect(paths, active, async (cwd) => {
        const previous = this.checkouts.get(cwd);
        if (!forcePaths && previous && Date.now() - previous.checkedAt < CHECKOUT_TTL) return;
        const exists = await stat(cwd).then(
          (info) => info.isDirectory(),
          () => false,
        );
        const remotes = exists
          ? await findRepositories([cwd])
          : new Map<string, WorkspaceRepository>();
        this.checkouts.set(cwd, { checkedAt: Date.now(), remotes });
        if (
          active() &&
          [...new Set([...remotes.keys(), ...(previous?.remotes.keys() ?? [])])].some(
            (key) => previous?.remotes.get(key)?.root !== remotes.get(key)?.root,
          )
        )
          changed();
      }),
    ]);
  }

  presentation(
    chats: readonly Chat[],
    workspace: ReadonlyMap<string, WorkspaceRepository>,
  ): Map<string, RepositoryPresentation> {
    const names = new Map<number, CachedIdentity>();
    const canonical = new Map<string, CachedIdentity>();
    for (const entry of this.identities.values()) {
      if (!entry.identity) continue;
      const { id, remote } = entry.identity;
      const resolvedAt = entry.resolvedAt ?? entry.checkedAt;
      if (resolvedAt >= (names.get(id)?.resolvedAt ?? 0)) names.set(id, entry);
      if (resolvedAt >= (canonical.get(remote)?.resolvedAt ?? 0)) canonical.set(remote, entry);
    }
    const identityFor = (remote: string) =>
      this.identities.get(remote)?.identity ?? canonical.get(remote)?.identity;
    const groupKey = (remote: string) => {
      const identity = identityFor(remote);
      return identity ? `github:${identity.id}` : `remote:${remote}`;
    };
    const aliases = new Map<string, Set<string>>();
    for (const [remote, entry] of this.identities) {
      if (!entry.identity) continue;
      const key = groupKey(remote);
      const keys = aliases.get(key) ?? new Set<string>();
      keys.add(`remote:${remote}`);
      if (groupKey(entry.identity.remote) === key) keys.add(`remote:${entry.identity.remote}`);
      aliases.set(key, keys);
    }
    const current = new Map<string, string>();
    for (const [remote, checkout] of workspace) {
      const key = groupKey(remote);
      if (!current.has(key)) current.set(key, checkout.root);
    }
    const historical = new Map<string, { root: string; recencyAt: number }>();
    const result = new Map<string, RepositoryPresentation>();
    for (const chat of chats) {
      if (!chat.repository) continue;
      const key = groupKey(chat.repository);
      const existing = historical.get(key);
      if (current.has(key) || (existing && existing.recencyAt >= chat.recencyAt)) continue;
      for (const [remote, checkout] of this.checkouts.get(chat.cwd)?.remotes ?? []) {
        if (groupKey(remote) !== key) continue;
        historical.set(key, { root: checkout.root, recencyAt: chat.recencyAt });
        break;
      }
    }
    for (const chat of chats) {
      const remote = chat.repository;
      if (!remote || result.has(remote)) continue;
      const key = groupKey(remote);
      const preferenceAliases = aliases.get(key);
      const identity = identityFor(remote);
      result.set(remote, {
        key,
        remote: identity ? (names.get(identity.id)?.identity?.remote ?? identity.remote) : remote,
        current: current.has(key),
        checkout: current.get(key) ?? historical.get(key)?.root,
        preferenceAliases: preferenceAliases ? [...preferenceAliases] : undefined,
      });
    }
    return result;
  }
}
