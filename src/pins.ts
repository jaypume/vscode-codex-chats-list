import { createHash } from 'node:crypto';
import { mkdir, open, readdir, rm } from 'node:fs/promises';
import path from 'node:path';

type PinKind = 'project' | 'chat';

function pinKey(kind: PinKind, id: string): string {
  return `${kind}-${createHash('sha256').update(id).digest('hex')}`;
}

/** Keep user preferences independent of the rebuildable history index. */
export class Pins {
  private readonly directory?: string;
  private keys = new Set<string>();
  private revision = 0;

  constructor(storage?: string) {
    if (storage) this.directory = path.join(storage, 'pins-v1');
  }

  has(kind: PinKind, id: string): boolean {
    return this.keys.size > 0 && this.keys.has(pinKey(kind, id));
  }

  async reload(): Promise<boolean> {
    if (!this.directory) return false;
    const revision = ++this.revision;
    const files = await readdir(this.directory).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return [];
      throw error;
    });
    if (revision !== this.revision) return false;
    const keys = new Set(files.filter((file) => /^(project|chat)-[a-f0-9]{64}$/.test(file)));
    const changed = keys.size !== this.keys.size || [...keys].some((key) => !this.keys.has(key));
    this.keys = keys;
    return changed;
  }

  async set(kind: PinKind, id: string, pinned: boolean): Promise<void> {
    const key = pinKey(kind, id);
    if (this.directory) {
      const file = path.join(this.directory, key);
      if (pinned) {
        await mkdir(this.directory, { recursive: true, mode: 0o700 });
        const marker = await open(file, 'a', 0o600);
        await marker.close();
      } else {
        await rm(file, { force: true });
      }
    }
    this.revision++;
    if (pinned) this.keys.add(key);
    else this.keys.delete(key);
  }
}
