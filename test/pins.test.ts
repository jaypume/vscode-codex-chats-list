import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from 'vitest';
import { Pins } from '../src/pins';

test('two windows share independent pin changes and a fresh window restores them', async () => {
  const storage = await mkdtemp(path.join(os.tmpdir(), 'codex-chats-pins-'));
  try {
    const first = new Pins(storage);
    const second = new Pins(storage);
    expect(await first.reload()).toBe(false);
    await Promise.all([
      first.set('project', 'remote:github.com/team/app', true),
      second.set('chat', 'thread-older', true),
    ]);
    expect(await first.reload()).toBe(true);
    expect(first.has('chat', 'thread-older')).toBe(true);
    expect(await second.reload()).toBe(true);
    expect(second.has('project', 'remote:github.com/team/app')).toBe(true);
    await second.set('project', 'remote:github.com/team/app', false);
    const fresh = new Pins(storage);
    await fresh.reload();
    expect(fresh.has('project', 'remote:github.com/team/app')).toBe(false);
    expect(fresh.has('chat', 'thread-older')).toBe(true);
  } finally {
    await rm(storage, { recursive: true, force: true });
  }
});
