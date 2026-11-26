import { execFile } from 'node:child_process';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

export interface WorkspaceRepository {
  key: string;
  root: string;
}

export type GitDirectory = { kind: 'git'; root: string; common: string };
export type Directory = GitDirectory | { kind: 'folder' | 'unknown' };
export type RepositoryTarget =
  | GitDirectory
  | { kind: 'remote'; remote: string; githubKey?: string };

const exec = promisify(execFile);
const gitOptions = {
  encoding: 'utf8',
  timeout: 3_000,
  maxBuffer: 64 * 1024,
  windowsHide: true,
} as const;

/** Normalize network remotes without retaining URL credentials, queries, or fragments. */
export function repositoryKey(remote: string): string | undefined {
  let address = remote.trim();
  if (!address.includes('://')) {
    if (/^[a-z]:/i.test(address)) return undefined;
    const scp = /^(?:[^@/:\s]+@)?(\[[^\]]+\]|[^@/:\s]+):([^?#]+)$/.exec(address);
    if (!scp) return undefined;
    address = `ssh://${scp[1]}/${scp[2]}`;
  }
  try {
    const url = new URL(address);
    if (!url.hostname || !['http:', 'https:', 'ssh:', 'git:'].includes(url.protocol))
      return undefined;
    const host = url.hostname.toLowerCase();
    const defaultPort = url.protocol === 'ssh:' ? '22' : url.protocol === 'git:' ? '9418' : '';
    const port = url.port && url.port !== defaultPort ? `:${url.port}` : '';
    const path = url.pathname.replace(/^\/+|\/+$/g, '');
    const name = (host === 'github.com' ? path.toLowerCase() : path).replace(/\.git$/, '');
    return name ? `${host}${port}/${name}` : undefined;
  } catch {
    return undefined;
  }
}

async function git(folder: string, ...args: string[]): Promise<string> {
  try {
    const { stdout } = await exec('git', ['-C', folder, ...args], gitOptions);
    return stdout.replace(/\r?\n$/, '');
  } catch {
    return '';
  }
}

export async function inspectDirectory(folder: string): Promise<Directory> {
  try {
    if (!(await stat(folder)).isDirectory()) return { kind: 'unknown' };
    const { stdout } = await exec(
      'git',
      ['-C', folder, 'rev-parse', '--show-toplevel', '--git-common-dir'],
      { ...gitOptions, env: { ...process.env, LC_ALL: 'C' } },
    );
    const lines = stdout.replace(/\r?\n$/, '').split(/\r?\n/);
    const [root, common] = lines;
    if (lines.length !== 2 || !root || !common) return { kind: 'unknown' };
    const commonPath = path.resolve(folder, common);
    return {
      kind: 'git',
      root: path.basename(commonPath) === '.git' ? path.dirname(commonPath) : root,
      common: commonPath,
    };
  } catch (error) {
    const stderr = (error as { stderr?: unknown } | null)?.stderr;
    return {
      kind:
        typeof stderr === 'string' && stderr.includes('not a git repository')
          ? 'folder'
          : 'unknown',
    };
  }
}

async function repositoryRemotes(folder: string): Promise<(string | undefined)[]> {
  const remotes = await Promise.all([
    git(folder, 'remote', 'get-url', 'origin'),
    git(folder, 'remote', 'get-url', 'upstream'),
  ]);
  return remotes.map(repositoryKey);
}

export async function projectNameForDirectory(folder: string): Promise<string> {
  const directory = await inspectDirectory(folder);
  if (directory.kind !== 'git') return path.basename(folder);
  const [origin, upstream] = await repositoryRemotes(folder);
  const remote = origin ?? upstream;
  return remote ? path.posix.basename(remote) : path.basename(directory.root);
}

export async function findRepositories(
  folders: string[],
): Promise<Map<string, WorkspaceRepository>> {
  const roots = new Set(
    await Promise.all(folders.map((folder) => git(folder, 'rev-parse', '--show-toplevel'))),
  );
  roots.delete('');
  const matches = new Map<string, WorkspaceRepository>();
  const upstreams: [string, WorkspaceRepository][] = [];
  for (const root of roots) {
    const [origin, upstream] = await repositoryRemotes(root);
    const key = origin ?? upstream;
    if (!key) continue;
    const repository = { key, root };
    if (origin && !matches.has(origin)) matches.set(origin, repository);
    if (upstream) upstreams.push([upstream, repository]);
  }
  // Prefer a repository's own origin when the same remote is another repository's upstream.
  for (const [key, repository] of upstreams) {
    if (!matches.has(key)) matches.set(key, repository);
  }
  return matches;
}
