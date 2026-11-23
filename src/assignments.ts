import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, rmdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import type { RepositoryTarget } from './git';
import { isRecord } from './model';

function readTarget(value: unknown): RepositoryTarget | undefined {
  if (!isRecord(value)) return undefined;
  if (
    value.kind === 'git' &&
    typeof value.root === 'string' &&
    typeof value.common === 'string' &&
    path.isAbsolute(value.root) &&
    path.isAbsolute(value.common)
  ) {
    return { kind: 'git', root: value.root, common: value.common };
  }
  if (
    value.kind === 'remote' &&
    typeof value.remote === 'string' &&
    /^[^\s/@]+\/[^\s?#]+$/.test(value.remote)
  ) {
    const githubKey =
      typeof value.githubKey === 'string' && /^github:\d+$/.test(value.githubKey)
        ? value.githubKey
        : undefined;
    return { kind: 'remote', remote: value.remote, githubKey };
  }
  return undefined;
}

async function readData(file: string): Promise<Record<string, unknown>> {
  const contents = await readFile(file, 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return '{}';
    throw error;
  });
  const value: unknown = JSON.parse(contents);
  if (!isRecord(value)) throw new Error('Invalid extension data.');
  return value;
}

async function lockData(file: string) {
  const token = randomUUID();
  const owner = `owner-${process.pid}-${token}`;
  const staging = `${file}.${token}`;
  await mkdir(staging, { mode: 0o700 });
  try {
    await writeFile(path.join(staging, owner), '', { mode: 0o600 });
    for (let attempt = 0; attempt < 40; attempt++) {
      try {
        // Rename publishes a non-empty lock atomically. A late recovery cannot remove a new owner.
        await rename(staging, file);
        return async () => {
          await rm(path.join(file, owner), { force: true });
          await rmdir(file).catch(() => {});
        };
      } catch (error) {
        if (!['ENOTEMPTY', 'EEXIST', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? ''))
          throw error;
        const markers = await readdir(file).catch(() => []);
        for (const marker of markers) {
          const pid = /^owner-([1-9]\d*)-[a-f0-9-]+$/.exec(marker)?.[1];
          if (!pid) continue;
          try {
            process.kill(Number(pid), 0);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ESRCH')
              await rm(path.join(file, marker), { force: true });
          }
        }
        await rmdir(file).catch(() => {});
        await delay(25);
      }
    }
    throw new Error('Extension data is busy.');
  } finally {
    await rm(path.join(staging, owner), { force: true }).catch(() => {});
    await rmdir(staging).catch(() => {});
  }
}

/** User-owned repository overrides, stored independently of the history index. */
export class RepositoryAssignments {
  private readonly file?: string;
  private entries = new Map<string, RepositoryTarget>();
  private revision = 0;

  constructor(
    storage: string | undefined,
    private readonly sourceKey: string,
  ) {
    if (storage) this.file = path.join(storage, 'data.json');
  }

  get targets(): ReadonlyMap<string, RepositoryTarget> {
    return this.entries;
  }

  async reload(): Promise<boolean> {
    if (!this.file) return false;
    const revision = ++this.revision;
    const { repositoryAssignments } = await readData(this.file);
    const saved = isRecord(repositoryAssignments)
      ? repositoryAssignments[this.sourceKey]
      : undefined;
    const entries = new Map<string, RepositoryTarget>();
    for (const [id, value] of Object.entries(isRecord(saved) ? saved : {})) {
      const target = readTarget(value);
      if (/^[a-z0-9_-]{8,128}$/i.test(id) && target) entries.set(id, target);
    }
    if (revision !== this.revision) return false;
    const changed =
      entries.size !== this.entries.size ||
      [...entries].some(
        ([id, target]) => JSON.stringify(this.entries.get(id)) !== JSON.stringify(target),
      );
    if (changed) this.entries = entries;
    return changed;
  }

  async set(id: string, target?: RepositoryTarget): Promise<void> {
    if (this.file) {
      await mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
      const lock = `${this.file}.lock`;
      const release = await lockData(lock);
      const temporary = `${this.file}.${randomUUID()}.tmp`;
      try {
        const data = await readData(this.file);
        const assignments = isRecord(data.repositoryAssignments) ? data.repositoryAssignments : {};
        const previous = assignments[this.sourceKey];
        const source = isRecord(previous) ? { ...previous } : {};
        if (target) source[id] = target;
        else delete source[id];
        if (Object.keys(source).length) assignments[this.sourceKey] = source;
        else delete assignments[this.sourceKey];
        data.repositoryAssignments = assignments;
        await writeFile(temporary, JSON.stringify(data, null, 2) + '\n', {
          flag: 'wx',
          mode: 0o600,
        });
        await rename(temporary, this.file);
      } finally {
        await rm(temporary, { force: true }).catch(() => {});
        await release();
      }
    }
    this.revision++;
    if (target) this.entries.set(id, target);
    else this.entries.delete(id);
  }
}
