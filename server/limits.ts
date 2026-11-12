// Claude's plan usage, read from a worker terminal's status bar. Claude Code
// shows rate limits there only when the status line is set up to print them,
// so this reads the common shapes and reports nothing when none is present:
//   "5h:76% (resets in 0h6m) 7d:86% (resets in 2d3h)"
//   "7d:86% (76% resets in 0h6m)"   (a bracketed % is the five-hour window)
import type { ClaudeLimits } from '../shared/types.ts';

const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*(?:\x07|\x1b\\)/g;
const WINDOW = /\b(5h|7d|session|week(?:ly)?)\s*:?\s*(\d{1,3})(?:\.\d+)?%(?:\s*\(\s*(?:(\d{1,3})(?:\.\d+)?%\s*)?resets?\s+in\s+([0-9dhm ]+?)\s*\))?/gi;
const LOOSE_RESET = /(?:(\d{1,3})(?:\.\d+)?%\s+)?resets?\s+in\s+((?:\d+\s*[dhm]\s*)+)/i;

function pct(s: string | undefined): number | null {
  if (s === undefined) return null;
  const n = Number(s);
  return Number.isFinite(n) && n >= 0 && n <= 100 ? n : null;
}

export function durationMs(s: string | undefined): number | null {
  if (!s || !/\d/.test(s)) return null;
  const part = (u: string) => Number(new RegExp(`(\\d+)\\s*${u}`).exec(s)?.[1] ?? 0);
  return (part('d') * 86_400 + part('h') * 3600 + part('m') * 60) * 1000;
}

export function parseStatusBar(screen: string, at: number): Omit<ClaudeLimits, 'from'> | null {
  const lines = screen.replace(ANSI, '').split('\n');
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  // The status bar sits under the prompt, so only the bottom of the screen counts.
  for (const line of lines.slice(-8).reverse()) {
    let fiveHour: number | null = null;
    let sevenDay: number | null = null;
    let fiveReset: number | null = null;
    let weekReset: number | null = null;
    for (const m of line.matchAll(WINDOW)) {
      const weekly = /^(7d|week)/i.test(m[1]);
      const reset = durationMs(m[4]);
      if (weekly) sevenDay = pct(m[2]);
      else fiveHour = pct(m[2]);
      if (m[3] !== undefined) {
        fiveHour = pct(m[3]);
        fiveReset = reset;
      } else if (weekly) weekReset = reset;
      else fiveReset = reset;
    }
    if (fiveHour === null && sevenDay === null) continue;
    if (fiveReset === null && weekReset === null) {
      const loose = LOOSE_RESET.exec(line);
      if (loose) {
        fiveReset = durationMs(loose[2]);
        fiveHour ??= pct(loose[1]);
      }
    }
    return {
      fiveHour,
      sevenDay,
      resetsAt: fiveReset === null ? null : at + fiveReset,
      weekResetsAt: weekReset === null ? null : at + weekReset,
      at,
    };
  }
  return null;
}
