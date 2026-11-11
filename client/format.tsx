import { useContext, useState, type ReactNode } from 'react';
import { DocContext } from './docs.tsx';
import { isImagePath, isMarkdownPath, splitBlocks } from './blocks.ts';
import { Markdown } from './markdown.tsx';
import type { Badge } from '../shared/types.ts';

const VERB_LABELS: Record<string, string> = {
  'needs-decision': 'Needs your decision',
  blocked: 'Blocked',
  done: 'Done',
  working: 'Working',
  paused: 'Paused',
  failed: 'Failed',
  resolved: 'Resolved',
  'captain-held': 'Handed to the captain',
  queued: 'Queued',
  requested: 'Requested',
  reply: 'Reply',
  finished: 'Finished',
};

export function verbLabel(verb: string): string {
  if (VERB_LABELS[verb]) return VERB_LABELS[verb];
  const words = verb.replace(/[-_]+/g, ' ').trim();
  return words ? words[0].toUpperCase() + words.slice(1) : 'Update';
}

export function verbTone(verb: string): 'attention' | 'good' | 'busy' | 'muted' | 'bad' {
  switch (verb) {
    case 'needs-decision':
    case 'blocked':
      return 'attention';
    case 'done':
    case 'resolved':
      return 'good';
    case 'working':
    case 'queued':
    case 'requested':
    case 'reply':
      return 'busy';
    case 'failed':
      return 'bad';
    default:
      return 'muted';
  }
}

export const BADGE_LABELS: Record<Badge, string> = {
  'needs-you': 'Needs you',
  working: 'Working',
  ready: 'Ready',
  stopped: 'Stopped',
  checking: 'Checking',
  queued: 'Queued',
  requested: 'Requested',
  finished: 'Finished',
};

export function relativeTime(ms: number, now: number): string {
  const diff = Math.round((now - ms) / 1000);
  if (diff < 45) return 'just now';
  const min = Math.round(diff / 60);
  if (min < 60) return `${min} min ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr} hr ago`;
  const day = Math.round(hr / 24);
  if (day < 7) return day === 1 ? 'yesterday' : `${day} days ago`;
  return new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: day > 300 ? 'numeric' : undefined });
}

export function exactTime(ms: number): string {
  return new Date(ms).toLocaleString(undefined, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
  });
}

export function TimeAgo({ at, now, prefix }: { at: number | null; now: number; prefix?: string }) {
  if (at === null) return <span className="time time-unknown" title="This update has no time stamp.">earlier</span>;
  return (
    <time className="time" dateTime={new Date(at).toISOString()} title={exactTime(at)}>
      {prefix}
      {relativeTime(at, now)}
    </time>
  );
}

function prLabel(url: string): string | null {
  const m = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/.exec(url);
  return m ? `${m[2]} PR #${m[3]}` : null;
}

export function ExternalLink({ url }: { url: string }) {
  const pr = prLabel(url);
  return (
    <a className={pr ? 'link pr-link' : 'link'} href={url} target="_blank" rel="noreferrer noopener" title={url}>
      {pr ?? url}
    </a>
  );
}

function CopyPath({ path }: { path: string }) {
  const [copied, setCopied] = useState(false);
  const openDoc = useContext(DocContext);
  const copy = () => {
    void navigator.clipboard?.writeText(path).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1400);
      },
      () => undefined,
    );
  };
  if (openDoc && (isMarkdownPath(path) || isImagePath(path))) {
    return (
      <span className="path">
        <button type="button" className="path-open" title="Preview this file" onClick={() => openDoc(path)}>
          <code>{path}</code>
          <span className="path-hint">Preview</span>
        </button>
        <button type="button" className="path-copy" title="Copy this path" onClick={copy}>
          {copied ? 'Copied' : 'Copy'}
        </button>
      </span>
    );
  }
  return (
    <button type="button" className="path" title="Copy this path" onClick={copy}>
      <code>{path}</code>
      <span className="path-hint">{copied ? 'Copied' : 'Copy'}</span>
    </button>
  );
}

// URLs become links; absolute, home-relative, and dir/file.ext paths become
// copy buttons. Everything else stays plain text.
const TOKEN = /(https?:\/\/[^\s<>"'`]+)|((?<![\w/:.])(?:~|\/)[\w.@+-]+(?:\/[\w.@+-]+)+\/?|(?<![\w/:.])[\w.-]+\/[\w./-]*\.[A-Za-z]\w{0,5}\b)/g;

let uploadDir: string | null = null;

// Pasted images are sent as "[image: <path>]"; ones saved by this app show
// inline.
export function setUploadDir(dir: string | null): void {
  uploadDir = dir;
}

const IMAGE_TOKEN = /\[image: ([^\]\n]+)\]/g;

export function imageMarker(path: string): string {
  return `[image: ${path}]`;
}

export function RichText({ text }: { text: string }) {
  if (!text.includes('[image: ')) return <PlainRich text={text} />;
  const out: ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(IMAGE_TOKEN)) {
    const file = m[1].trim();
    const start = m.index ?? 0;
    const name = file.split('/').pop() ?? '';
    if (!uploadDir || !file.startsWith(`${uploadDir}/`) || !/^[A-Za-z0-9-]+\.(png|jpg|gif|webp)$/.test(name)) continue;
    if (start > last) out.push(<PlainRich key={`t${last}`} text={text.slice(last, start)} />);
    const url = `/api/uploads/${name}`;
    out.push(<InlineImage key={`i${start}`} url={url} file={file} />);
    last = start + m[0].length;
  }
  if (last < text.length) out.push(<PlainRich key={`t${last}`} text={text.slice(last)} />);
  return <>{out}</>;
}

function InlineImage({ url, file }: { url: string; file: string }) {
  const openDoc = useContext(DocContext);
  if (!openDoc) {
    return (
      <a className="msg-image" href={url} target="_blank" rel="noreferrer noopener" title={file}>
        <img src={url} alt="Pasted image" loading="lazy" />
      </a>
    );
  }
  return (
    <button type="button" className="msg-image" title="Click to view full size" onClick={() => openDoc(file)}>
      <img src={url} alt="Pasted image" loading="lazy" />
    </button>
  );
}

function PlainRich({ text }: { text: string }) {
  const out: ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(TOKEN)) {
    let token = m[0];
    const trail = /[).,;:!?\]]+$/.exec(token);
    if (trail) token = token.slice(0, -trail[0].length);
    if (!token) continue;
    const start = m.index ?? 0;
    if (start > last) out.push(text.slice(last, start));
    out.push(m[1] ? <ExternalLink key={start} url={token} /> : <CopyPath key={start} path={token} />);
    last = start + token.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return <>{out}</>;
}

const LONG_CHARS = 420;
const LONG_LINES = 7;

// The opening of a long message. A table the cut would land inside is kept
// whole, so a collapsed message never shows half a table.
function collapsed(text: string): string {
  const out: string[] = [];
  let budget = LONG_LINES;
  let chars = LONG_CHARS;
  for (const b of splitBlocks(text)) {
    if (budget <= 0 || chars <= 0) break;
    if (b.kind !== 'text') {
      out.push(b.text);
      budget -= b.text.split('\n').length;
      chars -= Math.min(b.text.length, 120);
      continue;
    }
    let part = b.text.split('\n').slice(0, budget).join('\n');
    if (part.length > chars) part = part.slice(0, chars).replace(/\s+\S*$/, '');
    out.push(part);
    budget -= part.split('\n').length;
    chars -= part.length;
  }
  return `${out.join('\n')}...`;
}

export function Collapsible({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const lines = text.split('\n');
  const long = text.length > LONG_CHARS || lines.length > LONG_LINES;
  if (!long) {
    return (
      <div className="body">
        <Blocks text={text} />
      </div>
    );
  }
  let shown = text;
  if (!open) shown = collapsed(text);
  return (
    <div className="body">
      <Blocks text={shown} />
      <button type="button" className="more" onClick={() => setOpen(!open)} aria-expanded={open}>
        {open ? 'Show less' : 'Show more'}
      </button>
    </div>
  );
}

export function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(n < 10_000_000 ? 2 : 1)}M`;
}

// Message text with its tables shown as tables: Markdown tables rendered,
// box-drawn terminal tables kept monospaced so their columns line up.
export function Blocks({ text }: { text: string }) {
  const blocks = splitBlocks(text);
  if (blocks.length === 1 && blocks[0].kind === 'text') return <RichText text={text} />;
  return (
    <>
      {blocks.map((b, i) =>
        b.kind === 'table' ? (
          <Markdown key={i} text={b.text} className="md md-table" />
        ) : b.kind === 'box' ? (
          <pre key={i} className="box-table">
            {b.text}
          </pre>
        ) : (
          <RichText key={i} text={b.text} />
        ),
      )}
    </>
  );
}

export function initials(title: string): string {
  const words = title.replace(/[^A-Za-z0-9 -]/g, ' ').split(/[\s-]+/).filter(Boolean);
  return ((words[0]?.[0] ?? '?') + (words[1]?.[0] ?? '')).toUpperCase();
}

export function hue(id: string): number {
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return h;
}
