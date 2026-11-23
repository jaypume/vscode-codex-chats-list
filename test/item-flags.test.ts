import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from 'vitest';
import { ItemFlags } from '../src/item-flags';

test('two windows share independent pin changes and a fresh window restores them', async () => {
  const storage = await mkdtemp(path.join(os.tmpdir(), 'codex-chats-pins-'));
  try {
    const first = new ItemFlags(storage, 'pins-v1');
    const second = new ItemFlags(storage, 'pins-v1');
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
    const fresh = new ItemFlags(storage, 'pins-v1');
    await fresh.reload();
    expect(fresh.has('project', 'remote:github.com/team/app')).toBe(false);
    expect(fresh.has('chat', 'thread-older')).toBe(true);
  } finally {
    await rm(storage, { recursive: true, force: true });
  }
});

test('hiding and restoring an item leaves its pin intact', async () => {
  const storage = await mkdtemp(path.join(os.tmpdir(), 'codex-chats-flags-'));
  try {
    const id = 'thread-example';
    const pins = new ItemFlags(storage, 'pins-v1');
    const hidden = new ItemFlags(storage, 'hidden-v1');
    await Promise.all([pins.set('chat', id, true), hidden.set('chat', id, true)]);
    const otherWindow = new ItemFlags(storage, 'hidden-v1');
    await otherWindow.reload();
    expect(otherWindow.has('chat', id)).toBe(true);
    await otherWindow.set('chat', id, false);
    await hidden.reload();
    expect(hidden.has('chat', id)).toBe(false);
    expect(pins.has('chat', id)).toBe(true);
  } finally {
    await rm(storage, { recursive: true, force: true });
  }
});
