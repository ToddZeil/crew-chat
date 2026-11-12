import { describe, expect, it } from 'vitest';
import { parseStatusBar } from '../../server/limits.ts';

const AT = 1_000_000;

describe('parseStatusBar', () => {
  it('reads the 5-hour and weekly use and the reset countdown, through colour codes', () => {
    const screen = [
      'some output',
      '\x1b[38;5;244m────────\x1b[39m',
      '❯ ',
      '\x1b[37m\x1b[43m 🐱 Opus 5.5 | crew-chat | context: 25% | 7d:86% (76% resets in 1h6m) $97.52 \x1b[39m\x1b[49m',
      '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
    ].join('\n');
    expect(parseStatusBar(screen, AT)).toEqual({ fiveHour: 76, sevenDay: 86, resetsAt: AT + (3600 + 360) * 1000, at: AT });
  });

  it('reads "5h:" and "week" labels, and a countdown in minutes only', () => {
    expect(parseStatusBar('Sonnet | 5h: 12% | week 40% | resets in 45m', AT)).toEqual({ fiveHour: 12, sevenDay: 40, resetsAt: AT + 45 * 60_000, at: AT });
  });

  it('ignores context percentages and usage text higher up the screen', () => {
    const screen = ['7d:99% mentioned in a message', ...Array(10).fill(''), 'Opus | context: 57% | $1.00'].join('\n');
    expect(parseStatusBar(screen, AT)).toBeNull();
  });
});
