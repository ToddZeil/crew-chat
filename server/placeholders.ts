// Threads for work that has no live worker yet, built from First mate's
// backlog and its note inbox (both read-only):
//   queued     a backlog task queued or in flight with no state/<id>.meta;
//   requested  a New worker request note no task or worker has taken up yet.
// Notes the user sends from such a thread carry a "[re: <thread id>] " tag, so
// the planning conversation stays in that thread.
import type { ChatItem, FirstmateNote, IncomingItem, OutgoingItem, ThreadDetail, ThreadSummary } from '../shared/types.ts';
import { parseWorkerRequest, type BacklogTask } from './parse.ts';

const DAY = 86_400_000;
// A held task this recent is still shown; older held ones are parked
// decisions, not work in progress.
const RECENT_HELD_MS = 3 * DAY;
// A request First mate has read but no task took up stays visible while its
// conversation is active, so the reply (declined, blocked, a question, a plan
// being discussed) can be read and answered in its thread.
const REQUEST_ACTIVE_MS = 6 * 60 * 60_000;

export const REQUEST_PREFIX = 'request-';

export function threadTag(id: string): string {
  return `[re: ${id}] `;
}

function taggedFor(n: FirstmateNote, ids: string[]): boolean {
  return ids.some((id) => n.body.startsWith(threadTag(id)));
}

function stripTag(body: string): string {
  return body.replace(/^\[re: [^\]]+\] /, '');
}

export function requestLines(text: string): { model: string | null; effort: string | null; planning: boolean } {
  const get = (k: string) => new RegExp(`^${k}: (\\S+)$`, 'm').exec(text)?.[1] ?? null;
  return { model: get('Model'), effort: get('Effort'), planning: get('Planning') === 'yes' };
}

interface Request {
  note: FirstmateNote;
  project: string;
  text: string;
}

export interface Placeholder {
  id: string;
  kind: 'queued' | 'requested';
  task: BacklogTask | null;
  requests: Request[];
}

function dayMs(day: string): number | null {
  const t = Date.parse(`${day}T00:00:00Z`);
  return Number.isNaN(t) ? null : t;
}

function createdMs(task: BacklogTask): number | null {
  return dayMs(task.created);
}

const STOP = new Set(
  'the and for from with that this into onto then than what when where which while have has had was were are can could should would will just also only make made check see about there their them they your yours our its it not but all any each new worker request project model effort planning auto yes'.split(' '),
);

export function words(text: string): Set<string> {
  const out = new Set<string>();
  for (const raw of text.toLowerCase().replace(/[‘’']s\b/g, '').split(/[^a-z0-9]+/)) {
    if (raw.length < 3 || STOP.has(raw) || /^\d+$/.test(raw)) continue;
    out.add(raw.replace(/(ing|ed|es|s)$/, ''));
  }
  return out;
}

// How many key words a request and a task title share.
export function overlap(a: Set<string>, b: Set<string>): number {
  let n = 0;
  for (const w of a) if (b.has(w)) n++;
  return n;
}

function sameProject(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

export interface Built {
  placeholders: Placeholder[];
  // Requests taken up by a live worker, so its thread keeps the planning chat.
  liveLinks: Map<string, Request[]>;
  // Requests taken up by any task or worker, by its id.
  links: Map<string, Request[]>;
}

export function buildPlaceholders(
  tasks: BacklogTask[],
  notes: FirstmateNote[],
  live: Array<{ id: string; project: string | null; spawnedAt: number | null; title: string | null }>,
  now: number,
): Built {
  const liveIds = new Set(live.map((l) => l.id));
  const requests: Request[] = [];
  for (const note of notes) {
    const r = parseWorkerRequest(note.body);
    if (r) requests.push({ note, project: r.project, text: r.text });
  }
  requests.sort((a, b) => (a.note.at ?? 0) - (b.note.at ?? 0));

  // Each request is taken up by at most one task or live worker for the same
  // project, started no earlier than the day before it (backlog dates are
  // whole days; done tasks record only when they closed), whose title shares
  // the most key words with the request.
  const claimed = new Set<string>();
  const byTask = new Map<string, Request[]>();
  const liveTitles = new Map(live.map((l) => [l.id, l.title]));
  const candidates = [
    ...tasks.map((t) => ({ id: t.id, project: t.repo, from: createdMs(t) ?? dayMs(t.closed), title: t.title })),
    ...live
      .filter((l) => !tasks.some((t) => t.id === l.id))
      .map((l) => ({ id: l.id, project: l.project ?? '', from: l.spawnedAt, title: liveTitles.get(l.id) ?? '' })),
  ];
  for (const r of requests) {
    const at = r.note.at ?? 0;
    if (r.project === 'not sure') continue;
    const want = words(r.text);
    let match: (typeof candidates)[number] | null = null;
    let best = 1;
    for (const c of candidates) {
      if (!sameProject(c.project, r.project) || c.from === null || c.from < at - DAY || byTask.has(c.id)) continue;
      const score = overlap(want, words(c.title));
      if (score > best || (score === best && match && (c.from ?? 0) < (match.from ?? 0))) {
        best = score;
        match = c;
      }
    }
    if (!match) continue;
    claimed.add(r.note.id);
    byTask.set(match.id, [r]);
  }

  const out: Placeholder[] = [];
  for (const t of tasks) {
    if (liveIds.has(t.id) || (t.state !== 'queued' && t.state !== 'in_flight')) continue;
    const created = createdMs(t);
    if (t.held && (created === null || now - created > RECENT_HELD_MS)) continue;
    out.push({ id: t.id, kind: 'queued', task: t, requests: byTask.get(t.id) ?? [] });
  }
  for (const r of requests) {
    if (claimed.has(r.note.id)) continue;
    const p: Placeholder = { id: `${REQUEST_PREFIX}${r.note.id}`, kind: 'requested', task: null, requests: [r] };
    if (r.note.acknowledged) {
      const last = Math.max(...threadNotes(p, notes).map((n) => Math.max(n.at ?? 0, n.reply?.at ?? 0)));
      if (now - last > REQUEST_ACTIVE_MS) continue;
    }
    out.push(p);
  }
  const liveLinks = new Map<string, Request[]>();
  for (const id of liveIds) liveLinks.set(id, byTask.get(id) ?? []);
  return { placeholders: out, liveLinks, links: byTask };
}

// Notes that belong in a thread: its own request notes and anything tagged
// for it (or for a request it took up).
export function threadNotes(p: { id: string; requests: Request[] }, notes: FirstmateNote[]): FirstmateNote[] {
  const tags = [p.id, ...p.requests.map((r) => `${REQUEST_PREFIX}${r.note.id}`)];
  const own = new Set(p.requests.map((r) => r.note.id));
  return notes.filter((n) => own.has(n.id) || taggedFor(n, tags)).sort((a, b) => (a.at ?? 0) - (b.at ?? 0));
}

export function noteItems(notes: FirstmateNote[]): ChatItem[] {
  const items: ChatItem[] = [];
  notes.forEach((n, i) => {
    const out: OutgoingItem = {
      type: 'outgoing',
      id: `n-${n.id}`,
      seq: -1 - i,
      at: n.at,
      body: stripTag(n.body),
      read: n.acknowledged,
      from: 'you',
    };
    items.push(out);
    if (n.reply) {
      const reply: IncomingItem = {
        type: 'incoming',
        id: `r-${n.id}`,
        verb: 'reply',
        text: n.reply.body,
        at: n.reply.at,
        atSource: n.reply.at === null ? null : 'stamp',
        key: null,
        decision: null,
        resolution: null,
        author: 'firstmate',
      };
      items.push(reply);
    }
  });
  return items;
}

function statusItem(p: Placeholder, now: number): IncomingItem {
  const lines: string[] = [];
  if (p.kind === 'requested') {
    const n = p.requests[0].note;
    lines.push(n.acknowledged ? 'First mate has read this request but has not started a worker for it.' : 'Waiting for First mate to pick this request up.');
  } else {
    const t = p.task!;
    lines.push(t.state === 'in_flight' ? 'In flight in First mate\'s backlog, but no worker is running for it right now.' : 'Queued in First mate\'s backlog. A worker has not started yet.');
    if (t.held && t.holdReason) lines.push(`Held: ${t.holdReason}`);
    if (t.blocked && t.blockedBy) lines.push(`Waiting on: ${t.blockedBy}`);
  }
  if (p.requests.some((r) => requestLines(r.text).planning)) lines.push('You asked for a planning phase first: plan it here with First mate.');
  lines.push('When the worker starts, this conversation carries on with it.');
  return {
    type: 'incoming',
    id: 'placeholder-status',
    verb: p.kind,
    text: lines.join('\n'),
    at: now,
    atSource: 'observed',
    key: null,
    decision: null,
    resolution: null,
    author: 'firstmate',
  };
}

export function placeholderSummary(p: Placeholder, notes: FirstmateNote[], now: number): ThreadSummary {
  const req = p.requests[0];
  const pick = req ? requestLines(req.text) : { model: null, effort: null, planning: false };
  const title = p.task?.title ?? (req ? req.text.split('\n')[0].slice(0, 120) : p.id);
  const mine = threadNotes(p, notes);
  const last = mine[mine.length - 1];
  const lastReply = [...mine].reverse().find((n) => n.reply);
  const lastAt = Math.max(last?.at ?? 0, lastReply?.reply?.at ?? 0) || null;
  const state = p.task
    ? `${p.task.state.replace('_', ' ')} in the backlog${p.task.held ? ' · held' : ''}${p.task.blocked ? ' · blocked' : ''}`
    : req?.note.acknowledged
      ? 'requested · read by First mate'
      : 'requested · not picked up yet';
  return {
    id: p.id,
    title,
    badge: p.kind,
    stateLine: `${state} · no worker yet${pick.planning ? ' · planning first' : ''}`,
    project: p.task?.repo ?? req?.project ?? null,
    kind: p.task?.kind ?? null,
    backend: 'none',
    pr: null,
    lastText: lastReply?.reply?.body ?? (last ? stripTag(last.body) : null),
    lastVerb: lastReply ? 'reply' : null,
    lastAt,
    incomingCount: mine.filter((n) => n.reply).length,
    openDecisions: 0,
    unreadByWorker: 0,
    terminal: { available: false, reason: 'No worker is running for this yet.' },
    harness: null,
    model: pick.model,
    effort: pick.effort,
    usage: null,
    usageNote: null,
    placeholder: p.kind,
  };
}

export function placeholderDetail(p: Placeholder, notes: FirstmateNote[], now: number): ThreadDetail {
  const items = noteItems(threadNotes(p, notes));
  items.push(statusItem(p, now));
  return { summary: placeholderSummary(p, notes, now), items };
}
