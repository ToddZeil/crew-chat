import type { NoteResult, ThreadSummary, WriteResult } from '../shared/types.ts';

export const FIRSTMATE = '__firstmate__';

export interface Notice {
  id: number;
  tone: 'error' | 'warning';
  title: string;
  result: WriteResult;
}

let noticeSeq = 0;
export function nextNoticeId(): number {
  return ++noticeSeq;
}

export function newRequestId(): string {
  return crypto.randomUUID();
}

export function needsAttention(t: ThreadSummary): boolean {
  return t.badge === 'needs-you' || t.openDecisions > 0;
}

export type GroupKey = 'needs-you' | 'working' | 'queued' | 'done';

export const GROUPS: Array<{ key: GroupKey; label: string }> = [
  { key: 'needs-you', label: 'Needs you' },
  { key: 'working', label: 'Working' },
  { key: 'queued', label: 'Queued' },
  { key: 'done', label: 'Done / stopped' },
];

export function groupOf(t: ThreadSummary): GroupKey {
  if (t.placeholder === 'finished') return 'done';
  if (t.placeholder) return 'queued';
  if (needsAttention(t)) return 'needs-you';
  if (t.badge === 'working' || t.badge === 'checking') return 'working';
  return 'done';
}

// Sections keep their order (Needs you, Working, Queued, Done / stopped);
// inside each, the newest activity comes first.
export function sortThreads(list: ThreadSummary[]): ThreadSummary[] {
  const order = (t: ThreadSummary) => GROUPS.findIndex((g) => g.key === groupOf(t));
  return [...list].sort((a, b) => order(a) - order(b) || (b.lastAt ?? 0) - (a.lastAt ?? 0) || a.title.localeCompare(b.title));
}

export function idFromHash(): string | null {
  if (window.location.hash === '#/firstmate') return FIRSTMATE;
  const m = /^#\/t\/(.+)$/.exec(window.location.hash);
  return m ? decodeURIComponent(m[1]) : null;
}

// Browser storage only holds conveniences (what was read, collapsed
// sections); without it they reset per load.
export function loadJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}

export function saveJson(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // ignore
  }
}

export const PENDING_TEXT =
  'Saved, but First mate has not been told yet. It will see it at its next check, so there is no need to resend.';

export function noteAsWrite(r: NoteResult): WriteResult {
  return {
    ok: r.outcome !== 'refused',
    outcome: r.outcome === 'refused' ? 'refused' : 'sent',
    exitCode: r.exitCode,
    stdout: r.stdout,
    stderr: r.stderr,
    error: r.error,
  };
}

// Must match server/placeholders.ts threadTag.
export function threadTag(id: string): string {
  return `[re: ${id}] `;
}
