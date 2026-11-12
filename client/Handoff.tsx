import { useEffect, useState } from 'react';
import { api } from './api.ts';
import { typedApproval } from './handoff.ts';

// Puts exactly these words on the clipboard. The async clipboard API can be
// refused (no focus, no permission), so the older copy command is the fallback.
async function copyExactly(words: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(words);
    return true;
  } catch {
    const area = document.createElement('textarea');
    area.value = words;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch {
      ok = false;
    }
    area.remove();
    return ok;
  }
}

// Approvals only count when the captain types them in First mate's own
// terminal, so this copies the words and opens that terminal. It never types
// anything there itself.
export function Handoff({ text, readOnly }: { text: string; readOnly: boolean }) {
  const ask = typedApproval(text);
  const [note, setNote] = useState<{ tone: 'good' | 'warn'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  // Whether First mate's terminal can be opened from here; when it runs in
  // another app the button only copies.
  const [canOpen, setCanOpen] = useState<boolean | null>(null);
  const [whyNot, setWhyNot] = useState<string | null>(null);
  useEffect(() => {
    if (!ask || readOnly) return;
    let live = true;
    void api.firstmateTerminal().then(
      (a) => {
        if (!live) return;
        setCanOpen(a.available);
        setWhyNot(a.available ? null : (a.reason ?? null));
      },
      () => live && setCanOpen(false),
    );
    return () => {
      live = false;
    };
  }, [ask?.words, readOnly]);
  if (!ask) return null;

  const run = async () => {
    setBusy(true);
    if (ask.words && !(await copyExactly(ask.words))) {
      // Opening the terminal now would leave whatever was copied before on
      // the clipboard, ready to be pasted as if it were the approval.
      setBusy(false);
      setNote({ tone: 'warn', text: `Could not copy, so the terminal was not opened. Type "${ask.words}" in First mate's terminal yourself.` });
      return;
    }
    const lead = ask.words ? `Copied "${ask.words}".` : '';
    if (canOpen === false) {
      setBusy(false);
      setNote({ tone: 'good', text: `${lead} Paste it in First mate's terminal and press Enter.`.trim() });
      return;
    }
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
        : { tone: 'warn', text: `${lead} ${r.error ?? "First mate's terminal did not open."} ${ask.words ? "Paste it in First mate's terminal yourself." : ''}`.trim() },
    );
  };

  return (
    <div className="handoff" data-testid="handoff">
      <button type="button" className="btn small handoff-btn" onClick={() => void run()} disabled={busy}>
        <svg viewBox="0 0 20 20" width="14" height="14" aria-hidden="true">
          <path d="M3 4.5h14v11H3z M5.5 8l2.5 2-2.5 2 M10 12.5h4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />
        </svg>
        {ask.words ? (
          <>
            Copy <code className="handoff-phrase">{ask.words}</code>
            {canOpen === false ? '' : " and open First mate's terminal"}
          </>
        ) : (
          "Open First mate's terminal"
        )}
      </button>
      {canOpen === false && ask.words && !note && (
        <span className="handoff-hint" title={whyNot ?? undefined}>
          then paste it in First mate's terminal
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
