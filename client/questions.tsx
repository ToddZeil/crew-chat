import { useContext, useEffect, useRef, useState } from 'react';
import type { DecisionForm, WriteResult } from '../shared/types.ts';
import { api } from './api.ts';
import { DocContext } from './docs.tsx';
import { RichText } from './format.tsx';
import { layoutDecision } from './layout.ts';
import { renderMarkdown } from './markdown.tsx';
import { alreadyClosed, APPROVAL_CHOICES, compileAnswer, formFilled, loadJson, saveJson, type FormAnswers } from './model.ts';

// Questions are prose, so a placeholder like <link> is text, not a tag the
// sanitiser would drop. Code spans already show their text as written.
export function escapeTags(md: string): string {
  return md
    .split(/(`[^`]*`)/)
    .map((part, i) => (i % 2 ? part : part.replace(/</g, '&lt;')))
    .join('');
}

const EMPTY: FormAnswers = { approval: null, option: null, answers: {}, other: '' };

// Grows with its text, so a long answer stays readable without a scrollbar.
function GrowingText(props: { value: string; onChange: (v: string) => void; label: string; placeholder: string; disabled: boolean; inputRef?: (el: HTMLTextAreaElement | null) => void }) {
  const ref = useRef<HTMLTextAreaElement | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight + 2}px`;
  }, [props.value]);
  return (
    <textarea
      ref={(el) => {
        ref.current = el;
        props.inputRef?.(el);
      }}
      rows={1}
      className="q-input"
      value={props.value}
      aria-label={props.label}
      placeholder={props.placeholder}
      disabled={props.disabled}
      onChange={(e) => props.onChange(e.target.value)}
    />
  );
}

export function QuestionForm({
  form,
  threadId,
  decisionKey,
  readOnly,
  addNotice,
}: {
  form: DecisionForm;
  threadId: string;
  decisionKey: string;
  readOnly: boolean;
  addNotice: (tone: 'error' | 'warning', title: string, r: WriteResult) => void;
}) {
  const storeKey = `crew-chat:answers:${threadId}:${decisionKey}`;
  const [a, setA] = useState<FormAnswers>(() => ({ ...EMPTY, ...loadJson<Partial<FormAnswers>>(storeKey, {}) }));
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState(false);
  const openDoc = useContext(DocContext);
  const inputs = useRef(new Map<string, HTMLTextAreaElement>());

  const update = (next: FormAnswers) => {
    setA(next);
    saveJson(storeKey, next);
  };
  const setAnswer = (n: string, v: string) => update({ ...a, answers: { ...a.answers, [n]: v } });

  const total = form.questions.length;
  const done = form.questions.filter((q) => a.answers[q.n]?.trim()).length;
  const filled = formFilled(form, a);
  const text = compileAnswer(form, a);

  // A ref, not state, so a quick second click cannot send the answer twice
  // before the button redraws as disabled.
  const sending = useRef(false);
  const [sent, setSent] = useState(false);
  const submit = async () => {
    if (!filled || sending.current || sent || readOnly) return;
    sending.current = true;
    setBusy(true);
    const r = await api.answer(threadId, decisionKey, text);
    sending.current = false;
    setBusy(false);
    if (r.ok) {
      setSent(true);
      try {
        localStorage.removeItem(storeKey);
      } catch {
        // ignore
      }
    } else if (alreadyClosed(r)) {
      setSent(true);
      addNotice('warning', 'This decision was already answered, so nothing was sent again', r);
    } else addNotice('error', 'Your answers were not sent', r);
  };

  const sourceName = form.source?.path.split('/').pop();
  return (
    <section className="qform" data-testid="question-form" aria-label="Answer this decision">
      <header className="qform-head">
        <div className="qform-title">
          <strong>{total ? `${total} question${total === 1 ? '' : 's'} to answer` : 'Your answer'}</strong>
          {form.source && (
            <span className="qform-source">
              from{' '}
              {openDoc ? (
                <button type="button" className="link-btn" onClick={() => openDoc(form.source!.path)} title={form.source.path}>
                  {sourceName}
                </button>
              ) : (
                sourceName
              )}
              {' · '}
              {form.source.heading}
            </span>
          )}
        </div>
        {total > 0 && (
          <div className="qform-progress" aria-label={`${done} of ${total} answered`}>
            <span>
              {done} of {total} answered
            </span>
            <span className="qform-bar">
              <span style={{ width: `${(done / total) * 100}%` }} />
            </span>
          </div>
        )}
      </header>

      {form.approval && (
        <div className="qform-block">
          <div className="qform-label">Plan approval</div>
          <div className="seg" role="radiogroup" aria-label="Plan approval">
            {APPROVAL_CHOICES.map((c) => (
              <button
                key={c}
                type="button"
                role="radio"
                aria-checked={a.approval === c}
                className={a.approval === c ? 'seg-btn on' : 'seg-btn'}
                disabled={readOnly}
                onClick={() => update({ ...a, approval: a.approval === c ? null : c })}
              >
                {c}
              </button>
            ))}
          </div>
        </div>
      )}

      {form.options.length >= 2 && (
        <div className="qform-block">
          <div className="qform-label">Pick one</div>
          <div className="opts" role="radiogroup" aria-label="Options">
            {form.options.map((o) => (
              <button
                key={o.label}
                type="button"
                role="radio"
                aria-checked={a.option === o.label}
                className={a.option === o.label ? 'opt on' : 'opt'}
                disabled={readOnly}
                onClick={() => update({ ...a, option: a.option === o.label ? null : o.label })}
              >
                <span className="opt-letter">{o.label}</span>
                <span className="opt-text">{o.text}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {total > 0 && (
        <ol className="qlist">
          {form.questions.map((q) => {
            const answered = Boolean(a.answers[q.n]?.trim());
            return (
              <li key={q.n} className={answered ? 'q answered' : 'q'} data-testid="question">
                <span className="q-num" aria-hidden="true">
                  {answered ? '✓' : q.n}
                </span>
                <div className="q-main">
                  <div className="md q-text" dangerouslySetInnerHTML={{ __html: renderMarkdown(escapeTags(q.text)) }} />
                  {q.recommendation && !answered && (
                    <button
                      type="button"
                      className="q-suggest"
                      disabled={readOnly}
                      title="Use this as your answer"
                      onClick={() => {
                        setAnswer(q.n, q.recommendation!);
                        inputs.current.get(q.n)?.focus();
                      }}
                    >
                      <span className="q-suggest-tag">Suggested</span>
                      {q.recommendation}
                    </button>
                  )}
                  <GrowingText
                    value={a.answers[q.n] ?? ''}
                    onChange={(v) => setAnswer(q.n, v)}
                    label={`Answer to question ${q.n}`}
                    placeholder="Your answer"
                    disabled={readOnly}
                    inputRef={(el) => {
                      if (el) inputs.current.set(q.n, el);
                      else inputs.current.delete(q.n);
                    }}
                  />
                </div>
              </li>
            );
          })}
        </ol>
      )}

      <div className="qform-block">
        <div className="qform-label">{total || form.options.length >= 2 ? 'Anything else' : 'Comments'}</div>
        <GrowingText value={a.other} onChange={(v) => update({ ...a, other: v })} label="Anything else" placeholder="Optional" disabled={readOnly} />
      </div>

      {preview && filled && (
        <pre className="qform-preview" data-testid="answer-preview">
          {text}
        </pre>
      )}

      <footer className="qform-foot">
        <button type="button" className="btn primary" onClick={() => void submit()} disabled={!filled || busy || sent || readOnly} title={readOnly ? 'Read-only mode' : undefined}>
          {busy ? 'Sending...' : sent ? 'Sent' : 'Send answers'}
        </button>
        <button type="button" className="btn ghost" onClick={() => setPreview(!preview)} disabled={!filled} aria-pressed={preview}>
          {preview ? 'Hide preview' : 'Preview'}
        </button>
        <span className="hint">
          {total && done < total ? 'Sent as one reply. You can leave some blank; they are listed as not answered yet.' : 'Sent as one reply, and closes this decision.'}
        </span>
      </footer>
    </section>
  );
}

// A long one-line decision, shown as short paragraphs with its lists as bullets.
export function DecisionText({ text }: { text: string }) {
  const paras = layoutDecision(text);
  if (!paras) return null;
  return (
    <div className="body decision-text" data-testid="decision-text">
      {paras.map((p, i) => (
        <div key={i} className="dt-para">
          <RichText text={p.lead} />
          {p.items.length > 0 && (
            <ul className="dt-list">
              {p.items.map((item, j) => (
                <li key={j}>
                  <RichText text={item} />
                </li>
              ))}
            </ul>
          )}
        </div>
      ))}
    </div>
  );
}
