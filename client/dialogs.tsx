import { useEffect, useState } from 'react';
import type { CleanupResult, NoteResult, ThreadSummary } from '../shared/types.ts';
import { api } from './api.ts';
import { newRequestId, threadTag } from './model.ts';

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

export type ModelChoice = 'auto' | 'haiku' | 'sonnet' | 'opus';
// The levels fm-spawn.sh --effort accepts for Claude workers.
export const EFFORTS = [
  ['auto', 'Auto (First mate picks)'],
  ['low', 'Low'],
  ['medium', 'Medium'],
  ['high', 'High'],
  ['xhigh', 'Extra high'],
  ['max', 'Max'],
] as const;
export type EffortChoice = (typeof EFFORTS)[number][0];

// The note First mate reads: the request, then the model pick on its own
// line, and the effort when one was picked.
export function newWorkerNote(project: string, text: string, model: ModelChoice, effort: EffortChoice, planning: boolean): string {
  const lines = [`New worker request - project: ${project}. ${text.trim()}`, `Model: ${model}`];
  if (effort !== 'auto') lines.push(`Effort: ${effort}`);
  lines.push(`Planning: ${planning ? 'yes' : 'no'}`);
  return lines.join('\n');
}

type Failure = Pick<NoteResult, 'error' | 'exitCode' | 'stderr' | 'stdout'>;

export function NewWorkerDialog({
  projects,
  onClose,
  onSent,
  onStarted,
}: {
  projects: { name: string; description: string }[];
  onClose: () => void;
  onSent: (r: NoteResult) => void;
  onStarted: (id: string) => void;
}) {
  const [project, setProject] = useState(projects[0]?.name ?? OTHER_PROJECT);
  const [text, setText] = useState('');
  const [model, setModel] = useState<ModelChoice>('auto');
  const [effort, setEffort] = useState<EffortChoice>('auto');
  const [planning, setPlanning] = useState(false);
  const [direct, setDirect] = useState(false);
  const [rid, setRid] = useState(newRequestId);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);

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
    if (direct) {
      const started = await api.startDirect({ project, text, model, effort });
      setBusy(false);
      if (started.ok && started.id) onStarted(started.id);
      else setFailure(started);
      return;
    }
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
          {direct
            ? 'The worker starts now, with no First mate in the loop. It shows as its own conversation once it is running. Auto model and effort follow Firstmate\'s dispatch rules.'
            : 'This asks First mate to start one. The request shows as its own conversation under Queued right away, and the worker carries it on once it starts.'}
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
              <option value="haiku">Haiku</option>
              <option value="sonnet">Sonnet</option>
              <option value="opus">Opus</option>
            </select>
          </label>
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
              {EFFORTS.map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
        </div>
        <label className="check-field">
          <input
            type="checkbox"
            checked={direct}
            onChange={(e) => {
              setDirect(e.target.checked);
              setRid(newRequestId());
            }}
            disabled={busy}
          />
          <span>
            <strong>Start it directly</strong>
            <span className="hint"> Skip First mate. crew-chat files the task, writes its brief and starts the worker itself. It works on a local branch (no push, no PR), and its tool approvals stay on, so it may wait in its terminal for an answer.</span>
          </span>
        </label>
        {!direct && (
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
        )}
        {failure && (
          <div className="notice notice-error" role="alert">
            <strong>{direct ? 'The worker was not started' : 'The request was not sent'}</strong>
            {failure.exitCode !== null && <span className="mono"> exit {failure.exitCode}</span>}
            {failureText && <pre className="notice-detail">{failureText}</pre>}
          </div>
        )}
        <div className="dialog-actions">
          <button type="button" className="btn ghost" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="submit" className="btn primary" disabled={busy || !text.trim()}>
            {busy
              ? direct
                ? 'Starting...'
                : 'Sending...'
              : failure
                ? 'Try again'
                : direct
                  ? 'Start worker'
                  : 'Send to First mate'}
          </button>
        </div>
      </form>
    </div>
  );
}

// The note that asks First mate to drop work that has no worker yet. crew-chat
// cannot cancel it itself: the backlog and the request belong to First mate.
export function cancelNote(t: Pick<ThreadSummary, 'id' | 'title' | 'placeholder'>, reason: string): string {
  const why = reason.trim() ? ` Reason: ${reason.trim()}` : '';
  return t.placeholder === 'queued'
    ? `Please cancel the queued task ${t.id} ("${t.title}"): do not start a worker for it, and close it in the backlog.${why}`
    : `Please cancel this request ("${t.title}"): do not start a worker for it.${why}`;
}

export function CancelDialog({
  t,
  onClose,
  onSent,
}: {
  t: ThreadSummary;
  onClose: () => void;
  onSent: (r: NoteResult, hide: boolean) => void;
}) {
  const [reason, setReason] = useState('');
  const [hide, setHide] = useState(true);
  const [rid] = useState(newRequestId);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<NoteResult | null>(null);

  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [busy, onClose]);

  const send = async () => {
    setBusy(true);
    const r = await api.sendNote(`${threadTag(t.id)}${cancelNote(t, reason)}`, rid);
    setBusy(false);
    if (r.outcome === 'refused') setFailure(r);
    else onSent(r, hide);
  };
  const failureText = failure ? [failure.error, failure.stderr.trim(), failure.stdout.trim()].filter(Boolean).join('\n') : '';

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <div className="dialog" role="dialog" aria-modal="true" aria-labelledby="cancel-title">
        <h3 id="cancel-title">Cancel {t.title}?</h3>
        <p>
          {t.placeholder === 'queued' ? (
            <>
              This asks First mate to drop <code>{t.id}</code>: no worker is started for it, and it is closed in the backlog.
            </>
          ) : (
            <>This asks First mate not to start a worker for this request.</>
          )}{' '}
          crew-chat sends the request; First mate makes the change.
        </p>
        <label className="field">
          <span>Reason (optional)</span>
          <textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} disabled={busy} aria-label="Reason" placeholder="For example: no longer needed" />
        </label>
        <label className="check-field">
          <input type="checkbox" checked={hide} onChange={(e) => setHide(e.target.checked)} disabled={busy} />
          <span>Also remove it from my list now</span>
        </label>
        {failure && (
          <pre className="dialog-output" data-testid="cancel-output">
            {failureText || 'First mate did not take the note.'}
          </pre>
        )}
        <div className="dialog-actions">
          <button type="button" className="btn ghost" onClick={onClose} disabled={busy}>
            Keep it
          </button>
          <button type="button" className="btn danger" onClick={() => void send()} disabled={busy} autoFocus>
            {busy ? 'Sending...' : 'Ask First mate to cancel'}
          </button>
        </div>
      </div>
    </div>
  );
}
