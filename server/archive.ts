// crew-chat's own read-only copy of each worker thread, kept as it goes, so a
// worker's history survives its cleanup (which removes its state files). One
// JSON file per thread under the app's data folder, never under FM_HOME.
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { ThreadDetail } from '../shared/types.ts';

export interface Saved {
  id: string;
  savedAt: number;
  detail: ThreadDetail;
}

export class Archive {
  private readonly dir: string;
  private readonly written = new Map<string, string>();

  // Threads are kept per Firstmate home, so two homes never mix.
  constructor(root: string, home: string) {
    this.dir = path.join(root, createHash('sha1').update(path.resolve(home)).digest('hex').slice(0, 12));
  }

  save(detail: ThreadDetail, now = Date.now()): void {
    const id = detail.summary.id;
    const body = JSON.stringify(detail);
    if (this.written.get(id) === body) return;
    mkdirSync(this.dir, { recursive: true });
    const file = path.join(this.dir, `${id}.json`);
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ id, savedAt: now, detail } satisfies Saved), { mode: 0o600 });
    renameSync(tmp, file);
    this.written.set(id, body);
  }

  ids(): string[] {
    try {
      return readdirSync(this.dir)
        .filter((f) => f.endsWith('.json') && f !== 'hidden.json')
        .map((f) => f.slice(0, -'.json'.length));
    } catch {
      return [];
    }
  }

  // Finished threads the user removed from the list. Only crew-chat's view
  // changes; nothing in the Firstmate home is touched.
  hidden(): Set<string> {
    try {
      return new Set(JSON.parse(readFileSync(path.join(this.dir, 'hidden.json'), 'utf8')) as string[]);
    } catch {
      return new Set();
    }
  }

  setHidden(id: string, hide: boolean): void {
    const set = this.hidden();
    if (hide) set.add(id);
    else set.delete(id);
    mkdirSync(this.dir, { recursive: true });
    const file = path.join(this.dir, 'hidden.json');
    writeFileSync(`${file}.tmp`, JSON.stringify([...set].sort()), { mode: 0o600 });
    renameSync(`${file}.tmp`, file);
  }

  load(id: string): Saved | null {
    try {
      const saved = JSON.parse(readFileSync(path.join(this.dir, `${id}.json`), 'utf8')) as Saved;
      return saved.detail?.summary?.id === id ? saved : null;
    } catch {
      return null;
    }
  }
}
