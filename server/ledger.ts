// The app's own record of the messages it sent to workers, so a worker thread
// can tell the user's messages from the supervisor's: the inbox format
// (fm-task-inbox.v1) records no sender. It lives in the app's data folder,
// never under FM_HOME, as an append-only JSON-lines file.
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

interface Entry {
  key: string;
  home: string;
  id: string;
  body: string;
  at: number;
  seq: number | null;
  cancelled: boolean;
}

type Line =
  | { op: 'sent'; key: string; home: string; id: string; body: string; at: number }
  | { op: 'seq'; key: string; seq: number }
  | { op: 'cancel'; key: string };

// An entry without a known sequence claims an inbox record with the same body
// written within this window of the send.
const MATCH_WINDOW_MS = 15 * 60_000;

export class SentLedger {
  private readonly file: string;
  private readonly entries = new Map<string, Entry>();

  constructor(file: string) {
    this.file = file;
    let text = '';
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      return;
    }
    for (const raw of text.split('\n')) {
      if (!raw.trim()) continue;
      try {
        this.apply(JSON.parse(raw) as Line);
      } catch {
        // A torn last line from a crash is skipped.
      }
    }
  }

  private apply(line: Line): void {
    if (line.op === 'sent') {
      this.entries.set(line.key, { key: line.key, home: line.home, id: line.id, body: line.body, at: line.at, seq: null, cancelled: false });
    } else {
      const e = this.entries.get(line.key);
      if (!e) return;
      if (line.op === 'seq') e.seq = line.seq;
      else e.cancelled = true;
    }
  }

  private write(line: Line): void {
    mkdirSync(path.dirname(this.file), { recursive: true });
    appendFileSync(this.file, `${JSON.stringify(line)}\n`, { mode: 0o600 });
    this.apply(line);
  }

  // Recorded before the send script runs, so the record it writes is
  // attributed correctly the moment the page sees it.
  begin(home: string, id: string, body: string, at = Date.now()): string {
    const key = `${at.toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    this.write({ op: 'sent', key, home, id, body, at });
    return key;
  }

  confirm(key: string, seq: number): void {
    this.write({ op: 'seq', key, seq });
  }

  cancel(key: string): void {
    this.write({ op: 'cancel', key });
  }

  // Which of a worker's inbox records the app sent, by sequence number.
  sentSeqs(home: string, id: string, records: Array<{ seq: number; body: string; at: number | null }>): Set<number> {
    const mine = [...this.entries.values()].filter((e) => !e.cancelled && e.home === home && e.id === id);
    const out = new Set<number>();
    for (const e of mine) if (e.seq !== null) out.add(e.seq);
    for (const e of mine) {
      if (e.seq !== null) continue;
      const match = records.find(
        (r) => !out.has(r.seq) && r.body === e.body && r.at !== null && Math.abs(r.at - e.at) <= MATCH_WINDOW_MS,
      );
      if (match) out.add(match.seq);
    }
    return out;
  }
}
