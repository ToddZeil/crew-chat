import { useState } from 'react';
import { api } from './api.ts';
import { typedApproval } from './handoff.ts';

// Approvals only count when the captain types them in First mate's own
// terminal, so this copies the words and opens that terminal. It never types
// anything there itself.
export function Handoff({ text, readOnly }: { text: string; readOnly: boolean }) {
  const ask = typedApproval(text);
  const [note, setNote] = useState<{ tone: 'good' | 'warn'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  if (!ask) return null;

  const run = async () => {
    setBusy(true);
    let copied = false;
    if (ask.words) {
      try {
        await navigator.clipboard.writeText(ask.words);
        copied = true;
      } catch {
        copied = false;
      }
    }
    const lead = ask.words ? (copied ? `Copied "${ask.words}".` : `Could not copy; type "${ask.words}" yourself.`) : '';
    if (readOnly) {
      setNote({ tone: 'warn', text: `${lead} Read-only mode, so First mate's terminal was not opened.`.trim() });
      setBusy(false);
      return;
    }
    const r = await api.openFirstmateTerminal();
    setBusy(false);
    setNote(
      r.ok
        ? { tone: 'good', text: `${lead} Opened First mate's terminal${ask.words ? ': paste it there and press Enter.' : '.'}`.trim() }
        : { tone: 'warn', text: `${lead} ${r.error ?? "First mate's terminal did not open."} ${ask.words ? 'Paste it in First mate\'s terminal yourself.' : ''}`.trim() },
    );
  };

  return (
    <div className="handoff" data-testid="handoff">
      <button type="button" className="btn small handoff-btn" onClick={() => void run()} disabled={busy}>
        <svg viewBox="0 0 20 20" width="14" height="14" aria-hidden="true">
          <path d="M3 4.5h14v11H3z M5.5 8l2.5 2-2.5 2 M10 12.5h4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />
        </svg>
        {ask.words ? "Copy and open First mate's terminal" : "Open First mate's terminal"}
      </button>
      {ask.words && !note && (
        <span className="handoff-words">
          to type <code>{ask.words}</code>
        </span>
      )}
      {note && (
        <span className={`handoff-note ${note.tone}`} role="status">
          {note.text}
        </span>
      )}
    </div>
  );
}
