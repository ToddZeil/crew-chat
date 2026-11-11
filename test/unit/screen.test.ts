import { describe, expect, it } from 'vitest';
import { addFrame, historyText, scrollShift, type ScreenHistory } from '../../client/screen.ts';

const screen = (...lines: string[]) => lines.join('\n');
const empty: ScreenHistory = { past: [], frame: [] };

describe('screen history', () => {
  it('keeps lines that scroll off the top', () => {
    let h = addFrame(empty, screen('one', 'two', 'three', 'four', '> input'));
    h = addFrame(h, screen('three', 'four', 'five', 'six', '> input'));
    expect(h.past).toEqual(['one', 'two']);
    expect(historyText(h)).toBe(screen('one', 'two', 'three', 'four', 'five', 'six', '> input'));
  });

  it('replaces a frame redrawn in place instead of piling it up', () => {
    let h = addFrame(empty, screen('alpha', 'beta', 'gamma', '⠋ Thinking'));
    h = addFrame(h, screen('alpha', 'beta', 'gamma', '⠙ Thinking'));
    h = addFrame(h, screen('alpha', 'beta', 'gamma', '⠹ Thinking'));
    expect(h.past).toEqual([]);
    expect(h.frame.at(-1)).toBe('⠹ Thinking');
  });

  it('ignores colour codes when lining frames up', () => {
    const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
    expect(scrollShift([red('a'), 'b', 'c', 'd'], ['c', red('d'), 'e', 'f'])).toBe(2);
  });

  it('keeps a cleared screen whole, without its blank padding', () => {
    let h = addFrame(empty, screen('old 1', 'old 2', 'old 3', 'old 4', 'old 5', '', ''));
    h = addFrame(h, screen('brand new', 'screen', 'entirely', 'different', 'now', '', ''));
    expect(h.past).toEqual(['old 1', 'old 2', 'old 3', 'old 4', 'old 5']);
    expect(h.frame[0]).toBe('brand new');
  });

  it('does not treat a screen of blank lines as a match', () => {
    expect(scrollShift(['', '', '', 'x'], ['', '', '', 'y'])).toBeNull();
  });
});
