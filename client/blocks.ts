// Pure text helpers for messages, kept free of the DOM so they can be
// tested without a browser.

export interface Block {
  kind: 'text' | 'table' | 'box';
  text: string;
}

const BOX_CHARS = /[│┃├┼┤┌┐└┘─━═║╔╗╚╝╠╣╬╭╮╰╯┬┴]/;
const TABLE_ROW = /^\s*\|.*\|\s*$/;
const TABLE_RULE = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/;

// Pull tables out of a message so they can be shown as tables: Markdown
// tables (a header row, then a --- rule) and box-drawn terminal tables.
export function splitBlocks(text: string): Block[] {
  const lines = text.split('\n');
  const out: Block[] = [];
  let buf: string[] = [];
  const flush = () => {
    if (buf.length) out.push({ kind: 'text', text: buf.join('\n') });
    buf = [];
  };
  let i = 0;
  while (i < lines.length) {
    if (TABLE_ROW.test(lines[i]) && i + 1 < lines.length && TABLE_RULE.test(lines[i + 1])) {
      let j = i + 2;
      while (j < lines.length && TABLE_ROW.test(lines[j])) j++;
      flush();
      out.push({ kind: 'table', text: lines.slice(i, j).join('\n') });
      i = j;
      continue;
    }
    if (BOX_CHARS.test(lines[i])) {
      let j = i;
      while (j < lines.length && BOX_CHARS.test(lines[j])) j++;
      if (j - i >= 2) {
        flush();
        out.push({ kind: 'box', text: lines.slice(i, j).join('\n') });
        i = j;
        continue;
      }
    }
    buf.push(lines[i]);
    i++;
  }
  flush();
  return out;
}

export function isImagePath(path: string): boolean {
  return /\.(png|jpe?g|gif|webp)$/i.test(path);
}

export function isMarkdownPath(path: string): boolean {
  return /\.(md|markdown)$/i.test(path);
}
