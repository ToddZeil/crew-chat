// Turns an open decision into a short form: the questions it asks, each with
// its own answer field, plus any lettered options and a plan approval. The
// questions come from the decision text itself or, when it points at them,
// from the "Open questions" section of the worker's report.
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import type { DecisionForm, DecisionQuestion } from '../shared/types.ts';

const MAX_REPORT_BYTES = 400_000;

function clean(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

// "(I recommend X.)" or "X (recommended)" inside a question.
export function recommendation(text: string): string | null {
  const said = /\((?:I|we) (?:recommend|suggest|propose)\s+([^)]+?)\.?\)/i.exec(text);
  if (said) return clean(said[1]);
  const tagged = /([^:;,?(]+?)\s*\((?:recommended|my pick)\)/i.exec(text);
  const proposed = /\bor\s+([^,?;]+?),?\s+as proposed\b/i.exec(text);
  if (proposed) return clean(proposed[1]);
  if (/\bas proposed\b/i.test(text)) return 'Yes, as proposed';
  if (tagged) return clean(tagged[1].replace(/^[\s*_]+/, '').replace(/^(?:either|or)\s+/i, ''));
  return null;
}

// The bold lead of a question, or its first sentence, for the compiled answer.
export function questionLabel(text: string): string {
  const bold = /^\*\*(.+?)\*\*/.exec(text.trim());
  const lead = bold ? bold[1] : (/^(.+?[?.:])(\s|$)/.exec(text.trim())?.[1] ?? text.trim());
  const plain = clean(lead.replace(/\*\*|__|`/g, '')).replace(/:$/, '');
  return plain.length > 140 ? `${plain.slice(0, 137)}...` : plain;
}

// Keeps the item's own line breaks, so a nested list still renders as one.
function question(n: string, text: string): DecisionQuestion {
  const t = clean(text);
  const md = text.trim().replace(/\n{3,}/g, '\n\n');
  return { n, text: md, label: questionLabel(t), recommendation: recommendation(t) };
}

// Numbered items under a heading that names open questions, up to the next
// heading of the same or a higher level.
export function reportQuestions(markdown: string): { heading: string; questions: DecisionQuestion[] } | null {
  const lines = markdown.split('\n');
  let start = -1;
  let level = 0;
  let heading = '';
  for (let i = 0; i < lines.length; i++) {
    const m = /^(#{1,6})\s+(.*\bquestions?\b.*)$/i.exec(lines[i]);
    if (m && /open|outstanding|for (?:the )?(?:captain|you|reviewer)|unanswered|to answer/i.test(m[2])) {
      start = i + 1;
      level = m[1].length;
      heading = clean(m[2].replace(/[*_`]/g, ''));
    }
  }
  if (start < 0) return null;
  const questions: DecisionQuestion[] = [];
  let current: { n: string; parts: string[] } | null = null;
  let inFence = false;
  const flush = () => {
    if (current) questions.push(question(current.n, current.parts.join('\n')));
    current = null;
  };
  for (let i = start; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
    if (inFence) continue;
    const h = /^(#{1,6})\s/.exec(line);
    if (h && h[1].length <= level) break;
    const item = /^\s{0,3}(\d{1,3})[.)]\s+(.*)$/.exec(line);
    if (item) {
      flush();
      current = { n: item[1], parts: [item[2]] };
    } else if (current && !line.trim()) {
      current.parts.push('');
    } else if (current && /^\s/.test(line)) {
      current.parts.push(line.replace(/^ {1,4}|^\t/, '').trimEnd());
    } else if (current && line.trim()) {
      // A non-indented paragraph ends the list item.
      flush();
    }
  }
  flush();
  return questions.length ? { heading, questions } : null;
}

// "(A) ...; (B) ...; or (C) ..." or "(1) ... (2) ..." in the decision text.
export function letteredOptions(text: string): { label: string; text: string }[] {
  const marks = [...text.matchAll(/\(([A-Z]|[1-9])\)\s+/g)];
  const first = marks.findIndex((m) => m[1] === 'A' || m[1] === '1');
  if (first < 0) return [];
  const seq: RegExpMatchArray[] = [];
  for (const m of marks.slice(first)) {
    const want = seq.length === 0 ? m[1] : String.fromCharCode(seq[seq.length - 1][1].charCodeAt(0) + 1);
    if (m[1] !== want) continue;
    seq.push(m);
  }
  if (seq.length < 2) return [];
  return seq.map((m, i) => {
    const from = (m.index ?? 0) + m[0].length;
    const to = i + 1 < seq.length ? (seq[i + 1].index ?? text.length) : text.length;
    let body = text.slice(from, to);
    // The last option runs to the end of its sentence.
    if (i + 1 === seq.length) body = body.split(/(?<=[.!?])\s+(?=[A-Z])/)[0];
    body = clean(body).replace(/[;,]?\s*(?:or|and)?$/i, '').replace(/[;,.]$/, '');
    return { label: m[1], text: body };
  });
}

// Sentences of the decision text that end in a question mark.
export function inlineQuestions(text: string): DecisionQuestion[] {
  return text
    .split(/(?<=[?.!])\s+(?=[A-Z'"(])|;\s+/)
    .map(clean)
    .filter((p) => p.endsWith('?') && p.length > 8)
    .map((p, i) => question(String(i + 1), p));
}

export function asksApproval(text: string): boolean {
  return /\b(?:plan approval|approve (?:the|this|my) (?:plan|approach|design)|needs? (?:your )?approval|awaiting approval|sign[- ]off)\b/i.test(text);
}

function readReport(file: string): string | null {
  try {
    if (!statSync(file).isFile()) return null;
    return readFileSync(file).subarray(0, MAX_REPORT_BYTES).toString('utf8');
  } catch {
    return null;
  }
}

// Question numbers the decision points at: "Q7", "question 3", "questions 2 and 5".
export function questionRefs(text: string): string[] {
  const refs = new Set<string>();
  for (const m of text.matchAll(/\bQ(\d{1,2})\b/g)) refs.add(String(Number(m[1])));
  for (const m of text.matchAll(/\bquestions?\s+((?:\d{1,2}(?:\s*(?:,|and|&)\s*)?)+)/gi)) {
    for (const n of m[1].match(/\d{1,2}/g) ?? []) refs.add(String(Number(n)));
  }
  return [...refs];
}

// Report questions are used only when the decision mentions questions, so an
// unrelated old section never turns up under a simple yes/no decision. When it
// names some by number, only those are still open.
export function decisionForm(home: string, id: string, text: string): DecisionForm | null {
  const reportPath = path.join(home, 'data', id, 'report.md');
  let source: DecisionForm['source'] = null;
  let questions: DecisionQuestion[] = [];
  const refs = questionRefs(text);
  if (refs.length || /\bquestions?\b/i.test(text)) {
    const md = readReport(reportPath);
    const found = md === null ? null : reportQuestions(md);
    const picked = found && refs.length ? found.questions.filter((q) => refs.includes(q.n)) : (found?.questions ?? []);
    if (found && picked.length) {
      questions = picked;
      source = { path: reportPath, heading: found.heading };
    }
  }
  if (!questions.length) {
    const inline = inlineQuestions(text);
    if (inline.length >= 2) questions = inline;
  }
  const options = letteredOptions(text);
  const approval = asksApproval(text);
  if (!questions.length && options.length < 2 && !approval) return null;
  return { source, questions, options, approval };
}
