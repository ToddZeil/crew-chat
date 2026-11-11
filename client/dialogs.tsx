import { useEffect, useState } from 'react';
import type { CleanupResult, NoteResult, ThreadSummary } from '../shared/types.ts';
import { api } from './api.ts';
import { newRequestId } from './model.ts';

type CleanupStep = 'confirm' | 'running' | 'refused' | 'forcing' | 'error';

export function CleanupDialog({
  t,
  onClose: close,
  onCleaned,
}: {
  t: ThreadSummary;
  onClose: (last: CleanupResult | null) => void;
  onCleaned: (r: CleanupResult) => void;
}) {
  const [step, setStep] = useState<CleanupStep>('confirm');
  const [result, setResult] = useState<CleanupResult | null>(null);
  const [typed, setTyped] = useState('');
  const busy = step === 'running' || step === 'forcing';
  const active = t.badge === 'working' || t.badge === 'needs-you' || t.openDecisions > 0;
  const onClose = () => close(result);

  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [busy, onClose]);

  const run = async (force: boolean) => {
    setStep(force ? 'forcing' : 'running');
    const r = await api.cleanup(t.id, force ? typed : undefined);
    setResult(r);
    if (r.outcome === 'cleaned' || r.outcome === 'cleaned-with-warning') onCleaned(r);
    else setStep(r.outcome === 'refused' && r.exitCode === 1 ? 'refused' : 'error');
  };

  const output = result ? [result.error, result.stderr.trim(), result.stdout.trim()].filter(Boolean).join('\n') : '';

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <div className="dialog" role="dialog" aria-modal="true" aria-labelledby="cleanup-title">
        <h3 id="cleanup-title">Clean up {t.title}?</h3>
        {(step === 'confirm' || step === 'running') && (
          <>
            {active && (
              <p className="dialog-warning" data-testid="cleanup-active-warning">
                {t.badge === 'working'
                  ? 'This worker is still working right now. Cleaning up stops it mid-task.'
                  : 'This worker is waiting on you. Cleaning up drops its open question.'}
              </p>
            )}
            <p>This runs Firstmate's own cleanup for <code>{t.id}</code>:</p>
            <ul>
              <li>the worker is stopped,</li>
              <li>its local copy of the code is cleaned up,</li>
              <li>its backlog item is closed,</li>
              <li>and this thread disappears.</li>
            </ul>
            <p className="hint">If the worker holds code that has not landed yet, the cleanup refuses and nothing changes.</p>
            <div className="dialog-actions">
              <button type="button" className="btn ghost" onClick={onClose} disabled={busy}>
                Cancel
              </button>
              <button type="button" className="btn danger" onClick={() => void run(false)} disabled={busy} autoFocus>
                {step === 'running' ? 'Cleaning up...' : 'Clean up'}
              </button>
            </div>
          </>
        )}
        {(step === 'refused' || step === 'forcing') && (
          <>
            <p>
              <strong>The cleanup refused, and nothing was changed.</strong> Here is what it said:
            </p>
            <pre className="dialog-output" data-testid="cleanup-output">{output || '(no explanation printed)'}</pre>
            <div className="discard">
              <h4>Discard this work and clean up</h4>
              <p>
                This throws away the worker's work that has not landed, then cleans up. It cannot be undone. Some refusals
                are not lifted by this; if so, the script will say so again.
              </p>
              <label>
                <span>
                  Type <code>{t.id}</code> to confirm
                </span>
                <input
                  value={typed}
                  onChange={(e) => setTyped(e.target.value)}
                  disabled={busy}
                  spellCheck={false}
                  autoComplete="off"
                  aria-label="Worker id to confirm"
                />
              </label>
            </div>
            <div className="dialog-actions">
              <button type="button" className="btn ghost" onClick={onClose} disabled={busy}>
                Keep the worker
              </button>
              <button type="button" className="btn danger" onClick={() => void run(true)} disabled={busy || typed !== t.id}>
                {step === 'forcing' ? 'Discarding...' : 'Discard this work and clean up'}
              </button>
            </div>
          </>
        )}
        {step === 'error' && (
          <>
            <p>
              <strong>The cleanup did not run to completion.</strong>
              {result?.exitCode !== null && result?.exitCode !== undefined && <span className="mono"> exit {result.exitCode}</span>}
            </p>
            <pre className="dialog-output" data-testid="cleanup-output">{output || '(no explanation printed)'}</pre>
            <div className="dialog-actions">
              <button type="button" className="btn" onClick={onClose}>
                Close
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}


const OTHER_PROJECT = 'not sure';

export type ModelChoice = 'auto' | 'sonnet' | 'opus';
export type EffortChoice = 'medium' | 'high';

// The note First mate reads: the request, then the explicit model pick on its
// own line, and the effort when a model was picked.
export function newWorkerNote(project: string, text: string, model: ModelChoice, effort: EffortChoice, planning: boolean): string {
  const lines = [`New worker request - project: ${project}. ${text.trim()}`, `Model: ${model}`];
  if (model !== 'auto') lines.push(`Effort: ${effort}`);
  lines.push(`Planning: ${planning ? 'yes' : 'no'}`);
  return lines.join('\n');
}

export function NewWorkerDialog({
  projects,
  onClose,
  onSent,
}: {
  projects: { name: string; description: string }[];
  onClose: () => void;
  onSent: (r: NoteResult) => void;
}) {
  const [project, setProject] = useState(projects[0]?.name ?? OTHER_PROJECT);
  const [text, setText] = useState('');
  const [model, setModel] = useState<ModelChoice>('auto');
  const [effort, setEffort] = useState<EffortChoice>('high');
  const [planning, setPlanning] = useState(false);
  const [rid, setRid] = useState(newRequestId);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<NoteResult | null>(null);

  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [busy, onClose]);

  const submit = async () => {
    if (busy || !text.trim()) return;
    setBusy(true);
    const r = await api.sendNote(newWorkerNote(project, text, model, effort, planning), rid);
    setBusy(false);
    if (r.outcome === 'refused') setFailure(r);
    else onSent(r);
  };
  const failureText = failure ? [failure.error, failure.stderr.trim(), failure.stdout.trim()].filter(Boolean).join('\n') : '';

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <form
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="new-worker-title"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <h3 id="new-worker-title">Start a new worker</h3>
        <p className="hint">
          This asks First mate to start one. The request shows as its own conversation under Queued right away, and the worker carries it on once it starts.
        </p>
        <label className="field">
          <span>Project</span>
          <select
            value={project}
            onChange={(e) => {
              setProject(e.target.value);
              setRid(newRequestId());
            }}
            disabled={busy}
            aria-label="Project"
          >
            {projects.map((p) => (
              <option key={p.name} value={p.name} title={p.description}>
                {p.name}
              </option>
            ))}
            <option value={OTHER_PROJECT}>Other / not sure</option>
          </select>
        </label>
        <label className="field">
          <span>What should it do?</span>
          <textarea
            rows={5}
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              setRid(newRequestId());
            }}
            disabled={busy}
            autoFocus
            aria-label="What should it do?"
            placeholder="For example: fix the double submit on the apply screen and add a widget test"
          />
        </label>
        <div className="field-row">
          <label className="field">
            <span>Model</span>
            <select
              value={model}
              onChange={(e) => {
                setModel(e.target.value as ModelChoice);
                setRid(newRequestId());
              }}
              disabled={busy}
              aria-label="Model"
            >
              <option value="auto">Auto (First mate picks)</option>
              <option value="sonnet">Sonnet</option>
              <option value="opus">Opus</option>
            </select>
          </label>
          {model !== 'auto' && (
            <label className="field">
              <span>Effort</span>
              <select
                value={effort}
                onChange={(e) => {
                  setEffort(e.target.value as EffortChoice);
                  setRid(newRequestId());
                }}
                disabled={busy}
                aria-label="Effort"
              >
                <option value="medium">Medium</option>
                <option value="high">High</option>
              </select>
            </label>
          )}
        </div>
        <label className="check-field">
          <input
            type="checkbox"
            checked={planning}
            onChange={(e) => {
              setPlanning(e.target.checked);
              setRid(newRequestId());
            }}
            disabled={busy}
          />
          <span>
            <strong>Plan it first</strong>
            <span className="hint"> Talk the approach over with First mate before any code is written. The request's own conversation is where that happens.</span>
          </span>
        </label>
        {failure && (
          <div className="notice notice-error" role="alert">
            <strong>The request was not sent</strong>
            {failure.exitCode !== null && <span className="mono"> exit {failure.exitCode}</span>}
            {failureText && <pre className="notice-detail">{failureText}</pre>}
          </div>
        )}
        <div className="dialog-actions">
          <button type="button" className="btn ghost" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="submit" className="btn primary" disabled={busy || !text.trim()}>
            {busy ? 'Sending...' : failure ? 'Try again' : 'Send to First mate'}
          </button>
        </div>
      </form>
    </div>
  );
}
