// Claude's plan usage, read from a worker terminal's status bar. Claude Code
// shows rate limits there only when the status line is set up to print them,
// so this reads the common shapes ("7d:86%", "5h:40%", "(76% resets in 0h6m)")
// and reports nothing when none is present.
import type { ClaudeLimits } from '../shared/types.ts';

const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*(?:\x07|\x1b\\)/g;

function pct(s: string | undefined): number | null {
  if (s === undefined) return null;
  const n = Number(s);
  return Number.isFinite(n) && n >= 0 && n <= 100 ? n : null;
}

export function parseStatusBar(screen: string, at: number): Omit<ClaudeLimits, 'from'> | null {
  const lines = screen.replace(ANSI, '').split('\n');
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  // The status bar sits under the prompt, so only the bottom of the screen counts.
  for (const line of lines.slice(-8).reverse()) {
    const week = pct(/\b(?:7d|week(?:ly)?)\s*:?\s*(\d{1,3})(?:\.\d+)?%/i.exec(line)?.[1]);
    const reset = /(?:(\d{1,3})(?:\.\d+)?%\s+)?resets? in\s+(?:(\d+)h)?\s*(?:(\d+)m)?/i.exec(line);
    const five = pct(/\b(?:5h|session)\s*:?\s*(\d{1,3})(?:\.\d+)?%/i.exec(line)?.[1] ?? reset?.[1]);
    if (week === null && five === null) continue;
    const secs = reset && (reset[2] || reset[3]) ? Number(reset[2] ?? 0) * 3600 + Number(reset[3] ?? 0) * 60 : null;
    return { fiveHour: five, sevenDay: week, resetsAt: secs === null ? null : at + secs * 1000, at };
  }
  return null;
}
