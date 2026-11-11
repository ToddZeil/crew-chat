import type { CSSProperties, ReactNode } from 'react';

// Enough of ANSI SGR to show a terminal faithfully: 16, 256, and true colour,
// bold, dim, italic, underline, inverse. Other escape sequences are dropped.

const BASIC = [
  '#1d1f21', '#e5534b', '#57ab5a', '#c69026', '#539bf5', '#b083f0', '#39c5cf', '#d1d2d3',
  '#636e7b', '#ff938a', '#6bc46d', '#daaa3f', '#6cb6ff', '#dcbdfb', '#56d4dd', '#ffffff',
];

function color256(n: number): string {
  if (n < 16) return BASIC[n];
  if (n >= 232) {
    const v = 8 + (n - 232) * 10;
    return `rgb(${v},${v},${v})`;
  }
  const i = n - 16;
  const step = (x: number) => (x === 0 ? 0 : 55 + x * 40);
  return `rgb(${step(Math.floor(i / 36))},${step(Math.floor(i / 6) % 6)},${step(i % 6)})`;
}

interface Style {
  fg?: string;
  bg?: string;
  bold?: boolean;
  dim?: boolean;
  italic?: boolean;
  underline?: boolean;
  inverse?: boolean;
}

function apply(style: Style, codes: number[]): Style {
  const s = { ...style };
  for (let i = 0; i < codes.length; i++) {
    const c = codes[i];
    if (c === 0) Object.keys(s).forEach((k) => delete s[k as keyof Style]);
    else if (c === 1) s.bold = true;
    else if (c === 2) s.dim = true;
    else if (c === 3) s.italic = true;
    else if (c === 4) s.underline = true;
    else if (c === 7) s.inverse = true;
    else if (c === 22) s.bold = s.dim = false;
    else if (c === 23) s.italic = false;
    else if (c === 24) s.underline = false;
    else if (c === 27) s.inverse = false;
    else if (c >= 30 && c <= 37) s.fg = BASIC[c - 30];
    else if (c >= 90 && c <= 97) s.fg = BASIC[c - 90 + 8];
    else if (c >= 40 && c <= 47) s.bg = BASIC[c - 40];
    else if (c >= 100 && c <= 107) s.bg = BASIC[c - 100 + 8];
    else if (c === 39) delete s.fg;
    else if (c === 49) delete s.bg;
    else if ((c === 38 || c === 48) && codes[i + 1] === 5) {
      const v = color256(codes[i + 2] ?? 0);
      if (c === 38) s.fg = v;
      else s.bg = v;
      i += 2;
    } else if ((c === 38 || c === 48) && codes[i + 1] === 2) {
      const v = `rgb(${codes[i + 2] ?? 0},${codes[i + 3] ?? 0},${codes[i + 4] ?? 0})`;
      if (c === 38) s.fg = v;
      else s.bg = v;
      i += 4;
    }
  }
  return s;
}

function css(s: Style): CSSProperties | undefined {
  const out: CSSProperties = {};
  const fg = s.inverse ? (s.bg ?? '#1a1d21') : s.fg;
  const bg = s.inverse ? (s.fg ?? '#d1d2d3') : s.bg;
  if (fg) out.color = fg;
  if (bg) out.background = bg;
  if (s.bold) out.fontWeight = 700;
  if (s.dim) out.opacity = 0.65;
  if (s.italic) out.fontStyle = 'italic';
  if (s.underline) out.textDecoration = 'underline';
  return Object.keys(out).length ? out : undefined;
}

export interface Segment {
  text: string;
  style: Style;
}

export function parseAnsi(input: string): Segment[] {
  const out: Segment[] = [];
  let style: Style = {};
  // CSI sequences (ESC [ ... final byte) and OSC sequences (ESC ] ... BEL or ST).
  const re = /\x1b\[([0-9;?]*)([A-Za-z])|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][A-Za-z0-9]|\x1b./g;
  let last = 0;
  for (const m of input.matchAll(re)) {
    const start = m.index ?? 0;
    if (start > last) out.push({ text: input.slice(last, start), style });
    if (m[2] === 'm') {
      const codes = (m[1] || '0').split(';').map((x) => (x === '' ? 0 : Number(x)));
      style = apply(style, codes);
    }
    last = start + m[0].length;
  }
  if (last < input.length) out.push({ text: input.slice(last), style });
  return out.filter((s) => s.text !== '');
}

export function Ansi({ text }: { text: string }): ReactNode {
  return parseAnsi(text).map((seg, i) => (
    <span key={i} style={css(seg.style)} className={seg.style.fg ? 'ansi-fg' : undefined}>
      {seg.text}
    </span>
  ));
}
