// Breaks a long one-line decision into sentences, and turns the lists packed
// inside them ("x (a; b; c)." or "Lead: a, b, c, d.") into bullet points.

export interface Para {
  lead: string;
  items: string[];
}

const ABBREV = /\b(?:e\.g|i\.e|vs|etc|approx|incl|cf)\.$/i;

// Splits at top-level separators only: never inside brackets, quotes or a URL.
function splitTop(text: string, at: (s: string, i: number) => number): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '(' || c === '[') depth++;
    else if ((c === ')' || c === ']') && depth > 0) depth--;
    if (depth > 0) continue;
    const len = at(text, i);
    if (len > 0) {
      out.push(text.slice(start, i + 1));
      start = i + 1 + len;
      i = start - 1;
    }
  }
  out.push(text.slice(start));
  return out.map((s) => s.trim()).filter(Boolean);
}

export function sentences(text: string): string[] {
  return splitTop(text, (s, i) => {
    if (!'.!?'.includes(s[i])) return 0;
    const m = /^\s+(?=[A-Z0-9'"(])/.exec(s.slice(i + 1));
    if (!m) return 0;
    if (ABBREV.test(s.slice(Math.max(0, i - 7), i + 1))) return 0;
    // A full stop inside a URL or file name is followed by no space, so it never matches here.
    return m[0].length;
  });
}

function listItems(body: string, sep: ';' | ','): string[] {
  const parts = splitTop(body, (s, i) => (s[i] === sep && /\s/.test(s[i + 1] ?? '') ? 1 : 0));
  return parts.map((p) => p.replace(new RegExp(`\\${sep}$`), '').replace(/^and\s+/i, '').trim());
}

function para(sentence: string): Para {
  const s = sentence.trim();
  const end = /[.!]$/.test(s) && !s.endsWith('..') ? s.slice(0, -1) : s;
  // "lead (a; b; c)" closing the sentence.
  if (end.endsWith(')')) {
    let depth = 0;
    let open = -1;
    for (let i = end.length - 1; i >= 0; i--) {
      if (end[i] === ')') depth++;
      else if (end[i] === '(' && --depth === 0) {
        open = i;
        break;
      }
    }
    if (open > 0) {
      const items = listItems(end.slice(open + 1, -1), ';');
      if (items.length >= 3) return { lead: `${end.slice(0, open).trim()}:`, items };
    }
  }
  // "Lead: a; b; c" or "Lead: a, b, c" with a short lead.
  const colon = /^([^:?]{3,60}):\s+(.+)$/.exec(end);
  if (colon && !/https?$/i.test(colon[1])) {
    for (const sep of [';', ','] as const) {
      const items = listItems(colon[2], sep);
      if (items.length >= 3 && items.every((x) => x.length <= 160)) return { lead: `${colon[1]}:`, items };
    }
  }
  return { lead: s, items: [] };
}

// Long single-line text only; anything the worker already laid out is left alone.
export function layoutDecision(text: string): Para[] | null {
  if (text.includes('\n') || text.length < 220) return null;
  const paras = sentences(text).map(para);
  return paras.length >= 2 || paras.some((p) => p.items.length) ? paras : null;
}
