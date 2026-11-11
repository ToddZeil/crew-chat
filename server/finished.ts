// Threads for workers that finished and were cleaned up: crew-chat's saved
// copy when it has one, otherwise rebuilt from what Firstmate keeps after a
// cleanup (the backlog task, the request notes and replies, and the task's
// brief and report under $FM_HOME/data/<id>/, all read-only).
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import type { ChatItem, FirstmateNote, IncomingItem, OutgoingItem, ThreadDetail, ThreadSummary } from '../shared/types.ts';
import type { Saved } from './archive.ts';
import type { BacklogTask } from './parse.ts';
import { noteItems, threadNotes, type Placeholder } from './placeholders.ts';

const MAX_DOC_BYTES = 200_000;
// Finished tasks rebuilt from the backlog are shown for this long after they close.
export const BACKFILL_DAYS = 7;

interface Doc {
  text: string;
  at: number;
  path: string;
}

function readDoc(file: string): Doc | null {
  try {
    const st = statSync(file);
    if (!st.isFile()) return null;
    const buf = readFileSync(file);
    const text = buf.subarray(0, MAX_DOC_BYTES).toString('utf8') + (buf.length > MAX_DOC_BYTES ? '\n... (cut short)' : '');
    return { text, at: st.mtimeMs, path: file };
  } catch {
    return null;
  }
}

// The report a finished task links to, else data/<id>/report.md.
export function taskDocs(home: string, task: BacklogTask): { brief: Doc | null; report: Doc | null; pr: string | null } {
  const dataDir = path.join(home, 'data', task.id);
  const link = /report:(\S+)/.exec(task.links ?? '')?.[1];
  const inHome = (rel: string) => {
    const abs = path.resolve(home, rel);
    return abs.startsWith(path.resolve(home) + path.sep) ? abs : null;
  };
  const reportPath = (link && inHome(link)) || path.join(dataDir, 'report.md');
  return {
    brief: readDoc(path.join(dataDir, 'brief.md')),
    report: readDoc(reportPath),
    pr: /(https:\/\/github\.com\/\S+\/pull\/\d+)/.exec(task.links ?? '')?.[1] ?? null,
  };
}

function finishedStatus(at: number, saved: boolean): IncomingItem {
  return {
    type: 'incoming',
    id: 'finished-status',
    verb: 'finished',
    text: saved
      ? 'This worker finished and was cleaned up. This is the copy crew-chat kept as it went; nothing new will arrive here.'
      : "This worker finished and was cleaned up before crew-chat kept a copy, so its own updates are gone. This is rebuilt from First mate's notes and the task's brief and report.",
    at,
    atSource: 'observed',
    key: null,
    decision: null,
    resolution: null,
    author: 'firstmate',
  };
}

function docItems(docs: ReturnType<typeof taskDocs>, home: string): ChatItem[] {
  const items: ChatItem[] = [];
  if (docs.brief) {
    const brief: OutgoingItem = {
      type: 'outgoing',
      id: 'doc-brief',
      seq: -1000,
      at: docs.brief.at,
      body: `Brief for this worker (${path.relative(home, docs.brief.path)}):\n\n${docs.brief.text}`,
      read: true,
      from: 'firstmate',
    };
    items.push(brief);
  }
  if (docs.report) {
    const report: IncomingItem = {
      type: 'incoming',
      id: 'doc-report',
      verb: 'done',
      text: `Report (${path.relative(home, docs.report.path)}):\n\n${docs.report.text}`,
      at: docs.report.at,
      atSource: 'stamp',
      key: null,
      decision: null,
      resolution: null,
    };
    items.push(report);
  }
  return items;
}

function byTime(items: ChatItem[]): ChatItem[] {
  return items.map((item, i) => ({ item, i })).sort((a, b) => (a.item.at ?? 0) - (b.item.at ?? 0) || a.i - b.i).map((x) => x.item);
}

function finishSummary(base: ThreadSummary, lastAt: number | null): ThreadSummary {
  return {
    ...base,
    badge: 'finished',
    placeholder: 'finished',
    openDecisions: 0,
    unreadByWorker: 0,
    lastAt: lastAt ?? base.lastAt,
    stateLine: 'finished · cleaned up',
    terminal: { available: false, reason: 'This worker finished and was cleaned up.' },
  };
}

export function savedThread(saved: Saved, task: BacklogTask | null, home: string): ThreadDetail {
  const items = [...saved.detail.items];
  if (task) {
    const docs = taskDocs(home, task);
    // The report usually lands as the worker finishes, after the last copy.
    if (docs.report && !items.some((i) => i.id === 'doc-report')) items.push(...docItems({ brief: null, report: docs.report, pr: null }, home));
  }
  items.push(finishedStatus(saved.savedAt, true));
  const decisionsClosed = items.map((i) => (i.type === 'incoming' && i.decision === 'open' ? { ...i, decision: null } : i));
  return { summary: finishSummary(saved.detail.summary, saved.savedAt), items: decisionsClosed };
}

export function rebuiltThread(
  task: BacklogTask,
  requests: Placeholder['requests'],
  notes: FirstmateNote[],
  home: string,
  now: number,
): ThreadDetail | null {
  const docs = taskDocs(home, task);
  const chat = noteItems(threadNotes({ id: task.id, requests }, notes));
  const items = byTime([...chat, ...docItems(docs, home)]);
  if (items.length === 0) return null;
  // Firstmate closes old tasks in batches, so the close date alone does not
  // say the work is recent; the brief, report, or notes must be.
  const activity = Math.max(...items.map((i) => i.at ?? 0));
  if (now - activity > BACKFILL_DAYS * 86_400_000) return null;
  const last = items[items.length - 1].at ?? Date.parse(`${task.closed}T00:00:00Z`);
  items.push(finishedStatus(last, false));
  const lastIncoming = [...items].reverse().find((i): i is IncomingItem => i.type === 'incoming' && i.id !== 'finished-status');
  const base: ThreadSummary = {
    id: task.id,
    title: task.title,
    badge: 'finished',
    stateLine: null,
    project: task.repo,
    kind: task.kind,
    backend: 'none',
    pr: docs.pr,
    lastText: lastIncoming?.text.split('\n')[0] ?? null,
    lastVerb: lastIncoming?.verb ?? null,
    lastAt: last,
    incomingCount: items.filter((i) => i.type === 'incoming').length,
    openDecisions: 0,
    unreadByWorker: 0,
    terminal: { available: false, reason: '' },
    harness: null,
    model: null,
    effort: null,
    usage: null,
    usageNote: null,
    placeholder: 'finished',
  };
  return { summary: finishSummary(base, last), items };
}

export function recentlyClosed(task: BacklogTask, now: number): boolean {
  const closed = Date.parse(`${task.closed}T00:00:00Z`);
  return task.state === 'done' && !Number.isNaN(closed) && now - closed <= BACKFILL_DAYS * 86_400_000;
}
