import { describe, expect, it } from 'vitest';
import { parseAnsi } from '../../client/ansi.tsx';

describe('parseAnsi', () => {
  it('splits text by colour and resets', () => {
    const segs = parseAnsi('\x1b[31mred\x1b[39m plain \x1b[1;38;5;46mgreen\x1b[0m end');
    expect(segs.map((s) => s.text)).toEqual(['red', ' plain ', 'green', ' end']);
    expect(segs[0].style.fg).toBe('#e5534b');
    expect(segs[1].style.fg).toBeUndefined();
    expect(segs[2].style).toMatchObject({ bold: true, fg: 'rgb(0,255,0)' });
    expect(segs[3].style).toEqual({});
  });

  it('reads true colour and drops other escape sequences', () => {
    const segs = parseAnsi('\x1b]0;title\x07\x1b[2K\x1b[38;2;10;20;30mx\x1b[m');
    expect(segs).toEqual([{ text: 'x', style: { fg: 'rgb(10,20,30)' } }]);
  });
});
