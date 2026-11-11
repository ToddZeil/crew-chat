import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { compileAnswer, formFilled } from '../../client/model.ts';
import { asksApproval, decisionForm, inlineQuestions, letteredOptions, questionLabel, recommendation, reportQuestions } from '../../server/questions.ts';

const REPORT = `# Plan

## Summary

1. Not a question, just a list item.

## Open questions for the captain

1. **Who can see the board?** Only you, or the whole team? (I recommend the whole team, with edit rights for leads.)
2. **History depth:** the last 12 months (recommended) or back to 2022?
3. **Rubric:** is paying > trial > internal the right order,
   and should founders get a multiplier?

\`\`\`
4. inside a fence, ignored
\`\`\`

## Verified vs inferred

1. Not a question either.
`;

describe('reportQuestions', () => {
  it('takes the numbered items under the open-questions heading only', () => {
    const r = reportQuestions(REPORT);
    expect(r?.heading).toBe('Open questions for the captain');
    expect(r?.questions.map((q) => q.n)).toEqual(['1', '2', '3']);
    expect(r?.questions[2].text).toBe('**Rubric:** is paying > trial > internal the right order, and should founders get a multiplier?');
  });

  it('finds the suggestion in either form', () => {
    const qs = reportQuestions(REPORT)!.questions;
    expect(qs[0].recommendation).toBe('the whole team, with edit rights for leads');
    expect(qs[1].recommendation).toBe('the last 12 months');
    expect(qs[2].recommendation).toBeNull();
  });

  it('returns null without such a section', () => {
    expect(reportQuestions('# Plan\n\n1. a\n2. b\n')).toBeNull();
  });
});

describe('questionLabel', () => {
  it('uses the bold lead, else the first sentence', () => {
    expect(questionLabel('**Who can see the board?** Only you?')).toBe('Who can see the board?');
    expect(questionLabel('Should it page anyone? It is not urgent.')).toBe('Should it page anyone?');
  });
});

describe('recommendation', () => {
  it('reads "I suggest" too, and nothing when there is none', () => {
    expect(recommendation('Ship it now? (I suggest waiting a day.)')).toBe('waiting a day');
    expect(recommendation('Ship it now?')).toBeNull();
  });
});

describe('letteredOptions', () => {
  it('splits (A) (B) (C) choices and ends the last at its sentence', () => {
    const text =
      "Where should it live? Options: (A) move it to your account, history kept; (B) move it to an org you name; (C) make it private for now, then move it. Note: you may need sign-off. Reply A, B, or C.";
    expect(letteredOptions(text)).toEqual([
      { label: 'A', text: 'move it to your account, history kept' },
      { label: 'B', text: 'move it to an org you name' },
      { label: 'C', text: 'make it private for now, then move it' },
    ]);
  });

  it('needs at least two in sequence', () => {
    expect(letteredOptions('See (A) only.')).toEqual([]);
    expect(letteredOptions('(B) one (C) two')).toEqual([]);
  });
});

describe('inlineQuestions', () => {
  it('lists each sentence that asks something', () => {
    const qs = inlineQuestions('Two things. Should sort_by take a list? Should it default to newest first? I lean yes.');
    expect(qs.map((q) => q.text)).toEqual(['Should sort_by take a list?', 'Should it default to newest first?']);
  });
});

describe('asksApproval', () => {
  it('spots a pending plan approval', () => {
    expect(asksApproval('Captain still owes plan approval + 9 open questions')).toBe(true);
    expect(asksApproval('Should sort_by take a list?')).toBe(false);
  });
});

describe('decisionForm', () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'crew-chat-questions-'));
  mkdirSync(path.join(home, 'data', 'plan-w'), { recursive: true });
  writeFileSync(path.join(home, 'data', 'plan-w', 'report.md'), REPORT);
  afterAll(() => rmSync(home, { recursive: true, force: true }));

  it('pulls the report questions when the decision mentions them', () => {
    const f = decisionForm(home, 'plan-w', 'Plan is in report.md. Captain owes plan approval + 3 open questions.');
    expect(f?.approval).toBe(true);
    expect(f?.questions).toHaveLength(3);
    expect(f?.source?.path).toBe(path.join(home, 'data', 'plan-w', 'report.md'));
  });

  it('ignores the report when the decision does not mention questions', () => {
    expect(decisionForm(home, 'plan-w', 'Merge now or wait for CI?')).toBeNull();
  });

  it('falls back to the questions in the decision text', () => {
    const f = decisionForm(home, 'other', 'Should it take a list? Should it default to newest?');
    expect(f?.source).toBeNull();
    expect(f?.questions).toHaveLength(2);
  });
});

describe('compileAnswer', () => {
  const form = {
    source: { path: '/h/data/w/report.md', heading: 'Open questions' },
    questions: [
      { n: '1', text: '**Who can see it?** ...', label: 'Who can see it?', recommendation: null },
      { n: '2', text: '**Depth:** ...', label: 'Depth', recommendation: null },
      { n: '3', text: '**Rubric:** ...', label: 'Rubric', recommendation: null },
    ],
    options: [],
    approval: true,
  };

  it('puts the approval first, then each answer by number, the open ones, and the rest', () => {
    const text = compileAnswer(form, { approval: 'Approved', option: null, answers: { '1': 'The whole team', '3': ' Yes,\n as proposed ' }, other: 'Thanks.' });
    expect(text).toBe(
      'Plan: Approved.\n\nAnswers to the open questions in report.md:\n1. Who can see it? The whole team\n3. Rubric: Yes, as proposed\nNot answered yet: 2.\n\nThanks.',
    );
  });

  it('names a picked option with its text', () => {
    const f = { ...form, questions: [], approval: false, source: null, options: [{ label: 'A', text: 'move it' }, { label: 'B', text: 'keep it' }] };
    expect(compileAnswer(f, { approval: null, option: 'B', answers: {}, other: '' })).toBe('Choice: (B) keep it.');
    expect(formFilled(f, { approval: null, option: null, answers: {}, other: ' ' })).toBe(false);
  });
});
