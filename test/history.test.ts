import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import type { CodexClient } from '../src/client';
import { ConversationHistory } from '../src/history';
import { openHistoryStore } from '../src/history-store';
import type { Chat, ChatPage } from '../src/model';

function chat(id: string, recencyAt = 1): Chat {
  return { id, title: id, cwd: '/history/app', recencyAt, repository: 'github.com/example/app' };
}

afterEach(() => { vi.restoreAllMocks(); });

test('shared cursors and leases prevent duplicate scans, including interrupted writers', async () => {
  const folder = await mkdtemp(path.join(tmpdir(), 'codex-chats-index-'));
  const first = await openHistoryStore(folder, 'first-source');
  const second = await openHistoryStore(folder, 'first-source');
  const other = await openHistoryStore(folder, 'other-source');
  const now = vi.spyOn(Date, 'now').mockReturnValue(100_000);
  try {
    expect(first.persistent).toBe(true);
    expect(first.claim('writer-a')).toBe(true);
    expect(second.claim('writer-b')).toBe(false);
    expect(first.commit('writer-a', [chat('thread-first')], 100_000, {
      cursor: 'next', complete: false, head: 1, checkedAt: 100_000,
    })).toBe(true);
    expect(second.progress().cursor).toBe('next');
    expect(second.rows().map(row => row.id)).toEqual(['thread-first']);
    expect(other.rows()).toEqual([]);
    now.mockReturnValue(170_000);
    expect(second.claim('writer-b')).toBe(true);
    first.release('writer-a');
    expect(first.commit('writer-a', [chat('thread-stale')], 100_001)).toBe(false);
    expect(second.commit('writer-b', [chat('thread-second')], 170_000, {
      cursor: null, complete: true, head: 1, checkedAt: 100_000,
    })).toBe(true);
    expect(first.progress().complete).toBe(true);
    expect(first.rows().map(row => row.id)).toEqual(['thread-first', 'thread-second']);
  } finally {
    first.close(); second.close(); other.close();
    await rm(folder, { recursive: true, force: true });
  }
});

test('a scan started before archiving cannot restore the cached row', async () => {
  const folder = await mkdtemp(path.join(tmpdir(), 'codex-chats-index-'));
  const store = await openHistoryStore(folder, 'source');
  try {
    const thread = chat('thread-archive');
    expect(store.claim('scan')).toBe(true);
    store.update(thread, 20, false);
    expect(store.commit('scan', [thread], 10)).toBe(true);
    expect(store.rows()).toEqual([]);
    store.update(thread, 30, true);
    expect(store.rows()).toEqual([thread]);
  } finally { store.close(); await rm(folder, { recursive: true, force: true }); }
});

test('backfill advances across windows and a later sync only scans the recent boundary', async () => {
  const folder = await mkdtemp(path.join(tmpdir(), 'codex-chats-index-'));
  const firstPage = { chats: [chat('thread-head', 100)], nextCursor: 'older' };
  const oldPage = { chats: [chat('thread-older', 70)], nextCursor: null };
  const list = vi.fn<(...args: [undefined, string, string | null]) => Promise<ChatPage>>()
    .mockResolvedValueOnce(firstPage).mockResolvedValueOnce(oldPage);
  const client = () => ({ historySource: async () => '/codex', list, dispose() {} }) as unknown as CodexClient;
  const now = vi.spyOn(Date, 'now').mockReturnValue(100_000);
  const first = await ConversationHistory.open(client(), folder);
  const second = await ConversationHistory.open(client(), folder);
  try {
    await first.step(() => true);
    expect(second.rows()).toEqual(firstPage.chats);
    expect(second.complete).toBe(false);
    await second.step(() => true);
    expect(first.complete).toBe(true);
    await first.step(() => true);
    expect(list.mock.calls.map(args => args[2])).toEqual([null, 'older']);
    list.mockResolvedValueOnce({ chats: [chat('thread-new', 102), chat('thread-head', 100)], nextCursor: 'boundary' })
      .mockResolvedValueOnce({ chats: [chat('thread-tie', 100), chat('thread-older', 70)], nextCursor: 'untouched' });
    now.mockReturnValue(106_000);
    await second.step(() => true);
    expect(list.mock.calls.map(args => args[2])).toEqual([null, 'older', null, 'boundary']);
    expect(first.rows().map(row => row.id)).toEqual(['thread-head', 'thread-new', 'thread-older', 'thread-tie']);
  } finally { first.dispose(); second.dispose(); await rm(folder, { recursive: true, force: true }); }
});
