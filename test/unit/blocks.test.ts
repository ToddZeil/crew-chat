import { describe, expect, it } from 'vitest';
import { splitBlocks } from '../../client/blocks.ts';

describe('splitBlocks', () => {
  it('pulls a Markdown table out of surrounding text', () => {
    const text = 'Results:\n| Platform | Rate |\n| --- | ---: |\n| iOS | 22% |\n| Web | 30% |\nThat is all.';
    expect(splitBlocks(text)).toEqual([
      { kind: 'text', text: 'Results:' },
      { kind: 'table', text: '| Platform | Rate |\n| --- | ---: |\n| iOS | 22% |\n| Web | 30% |' },
      { kind: 'text', text: 'That is all.' },
    ]);
  });

  it('keeps a box-drawn terminal table together', () => {
    const box = '┌──────┬─────┐\n│ name │ ok  │\n├──────┼─────┤\n│ a    │ yes │\n└──────┴─────┘';
    expect(splitBlocks(`before\n${box}\nafter`).map((b) => b.kind)).toEqual(['text', 'box', 'text']);
  });

  it('leaves plain text and lone pipes alone', () => {
    expect(splitBlocks('a | b\nno rule here')).toEqual([{ kind: 'text', text: 'a | b\nno rule here' }]);
    expect(splitBlocks('one ─ dash')).toEqual([{ kind: 'text', text: 'one ─ dash' }]);
  });
});
