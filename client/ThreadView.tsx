import { useEffect, useLayoutEffect, useRef, useState, type ClipboardEvent, type DragEvent, type ReactNode } from 'react';
import type { IncomingItem, OutgoingItem, ThreadDetail, WriteResult } from '../shared/types.ts';
import { api } from './api.ts';
import { BADGE_LABELS, Collapsible, ExternalLink, formatTokens, imageMarker, RichText, verbLabel, verbTone } from './format.tsx';
import { Avatar, MessageList, type Author, type Row } from './messages.tsx';
import { isActive } from './Sidebar.tsx';
import { loadJson, newRequestId, noteAsWrite, PENDING_TEXT, saveJson, threadTag, type Notice } from './model.ts';
import { QuestionForm } from './questions.tsx';
import { TerminalPanel } from './TerminalPanel.tsx';

export const YOU: Author = { key: 'you', name: 'You', kind: 'you' };
export const FIRST_MATE: Author = { key: 'firstmate', name: 'First mate', kind: 'firstmate' };

export function NoticeView({ n, onDismiss }: { n: Notice; onDismiss: () => void }) {
  const r = n.result;
  const detail = [r.error, r.stderr.trim(), r.stdout.trim()].filter(Boolean).join('\n');
  return (
    <div className={`notice notice-${n.tone}`} role="alert">
      <div className="notice-head">
        <strong>{n.title}</strong>
        {r.exitCode !== null && <span className="mono">exit {r.exitCode}</span>}
        <button type="button" className="btn ghost small" onClick={onDismiss} aria-label="Dismiss">
          Dismiss
        </button>
      </div>
      {detail && <pre className="notice-detail">{detail}</pre>}
    </div>
  );
}

function clipboardImages(data: DataTransfer): File[] {
  return [...data.items]
    .filter((i) => i.kind === 'file' && i.type.startsWith('image/'))
    .map((i) => i.getAsFile())
    .filter((f): f is File => f !== null);
}

interface Attachment {
  path: string;
  url: string;
}

// The text that reaches the worker: the typed message, then one
// "[image: <path>]" line per pasted image.
export function composeMessage(text: string, attachments: { path: string }[]): string {
  return [text.trim() ? text : '', ...attachments.map((a) => imageMarker(a.path))].filter(Boolean).join('\n');
}

export function ComposerBox({
  value,
  onChange,
  onSubmit,
  busy,
  readOnly,
  placeholder,
  hint,
}: {
  value: string;
  onChange: (v: string) => void;
  // Resolves true when the message was accepted, so pasted images clear.
  onSubmit: (full: string) => Promise<boolean>;
  busy: boolean;
  readOnly: boolean;
  placeholder: string;
  hint?: ReactNode;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [uploading, setUploading] = useState(0);
  const [uploadError, setUploadError] = useState<string | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
  }, [value]);
  useLayoutEffect(() => {
    if (!busy) ref.current?.focus({ preventScroll: true });
  }, [busy]);

  const canSend = !readOnly && !busy && uploading === 0 && (value.trim() !== '' || attachments.length > 0);
  const submit = async () => {
    if (!canSend) return;
    if (await onSubmit(composeMessage(value, attachments))) setAttachments([]);
  };

  const [dragging, setDragging] = useState(false);

  const addImages = (files: File[]) => {
    setUploadError(null);
    for (const file of files) {
      setUploading((n) => n + 1);
      void api.upload(file).then((r) => {
        setUploading((n) => n - 1);
        if (r.ok && r.path && r.url) setAttachments((prev) => [...prev, { path: r.path!, url: r.url! }]);
        else setUploadError(r.error ?? 'The image could not be saved.');
      });
    }
  };

  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = clipboardImages(e.clipboardData);
    if (files.length === 0 || readOnly) return;
    e.preventDefault();
    addImages(files);
  };

  // Cmd+V with an image anywhere in the conversation attaches it here, not
  // only when the message box has focus.
  const addRef = useRef(addImages);
  addRef.current = addImages;
  useEffect(() => {
    const onDocPaste = (e: globalThis.ClipboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (readOnly || !e.clipboardData || target?.closest('input, textarea, [contenteditable="true"], .dialog')) return;
      const files = clipboardImages(e.clipboardData);
      if (files.length === 0) return;
      e.preventDefault();
      addRef.current(files);
      ref.current?.focus();
    };
    document.addEventListener('paste', onDocPaste);
    return () => document.removeEventListener('paste', onDocPaste);
  }, [readOnly]);

  const fileRef = useRef<HTMLInputElement>(null);
  const [showTools, setShowTools] = useState(() => loadJson('crewchat.format-bar.v1', true));
  const toggleTools = () => {
    setShowTools(!showTools);
    saveJson('crewchat.format-bar.v1', !showTools);
  };

  // Markdown formatting around the selection, as the toolbar buttons do.
  const wrap = (before: string, after = before, empty = '') => {
    const el = ref.current;
    if (!el) return;
    const a = el.selectionStart;
    const b = el.selectionEnd;
    const sel = value.slice(a, b) || empty;
    onChange(value.slice(0, a) + before + sel + after + value.slice(b));
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(a + before.length, a + before.length + sel.length);
    });
  };
  const prefixLines = (prefix: (i: number) => string) => {
    const el = ref.current;
    if (!el) return;
    const a = value.lastIndexOf('\n', el.selectionStart - 1) + 1;
    const end = value.indexOf('\n', el.selectionEnd);
    const b = end < 0 ? value.length : end;
    const lines = value.slice(a, b).split('\n').map((l, i) => prefix(i) + l);
    onChange(value.slice(0, a) + lines.join('\n') + value.slice(b));
    requestAnimationFrame(() => el.focus());
  };
  const tools: Array<{ label: string; icon: ReactNode; run: () => void }> = [
    { label: 'Bold', icon: <svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true"><path d="M6 4h5a3 3 0 0 1 0 6H6zm0 6h6a3 3 0 0 1 0 6H6z" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" /></svg>, run: () => wrap('**') },
    { label: 'Italic', icon: <svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true"><path d="M12 4H8.5m3 0-3 12m0 0H5m3.5 0H12" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" /></svg>, run: () => wrap('_') },
    { label: 'Strikethrough', icon: <svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true"><path d="M4 10h12M13.5 6.5C13 5 11.6 4 10 4 8 4 6.5 5.2 6.5 6.8c0 1 .5 1.8 1.6 2.4M6.5 13.5C7 15 8.4 16 10 16c2 0 3.5-1.2 3.5-2.8 0-.6-.2-1.1-.5-1.5" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" /></svg>, run: () => wrap('~') },
    { label: 'Link', icon: <svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true"><path d="M8.5 11.5a3 3 0 0 0 4.2 0l2.6-2.6a3 3 0 0 0-4.2-4.2l-.9.9m-1.7 5.3a3 3 0 0 0-4.2 0L1.7 13.5a3 3 0 0 0 4.2 4.2l.9-.9" transform="translate(1.5 -1.2)" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" /></svg>, run: () => wrap('[', '](https://)', 'text') },
    { label: 'Numbered list', icon: <svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true"><path d="M8.5 5.5H17m-8.5 4.5H17m-8.5 4.5H17M3.5 4.5l1-.5v3.5m-1 0h2m-2 3.5c0-.6.5-1 1-1s1 .4 1 1-2 1.5-2 2.5h2" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" /></svg>, run: () => prefixLines((i) => `${i + 1}. `) },
    { label: 'Bulleted list', icon: <svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true"><path d="M8 5.5h9M8 10h9m-9 4.5h9" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" /><circle cx="4" cy="5.5" r="1.2" fill="currentColor" /><circle cx="4" cy="10" r="1.2" fill="currentColor" /><circle cx="4" cy="14.5" r="1.2" fill="currentColor" /></svg>, run: () => prefixLines(() => '- ') },
    { label: 'Quote', icon: <svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true"><path d="M4 4v12M8 6h8M8 10h8m-8 4h5" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" /></svg>, run: () => prefixLines(() => '> ') },
    { label: 'Code', icon: <svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true"><path d="m7 6-4 4 4 4m6-8 4 4-4 4" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" /></svg>, run: () => wrap('`') },
    { label: 'Code block', icon: <svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true"><rect x="3" y="3.5" width="14" height="13" rx="2" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" /><path d="m8 8-2 2 2 2m4-4 2 2-2 2" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" /></svg>, run: () => wrap('```\n', '\n```') },
  ];

  const hasFiles = (e: DragEvent) => e.dataTransfer.types.includes('Files');
  const onDrop = (e: DragEvent<HTMLFormElement>) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    setDragging(false);
    if (readOnly) return;
    const all = [...e.dataTransfer.files];
    const images = all.filter((f) => f.type.startsWith('image/'));
    if (images.length < all.length) setUploadError('Only images can be dropped here.');
    if (images.length) addImages(images);
  };

  return (
    <form
      className={`composer${dragging ? ' dragging' : ''}`}
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
      onDragOver={(e) => {
        if (!hasFiles(e) || readOnly) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
        setDragging(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false);
      }}
      onDrop={onDrop}
      data-testid="composer"
    >
      <div className="composer-box">
        {dragging && <div className="drop-hint">Drop the image to attach it</div>}
        {showTools && (
        <div className="format-bar" role="toolbar" aria-label="Formatting">
          {tools.map((t) => (
            <button
              key={t.label}
              type="button"
              className="fmt"
              title={t.label}
              aria-label={t.label}
              // Keep the message box focused so its selection survives the click.
              onMouseDown={(e) => e.preventDefault()}
              onClick={t.run}
              disabled={readOnly}
              tabIndex={-1}
            >
              {t.icon}
            </button>
          ))}
        </div>
        )}
        <textarea
          ref={ref}
          rows={1}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onPaste={onPaste}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void submit();
            }
          }}
          placeholder={readOnly ? 'Read-only mode: sending is turned off' : placeholder}
          aria-label="Message"
          disabled={readOnly}
        />
        {(attachments.length > 0 || uploading > 0 || uploadError) && (
          <div className="attachments">
            {attachments.map((a) => (
              <span key={a.path} className="attachment" title={a.path}>
                <img src={a.url} alt="Pasted image" />
                <button
                  type="button"
                  className="attachment-remove"
                  aria-label="Remove image"
                  onClick={() => setAttachments((prev) => prev.filter((x) => x.path !== a.path))}
                >
                  ×
                </button>
              </span>
            ))}
            {uploading > 0 && <span className="attachment uploading">Saving image...</span>}
            {uploadError && (
              <span className="upload-error" role="alert">
                {uploadError}
              </span>
            )}
          </div>
        )}
        <div className="composer-bar">
          <button
            type="button"
            className="attach"
            aria-label="Attach an image"
            title="Attach an image"
            disabled={readOnly}
            onClick={() => fileRef.current?.click()}
          >
            +
          </button>
          <button
            type="button"
            className={`aa${showTools ? ' on' : ''}`}
            aria-label={showTools ? 'Hide formatting' : 'Show formatting'}
            aria-pressed={showTools}
            title={showTools ? 'Hide formatting' : 'Show formatting'}
            onClick={toggleTools}
          >
            Aa
          </button>
          <input
            ref={fileRef}
            type="file"
            accept="image/png,image/jpeg,image/gif,image/webp"
            multiple
            hidden
            onChange={(e) => {
              const files = [...(e.target.files ?? [])];
              e.target.value = '';
              if (files.length) addImages(files);
            }}
          />
          <span className="composer-hint">{hint ?? 'Enter to send, Shift+Enter for a new line, paste or drop an image to attach it'}</span>
          <button type="submit" className="send" disabled={!canSend} aria-label="Send">
            {busy ? (
              'Sending...'
            ) : (
              <svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true">
                <path d="M2.5 16.5 18 10 2.5 3.5 2.5 8.6 13 10 2.5 11.4z" fill="currentColor" />
              </svg>
            )}
          </button>
        </div>
      </div>
    </form>
  );
}

interface ThreadViewProps {
  detail: ThreadDetail;
  now: number;
  readOnly: boolean;
  notices: Notice[];
  draft: string;
  setDraft: (v: string) => void;
  addNotice: (tone: Notice['tone'], title: string, r: WriteResult) => void;
  dismissNotice: (id: number) => void;
  onCleanup: () => void;
  onHidden: (hidden: boolean) => void;
  starred: boolean;
  onToggleStar: () => void;
  // Incoming messages already read when the thread was opened.
  newFrom: number | null;
}

export function ThreadView({
  detail,
  now,
  readOnly,
  notices,
  draft,
  setDraft,
  addNotice,
  dismissNotice,
  onCleanup,
  onHidden,
  starred,
  onToggleStar,
  newFrom,
}: ThreadViewProps) {
  const t = detail.summary;
  const listRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const [openingTerminal, setOpeningTerminal] = useState(false);
  const [answering, setAnswering] = useState<string | null>(null);
  const [paneOpen, setPaneOpen] = useState<boolean>(() => loadJson('crewchat.pane.v1', false));
  const togglePane = (v: boolean) => {
    setPaneOpen(v);
    saveJson('crewchat.pane.v1', v);
  };
  // Messages handed to the send script that it has not answered yet. They
  // show at once, so the box can clear without waiting for the script.
  const [pending, setPending] = useState<Pending[]>([]);
  const draftRef = useRef(draft);
  draftRef.current = draft;

  useLayoutEffect(() => {
    const el = listRef.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [detail.items.length, notices.length, answering, pending.length]);

  const firstOpen = detail.items.find((i): i is IncomingItem => i.type === 'incoming' && i.decision === 'open');
  const worker: Author = { key: t.id, name: t.id, kind: 'worker', seed: t.title };
  const badge = t.openDecisions > 0 && t.badge !== 'needs-you' ? 'needs-you' : t.badge;

  const openTerminal = async () => {
    setOpeningTerminal(true);
    const r = await api.openTerminal(t.id);
    setOpeningTerminal(false);
    if (!r.ok) addNotice('error', 'Could not open the terminal', r);
  };

  const noteRid = useRef<{ text: string; rid: string } | null>(null);

  // With no worker yet, messages go to First mate as notes tagged with this
  // thread, which is how the planning conversation stays here.
  const sendNoteHere = (full: string): boolean => {
    const rid = noteRid.current?.text === full ? noteRid.current.rid : newRequestId();
    noteRid.current = { text: full, rid };
    const entry: Pending = { key: `p${Date.now()}-${Math.random()}`, text: full, since: Date.now() };
    setPending((p) => [...p, entry]);
    setDraft('');
    void api.sendNote(`${threadTag(t.id)}${full}`, rid).then((r) => {
      setPending((p) => p.filter((x) => x.key !== entry.key));
      if (r.outcome === 'refused') {
        setDraft(restoreDraft(full, draftRef.current));
        addNotice('error', 'Your message to First mate was not sent', noteAsWrite(r));
      } else {
        noteRid.current = null;
        if (r.outcome === 'pending') addNotice('warning', PENDING_TEXT, noteAsWrite(r));
      }
    });
    return true;
  };

  const send = async (full: string): Promise<boolean> => {
    if (!full.trim()) return false;
    if (t.placeholder) return sendNoteHere(full);
    const entry: Pending = { key: `p${Date.now()}-${Math.random()}`, text: full, since: Date.now() };
    setPending((p) => [...p, entry]);
    setDraft('');
    void api.send(t.id, full).then((r) => {
      setPending((p) => p.filter((x) => x.key !== entry.key));
      if (r.outcome === 'unconfirmed') {
        addNotice('warning', 'Typed into the terminal, but the send script could not confirm it was submitted. Check the terminal before resending.', r);
      } else if (r.outcome === 'refused') {
        // Put the text back so nothing typed is lost.
        setDraft(restoreDraft(full, draftRef.current));
        addNotice('error', 'Your message was not sent', r);
      }
    });
    return true;
  };

  const rows: Row[] = detail.items.map((item) =>
    item.type === 'incoming'
      ? incomingRow(item, worker, readOnly, answering === item.id, setAnswering, t.id, addNotice)
      : outgoingRow(item),
  );
  // The first message that arrived since the thread was last read.
  const incomingItems = detail.items.filter((i) => i.type === 'incoming');
  const newKey = newFrom !== null && incomingItems.length > newFrom ? incomingItems[newFrom].id : null;
  const delivered = detail.items.filter((i): i is OutgoingItem => i.type === 'outgoing');
  for (const p of pending) {
    if (!delivered.some((o) => o.body === p.text && (o.at ?? 0) >= p.since - 60_000)) rows.push(pendingRow(p));
  }

  return (
    <>
      <header className="channel-head">
        <div className="head-row">
        <div className="head-main">
          <h2 title={t.title}>
            <button
              type="button"
              className={`star${starred ? ' on' : ''}`}
              aria-label={starred ? 'Unstar conversation' : 'Star conversation'}
              aria-pressed={starred}
              title={starred ? 'Remove from Starred' : 'Add to Starred, at the top of the sidebar'}
              onClick={onToggleStar}
            >
              <svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true">
                <path
                  d="m10 2.8 2.2 4.6 5 .7-3.6 3.5.9 5-4.5-2.4-4.5 2.4.9-5L2.8 8.1l5-.7z"
                  fill={starred ? 'currentColor' : 'none'}
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinejoin="round"
                />
              </svg>
            </button>
            <Avatar author={worker} size={24} presence={isActive(badge)} className="head-avatar" />
            {t.id}
            <span className={`badge badge-${badge}`} title={t.stateLine ?? 'Checking current state...'}>
              {BADGE_LABELS[badge]}
            </span>
          </h2>
          <div className="topic">
            <span className="topic-title">{t.title}</span>
            {t.project && <span>{t.project}</span>}
            {t.pr && <ExternalLink url={t.pr} />}
          </div>
        </div>
        {t.placeholder === 'finished' && (
          <div className="head-actions">
            <div className="head-buttons">
              <button
                type="button"
                className="btn"
                disabled={readOnly}
                data-testid="hide-thread"
                title="Remove this finished thread from the list. Only crew-chat's view changes."
                onClick={() => {
                  const hide = !t.hidden;
                  void api.setHidden(t.id, hide).then((r) => {
                    if (r.ok) onHidden(hide);
                    else addNotice('error', 'Could not change the list', r);
                  });
                }}
              >
                {t.hidden ? 'Put back in the list' : 'Remove from list'}
              </button>
            </div>
          </div>
        )}
        {!t.placeholder && (
        <div className="head-actions">
          <div className="head-buttons">
            <button
              type="button"
              className="btn"
              onClick={() => void openTerminal()}
              disabled={!t.terminal.available || readOnly || openingTerminal}
              title={!t.terminal.available ? t.terminal.reason : readOnly ? 'Read-only mode' : "Open this worker's live terminal in a new Terminal window"}
              data-testid="open-terminal"
            >
              <svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true">
                <path d="M11 4h5v5m0-5-7 7M14 12v3a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h3" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              {openingTerminal ? 'Opening...' : 'Open terminal'}
            </button>
            <button
              type="button"
              className="btn danger-outline"
              onClick={onCleanup}
              disabled={readOnly}
              title={readOnly ? 'Read-only mode' : 'Stop this worker and clean it up'}
              data-testid="clean-up"
            >
              <svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true">
                <path d="M4 6h12M8 6V4h4v2m-6 0 .7 10a1 1 0 0 0 1 .9h4.6a1 1 0 0 0 1-.9L14 6" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              Clean up
            </button>
          </div>

        </div>
        )}
        </div>
        <div className="tabs">
          <button type="button" className={`tab${paneOpen && !t.placeholder ? '' : ' on'}`} onClick={() => togglePane(false)}>
            <svg viewBox="0 0 20 20" width="15" height="15" aria-hidden="true">
              <path d="M4 4h12a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H9l-4 3v-3H4a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1z" fill="currentColor" />
            </svg>
            Messages
          </button>
          {!t.placeholder && (
            <button
              type="button"
              className={`tab${paneOpen ? ' on' : ''}`}
              onClick={() => togglePane(!paneOpen)}
              aria-pressed={paneOpen}
              title="Show what the worker's terminal shows, next to the chat"
              data-testid="terminal-view"
            >
              <svg viewBox="0 0 20 20" width="15" height="15" aria-hidden="true">
                <rect x="2.5" y="3.5" width="15" height="13" rx="2" fill="none" stroke="currentColor" strokeWidth="1.5" />
                <path d="m6 8 2.5 2L6 12m4 0h4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              Terminal
            </button>
          )}
          <div className="head-info">
            {t.stateLine && (
              <span className="state-line" title={t.stateLine}>
                {t.stateLine.replace(/^state:\s*/, '')}
              </span>
            )}
            {!t.placeholder && !t.terminal.available && t.terminal.reason && (
              <span className="btn-reason" title="Why Open terminal is off">
                {t.terminal.reason}
              </span>
            )}
            <ModelLine t={t} />
          </div>
        </div>
      </header>
      {firstOpen && (
        <button
          type="button"
          className="decision-banner"
          onClick={() => document.getElementById(`item-${firstOpen.id}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' })}
        >
          {t.openDecisions === 1 ? 'This worker is waiting on a decision from you.' : `This worker is waiting on ${t.openDecisions} decisions from you.`}{' '}
          <span className="banner-link">Jump to it</span>
        </button>
      )}
      <div className="conv-split">
      <div className="conv-main">
      <div
        className="messages"
        ref={listRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        }}
      >
        {detail.items.length === 0 ? (
          <div className="empty center">
            <strong>No messages yet</strong>
            <span>Updates from this worker will show up here as they arrive.</span>
          </div>
        ) : (
          <div className="dm-intro">
            <div className="intro-who">
              <Avatar author={worker} size={72} presence={isActive(badge)} className="intro-avatar" />
              <h3>{t.id}</h3>
            </div>
            {t.placeholder === 'finished' ? (
              <p>
                <strong>{t.title}</strong> is finished and its worker was cleaned up. This is the history crew-chat kept. Messages you send
                here go to First mate.
              </p>
            ) : t.placeholder ? (
              <p>
                No worker is running for <strong>{t.title}</strong> yet. Talk it over with First mate here: your messages go to First mate,
                its replies show up here, and when the worker starts this conversation carries on with it.
              </p>
            ) : (
              <p>
                This conversation is just between <strong>{t.id}</strong> and you. It is working on <strong>{t.title}</strong>; its updates
                appear here, and anything you send goes straight to it.
              </p>
            )}
          </div>
        )}
        <MessageList rows={rows} now={now} newKey={newKey} onQuote={(text) => setDraft(quoteInto(text, draftRef.current))} />
        {notices.map((n) => (
          <NoticeView key={n.id} n={n} onDismiss={() => dismissNotice(n.id)} />
        ))}
      </div>
      <ComposerBox
        value={draft}
        onChange={setDraft}
        onSubmit={send}
        busy={false}
        readOnly={readOnly}
        placeholder={t.placeholder === 'finished' ? 'Ask First mate about this' : t.placeholder ? 'Message First mate about this' : `Message ${t.id}`}
        hint={
          t.placeholder ? (
            <span>Goes to First mate, tagged with this conversation. Enter to send.</span>
          ) : draft.startsWith('/') ? (
            <span className="warn">Starts with "/", so it is typed straight into the worker's terminal as a command instead of going to its inbox.</span>
          ) : undefined
        }
      />
      </div>
      {paneOpen && !t.placeholder && <TerminalPanel id={t.id} onClose={() => togglePane(false)} />}
      </div>
    </>
  );
}

function incomingRow(
  item: IncomingItem,
  author: Author,
  readOnly: boolean,
  answering: boolean,
  setAnswering: (id: string | null) => void,
  threadId: string,
  addNotice: ThreadViewProps['addNotice'],
): Row {
  if (item.author === 'firstmate') author = FIRST_MATE;
  const tone = verbTone(item.verb);
  const cls = ['in', `tone-${tone}`];
  if (item.decision) cls.push(`decision-${item.decision}`);
  const canAnswer = item.decision === 'open' && item.key !== null && !readOnly;
  const form = item.decision === 'open' && item.key ? (item.form ?? null) : null;
  return {
    key: item.id,
    author,
    at: item.at,
    className: cls.join(' '),
    attrs: { 'data-verb': item.verb, 'data-decision': item.decision ?? undefined, 'data-at-source': item.atSource ?? 'none' },
    copyText: item.text,
    actions: canAnswer && !answering && !form ? (
      <button type="button" className="bar-btn" onClick={() => setAnswering(item.id)} aria-label="Answer this decision" title="Answer">
        Answer
      </button>
    ) : undefined,
    tags: (
      <>
        <span className={`chip chip-${tone}`}>{verbLabel(item.verb)}</span>
        {item.decision === 'resolved' && <span className="chip chip-good">Resolved</span>}
      </>
    ),
    body: (
      <>
        <Collapsible text={item.text || '(no text)'} />
        {form && item.key && <QuestionForm form={form} threadId={threadId} decisionKey={item.key} readOnly={readOnly} addNotice={addNotice} />}
        {!form && item.decision === 'open' && item.key && !answering && (
          <div className="decision-actions">
            <button type="button" className="btn primary" onClick={() => setAnswering(item.id)} disabled={readOnly} title={readOnly ? 'Read-only mode' : undefined}>
              Answer
            </button>
            <span className="hint">Your answer goes to the worker and closes this decision.</span>
          </div>
        )}
        {!form && item.decision === 'open' && item.key && answering && (
          <AnswerBox threadId={threadId} decisionKey={item.key} onDone={() => setAnswering(null)} addNotice={addNotice} />
        )}
        {item.decision === 'resolved' && item.resolution && (
          <div className="resolution">
            <span className="resolution-mark" aria-hidden="true">
              ✓
            </span>
            <RichText text={item.resolution} />
          </div>
        )}
        {item.decision === 'closed-by-result' && <div className="resolution muted">Closed when the worker reported its result.</div>}
        {item.decision === 'replaced' && <div className="resolution muted">Asked again further down.</div>}
      </>
    ),
  };
}

export interface Pending {
  key: string;
  text: string;
  since: number;
}

// "> "-prefixed copy of a message, ahead of whatever is already typed.
export function quoteInto(text: string, current: string): string {
  const quoted = text
    .trim()
    .split('\n')
    .map((l) => `> ${l}`)
    .join('\n');
  return current.trim() ? `${quoted}\n${current}` : `${quoted}\n`;
}

export function restoreDraft(sent: string, current: string): string {
  return current.trim() ? `${sent}\n${current}` : sent;
}

export function pendingRow(p: Pending): Row {
  return {
    key: p.key,
    author: YOU,
    at: p.since,
    className: 'out pending',
    attrs: { 'data-pending': 'yes' },
    body: (
      <>
        <Collapsible text={p.text} />
        <span className="receipt" title="Handing this to the send script.">
          Sending...
        </span>
      </>
    ),
  };
}

function outgoingRow(item: OutgoingItem): Row {
  return {
    key: item.id,
    author: item.from === 'you' ? YOU : FIRST_MATE,
    at: item.at,
    className: `out from-${item.from}`,
    copyText: item.body,
    attrs: { 'data-read': item.read ? 'yes' : 'no', 'data-from': item.from },
    body: (
      <>
        <Collapsible text={item.body} />
        <span className={item.read ? 'receipt read' : 'receipt'} title={item.read ? 'The worker has picked this up.' : 'Waiting for the worker to pick this up.'}>
          {item.read ? '✓✓ Read' : '✓ Sent'}
        </span>
      </>
    ),
  };
}

function AnswerBox({
  threadId,
  decisionKey,
  onDone,
  addNotice,
}: {
  threadId: string;
  decisionKey: string;
  onDone: () => void;
  addNotice: ThreadViewProps['addNotice'];
}) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (!text.trim() || busy) return;
    setBusy(true);
    const r = await api.answer(threadId, decisionKey, text);
    setBusy(false);
    if (r.ok) onDone();
    else addNotice('error', 'Your answer was not sent', r);
  };
  return (
    <div className="answer-box">
      <textarea
        autoFocus
        rows={3}
        value={text}
        placeholder="Type your answer"
        aria-label="Your answer"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            void submit();
          } else if (e.key === 'Escape') onDone();
        }}
      />
      <div className="answer-actions">
        <button type="button" className="btn primary" onClick={() => void submit()} disabled={busy || !text.trim()}>
          {busy ? 'Sending...' : 'Send answer'}
        </button>
        <button type="button" className="btn ghost" onClick={onDone} disabled={busy}>
          Cancel
        </button>
      </div>
    </div>
  );
}

export function modelLabel(t: { model: string | null; usage: { model: string | null } | null }): string | null {
  const actual = t.usage?.model ?? null;
  const asked = t.model && t.model !== 'default' ? t.model : null;
  if (actual && asked && !actual.includes(asked)) return `${actual} (asked for ${asked})`;
  return actual ?? asked ?? (t.model === 'default' ? 'default model' : null);
}

function ModelLine({ t }: { t: ThreadDetail['summary'] }) {
  const model = modelLabel(t);
  const u = t.usage;
  return (
    <div className="model-line" data-testid="model-line">
      {model && <span className="model-chip">{model}</span>}
      {t.effort && <span className="model-chip">{t.effort} effort</span>}
      {u ? (
        <span
          className="tokens"
          title={`Since this worker started: ${u.inputTokens.toLocaleString()} input, ${u.cacheReadTokens.toLocaleString()} cache read, ${u.outputTokens.toLocaleString()} output tokens over ${u.messages} responses.`}
        >
          {formatTokens(u.contextTokens)} in context · {formatTokens(u.inputTokens + u.cacheReadTokens + u.outputTokens)} tokens used · {formatTokens(u.outputTokens)} output
        </span>
      ) : (
        t.usageNote && <span className="tokens muted">{t.usageNote}</span>
      )}
    </div>
  );
}
