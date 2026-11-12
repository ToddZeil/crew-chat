// Spots a First mate reply that asks the captain to type an approval in its
// own terminal, which is the only place Claude Code accepts one. The words to
// type are returned when the reply quotes them.

const TERMINAL = String.raw`(?:the\s+|my\s+|your\s+|first\s?mate'?s\s+|firstmate'?s\s+)?(?:main|supervisor|first\s?mate'?s?|firstmate'?s?|captain'?s?|own)\s+(?:terminal|session|pane|window)`;
const QUOTED = new RegExp(String.raw`\btype\s+(?:in\s+)?["“'‘\x60]([^"”'’\x60\n]{1,200})["”'’\x60]\s+(?:in|into|at|on)\s+${TERMINAL}`, 'i');
const ANY = new RegExp(String.raw`\b(?:typ(?:e|ed|ing)|approv\w*|confirm\w*)\b[^.\n]{0,120}\b(?:in|into|at|from)\s+${TERMINAL}`, 'i');

export function typedApproval(text: string): { words: string | null } | null {
  const quoted = QUOTED.exec(text);
  if (quoted) return { words: quoted[1].trim() };
  return ANY.test(text) ? { words: null } : null;
}
