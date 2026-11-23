import { createHash, randomUUID } from 'node:crypto';
import type { CodexClient } from './client';
import { inspectDirectory, type Directory } from './git';
import { openHistoryStore, type HistoryStore } from './history-store';
import { pathKey, type Chat } from './model';

export const HEAD_REFRESH_MS = 5_000;

export class ConversationHistory {
  private readonly directories = new Map<string, Directory>();
  private active = 0;
  private disposed = false;

  private constructor(private readonly client: CodexClient, private readonly store: HistoryStore) {
    for (const chat of store.rows()) {
      if (chat.directory) this.directories.set(pathKey(chat.cwd), chat.directory);
    }
  }

  static async open(client: CodexClient, storage?: string): Promise<ConversationHistory> {
    const source = createHash('sha256').update(await client.historySource()).digest('hex');
    const store = await openHistoryStore(storage, source);
    try { return new ConversationHistory(client, store); }
    catch (error) { store.close(); throw error; }
  }

  get persistent() { return this.store.persistent; }
  get complete() { return this.store.progress().complete; }
  rows() { return this.store.rows(); }

  async step(keepGoing: () => boolean, force = false): Promise<void> {
    if (this.disposed || !keepGoing()) return;
    const before = this.store.progress();
    if (before.complete && !force && Date.now() - before.checkedAt < HEAD_REFRESH_MS) return;
    const token = randomUUID();
    if (!this.store.claim(token)) return;
    this.active++;
    try {
      const progress = this.store.progress();
      const refreshHead = progress.checkedAt !== 0 && (force || Date.now() - progress.checkedAt >= HEAD_REFRESH_MS);
      if (!refreshHead) {
        if (progress.complete) return;
        const observedAt = Date.now();
        const page = await this.client.list(undefined, '', progress.cursor);
        if (this.disposed || !keepGoing()) return;
        const chats = await this.classify(page.chats);
        if (this.disposed || !keepGoing()) return;
        if (page.nextCursor && page.nextCursor === progress.cursor) throw new Error('Codex returned the same history cursor.');
        const first = !progress.checkedAt;
        this.store.commit(token, chats, observedAt, {
          cursor: page.nextCursor,
          complete: !page.nextCursor,
          head: first ? Math.max(0, ...chats.map(chat => chat.recencyAt)) : progress.head,
          checkedAt: first ? Date.now() : progress.checkedAt,
        });
        return;
      }

      let cursor: string | null = null;
      let head = progress.head;
      // Read through the previous boundary second so changes with equal timestamps are not skipped.
      do {
        const observedAt = Date.now();
        const page = await this.client.list(undefined, '', cursor);
        if (this.disposed || !keepGoing()) return;
        const chats = await this.classify(page.chats);
        if (this.disposed || !keepGoing()) return;
        head = Math.max(head, ...chats.map(chat => chat.recencyAt));
        if (page.nextCursor && page.nextCursor === cursor) throw new Error('Codex returned the same history cursor.');
        cursor = page.nextCursor;
        const done = !cursor || !progress.head || chats.some(chat => chat.recencyAt < progress.head);
        if (!this.store.commit(token, chats, observedAt,
          done ? { ...progress, head, checkedAt: Date.now() } : undefined) || done) return;
      } while (cursor);
    } finally {
      try { this.store.release(token); } finally { this.finish(); }
    }
  }

  async verify(chat: Chat): Promise<boolean> {
    if (this.disposed) return false;
    this.active++;
    const observedAt = Date.now();
    try {
      const result = await this.client.checkThread(chat.id);
      if (this.disposed) return false;
      if (!result) {
        this.store.update(chat, observedAt, false);
        return false;
      }
      if (!result.repository) {
        result.directory = await inspectDirectory(result.cwd);
        if (this.disposed) return false;
        this.directories.set(pathKey(result.cwd), result.directory);
      }
      this.store.update(result, observedAt, true);
      return true;
    } finally { this.finish(); }
  }

  async deleteThread(chat: Chat): Promise<void> {
    if (this.disposed) throw new Error('History is closed.');
    this.active++;
    try {
      await this.client.deleteThread(chat.id);
      this.store.update(chat, Date.now(), false);
    } finally { this.finish(); }
  }

  private async classify(chats: Chat[]): Promise<Chat[]> {
    const missing = new Map<string, string>();
    for (const chat of chats) {
      const key = pathKey(chat.cwd);
      if (!chat.repository && !this.directories.has(key)) missing.set(key, chat.cwd);
    }
    const entries = [...missing];
    for (let offset = 0; offset < entries.length; offset += 8) {
      if (this.disposed) break;
      await Promise.all(entries.slice(offset, offset + 8).map(async ([key, cwd]) => {
        const result = await inspectDirectory(cwd);
        this.directories.set(key, result);
      }));
    }
    return chats.map(chat => {
      const directory = !chat.repository && this.directories.get(pathKey(chat.cwd));
      return directory ? { ...chat, directory } : chat;
    });
  }

  private finish() {
    this.active--;
    if (this.disposed && !this.active) this.store.close();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.client.dispose();
    if (!this.active) this.store.close();
  }
}
