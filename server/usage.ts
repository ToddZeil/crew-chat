// Token use per worker, read from Claude Code's own session transcripts:
// <projects dir>/<worktree path with every non-alphanumeric as "-">/*.jsonl.
// Files are read incrementally, so a large transcript is parsed once and then
// only its new lines.
import { closeSync, openSync, readdirSync, readSync, statSync } from 'node:fs';
import os from 'node:os';
import { StringDecoder } from 'node:string_decoder';
import path from 'node:path';
import type { ActivityEntry, WorkerUsage } from '../shared/types.ts';

const MAX_ENTRIES_PER_FILE = 3000;
const MAX_RESULT_CHARS = 4000;

interface MessageUsage {
  at: number;
  model: string | null;
  input: number;
  cacheCreation: number;
  cacheRead: number;
  output: number;
}

interface FileState {
  size: number;
  offset: number;
  partial: string;
  decoder: StringDecoder;
  // One entry per API message: a message written as several lines repeats
  // the same usage, so it is keyed by message id.
  messages: Map<string, MessageUsage>;
  entries: ActivityEntry[];
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}\n... (${text.length - max} more characters)` : text;
}

function toolSummary(name: string, input: Record<string, unknown> | undefined): string {
  const i = input ?? {};
  const str = (k: string) => (typeof i[k] === 'string' ? (i[k] as string) : null);
  return (
    str('command') ??
    str('file_path') ??
    str('notebook_path') ??
    str('pattern') ??
    str('url') ??
    str('description') ??
    str('prompt') ??
    clip(JSON.stringify(i), 300)
  );
}

function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => (c && typeof c === 'object' && (c as { type?: string }).type === 'text' ? String((c as { text?: unknown }).text ?? '') : '[non-text output]'))
      .join('\n');
  }
  return '';
}

// The readable steps in one transcript line; thinking and server-side tool
// traffic are left out.
export function parseActivityLine(line: string): ActivityEntry[] {
  if (!line.includes('"message"')) return [];
  let o: { type?: unknown; timestamp?: unknown; isMeta?: unknown; message?: { content?: unknown } };
  try {
    o = JSON.parse(line);
  } catch {
    return [];
  }
  if ((o.type !== 'assistant' && o.type !== 'user') || o.isMeta === true) return [];
  const at = typeof o.timestamp === 'string' ? Date.parse(o.timestamp) : NaN;
  if (Number.isNaN(at)) return [];
  const content = o.message?.content;
  if (typeof content === 'string') {
    return o.type === 'user' && content.trim() ? [{ at, kind: 'prompt', text: clip(content, MAX_RESULT_CHARS) }] : [];
  }
  if (!Array.isArray(content)) return [];
  const out: ActivityEntry[] = [];
  for (const raw of content) {
    const c = raw as { type?: string; text?: unknown; name?: unknown; input?: Record<string, unknown>; content?: unknown; is_error?: unknown };
    if (c.type === 'text' && typeof c.text === 'string' && c.text.trim()) {
      out.push({ at, kind: o.type === 'user' ? 'prompt' : 'say', text: clip(c.text, MAX_RESULT_CHARS) });
    } else if (c.type === 'tool_use' && typeof c.name === 'string') {
      out.push({ at, kind: 'tool', tool: c.name, text: clip(toolSummary(c.name, c.input), 1000) });
    } else if (c.type === 'tool_result') {
      out.push({ at, kind: 'result', text: clip(resultText(c.content), MAX_RESULT_CHARS), error: c.is_error === true });
    }
  }
  return out;
}

export function defaultProjectsDir(): string {
  const base = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  return path.join(base, 'projects');
}

export function projectSlug(worktree: string): string {
  return worktree.replace(/[^A-Za-z0-9]/g, '-');
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

export function parseUsageLine(line: string): [string, MessageUsage] | null {
  if (!line.includes('"usage"')) return null;
  let o: { type?: unknown; timestamp?: unknown; uuid?: unknown; message?: { id?: unknown; model?: unknown; usage?: Record<string, unknown> } };
  try {
    o = JSON.parse(line);
  } catch {
    return null;
  }
  const u = o.message?.usage;
  if (o.type !== 'assistant' || !u) return null;
  const at = typeof o.timestamp === 'string' ? Date.parse(o.timestamp) : NaN;
  if (Number.isNaN(at)) return null;
  const id = typeof o.message?.id === 'string' ? o.message.id : typeof o.uuid === 'string' ? o.uuid : `${at}`;
  return [
    id,
    {
      at,
      model: typeof o.message?.model === 'string' ? o.message.model : null,
      input: num(u.input_tokens),
      cacheCreation: num(u.cache_creation_input_tokens),
      cacheRead: num(u.cache_read_input_tokens),
      output: num(u.output_tokens),
    },
  ];
}

export class UsageReader {
  private readonly files = new Map<string, FileState>();
  readonly projectsDir: string;

  constructor(projectsDir: string) {
    this.projectsDir = projectsDir;
  }

  private update(file: string): FileState | null {
    let size: number;
    try {
      size = statSync(file).size;
    } catch {
      this.files.delete(file);
      return null;
    }
    let st = this.files.get(file);
    if (!st || size < st.size) {
      st = { size: 0, offset: 0, partial: '', decoder: new StringDecoder('utf8'), messages: new Map(), entries: [] };
      this.files.set(file, st);
    }
    if (size === st.offset) return st;
    const fd = openSync(file, 'r');
    try {
      const chunk = Buffer.alloc(1 << 20);
      let pos = st.offset;
      while (pos < size) {
        const n = readSync(fd, chunk, 0, Math.min(chunk.length, size - pos), pos);
        if (n <= 0) break;
        pos += n;
        const text = st.partial + st.decoder.write(chunk.subarray(0, n));
        const lines = text.split('\n');
        st.partial = lines.pop() ?? '';
        for (const line of lines) {
          const parsed = parseUsageLine(line);
          if (parsed) st.messages.set(parsed[0], parsed[1]);
          for (const e of parseActivityLine(line)) st.entries.push(e);
        }
      }
      if (st.entries.length > MAX_ENTRIES_PER_FILE) st.entries.splice(0, st.entries.length - MAX_ENTRIES_PER_FILE);
      st.offset = pos;
      st.size = size;
    } finally {
      closeSync(fd);
    }
    return st;
  }

  // The latest steps of one worker's sessions since it was spawned, oldest first.
  activity(worktree: string, sinceMs: number | null, limit = 400): ActivityEntry[] | null {
    const dir = path.join(this.projectsDir, projectSlug(worktree));
    let names: string[];
    try {
      names = readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
    } catch {
      return null;
    }
    const all: ActivityEntry[] = [];
    for (const name of names) {
      const st = this.update(path.join(dir, name));
      if (!st) continue;
      for (const e of st.entries) if (sinceMs === null || e.at >= sinceMs) all.push(e);
    }
    all.sort((a, b) => a.at - b.at);
    return all.slice(-limit);
  }

  // Usage for one worker since it was spawned (pool worktrees are reused, so
  // older sessions in the same directory belong to earlier tasks).
  read(worktree: string, sinceMs: number | null): WorkerUsage | null {
    const dir = path.join(this.projectsDir, projectSlug(worktree));
    let names: string[];
    try {
      names = readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
    } catch {
      return null;
    }
    const all: MessageUsage[] = [];
    for (const name of names) {
      const st = this.update(path.join(dir, name));
      if (!st) continue;
      for (const m of st.messages.values()) if (sinceMs === null || m.at >= sinceMs) all.push(m);
    }
    if (all.length === 0) return null;
    all.sort((a, b) => a.at - b.at);
    const last = all[all.length - 1];
    const sum = (k: 'input' | 'cacheCreation' | 'cacheRead' | 'output') => all.reduce((acc, m) => acc + m[k], 0);
    return {
      model: last.model,
      contextTokens: last.input + last.cacheCreation + last.cacheRead,
      inputTokens: sum('input') + sum('cacheCreation'),
      cacheReadTokens: sum('cacheRead'),
      outputTokens: sum('output'),
      messages: all.length,
      lastAt: last.at,
    };
  }
}

// spawn_gen=s<epoch>.<pid>.<rand> in the meta records when the worker started.
export function spawnTime(meta: Record<string, string>): number | null {
  const m = /^s(\d+)\./.exec(meta.spawn_gen ?? '');
  return m ? Number(m[1]) * 1000 : null;
}
