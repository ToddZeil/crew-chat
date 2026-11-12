// Spots a First mate reply that asks the captain to type something in its own
// terminal, which is the only place Claude Code accepts an approval. The words
// to type are returned when the reply quotes them.

// "the main terminal", "First mate's terminal", "that terminal", ...
const TERMINAL = /\b(?:main|supervisor|first\s?mate'?s?|firstmate'?s?|captain'?s?|own|that|the)\s+(?:terminal|session|pane)\b/i;
// "type / send / paste / enter / say / reply with" followed by quoted words.
const WORDS = /\b(?:type|send|paste|enter|say|reply(?:\s+with)?)\s+(?:in\s+)?["“'‘\x60]([^"”'’\x60\n]{1,200})["”'’\x60]/i;
const ASK = /\b(?:typ(?:e|ed|ing)|approv\w*|confirm\w*|go-ahead|paste|send)\b/i;

export function typedApproval(text: string): { words: string | null } | null {
  if (!TERMINAL.test(text)) return null;
  const quoted = WORDS.exec(text);
  if (quoted) return { words: quoted[1].trim() };
  return ASK.test(text) ? { words: null } : null;
}
