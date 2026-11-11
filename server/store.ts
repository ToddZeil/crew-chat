import { EventEmitter } from 'node:events';
import { existsSync, lstatSync, readdirSync, readFileSync, watch, type FSWatcher } from 'node:fs';
import path from 'node:path';
import type {
  ActivityLog,
  Badge,
  ChatItem,
  FirstmateDetail,
  FirstmateNote,
  IncomingItem,
  OutgoingItem,
  TerminalAvailability,
  ThreadDetail,
  ThreadSummary,
  WorkerUsage,
} from '../shared/types.ts';
import { crewState, receipts, taskList, taskShow } from './fm.ts';
import {
  badgeFor,
  crewStateOf,
  inboxSeq,
  parseInboxMessage,
  parseMeta,
  parseProjects,
  parseReceipts,
  parseStatusLog,
  parseTaskList,
  parseTaskTitle,
  type BacklogTask,
  taskKind,
} from './parse.ts';
import { availability, type TmuxConfig } from './terminal.ts';
import { Archive } from './archive.ts';
import { rebuiltThread, recentlyClosed, savedThread } from './finished.ts';
import type { SentLedger } from './ledger.ts';
import { buildPlaceholders, noteItems, placeholderDetail, placeholderSummary, threadNotes, type Built } from './placeholders.ts';
import { spawnTime, UsageReader } from './usage.ts';

export const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

const WATCHED = /^([^/\\]+?)\.(status|meta|inbox)(?:[/\\]|$)/;
// Firstmate's own note queue, state/inbox/, is not a worker inbox.
const FIRSTMATE_INBOX = /^inbox(?:[/\\]|$)/;
export const FIRSTMATE_ID = '__firstmate__';
// Change-event id for the backlog, which feeds the queued and requested threads.
export const BACKLOG_ID = '__backlog__';

interface CrewCache {
  badge: Badge;
  line: string | null;
}

function readText(file: string): string | null {
  try {
    if (lstatSync(file).isSymbolicLink()) return null;
    return readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

function readDirSafe(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

// A small FIFO limiter so fm-crew-state.sh (about 1.5s each on a real home)
// never runs for every worker at once.
class Limiter {
  private active = 0;
  private queue: Array<() => void> = [];
  private readonly max: number;
  constructor(max: number) {
    this.max = max;
  }
  run<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const start = () => {
        this.active++;
        fn().then(resolve, reject).finally(() => {
          this.active--;
          this.queue.shift()?.();
        });
      };
      if (this.active < this.max) start();
      else this.queue.push(start);
    });
  }
}

export interface StoreOptions {
  home: string;
  tmux: TmuxConfig | null;
  crewConcurrency?: number;
  sweepMs?: number;
  debounceMs?: number;
  // Claude Code's projects directory; null turns token reading off.
  claudeProjectsDir?: string | null;
  usageMs?: number;
  ledger?: SentLedger | null;
  // Where crew-chat keeps its own copy of each thread; null keeps none.
  archiveDir?: string | null;
  // False when there is no terminal app to open a worker's window in.
  canLaunch?: boolean;
}

export class Store extends EventEmitter {
  readonly home: string;
  readonly stateDir: string;
  private readonly tmux: TmuxConfig | null;
  private readonly crew = new Map<string, CrewCache>();
  private readonly crewPending = new Set<string>();
  private readonly titles = new Map<string, string>();
  private readonly terminals = new Map<string, TerminalAvailability>();
  // Arrival times for unstamped status lines that appeared while running,
  // keyed by id then by line index.
  private readonly observed = new Map<string, Map<number, number>>();
  private readonly lineCounts = new Map<string, number>();
  private readonly limiter: Limiter;
  private readonly debounceMs: number;
  private readonly sweepMs: number;
  private watcher: FSWatcher | null = null;
  private sweepTimer: NodeJS.Timeout | null = null;
  private pendingIds = new Set<string>();
  private flushTimer: NodeJS.Timeout | null = null;
  private notes: FirstmateNote[] = [];
  private notesError: string | null = null;
  private notesQueued: Promise<void> | null = null;
  private notesCurrent: Promise<void> = Promise.resolve();
  private backlog: BacklogTask[] = [];
  private backlogRunning = false;
  private backlogAgain = false;
  private lastIds = '';
  private readonly usageReader: UsageReader | null;
  private readonly usageCache = new Map<string, { usage: WorkerUsage | null; note: string | null; sig: string }>();
  private readonly usageMs: number;
  readonly ledger: SentLedger | null;
  private readonly archive: Archive | null;
  private readonly canLaunch: boolean;
  private usageTimer: NodeJS.Timeout | null = null;

  constructor(opts: StoreOptions) {
    super();
    this.home = opts.home;
    this.stateDir = path.join(opts.home, 'state');
    this.tmux = opts.tmux;
    this.limiter = new Limiter(opts.crewConcurrency ?? 3);
    this.debounceMs = opts.debounceMs ?? 100;
    this.sweepMs = opts.sweepMs ?? 30_000;
    this.usageReader = opts.claudeProjectsDir ? new UsageReader(opts.claudeProjectsDir) : null;
    this.usageMs = opts.usageMs ?? 15_000;
    this.ledger = opts.ledger ?? null;
    this.archive = opts.archiveDir ? new Archive(opts.archiveDir, opts.home) : null;
    this.canLaunch = opts.canLaunch ?? true;
    this.on('change', (ids: string[]) => this.archiveLive(ids));
  }

  // Keep a copy of each live thread as it changes, so its history outlives
  // the worker's cleanup.
  private archiveLive(ids: string[]): void {
    if (!this.archive) return;
    for (const id of ids) {
      if (!this.isLive(id)) continue;
      try {
        const d = this.detail(id);
        if (d && !d.summary.placeholder) this.archive.save(d);
      } catch (err) {
        console.error(`crew-chat: could not save a copy of ${id}: ${(err as Error).message}`);
      }
    }
  }

  private finished(built: Built): Map<string, ThreadDetail> {
    const out = new Map<string, ThreadDetail>();
    const taken = new Set([...this.ids(), ...built.placeholders.map((p) => p.id)]);
    const tasks = new Map(this.backlog.map((t) => [t.id, t]));
    for (const id of this.archive?.ids() ?? []) {
      if (taken.has(id) || !ID_RE.test(id)) continue;
      const saved = this.archive!.load(id);
      if (saved) out.set(id, savedThread(saved, tasks.get(id) ?? null, this.home));
    }
    const now = Date.now();
    for (const t of this.backlog) {
      if (taken.has(t.id) || out.has(t.id) || !recentlyClosed(t, now)) continue;
      const d = rebuiltThread(t, built.links.get(t.id) ?? [], this.notes, this.home, now);
      if (d) out.set(t.id, d);
    }
    const hidden = this.archive?.hidden() ?? new Set<string>();
    for (const [id, d] of out) if (hidden.has(id)) d.summary.hidden = true;
    return out;
  }

  isFinished(id: string): boolean {
    return !this.isLive(id) && this.finished(this.built()).has(id);
  }

  setHidden(id: string, hide: boolean): void {
    this.archive?.setHidden(id, hide);
    this.emit('change', [id]);
  }

  get canHide(): boolean {
    return this.archive !== null;
  }

  ids(): string[] {
    return readDirSafe(this.stateDir)
      .filter((f) => f.endsWith('.meta'))
      .map((f) => f.slice(0, -'.meta'.length))
      .filter((id) => ID_RE.test(id))
      .filter((id) => {
        try {
          return lstatSync(path.join(this.stateDir, `${id}.meta`)).isFile();
        } catch {
          return false;
        }
      })
      .sort();
  }

  exists(id: string): boolean {
    if (!ID_RE.test(id)) return false;
    if (existsSync(path.join(this.stateDir, `${id}.meta`))) return true;
    const built = this.built();
    return built.placeholders.some((p) => p.id === id) || this.finished(built).has(id);
  }

  isLive(id: string): boolean {
    return ID_RE.test(id) && existsSync(path.join(this.stateDir, `${id}.meta`));
  }

  private built(): Built {
    const live = this.ids().map((id) => {
      const meta = this.meta(id) ?? {};
      return { id, project: meta.project ? path.basename(meta.project) : null, spawnedAt: spawnTime(meta), title: this.titles.get(id) ?? null };
    });
    return buildPlaceholders(this.backlog, this.notes, live, Date.now());
  }

  // First mate's backlog, for work that has no live worker yet.
  refreshBacklog(): void {
    if (this.backlogRunning) {
      this.backlogAgain = true;
      return;
    }
    this.backlogRunning = true;
    void (async () => {
      const r = await taskList(this.home);
      if (r.exitCode === 0) {
        const tasks = parseTaskList(r.stdout);
        // The list cuts long titles short; the queued ones are worth the full text.
        const live = new Set(this.ids());
        for (const t of tasks) {
          if (!t.title.endsWith('...') || live.has(t.id) || (t.state !== 'queued' && t.state !== 'in_flight')) continue;
          const known = this.titles.get(t.id);
          if (known) t.title = known;
          else {
            const full = parseTaskTitle((await taskShow(this.home, t.id)).stdout);
            if (full) {
              t.title = full;
              this.titles.set(t.id, full);
            }
          }
        }
        const before = JSON.stringify(this.backlog);
        this.backlog = tasks;
        if (JSON.stringify(tasks) !== before) this.emit('change', [BACKLOG_ID]);
      }
    })()
      .catch((err) => console.error(`crew-chat: backlog read failed: ${(err as Error).message}`))
      .finally(() => {
        this.backlogRunning = false;
        if (this.backlogAgain) {
          this.backlogAgain = false;
          this.refreshBacklog();
        }
      });
  }

  start(): void {
    for (const id of this.ids()) this.noteLineCount(id);
    try {
      this.watcher = watch(this.stateDir, { recursive: true }, (_event, file) => {
        if (!file) return;
        if (FIRSTMATE_INBOX.test(file.toString())) {
          this.refreshNotes();
          return;
        }
        const m = WATCHED.exec(file.toString());
        if (m && ID_RE.test(m[1])) this.touch(m[1], m[2] !== 'inbox');
      });
    } catch (err) {
      console.error(`crew-chat: cannot watch ${this.stateDir}: ${(err as Error).message}`);
    }
    this.archiveLive(this.ids());
    this.sweep();
    this.refreshNotes();
    this.sweepTimer = setInterval(() => {
      this.sweep();
      this.refreshNotes();
    }, this.sweepMs);
    this.sweepTimer.unref();
    this.usageTimer = setInterval(() => this.pollUsage(), this.usageMs);
    this.usageTimer.unref();
  }

  private computeUsage(id: string, meta: Record<string, string>): { usage: WorkerUsage | null; note: string | null; sig: string } {
    let usage: WorkerUsage | null = null;
    let note: string | null = null;
    const harness = meta.harness ?? null;
    if (!this.usageReader) note = 'Token reading is off.';
    else if (harness && harness !== 'claude') note = `Token use is only read for Claude workers; this one runs ${harness}.`;
    else if (!meta.worktree) note = 'No worktree is recorded for this worker.';
    else {
      usage = this.usageReader.read(meta.worktree, spawnTime(meta));
      if (!usage) note = 'No token use recorded yet.';
    }
    const sig = usage ? `${usage.messages}:${usage.lastAt}:${usage.model}` : `none:${note}`;
    const entry = { usage, note, sig };
    this.usageCache.set(id, entry);
    return entry;
  }

  activity(id: string): ActivityLog {
    const meta = this.meta(id) ?? {};
    const harness = meta.harness ?? null;
    if (!this.usageReader) return { available: false, reason: 'Reading worker transcripts is off.', entries: [] };
    if (harness && harness !== 'claude') {
      return { available: false, reason: `The transcript is only read for Claude workers; this one runs ${harness}.`, entries: [] };
    }
    if (!meta.worktree) return { available: false, reason: 'No worktree is recorded for this worker.', entries: [] };
    const entries = this.usageReader.activity(meta.worktree, spawnTime(meta));
    if (entries === null) return { available: false, reason: 'No transcript found for this worker yet.', entries: [] };
    return { available: true, entries };
  }

  private pollUsage(): void {
    const changed: string[] = [];
    for (const id of this.ids()) {
      const meta = this.meta(id);
      if (!meta) continue;
      const before = this.usageCache.get(id)?.sig;
      if (this.computeUsage(id, meta).sig !== before) changed.push(id);
    }
    if (changed.length) this.emit('change', changed);
  }

  stop(): void {
    this.watcher?.close();
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    if (this.usageTimer) clearInterval(this.usageTimer);
    if (this.flushTimer) clearTimeout(this.flushTimer);
  }

  private touch(id: string, recheck: boolean): void {
    this.noteLineCount(id);
    this.pendingIds.add(id);
    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => {
        this.flushTimer = null;
        const ids = [...this.pendingIds];
        this.pendingIds.clear();
        this.emit('change', ids);
        // A worker starting or being cleaned up changes what is queued.
        const now = this.ids().join(',');
        if (now !== this.lastIds) {
          this.lastIds = now;
          this.refreshBacklog();
        }
      }, this.debounceMs);
    }
    if (recheck) this.refreshCrew(id);
  }

  // Record when unstamped lines first appeared, so a live update shows "just
  // now" instead of no time.
  private noteLineCount(id: string): void {
    const content = readText(path.join(this.stateDir, `${id}.status`));
    const count = content === null ? 0 : content.split('\n').filter((l, i, a) => i < a.length - 1 || l !== '').length;
    const before = this.lineCounts.get(id);
    this.lineCounts.set(id, count);
    if (before === undefined || count <= before) return;
    let seen = this.observed.get(id);
    if (!seen) this.observed.set(id, (seen = new Map()));
    const now = Date.now();
    for (let i = before; i < count; i++) seen.set(i, now);
  }

  private sweep(): void {
    for (const id of this.ids()) this.refreshCrew(id);
    this.refreshBacklog();
  }

  private refreshCrew(id: string): void {
    if (this.crewPending.has(id)) return;
    this.crewPending.add(id);
    void this.limiter
      .run(async () => {
        const meta = this.meta(id);
        if (meta === null) return;
        const [state, term, title] = await Promise.all([
          crewState(this.home, id),
          availability(this.tmux, meta, this.canLaunch),
          this.titles.has(id) ? Promise.resolve(null) : taskShow(this.home, id),
        ]);
        const first = state.stdout.split('\n')[0]?.trim() || null;
        const prev = this.crew.get(id);
        const next: CrewCache = { badge: badgeFor(first ? crewStateOf(first) : null), line: first };
        if (title) this.titles.set(id, parseTaskTitle(title.stdout) ?? id);
        const prevTerm = this.terminals.get(id);
        this.terminals.set(id, term);
        this.crew.set(id, next);
        const changed =
          !prev ||
          prev.line !== next.line ||
          title !== null ||
          prevTerm?.available !== term.available ||
          prevTerm?.reason !== term.reason;
        if (changed) this.emit('change', [id]);
      })
      .catch((err) => console.error(`crew-chat: refresh ${id} failed: ${(err as Error).message}`))
      .finally(() => this.crewPending.delete(id));
  }

  meta(id: string): Record<string, string> | null {
    const text = readText(path.join(this.stateDir, `${id}.meta`));
    return text === null ? null : parseMeta(text);
  }

  inboxRecords(id: string): OutgoingItem[] {
    const dir = path.join(this.stateDir, `${id}.inbox`);
    const items: OutgoingItem[] = [];
    const add = (folder: string, read: boolean) => {
      for (const name of readDirSafe(folder)) {
        const seq = inboxSeq(name);
        if (seq === null) continue;
        const text = readText(path.join(folder, name));
        if (text === null) continue;
        const msg = parseInboxMessage(text);
        items.push({ type: 'outgoing', id: `m${seq}`, seq, at: msg.at, body: msg.body, read, from: 'firstmate' });
      }
    };
    add(path.join(dir, 'handled'), true);
    add(dir, false);
    // A message mid-move can briefly sit in both places; the handled copy wins.
    const bySeq = new Map<number, OutgoingItem>();
    for (const item of items) if (!bySeq.has(item.seq)) bySeq.set(item.seq, item);
    return [...bySeq.values()].sort((a, b) => a.seq - b.seq);
  }

  private outgoing(id: string): OutgoingItem[] {
    const records = this.inboxRecords(id);
    const mine = this.ledger ? this.ledger.sentSeqs(this.home, id, records) : new Set<number>();
    for (const r of records) if (mine.has(r.seq)) r.from = 'you';
    return records;
  }

  private incoming(id: string, meta: Record<string, string>): IncomingItem[] {
    const content = readText(path.join(this.stateDir, `${id}.status`)) ?? '';
    const log = parseStatusLog(content, taskKind(meta));
    const seen = this.observed.get(id);
    return log.lines.map((line) => {
      const opener = line.verb === 'needs-decision' || line.verb === 'blocked';
      const fate = log.fates.get(line.index);
      let resolution: string | null = null;
      if (fate?.state === 'resolved' && fate.by !== null) {
        const closer = log.lines.find((l) => l.index === fate.by);
        if (closer) resolution = closer.verb === 'captain-held' ? `Handed to the captain: ${closer.text}` : closer.text;
      }
      const observedAt = line.at === null ? seen?.get(line.index) : undefined;
      return {
        type: 'incoming',
        id: `s${line.index}`,
        verb: line.verb,
        text: line.text,
        at: line.at ?? observedAt ?? null,
        atSource: line.at !== null ? 'stamp' : observedAt !== undefined ? 'observed' : null,
        key: opener || line.keyed ? line.key : null,
        decision: fate?.state ?? null,
        resolution,
      };
    });
  }

  private summaryFrom(id: string, meta: Record<string, string>, incoming: IncomingItem[], outgoing: OutgoingItem[]): ThreadSummary {
    const crew = this.crew.get(id);
    const usage = this.usageCache.get(id) ?? this.computeUsage(id, meta);
    const last = incoming[incoming.length - 1];
    let lastAt: number | null = null;
    for (const item of [...incoming, ...outgoing]) if (item.at !== null && (lastAt === null || item.at > lastAt)) lastAt = item.at;
    return {
      id,
      title: this.titles.get(id) ?? id,
      badge: crew?.badge ?? 'checking',
      stateLine: crew?.line ?? null,
      project: meta.project ? path.basename(meta.project) : null,
      kind: meta.kind ?? null,
      backend: meta.backend || 'tmux',
      pr: meta.pr || null,
      lastText: last?.text ?? null,
      lastVerb: last?.verb ?? null,
      lastAt,
      incomingCount: incoming.length,
      openDecisions: incoming.filter((i) => i.decision === 'open').length,
      unreadByWorker: outgoing.filter((o) => !o.read).length,
      terminal: this.terminals.get(id) ?? { available: false, reason: 'Checking the tmux session...' },
      harness: meta.harness ?? null,
      model: meta.model ?? null,
      effort: meta.effort ?? null,
      usage: usage.usage,
      usageNote: usage.note,
      placeholder: null,
    };
  }

  summary(id: string): ThreadSummary | null {
    const meta = this.meta(id);
    if (meta === null) return null;
    return this.summaryFrom(id, meta, this.incoming(id, meta), this.outgoing(id));
  }

  summaries(): ThreadSummary[] {
    const live = this.ids()
      .map((id) => this.summary(id))
      .filter((s): s is ThreadSummary => s !== null);
    const now = Date.now();
    const built = this.built();
    return [
      ...live,
      ...built.placeholders.map((p) => placeholderSummary(p, this.notes, now)),
      ...[...this.finished(built).values()].map((d) => d.summary),
    ];
  }

  detail(id: string): ThreadDetail | null {
    const meta = this.meta(id);
    const built = this.built();
    if (meta === null) {
      const p = built.placeholders.find((x) => x.id === id);
      return p ? placeholderDetail(p, this.notes, Date.now()) : (this.finished(built).get(id) ?? null);
    }
    const incoming = this.incoming(id, meta);
    const outgoing = this.outgoing(id);
    const items = mergeTimeline(incoming, outgoing);
    // The planning chat from before the worker started stays in its thread.
    const extra = noteItems(threadNotes({ id, requests: built.liveLinks.get(id) ?? [] }, this.notes));
    return { summary: this.summaryFrom(id, meta, incoming, outgoing), items: insertByTime(items, extra) };
  }

  // fm-inbox.sh receipts runs python, so overlapping triggers collapse into
  // one follow-up run.
  // Resolves once a read that started after this call has finished, so a
  // caller that just wrote a note sees it. A read already waiting to start is
  // shared rather than queued twice.
  refreshNotes(): Promise<void> {
    if (this.notesQueued) return this.notesQueued;
    const next = this.notesCurrent.then(() => {
      this.notesQueued = null;
      return this.readNotes();
    });
    this.notesQueued = next;
    this.notesCurrent = next;
    return next;
  }

  private async readNotes(): Promise<void> {
    const r = await receipts(this.home);
    if (r.exitCode === 0) {
      try {
        this.notes = parseReceipts(r.stdout);
        this.notesError = null;
      } catch (err) {
        this.notesError = `Could not read fm-inbox.sh receipts: ${(err as Error).message}`;
      }
    } else {
      this.notesError = `fm-inbox.sh receipts failed (exit ${r.exitCode ?? '?'}): ${(r.stderr || r.error || '').trim()}`;
    }
    this.emit('change', [FIRSTMATE_ID, BACKLOG_ID]);
    // First mate usually files a backlog task when it reads a request.
    this.refreshBacklog();
  }

  firstmate(): FirstmateDetail {
    const md = readText(path.join(this.home, 'data', 'projects.md'));
    return { notes: this.notes, projects: md === null ? [] : parseProjects(md), error: this.notesError };
  }

  // Re-read after a write so the page does not wait for the watcher.
  nudge(id: string): void {
    this.touch(id, true);
  }
}

// Unstamped status lines inherit the time of the line before them, so the
// merge keeps status-log order while slotting sent messages in by time.
export function mergeTimeline(incoming: IncomingItem[], outgoing: OutgoingItem[]): ChatItem[] {
  let carry = -Infinity;
  const inc = incoming.map((item) => {
    if (item.at !== null) carry = Math.max(carry, item.at);
    return { item: item as ChatItem, t: carry };
  });
  const out = outgoing.map((item) => ({ item: item as ChatItem, t: item.at ?? Infinity }));
  const result: ChatItem[] = [];
  let i = 0;
  let o = 0;
  while (i < inc.length || o < out.length) {
    if (o >= out.length || (i < inc.length && inc[i].t <= out[o].t)) result.push(inc[i++].item);
    else result.push(out[o++].item);
  }
  return result;
}

// Slot timed items into a timeline by time; untimed timeline items keep the
// time of the item before them.
export function insertByTime(items: ChatItem[], extra: ChatItem[]): ChatItem[] {
  if (extra.length === 0) return items;
  const out: ChatItem[] = [];
  const queue = [...extra].sort((a, b) => (a.at ?? 0) - (b.at ?? 0));
  let carry = -Infinity;
  for (const item of items) {
    if (item.at !== null) carry = Math.max(carry, item.at);
    while (queue.length && (queue[0].at ?? 0) < carry) out.push(queue.shift()!);
    out.push(item);
  }
  return [...out, ...queue];
}
