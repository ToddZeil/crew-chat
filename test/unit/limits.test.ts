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
    expect(parseStatusBar(screen, AT)).toEqual({ fiveHour: 76, sevenDay: 86, resetsAt: AT + (3600 + 360) * 1000, weekResetsAt: null, at: AT });
  });

  it('reads "5h:" and "week" labels, and a countdown in minutes only', () => {
    expect(parseStatusBar('Sonnet | 5h: 12% | week 40% | resets in 45m', AT)).toEqual({ fiveHour: 12, sevenDay: 40, resetsAt: AT + 45 * 60_000, weekResetsAt: null, at: AT });
  });

  it('gives each window its own reset when both are shown', () => {
    expect(parseStatusBar('Opus | context: 25% | 5h:76% (resets in 0h6m) 7d:86% (resets in 2d3h) $9.00', AT)).toEqual({
      fiveHour: 76,
      sevenDay: 86,
      resetsAt: AT + 6 * 60_000,
      weekResetsAt: AT + (2 * 86_400 + 3 * 3600) * 1000,
      at: AT,
    });
  });

  it('keeps the 5h figure when a narrow pane cuts the countdown short', () => {
    expect(parseStatusBar('🐱 Sonnet 5.5 | app | context: 11% | 7d:97% (67% resets in …', AT)).toEqual({
      fiveHour: 67,
      sevenDay: 97,
      resetsAt: null,
      weekResetsAt: null,
      at: AT,
    });
  });

  it('ignores context percentages and usage text higher up the screen', () => {
    const screen = ['7d:99% mentioned in a message', ...Array(10).fill(''), 'Opus | context: 57% | $1.00'].join('\n');
    expect(parseStatusBar(screen, AT)).toBeNull();
  });
});
