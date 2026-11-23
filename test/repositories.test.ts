import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, test, vi } from 'vitest';
import { findRepositories, type WorkspaceRepository } from '../src/git';
import { groupChats, selectChats, type Chat } from '../src/model';
import { RepositoryCatalog } from '../src/repositories';

vi.mock('../src/git', async original => ({
  ...await original<typeof import('../src/git')>(),
  findRepositories: vi.fn<typeof findRepositories>(),
}));

test('a cached GitHub ID merges remote aliases, retains old pins, and prefers a verified checkout', async () => {
  const storage = await mkdtemp(path.join(os.tmpdir(), 'codex-repositories-'));
  try {
    const current = 'github.com/example/wiki';
    const old = 'github.com/example/notes-one';
    const unrelated = 'github.com/elsewhere/wiki';
    const cache = path.join(storage, 'repository-identities-v1');
    const valid = path.join(storage, 'valid');
    const missing = path.join(storage, 'missing');
    await Promise.all([mkdir(cache), mkdir(valid)]);
    for (const [remote, id] of [[old, 123], [current, 123], [unrelated, 456]] as const) {
      const filename = createHash('sha256').update(remote).digest('hex') + '.json';
      await writeFile(path.join(cache, filename), JSON.stringify({
        remote, checkedAt: Date.now(), identity: { id, remote: remote === old ? current : remote },
      }));
    }
    const local = new Map([[current, { key: current, root: valid }]]);
    vi.mocked(findRepositories).mockResolvedValue(local);
    const chat = (id: string, cwd: string, repository: string, recencyAt: number): Chat =>
      ({ id, cwd, repository, recencyAt, title: id });
    const chats = [
      chat('thread-old', missing, old, 3),
      chat('thread-checkout', valid, current, 2),
      chat('thread-unrelated', missing, unrelated, 1),
    ];
    const repository = new RepositoryCatalog(storage);
    await repository.refresh(chats, new Map(), () => true, () => {}, false);
    const workspace = new Map<string, WorkspaceRepository>([[current, { key: current, root: '/workspace/wiki' }]]);
    const view = repository.presentation(chats, workspace);
    expect(view.get(old)).toMatchObject({
      key: 'github:123', remote: current, current: true, checkout: '/workspace/wiki',
      pinAliases: expect.arrayContaining([`remote:${old}`, `remote:${current}`]),
    });
    expect(repository.presentation(chats, new Map()).get(old)?.checkout).toBe(valid);
    expect(repository.presentation([chats[0]!], new Map()).get(old)?.checkout).toBeUndefined();
    const projects = {
      roots: ['/workspace/wiki'], remotes: new Set(workspace.keys()),
      gitDirectories: new Set<string>(), repositoryView: view,
    };
    const filtered = selectChats(chats, projects, 'current', 'repository', true, '');
    expect(filtered.map(item => item.id)).toEqual(['thread-old', 'thread-checkout']);
    const groups = groupChats(chats, [], 'repository', projects);
    expect(groups.map(group => group.key)).toEqual(['github:123', 'github:456']);
    expect(groups[0]?.chats.map(item => item.cwd)).toEqual([missing, valid]);
  } finally {
    await rm(storage, { recursive: true, force: true });
  }
});
