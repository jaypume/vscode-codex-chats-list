import { mkdir, open } from 'node:fs/promises';
import path from 'node:path';
import type * as Sqlite from 'node:sqlite';
import type { Directory } from './git';
import type { Chat } from './model';

const LEASE_MS = 60_000;

export interface HistoryProgress {
  cursor: string | null;
  complete: boolean;
  head: number;
  checkedAt: number;
}

export interface HistoryStore {
  readonly persistent: boolean;
  progress(): HistoryProgress;
  rows(): Chat[];
  claim(token: string): boolean;
  commit(token: string, chats: Chat[], observedAt: number, progress?: HistoryProgress): boolean;
  release(token: string): void;
  update(chat: Chat, observedAt: number, available: boolean): void;
  close(): void;
}

const emptyProgress: HistoryProgress = { cursor: null, complete: false, head: 0, checkedAt: 0 };

class MemoryStore implements HistoryStore {
  readonly persistent = false;
  private state = emptyProgress;
  private records = new Map<string, { chat: Chat; observedAt: number; available: boolean }>();
  private token?: string;

  progress() { return this.state; }
  rows() { return Array.from(this.records.values()).filter(row => row.available).map(row => row.chat); }
  claim(token: string) {
    if (this.token) return false;
    this.token = token;
    return true;
  }

  commit(token: string, chats: Chat[], observedAt: number, progress?: HistoryProgress) {
    if (this.token !== token) return false;
    for (const chat of chats) this.update(chat, observedAt, true);
    if (progress) this.state = progress;
    return true;
  }

  release(token: string) { if (this.token === token) this.token = undefined; }
  update(chat: Chat, observedAt: number, available: boolean) {
    if ((this.records.get(chat.id)?.observedAt ?? 0) <= observedAt) {
      this.records.set(chat.id, { chat, observedAt, available });
    }
  }
  close() { this.records.clear(); }
}

const schema = `
  PRAGMA busy_timeout = 300;
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS history_source (
    source_key TEXT PRIMARY KEY,
    backfill_cursor TEXT,
    backfill_done INTEGER NOT NULL DEFAULT 0 CHECK (backfill_done IN (0, 1)),
    head_recency INTEGER NOT NULL DEFAULT 0,
    checked_at INTEGER NOT NULL DEFAULT 0,
    lease_token TEXT,
    lease_until INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS history_thread (
    source_key TEXT NOT NULL REFERENCES history_source (source_key) ON DELETE CASCADE,
    thread_id TEXT NOT NULL,
    title TEXT NOT NULL,
    cwd TEXT NOT NULL,
    recency_at INTEGER NOT NULL,
    repository TEXT,
    has_git INTEGER NOT NULL CHECK (has_git IN (0, 1)),
    directory TEXT,
    observed_at INTEGER NOT NULL,
    available INTEGER NOT NULL CHECK (available IN (0, 1)),
    PRIMARY KEY (source_key, thread_id)
  );
`;

class SqliteStore implements HistoryStore {
  readonly persistent = true;

  constructor(private readonly db: Sqlite.DatabaseSync, private readonly source: string) {
    db.exec(schema);
    db.prepare('INSERT OR IGNORE INTO history_source (source_key) VALUES (?)').run(source);
  }

  progress(): HistoryProgress {
    const row = this.db.prepare(`
      SELECT backfill_cursor, backfill_done, head_recency, checked_at
      FROM history_source WHERE source_key = ?
    `).get(this.source)!;
    return {
      cursor: typeof row.backfill_cursor === 'string' ? row.backfill_cursor : null,
      complete: row.backfill_done === 1,
      head: Number(row.head_recency),
      checkedAt: Number(row.checked_at),
    };
  }

  rows(): Chat[] {
    return this.db.prepare(`
      SELECT thread_id, title, cwd, recency_at, repository, has_git, directory
      FROM history_thread WHERE source_key = ? AND available = 1
    `).all(this.source).map(row => ({
      id: String(row.thread_id), title: String(row.title), cwd: String(row.cwd), recencyAt: Number(row.recency_at),
      ...(typeof row.repository === 'string' ? { repository: row.repository } : {}),
      ...(row.has_git === 1 ? { hasGit: true as const } : {}),
      ...(typeof row.directory === 'string' ? { directory: JSON.parse(row.directory) as Directory } : {}),
    }));
  }

  claim(token: string): boolean {
    const now = Date.now();
    return this.db.prepare(`
      UPDATE history_source SET lease_token = ?, lease_until = ?
      WHERE source_key = ? AND (lease_token IS NULL OR lease_until <= ?)
    `).run(token, now + LEASE_MS, this.source, now).changes === 1;
  }

  commit(token: string, chats: Chat[], observedAt: number, progress?: HistoryProgress): boolean {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const now = Date.now();
      const claimed = this.db.prepare(`
        UPDATE history_source SET lease_until = ?
        WHERE source_key = ? AND lease_token = ? AND lease_until > ?
      `).run(now + LEASE_MS, this.source, token, now).changes === 1;
      if (claimed) {
        const statement = this.upsert();
        for (const chat of chats) this.write(statement, chat, observedAt, true);
        if (progress) this.db.prepare(`
          UPDATE history_source SET backfill_cursor = ?, backfill_done = ?, head_recency = ?, checked_at = ?
          WHERE source_key = ?
        `).run(progress.cursor, Number(progress.complete), progress.head, progress.checkedAt, this.source);
      }
      this.db.exec('COMMIT');
      return claimed;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  release(token: string): void {
    this.db.prepare(`
      UPDATE history_source SET lease_token = NULL, lease_until = 0 WHERE source_key = ? AND lease_token = ?
    `).run(this.source, token);
  }

  update(chat: Chat, observedAt: number, available: boolean): void {
    this.write(this.upsert(), chat, observedAt, available);
  }

  private upsert() {
    return this.db.prepare(`
      INSERT INTO history_thread (
        source_key, thread_id, title, cwd, recency_at, repository, has_git, directory, observed_at, available
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (source_key, thread_id) DO UPDATE SET
        title = excluded.title, cwd = excluded.cwd, recency_at = excluded.recency_at,
        repository = excluded.repository, has_git = excluded.has_git, directory = excluded.directory,
        observed_at = excluded.observed_at, available = excluded.available
      WHERE excluded.observed_at >= history_thread.observed_at
    `);
  }

  private write(statement: ReturnType<SqliteStore['upsert']>, chat: Chat, observedAt: number, available: boolean) {
    statement.run(this.source, chat.id, chat.title, chat.cwd, chat.recencyAt, chat.repository ?? null,
      Number(Boolean(chat.hasGit)), chat.directory ? JSON.stringify(chat.directory) : null, observedAt, Number(available));
  }

  close(): void { this.db.close(); }
}

export async function openHistoryStore(directory: string | undefined, source: string): Promise<HistoryStore> {
  if (!directory) return new MemoryStore();
  let sqlite: typeof Sqlite;
  try {
    sqlite = require('node:sqlite');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ERR_UNKNOWN_BUILTIN_MODULE') throw error;
    return new MemoryStore();
  }
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const file = path.join(directory, 'history-v1.sqlite');
  await (await open(file, 'a', 0o600)).close();
  const db = new sqlite.DatabaseSync(file);
  try {
    return new SqliteStore(db, source);
  } catch (error) {
    db.close();
    throw error;
  }
}
