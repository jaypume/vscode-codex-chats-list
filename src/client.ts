import { createLocalizer, type Localize } from './i18n';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { homedir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { isRecord, parsePage, type Chat, type ChatPage } from './model';

interface Pending {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const listOptions = {
  archived: false, limit: 50, sortKey: 'recency_at', sortDirection: 'desc',
  sourceKinds: ['vscode', 'cli', 'appServer'], useStateDbOnly: true, modelProviders: [],
};

/** A local stdio client for reading conversation metadata. */
export class CodexClient {
  private process?: ChildProcessWithoutNullStreams;
  private nextId = 0;
  private pending = new Map<number, Pending>();
  private starting?: Promise<void>;
  private codexHome?: string;
  private readonly t: Localize;
  constructor(private readonly binary: string, private readonly version: string, language = 'en') { this.t = createLocalizer(language); }

  private async start(): Promise<void> {
    if (this.starting) return this.starting;
    this.starting = (async () => {
      const child = spawn(this.binary, ['app-server', '--listen', 'stdio://'], {
        stdio: 'pipe', windowsHide: true, env: { ...process.env, RUST_LOG: 'error' },
      });
      this.process = child;
      child.stdin.on('error', () => { if (this.process === child) this.fail(new Error(this.t('errorDisconnected'))); });
      child.stderr.resume(); // Never print protocol diagnostics that may contain local paths or metadata.
      const lines = createInterface({ input: child.stdout });
      lines.on('line', line => {
        try {
          const message: unknown = JSON.parse(line);
          if (!isRecord(message) || typeof message.id !== 'number') return;
          const pending = this.pending.get(message.id);
          if (!pending) return;
          this.pending.delete(message.id);
          clearTimeout(pending.timer);
          if (isRecord(message.error)) {
            pending.reject(Object.assign(
              new Error(typeof message.error.message === 'string' ? message.error.message : this.t('errorRequestFailed')),
              { code: message.error.code },
            ));
          } else pending.resolve(message.result);
        } catch { /* Ignore non-JSON diagnostics; the request timeout remains authoritative. */ }
      });
      child.once('error', () => { if (this.process === child) this.fail(new Error(this.t('errorStartFailed'))); });
      child.once('exit', () => {
        lines.close();
        if (this.process === child) {
          this.process = undefined; this.starting = undefined;
          this.fail(new Error(this.t('errorExited')));
        }
      });
      const initialized = await this.request('initialize', {
        clientInfo: { name: 'codex_chats_list', title: 'Codex Chats List', version: this.version },
      });
      this.codexHome = isRecord(initialized) && typeof initialized.codexHome === 'string' && path.isAbsolute(initialized.codexHome)
        ? initialized.codexHome : undefined;
      child.stdin.write(JSON.stringify({ method: 'initialized', params: {} }) + '\n');
    })();
    try { await this.starting; } catch (error) { this.dispose(); throw error; }
  }

  async historySource(): Promise<string> {
    await this.start();
    return this.codexHome ?? JSON.stringify([this.binary, process.env.CODEX_HOME || path.join(homedir(), '.codex')]);
  }

  private request(method: string, params: Record<string, unknown>): Promise<unknown> {
    const child = this.process;
    if (!child || child.killed || !child.stdin.writable) return Promise.reject(new Error(this.t('errorUnavailable')));
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(this.t('errorTimeout')));
      }, 20_000);
      this.pending.set(id, { resolve, reject, timer });
      child.stdin.write(JSON.stringify({ method, id, params }) + '\n', error => {
        if (!error) return;
        const pending = this.pending.get(id);
        if (pending) { clearTimeout(pending.timer); this.pending.delete(id); pending.reject(new Error(this.t('errorConnectFailed'))); }
      });
    });
  }

  /** Server-side filters apply before pagination; never scan a truncated global list for a project. */
  async list(roots: string[] | undefined, search: string, cursor: string | null): Promise<ChatPage> {
    await this.start();
    const params: Record<string, unknown> = { ...listOptions };
    if (roots !== undefined) {
      if (!roots.length) return { chats: [], nextCursor: null };
      params.cwd = roots;
    }
    if (search.trim()) params.searchTerm = search.trim();
    if (cursor) params.cursor = cursor;
    return parsePage(await this.request('thread/list', params), this.t);
  }

  async checkThread(id: string): Promise<Chat | undefined> {
    await this.start();
    const params = { ...listOptions, limit: 1, includedThreadIds: [id] };
    const active = parsePage(await this.request('thread/list', params), this.t).chats;
    const exact = active.find(chat => chat.id === id);
    if (exact) return exact;
    if (!active.length) {
      const archived = parsePage(await this.request('thread/list', { ...params, archived: true }), this.t).chats;
      if (archived.some(chat => chat.id === id)) return undefined;
    }
    // Some older servers ignore includedThreadIds. Read by ID before discarding the entry.
    try {
      const reply = await this.request('thread/read', { threadId: id, includeTurns: false });
      const chat = parsePage({ data: [isRecord(reply) ? reply.thread : undefined] }, this.t).chats[0];
      if (chat?.id === id) return chat;
      throw new Error(this.t('errorInvalidResponse'));
    } catch (error) {
      const code = (error as { code?: unknown } | null)?.code;
      if ((code === -32600 || code === -32602) && error instanceof Error
        && /no rollout path|thread (?:was )?not found/i.test(error.message)) return undefined;
      throw error;
    }
  }

  private fail(error: Error): void {
    for (const item of this.pending.values()) { clearTimeout(item.timer); item.reject(error); }
    this.pending.clear();
  }

  /** Close only the stdio process owned by this client; never terminate another Codex server. */
  dispose(): void {
    const child = this.process;
    this.process = undefined;
    this.starting = undefined;
    this.fail(new Error(this.t('errorClosed')));
    if (child && child.exitCode === null) {
      child.stdin.end();
      child.kill();
    }
  }
}
