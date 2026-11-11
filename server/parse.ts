// Parsers for the Firstmate home's read-only state records. They mirror the
// grammar in Firstmate's bin/fm-classify-lib.sh (verb, note, key, stamp, and
// the open-decision fold) so a thread shows the same open decisions that
// fm-send.sh --resolve-key will accept. Current-state classification is not
// reimplemented here: the badge comes from fm-crew-state.sh.

import type { FirstmateNote } from '../shared/types.ts';

const SLUG = /^[A-Za-z0-9._-]+$/;
const CORR_TOKEN = /^corr=[0-9A-Fa-f]{16}$/;
const RESERVED_KEY_PREFIXES = ['pending-reply-'];

export interface StatusLine {
  index: number;
  raw: string;
  verb: string;
  // The stated key, "default" for a keyless line, or null when the stated
  // slug is malformed (such a line never moves a decision).
  key: string | null;
  // True when the line itself carried a [key=...] token.
  keyed: boolean;
  // Epoch milliseconds from a well-formed [at=<epoch-seconds>] stamp.
  at: number | null;
  text: string;
}

// Remove each [at=...] run that sits before the line's first colon, so a
// readable stamp such as [at=10:30] cannot move the head/note separator.
export function unstamp(line: string): string {
  let rest = line;
  let keep = '';
  for (;;) {
    const open = rest.indexOf('[at=');
    if (open < 0) break;
    const close = rest.indexOf(']', open);
    if (close < 0) break;
    const before = rest.slice(0, open);
    if (before.includes(':')) break;
    keep += before.replace(/ $/, '');
    rest = rest.slice(close + 1);
  }
  return keep + rest;
}

export function statusAtEpoch(raw: string): number | null {
  const colon = raw.indexOf(':');
  if (colon < 0) return null;
  const head = raw.slice(0, colon);
  const first = head.indexOf('[at=');
  if (first < 0) return null;
  const rest = head.slice(first + 4);
  const close = rest.indexOf(']');
  if (close < 0) return null;
  if (rest.slice(close + 1).includes('[at=')) return null;
  const value = rest.slice(0, close);
  if (!/^(0|[1-9]\d{0,11})$/.test(value)) return null;
  return Number(value) * 1000;
}

export function statusVerb(raw: string): string {
  let v = raw.split(':', 1)[0];
  const bracket = v.indexOf('[');
  if (bracket >= 0) v = v.slice(0, bracket);
  v = v.trim();
  if (!v.includes('corr=')) return v;
  const words = v.split(/\s+/);
  return [words[0], ...words.slice(1).filter((w) => !CORR_TOKEN.test(w))].join(' ');
}

function keyBeforeColon(unstamped: string): string | null {
  const head = unstamped.split(':', 1)[0];
  const m = /\[key=([^\]]*)\]/.exec(head);
  return m ? m[1] : null;
}

function keyAtNoteHead(unstamped: string): string | null {
  const colon = unstamped.indexOf(':');
  if (colon < 0) return null;
  const m = /^\[key=([^\]]*)\]/.exec(unstamped.slice(colon + 1).trimStart());
  return m ? m[1] : null;
}

export function statusNote(raw: string): string {
  const unstamped = unstamp(raw);
  const colon = unstamped.indexOf(':');
  if (colon < 0) return unstamped;
  let note = unstamped.slice(colon + 1).trimStart();
  if (keyBeforeColon(unstamped) === null) {
    const k = keyAtNoteHead(unstamped);
    if (k !== null && SLUG.test(k)) note = note.slice(`[key=${k}]`.length).trimStart();
  }
  return note;
}

export function parseStatusLine(raw: string, index = 0): StatusLine {
  const unstamped = unstamp(raw);
  const stated = keyBeforeColon(unstamped) ?? keyAtNoteHead(unstamped);
  let key: string | null;
  if (stated === null) key = 'default';
  else key = SLUG.test(stated) ? stated : null;
  return {
    index,
    raw,
    verb: statusVerb(raw),
    key,
    keyed: stated !== null,
    at: statusAtEpoch(raw),
    text: statusNote(raw).trimEnd(),
  };
}

export type TaskKind = 'ship' | 'scout' | 'secondmate' | 'unknown';

export function taskKind(meta: Record<string, string> | null): TaskKind {
  if (meta === null) return 'unknown';
  const k = meta.kind ?? 'ship';
  return k === 'ship' || k === 'scout' || k === 'secondmate' ? k : 'unknown';
}

export interface OpenDecision {
  key: string;
  verb: string;
  // Index of the status line that currently holds the decision open.
  line: number;
}

// What became of a line that opened a decision: still open, resolved (or
// handed to the captain) by line `by`, closed by a ship/scout done/failed
// line `by`, or replaced by a later line `by` that opened the same key again.
export interface DecisionFate {
  state: 'open' | 'resolved' | 'closed-by-result' | 'replaced';
  by: number | null;
}

export interface StatusLog {
  lines: StatusLine[];
  open: Map<string, OpenDecision>;
  fates: Map<number, DecisionFate>;
}

function transitionAllowed(key: string, note: string): boolean {
  for (const prefix of RESERVED_KEY_PREFIXES) {
    if (key.startsWith(prefix)) return note.startsWith(prefix) && note.includes(':');
  }
  return true;
}

// A needs-decision or blocked line opens its key (keyless lines share the key
// "default"); a later resolved or captain-held line for the key closes it. A
// ship or scout done/failed declaration supersedes every open decision.
export function parseStatusLog(content: string, kind: TaskKind = 'ship'): StatusLog {
  const rawLines = content.split('\n');
  if (rawLines.length && rawLines[rawLines.length - 1] === '') rawLines.pop();
  const lines: StatusLine[] = [];
  const open = new Map<string, OpenDecision>();
  const fates = new Map<number, DecisionFate>();
  rawLines.forEach((raw, i) => {
    if (raw.trim() === '') return;
    const line = parseStatusLine(raw, i);
    lines.push(line);
    const unstamped = unstamp(raw);
    const hasColon = unstamped.includes(':');
    if (!hasColon && !/\[key=[^\]]*\]/.test(unstamped)) return;
    if (hasColon && (line.verb === 'done' || line.verb === 'failed') && (kind === 'ship' || kind === 'scout')) {
      for (const d of open.values()) fates.set(d.line, { state: 'closed-by-result', by: i });
      open.clear();
      return;
    }
    const opens = line.verb === 'needs-decision' || line.verb === 'blocked';
    const closes = line.verb === 'resolved' || line.verb === 'captain-held';
    if (!opens && !closes) return;
    if (line.key === null || !transitionAllowed(line.key, statusNote(raw))) return;
    const prev = open.get(line.key);
    if (prev) fates.set(prev.line, { state: opens ? 'replaced' : 'resolved', by: i });
    open.delete(line.key);
    if (opens) {
      open.set(line.key, { key: line.key, verb: line.verb, line: i });
      fates.set(i, { state: 'open', by: null });
    }
  });
  return { lines, open, fates };
}

export function parseMeta(content: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of content.split('\n')) {
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    out[line.slice(0, eq).trim()] = line.slice(eq + 1);
  }
  return out;
}

export interface InboxMessage {
  headers: Record<string, string>;
  at: number | null;
  body: string;
}

export function parseInboxMessage(content: string): InboxMessage {
  const lines = content.split('\n');
  const sep = lines.indexOf('--');
  if (sep < 0) return { headers: {}, at: null, body: content };
  const headers: Record<string, string> = {};
  for (const line of lines.slice(0, sep)) {
    const eq = line.indexOf('=');
    if (eq > 0) headers[line.slice(0, eq)] = line.slice(eq + 1);
  }
  let body = lines.slice(sep + 1).join('\n');
  // body-terminator=1 marks exactly one synthetic final newline added by the
  // writer; any other trailing newlines are part of the message.
  if (headers['body-terminator'] === '1' && body.endsWith('\n')) body = body.slice(0, -1);
  const parsed = headers.at ? Date.parse(headers.at) : NaN;
  return { headers, at: Number.isNaN(parsed) ? null : parsed, body };
}

export function inboxSeq(fileName: string): number | null {
  const m = /^(\d+)\.msg$/.exec(fileName);
  return m ? Number(m[1]) : null;
}

export interface ProjectLine {
  name: string;
  mode: string;
  description: string;
}

// Lines shaped `- <name> [<mode>] - <desc>` in data/projects.md.
export function parseProjects(md: string): ProjectLine[] {
  const out: ProjectLine[] = [];
  for (const line of md.split('\n')) {
    const m = /^- (\S+) \[([^\]]+)\] - (.*)$/.exec(line.trimEnd());
    if (m) out.push({ name: m[1], mode: m[2], description: m[3] });
  }
  return out;
}

interface RawNote {
  id?: unknown;
  at?: unknown;
  body?: unknown;
  request_id?: unknown;
  acknowledged?: unknown;
  announced?: unknown;
  reply?: { at?: unknown; body?: unknown } | null;
}

function isoMs(v: unknown): number | null {
  if (typeof v !== 'string') return null;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : t;
}

// Notes from `fm-inbox.sh receipts` JSON (schema fm-inbox-receipts.v1),
// oldest first.
export function parseReceipts(json: string): FirstmateNote[] {
  const data = JSON.parse(json) as { pending?: RawNote[]; handled?: RawNote[] };
  const notes = [...(data.pending ?? []), ...(data.handled ?? [])]
    .filter((n) => typeof n.id === 'string')
    .map((n) => ({
      id: n.id as string,
      requestId: typeof n.request_id === 'string' ? n.request_id : null,
      at: isoMs(n.at),
      body: typeof n.body === 'string' ? n.body : '',
      acknowledged: n.acknowledged === true,
      announced: n.announced === true ? true : n.announced === false ? false : null,
      reply: n.reply && typeof n.reply.body === 'string' ? { at: isoMs(n.reply.at), body: n.reply.body } : null,
    }));
  const seen = new Set<string>();
  return notes
    .filter((n) => (seen.has(n.id) ? false : (seen.add(n.id), true)))
    .sort((a, b) => (a.at ?? 0) - (b.at ?? 0) || a.id.localeCompare(b.id));
}

export interface BacklogTask {
  id: string;
  state: string;
  kind: string;
  repo: string;
  title: string;
  created: string;
  closed: string;
  held: boolean;
  holdKind: string | null;
  holdReason: string | null;
  blocked: boolean;
  blockedBy: string | null;
  links: string | null;
}

// One row of tasks-axi's list output: comma-separated, strings quoted with
// JSON-style escapes.
function splitRow(row: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i <= row.length) {
    if (row[i] === '"') {
      let j = i + 1;
      while (j < row.length && row[j] !== '"') j += row[j] === '\\' ? 2 : 1;
      const raw = row.slice(i, j + 1);
      let v: string;
      try {
        v = JSON.parse(raw) as string;
      } catch {
        v = raw.slice(1, -1);
      }
      out.push(v);
      i = j + 2;
    } else {
      const j = row.indexOf(',', i);
      const end = j < 0 ? row.length : j;
      out.push(row.slice(i, end));
      i = end + 1;
    }
  }
  return out;
}

const dash = (v: string | undefined) => (v === undefined || v === '-' || v === 'none' || v === '' ? null : v);

// `fm-tasks-axi.sh list --fields created,closed,held,hold_kind,hold_reason,blocked,blocked_by,links`
export function parseTaskList(output: string): BacklogTask[] {
  const lines = output.split('\n');
  const head = lines.findIndex((l) => /^tasks\[\d+\]\{/.test(l.trim()));
  if (head < 0) return [];
  const cols = /\{([^}]*)\}/.exec(lines[head])![1].split(',');
  const out: BacklogTask[] = [];
  for (const line of lines.slice(head + 1)) {
    if (!line.startsWith('  ') || line.trim() === '') break;
    const cells = splitRow(line.trim());
    const get = (c: string) => cells[cols.indexOf(c)];
    if (!get('id')) continue;
    out.push({
      id: get('id'),
      state: get('state') ?? '',
      kind: get('kind') ?? '',
      repo: get('repo') ?? '',
      title: (get('title') ?? '').replace(/\n\.\.\. \(truncated[^)]*\)$/, '...').replace(/\s+/g, ' ').trim(),
      created: get('created') ?? '',
      closed: get('closed') ?? '',
      held: get('held') === 'yes',
      holdKind: dash(get('hold_kind')),
      holdReason: dash(get('hold_reason')),
      blocked: get('blocked') === 'yes',
      blockedBy: dash(get('blocked_by')),
      links: dash(get('links')),
    });
  }
  return out;
}

// "New worker request - project: <name>. <text>" notes sent from the app.
export function parseWorkerRequest(body: string): { project: string; text: string } | null {
  const m = /^New worker request - project: (.+?)\. ([\s\S]*)$/.exec(body);
  return m ? { project: m[1], text: m[2] } : null;
}

export type CrewState = 'working' | 'parked' | 'done' | 'blocked' | 'paused' | 'failed' | 'unknown';

const CREW_STATES: CrewState[] = ['working', 'parked', 'done', 'blocked', 'paused', 'failed', 'unknown'];

export function crewStateOf(firstLine: string): CrewState | null {
  const m = /^state:\s*([a-z-]+)/.exec(firstLine.trim());
  if (!m) return null;
  return (CREW_STATES as string[]).includes(m[1]) ? (m[1] as CrewState) : null;
}

export function badgeFor(state: CrewState | null): 'needs-you' | 'working' | 'ready' | 'stopped' {
  switch (state) {
    case 'parked':
    case 'blocked':
      return 'needs-you';
    case 'working':
    case 'paused':
      return 'working';
    case 'done':
      return 'ready';
    default:
      return 'stopped';
  }
}

// Pull the title out of `fm-tasks-axi.sh show <id> --full` output. A missing
// task prints an error block with no title line, so the caller falls back.
export function parseTaskTitle(output: string): string | null {
  const m = /^\s*title:\s*(.*)$/m.exec(output);
  if (!m) return null;
  let v = m[1].trim();
  if (v.startsWith('"') && v.endsWith('"') && v.length >= 2) {
    try {
      v = JSON.parse(v) as string;
    } catch {
      v = v.slice(1, -1);
    }
  }
  v = v.replace(/\s+/g, ' ').trim();
  return v === '' || v === '-' ? null : v;
}
