import { useLayoutEffect, useRef, useState } from 'react';
import type { FirstmateDetail, FirstmateNote, WriteResult } from '../shared/types.ts';
import { api } from './api.ts';
import { Collapsible } from './format.tsx';
import { Handoff } from './Handoff.tsx';
import { FIRSTMATE_SOURCE, TerminalPanel } from './TerminalPanel.tsx';
import { typedApproval } from './handoff.ts';
import { Avatar, MessageList, type Row } from './messages.tsx';
import { loadJson, newRequestId, noteAsWrite, PENDING_TEXT, saveJson, type Notice } from './model.ts';

const FM_PANE_KEY = 'crewchat.fm-pane.v1';
import { ComposerBox, FIRST_MATE, NoticeView, pendingRow, quoteInto, restoreDraft, YOU, type Pending } from './ThreadView.tsx';

function noteReceipt(n: FirstmateNote): { text: string; title: string; read: boolean } {
  if (n.acknowledged) return { text: '✓✓ Seen', title: 'First mate has picked this up.', read: true };
  if (n.announced === true) return { text: '✓ Delivered', title: 'First mate was told and will pick it up at its next check.', read: false };
  if (n.announced === false) return { text: 'Saved, not announced yet', title: 'Saved, but First mate has not been told yet.', read: false };
  return { text: '✓ Sent', title: "Saved in First mate's inbox.", read: false };
}

export interface NoteDraft {
  text: string;
  rid: string;
  // The exact message the request id was last used for; a different message
  // gets a new id, the same one reuses it so a retry never makes a second note.
  ridFor: string | null;
}

export function FirstmateView({
  fm,
  now,
  readOnly,
  draft,
  setDraft,
  notices,
  addNotice,
  dismissNotice,
}: {
  fm: FirstmateDetail | null;
  now: number;
  readOnly: boolean;
  draft: NoteDraft;
  setDraft: (d: NoteDraft) => void;
  notices: Notice[];
  addNotice: (tone: Notice['tone'], title: string, r: WriteResult) => void;
  dismissNotice: (id: number) => void;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  const [pending, setPending] = useState<Pending[]>([]);
  const [paneOpen, setPaneOpen] = useState<boolean>(() => loadJson(FM_PANE_KEY, false));
  const togglePane = (v: boolean) => {
    setPaneOpen(v);
    saveJson(FM_PANE_KEY, v);
  };
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const notes = fm?.notes ?? [];

  useLayoutEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [notes.length, notices.length, pending.length]);

  const submit = async (full: string): Promise<boolean> => {
    if (!full.trim()) return false;
    // The same message keeps its request id, so a retry never makes a second note.
    const rid = draft.ridFor === full ? draft.rid : newRequestId();
    const entry: Pending = { key: `p${Date.now()}-${Math.random()}`, text: full, since: Date.now() };
    setPending((p) => [...p, entry]);
    setDraft({ text: '', rid: newRequestId(), ridFor: null });
    void api.sendNote(full, rid).then((r) => {
      setPending((p) => p.filter((x) => x.key !== entry.key));
      if (r.outcome === 'refused') {
        const text = restoreDraft(full, draftRef.current.text);
        setDraft({ text, rid, ridFor: text === full ? full : null });
        addNotice('error', 'Your message to First mate was not sent', noteAsWrite(r));
      } else if (r.outcome === 'pending') addNotice('warning', PENDING_TEXT, noteAsWrite(r));
    });
    return true;
  };

  // Only the newest request for a typed approval gets the hand-off button.
  const handoffId = [...notes].reverse().find((n) => n.reply && typedApproval(n.reply.body))?.id ?? null;
  const rows: Row[] = [];
  for (const n of notes) {
    const receipt = noteReceipt(n);
    rows.push({
      key: `note-${n.id}`,
      author: YOU,
      at: n.at,
      className: 'out',
      attrs: { 'data-note-id': n.id, 'data-read': receipt.read ? 'yes' : 'no' },
      copyText: n.body,
      body: (
        <>
          <Collapsible text={n.body} />
          <span className={receipt.read ? 'receipt read' : 'receipt'} title={receipt.title}>
            {receipt.text}
          </span>
        </>
      ),
    });
    if (n.reply) {
      rows.push({
        key: `reply-${n.id}`,
        author: FIRST_MATE,
        at: n.reply.at,
        className: 'in tone-busy',
        attrs: { 'data-reply-to': n.id },
        copyText: n.reply.body,
        body: (
          <>
            <Collapsible text={n.reply.body} />
            {n.id === handoffId && <Handoff text={n.reply.body} readOnly={readOnly} />}
          </>
        ),
      });
    }
  }

  for (const p of pending) {
    if (!notes.some((n) => n.body === p.text && (n.at ?? 0) >= p.since - 60_000)) rows.push(pendingRow(p));
  }

  return (
    <>
      <header className="channel-head">
        <div className="head-row">
          <div className="head-main">
            <h2>
              <Avatar author={FIRST_MATE} size={24} presence={true} className="head-avatar" />
              First mate
            </h2>
            <div className="topic">
              <span>Your conversation with the supervisor. Ask it anything, including starting a new worker.</span>
            </div>
          </div>
        </div>
        <div className="tabs">
          <button type="button" className={`tab${paneOpen ? '' : ' on'}`} onClick={() => togglePane(false)}>
            <svg viewBox="0 0 20 20" width="15" height="15" aria-hidden="true">
              <path d="M4 4h12a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H9l-4 3v-3H4a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1z" fill="currentColor" />
            </svg>
            Messages
          </button>
          <button
            type="button"
            className={`tab${paneOpen ? ' on' : ''}`}
            onClick={() => togglePane(!paneOpen)}
            aria-pressed={paneOpen}
            title="Show First mate's terminal next to the chat, read-only"
            data-testid="terminal-view"
          >
            <svg viewBox="0 0 20 20" width="15" height="15" aria-hidden="true">
              <rect x="2.5" y="3.5" width="15" height="13" rx="2" fill="none" stroke="currentColor" strokeWidth="1.5" />
              <path d="m6 8 2.5 2L6 12m4 0h4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            Terminal
          </button>
        </div>
      </header>
      <div className="conv-split">
      <div className="conv-main">
      <div className="messages" ref={listRef}>
        {fm?.error && (
          <div className="notice notice-error" role="alert">
            <strong>Cannot read First mate's inbox</strong>
            <pre className="notice-detail">{fm.error}</pre>
          </div>
        )}
        {fm && notes.length === 0 && !fm.error ? (
          <div className="empty center">
            <strong>No messages yet</strong>
            <span>Write to First mate below. Replies show up here.</span>
          </div>
        ) : (
          <div className="dm-intro">
            <div className="intro-who">
              <Avatar author={FIRST_MATE} size={72} presence={true} className="intro-avatar" />
              <h3>First mate</h3>
            </div>
            <p>
              This conversation is just between <strong>First mate</strong> and you. Notes you send go to the supervisor's inbox, and
              its replies show up here.
            </p>
          </div>
        )}
        <MessageList rows={rows} now={now} onQuote={(text) => setDraft({ ...draftRef.current, text: quoteInto(text, draftRef.current.text) })} />
        {notices.map((n) => (
          <NoticeView key={n.id} n={n} onDismiss={() => dismissNotice(n.id)} />
        ))}
      </div>
      <ComposerBox
        value={draft.text}
        onChange={(text) => setDraft({ ...draft, text })}
        onSubmit={submit}
        busy={false}
        readOnly={readOnly}
        placeholder="Message First mate"
      />
      </div>
      {paneOpen && <TerminalPanel id="__firstmate__" source={FIRSTMATE_SOURCE} onClose={() => togglePane(false)} />}
      </div>
    </>
  );
}
