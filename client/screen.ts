// Scrollback for a terminal that keeps none. Claude Code redraws one screen in
// place, so tmux has no history to hand over; the panel builds its own from
// successive captures. Each new frame is lined up against the previous one:
// lines that scrolled off are kept, and anything redrawn in place (a spinner,
// the input box) just replaces the old frame.

export interface ScreenHistory {
  // Lines that scrolled off earlier frames, oldest first.
  past: string[];
  // The latest frame, as captured.
  frame: string[];
}

const MAX_PAST = 5000;
const SAMPLE = 12;
// A changed region this small with no scroll is a redraw in place, such as a
// spinner or a status line, and is not worth keeping.
const IN_PLACE_LINES = 3;

// ANSI colour codes are ignored when comparing lines.
function plain(line: string): string {
  return line.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').trimEnd();
}

interface Split {
  head: number;
  a: string[];
  b: string[];
}

// A frame is a static head (lines unchanged at the top), a middle that
// scrolls, and a static footer (an input box or status bar at the bottom).
function split(prev: string[], next: string[]): Split {
  const a = prev.map(plain);
  const b = next.map(plain);
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let foot = 0;
  while (foot < a.length - head && foot < b.length - head && a[a.length - 1 - foot] === b[b.length - 1 - foot]) foot++;
  return { head, a: a.slice(head, a.length - foot), b: b.slice(head, b.length - foot) };
}

function shiftOf(a: string[], b: string[]): number | null {
  for (let d = 0; d < a.length; d++) {
    const n = Math.min(SAMPLE, a.length - d, b.length);
    let compared = 0;
    let equal = 0;
    for (let i = 0; i < n; i++) {
      // Blank lines match anything and prove nothing.
      if (a[d + i] === '' && b[i] === '') continue;
      compared++;
      if (a[d + i] === b[i]) equal++;
    }
    if (compared >= 2 && equal / compared >= 0.75) return d;
  }
  return null;
}

// How many lines of the old frame's scrolling region moved off the top to
// make the new frame; null when nothing lines up.
export function scrollShift(prev: string[], next: string[]): number | null {
  const { a, b } = split(prev, next);
  if (a.length === 0) return 0;
  return shiftOf(a, b);
}

export function addFrame(h: ScreenHistory, text: string): ScreenHistory {
  const next = text.replace(/\n+$/, '').split('\n');
  if (h.frame.length === 0) return { past: h.past, frame: next };
  const { head, a, b } = split(h.frame, next);
  let gone: string[] = [];
  if (a.length > 0) {
    const d = shiftOf(a, b);
    if (d !== null) gone = h.frame.slice(head, head + d);
    else if (a.length > IN_PLACE_LINES) {
      // The screen was cleared or replaced: keep what it showed, without its
      // blank padding.
      gone = h.frame.slice(head, head + a.length);
      while (gone.length && plain(gone[gone.length - 1]) === '') gone.pop();
    }
  }
  const past = gone.length ? [...h.past, ...gone].slice(-MAX_PAST) : h.past;
  return { past, frame: next };
}

export function historyText(h: ScreenHistory): string {
  return [...h.past, ...h.frame].join('\n');
}
