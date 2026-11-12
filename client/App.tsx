import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AppConfig, FirstmateDetail, ThreadDetail, ThreadSummary, WriteResult } from '../shared/types.ts';
import { api } from './api.ts';
import { CancelDialog, CleanupDialog, NewWorkerDialog } from './dialogs.tsx';
import { DocContext, DocViewer, ImageViewer } from './docs.tsx';
import { isImagePath } from './blocks.ts';
import { FirstmateView, type NoteDraft } from './FirstMate.tsx';
import { setUploadDir } from './format.tsx';
import {
  FIRSTMATE,
  isThreadId,
  USAGE,
  idFromHash,
  loadJson,
  newRequestId,
  nextNoticeId,
  noteAsWrite,
  PENDING_TEXT,
  saveJson,
  sortThreads,
  type Notice,
} from './model.ts';
import { Sidebar, ThemeSwitch, type View } from './Sidebar.tsx';
import { ContextMenu, type MenuEntry } from './menu.tsx';
import { UsageView } from './UsageView.tsx';
import { PANE_EVENT, ThreadView } from './ThreadView.tsx';

const SEEN_KEY = 'crewchat.seen.v1';

// The tab icon, with a red dot when something needs you or a softer dot for
// unread news.
function setFavicon(state: 'alert' | 'unread' | 'none'): void {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 64;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.fillStyle = '#4b4aa6';
  ctx.beginPath();
  ctx.roundRect(4, 4, 56, 56, 14);
  ctx.fill();
  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 38px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('F', 32, 35);
  if (state !== 'none') {
    ctx.fillStyle = state === 'alert' ? '#e01e5a' : '#1d9bd1';
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 5;
    ctx.beginPath();
    ctx.arc(49, 15, 13, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }
  let link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
  if (!link) {
    link = document.createElement('link');
    link.rel = 'icon';
    document.head.appendChild(link);
  }
  link.href = canvas.toDataURL('image/png');
  link.dataset.state = state;
}

function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

export function App() {
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [threads, setThreads] = useState<ThreadSummary[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(idFromHash);
  const [detail, setDetail] = useState<ThreadDetail | null>(null);
  const [seen, setSeen] = useState<Record<string, number>>(() => loadJson(SEEN_KEY, {}));
  const [live, setLive] = useState(false);
  const [notices, setNotices] = useState<Record<string, Notice[]>>({});
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [fm, setFm] = useState<FirstmateDetail | null>(null);
  const [noteDraft, setNoteDraft] = useState<NoteDraft>(() => ({ text: '', rid: newRequestId(), ridFor: null }));
  const [newWorkerOpen, setNewWorkerOpen] = useState(false);
  const [cleanupFor, setCleanupFor] = useState<ThreadSummary | null>(null);
  const [cancelFor, setCancelFor] = useState<ThreadSummary | null>(null);
  const [filter, setFilter] = useState('');
  const [view, setView] = useState<View>('all');
  const [themeOpen, setThemeOpen] = useState(false);
  const [doc, setDoc] = useState<{ path: string; thread: string | null } | null>(null);
  const [starred, setStarred] = useState<string[]>(() => loadJson('crewchat.starred.v1', []));
  const toggleStar = (id: string) =>
    setStarred((prev) => {
      const next = prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id];
      saveJson('crewchat.starred.v1', next);
      return next;
    });
  const [flash, setFlash] = useState<{ tone: 'good' | 'warning'; text: string; detail?: string } | null>(null);
  const [menu, setMenu] = useState<{ t: ThreadSummary; x: number; y: number } | null>(null);
  const closeMenu = useCallback(() => setMenu(null), []);
  // A thread whose open decision should be scrolled to once it has loaded.
  const jumpTo = useRef<string | null>(null);
  const now = useNow();
  const selectedRef = useRef(selected);
  selectedRef.current = selected;

  const refreshThreads = useCallback(async (): Promise<void> => {
    try {
      setThreads(await api.threads());
      setLoadError(null);
    } catch (err) {
      setLoadError((err as Error).message);
    }
  }, []);

  const refreshDetail = useCallback(async (id: string) => {
    try {
      const d = await api.thread(id);
      if (selectedRef.current === id) setDetail(d);
    } catch {
      if (selectedRef.current === id) setDetail(null);
    }
  }, []);

  const refreshFirstmate = useCallback(async () => {
    try {
      setFm(await api.firstmate());
    } catch {
      // Keep the last good copy; the live indicator shows connection trouble.
    }
  }, []);

  useEffect(() => {
    void api.config().then(
      (c) => {
        setUploadDir(c.uploadDir);
        setConfig(c);
      },
      (err: Error) => setLoadError(err.message),
    );
    void refreshThreads();
    void refreshFirstmate();
  }, [refreshThreads, refreshFirstmate]);

  useEffect(() => {
    const es = new EventSource('/api/events');
    es.onopen = () => {
      setLive(true);
      void refreshThreads();
      void refreshFirstmate();
      if (isThreadId(selectedRef.current)) void refreshDetail(selectedRef.current);
    };
    es.onerror = () => setLive(false);
    es.addEventListener('change', (ev) => {
      const { ids } = JSON.parse((ev as MessageEvent<string>).data) as { ids: string[] };
      if (ids.includes(FIRSTMATE)) void refreshFirstmate();
      if (ids.some((i) => i !== FIRSTMATE)) void refreshThreads();
      const sel = selectedRef.current;
      // Notes and the backlog feed queued threads and the planning chat.
      if (isThreadId(sel) && (ids.includes(sel) || ids.includes(FIRSTMATE) || ids.includes('__backlog__'))) void refreshDetail(sel);
    });
    return () => es.close();
  }, [refreshThreads, refreshDetail, refreshFirstmate]);

  useEffect(() => {
    const onHash = () => setSelected(idFromHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  const sorted = useMemo(() => (threads ? sortThreads(threads) : []), [threads]);

  // Without a thread in the URL, open the one at the top of the list.
  useEffect(() => {
    if (!threads || selected === FIRSTMATE || selected === USAGE) return;
    if (selected && threads.some((t) => t.id === selected)) return;
    const first = sortThreads(threads.filter((t) => !t.hidden))[0];
    if (first) window.location.replace(`#/t/${encodeURIComponent(first.id)}`);
    else if (selected) setSelected(null);
  }, [threads, selected]);

  useEffect(() => {
    setDetail(null);
    if (isThreadId(selected)) void refreshDetail(selected);
  }, [selected, refreshDetail]);

  // How much of the thread had been read when it was opened, for the New
  // line. Captured before the effect below marks the thread read.
  const seenRef = useRef(seen);
  seenRef.current = seen;
  const [openedAt, setOpenedAt] = useState<{ id: string; seen: number | null } | null>(null);
  useEffect(() => {
    setOpenedAt(selected ? { id: selected, seen: seenRef.current[selected] ?? null } : null);
  }, [selected]);

  // A thread first seen counts as read; after that, new updates count as
  // unread until the thread is opened. First mate counts its replies.
  const fmReplies = fm ? fm.notes.filter((n) => n.reply).length : 0;
  useEffect(() => {
    if (!threads) return;
    setSeen((prev) => {
      const next = { ...prev };
      let changed = false;
      const mark = (id: string, count: number) => {
        if (next[id] === undefined || (id === selected && next[id] !== count)) {
          next[id] = count;
          changed = true;
        }
      };
      for (const t of threads) mark(t.id, t.incomingCount);
      if (fm) mark(FIRSTMATE, fmReplies);
      if (!changed) return prev;
      saveJson(SEEN_KEY, next);
      return next;
    });
  }, [threads, fm, fmReplies, selected]);

  const markSeen = (id: string, count: number) =>
    setSeen((prev) => {
      const next = { ...prev, [id]: Math.max(0, count) };
      saveJson(SEEN_KEY, next);
      return next;
    });

  const addNotice = (id: string, tone: Notice['tone'], title: string, result: WriteResult) =>
    setNotices((prev) => ({ ...prev, [id]: [...(prev[id] ?? []), { id: nextNoticeId(), tone, title, result }] }));
  const dismissNotice = (id: string, nid: number) =>
    setNotices((prev) => ({ ...prev, [id]: (prev[id] ?? []).filter((n) => n.id !== nid) }));

  const unreadOf = (id: string) => {
    const t = threads?.find((x) => x.id === id);
    return t ? Math.max(0, t.incomingCount - (seen[id] ?? t.incomingCount)) : 0;
  };
  const readOnly = config?.readOnly ?? false;

  const fmUnread = Math.max(0, fmReplies - (seen[FIRSTMATE] ?? fmReplies));
  const attention = sorted.filter((t) => t.badge === 'needs-you' || t.openDecisions > 0).length;
  const needsYou = sorted.find((t) => !t.placeholder && (t.badge === 'needs-you' || t.openDecisions > 0));
  const firstWorker = sorted.find((t) => !t.hidden);
  const unreadTotal = sorted.reduce((n, t) => n + unreadOf(t.id), 0) + fmUnread;
  const selectedName = selected === FIRSTMATE ? 'First mate' : selected === USAGE ? 'Usage' : (selected ?? '');

  // Like a team chat tab: "!" and a red badge on the icon when something
  // needs you, "*" when there is only unread news.
  useEffect(() => {
    const prefix = attention > 0 ? '! ' : unreadTotal > 0 ? '* ' : '';
    document.title = `${prefix}${selectedName ? `${selectedName} - ` : ''}Firstmate crew`;
    setFavicon(attention > 0 ? 'alert' : unreadTotal > 0 ? 'unread' : 'none');
  }, [attention, unreadTotal, selectedName]);
  const openDoc = (path: string) => setDoc({ path, thread: isThreadId(selected) ? selected : null });

  useEffect(() => {
    if (!detail || jumpTo.current !== detail.summary.id) return;
    jumpTo.current = null;
    const open = detail.items.find((i) => i.type === 'incoming' && i.decision === 'open');
    if (open) requestAnimationFrame(() => document.getElementById(`item-${open.id}`)?.scrollIntoView({ block: 'center' }));
  }, [detail]);

  const copy = (text: string, what: string) =>
    void navigator.clipboard?.writeText(text).then(
      () => setFlash({ tone: 'good', text: `Copied ${what}.` }),
      () => setFlash({ tone: 'warning', text: `Could not copy ${what}.` }),
    );

  const setHidden = (t: ThreadSummary, hide: boolean) =>
    void api.setHidden(t.id, hide).then((r) => {
      if (!r.ok) return addNotice(t.id, 'error', 'Could not change the list', r);
      void refreshThreads().then(() => {
        if (hide && selectedRef.current === t.id) window.location.hash = '';
      });
    });

  const workerMenu = (t: ThreadSummary): MenuEntry[] => {
    const go = () => {
      window.location.hash = `#/t/${encodeURIComponent(t.id)}`;
    };
    const live = !t.placeholder;
    const isStarred = starred.includes(t.id);
    const unread = unreadOf(t.id);
    const entries: MenuEntry[] = [
      { kind: 'heading', label: t.id },
      { kind: 'item', label: 'Open conversation', onSelect: go },
    ];
    if (t.openDecisions > 0) {
      entries.push({
        kind: 'item',
        label: t.openDecisions === 1 ? 'Go to the open decision' : `Go to the ${t.openDecisions} open decisions`,
        onSelect: () => {
          jumpTo.current = t.id;
          if (selected === t.id && detail) setDetail({ ...detail });
          else go();
        },
      });
    }
    if (live) {
      entries.push(
        {
          kind: 'item',
          label: 'Show terminal beside the chat',
          onSelect: () => {
            saveJson('crewchat.pane.v1', true);
            window.dispatchEvent(new Event(PANE_EVENT));
            go();
          },
        },
        {
          kind: 'item',
          label: 'Open terminal window',
          disabled: readOnly || !t.terminal.available,
          hint: readOnly ? 'Read-only mode' : t.terminal.available ? undefined : (t.terminal.reason ?? 'No terminal for this worker'),
          onSelect: () =>
            void api.openTerminal(t.id).then((r) => {
              if (!r.ok) addNotice(t.id, 'error', 'Could not open the terminal', r);
            }),
        },
      );
    }
    entries.push(
      { kind: 'separator' },
      { kind: 'item', label: isStarred ? 'Unstar' : 'Star', onSelect: () => toggleStar(t.id) },
      unread > 0 || t.id === selected
        ? {
            kind: 'item',
            label: 'Mark as read',
            disabled: unread === 0,
            onSelect: () => markSeen(t.id, t.incomingCount),
          }
        : {
            kind: 'item',
            label: 'Mark as unread',
            disabled: t.incomingCount === 0,
            onSelect: () => markSeen(t.id, t.incomingCount - 1),
          },
      { kind: 'separator' },
      { kind: 'item', label: 'Copy name', onSelect: () => copy(t.id, 'the name') },
      { kind: 'item', label: 'Copy link to conversation', onSelect: () => copy(`${window.location.origin}/#/t/${encodeURIComponent(t.id)}`, 'the link') },
    );
    if (t.pr) entries.push({ kind: 'item', label: 'Open pull request', onSelect: () => window.open(t.pr!, '_blank', 'noopener,noreferrer') });
    if (t.placeholder === 'queued' || t.placeholder === 'requested') {
      entries.push(
        { kind: 'separator' },
        {
          kind: 'item',
          label: t.hidden ? 'Show in the list again' : 'Remove from the list',
          hint: "Only crew-chat's view changes; First mate still has it",
          disabled: readOnly,
          onSelect: () => setHidden(t, !t.hidden),
        },
        { kind: 'item', label: 'Ask First mate to cancel...', danger: true, disabled: readOnly, onSelect: () => setCancelFor(t) },
      );
    }
    if (t.placeholder === 'finished') {
      entries.push(
        { kind: 'separator' },
        {
          kind: 'item',
          label: t.hidden ? 'Show in the list again' : 'Remove from the list',
          onSelect: () => setHidden(t, !t.hidden),
        },
      );
    }
    if (live) {
      entries.push(
        { kind: 'separator' },
        {
          kind: 'item',
          label: 'Clean up...',
          danger: true,
          disabled: readOnly,
          hint: readOnly ? 'Read-only mode' : 'Asks before anything is removed',
          onSelect: () => setCleanupFor(t),
        },
      );
    }
    return entries;
  };

  return (
    <DocContext.Provider value={openDoc}>
    <div className="shell">
      <header className="topbar">
        <div className="topbar-nav">
          <button type="button" className="top-btn" aria-label="Back" title="Back" onClick={() => window.history.back()}>
            <svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true">
              <path d="M16 10H4m5-5-5 5 5 5" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
          <button type="button" className="top-btn" aria-label="Forward" title="Forward" onClick={() => window.history.forward()}>
            <svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true">
              <path d="M4 10h12m-5-5 5 5-5 5" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        </div>
        <label className="top-search">
          <svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true">
            <circle cx="9" cy="9" r="5.5" fill="none" stroke="currentColor" strokeWidth="1.7" />
            <path d="m13.2 13.2 3.8 3.8" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
          </svg>
          <input
            type="search"
            placeholder="Search workers by name, task, or project"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            aria-label="Search workers"
          />
        </label>
        <span className={live ? 'live on' : 'live'} role="status">
          {live ? 'Live' : 'Reconnecting...'}
        </span>
      </header>
      <div className="frame">
      <nav className="rail" aria-label="Places">
        <span className="rail-logo" title="Firstmate" aria-hidden="true">
          F
        </span>
        <button
          type="button"
          className={`rail-item${isThreadId(selected) && view === 'all' ? ' on' : ''}`}
          title="All workers"
          onClick={() => {
            setView('all');
            if (!isThreadId(selected) && firstWorker) window.location.hash = `#/t/${encodeURIComponent(firstWorker.id)}`;
          }}
        >
          <span className="rail-icon" aria-hidden="true">
            <svg viewBox="0 0 20 20" width="20" height="20">
              <path d="M3 9.5 10 4l7 5.5V16a1 1 0 0 1-1 1h-3.5v-4.5h-5V17H4a1 1 0 0 1-1-1z" fill="currentColor" />
            </svg>
          </span>
          <span className="rail-label">Home</span>
        </button>
        <a className={`rail-item${selected === FIRSTMATE ? ' on' : ''}`} href="#/firstmate" title="First mate">
          <span className="rail-icon" aria-hidden="true">
            <svg viewBox="0 0 20 20" width="20" height="20">
              <path d="M4 4h12a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H9l-4 3v-3H4a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1z" fill="none" stroke="currentColor" strokeWidth="1.6" />
            </svg>
            {fmUnread > 0 && <span className="rail-badge">{fmUnread}</span>}
          </span>
          <span className="rail-label">First mate</span>
        </a>
        <button
          type="button"
          className={`rail-item${view === 'unreads' ? ' on' : ''}`}
          title="What needs you: unread updates and open decisions"
          onClick={() => {
            setView('unreads');
            if (needsYou) window.location.hash = `#/t/${encodeURIComponent(needsYou.id)}`;
          }}
        >
          <span className="rail-icon" aria-hidden="true">
            <svg viewBox="0 0 20 20" width="20" height="20">
              <path d="M10 3a4.5 4.5 0 0 0-4.5 4.5c0 3-1.5 5-2 5.5h13c-.5-.5-2-2.5-2-5.5A4.5 4.5 0 0 0 10 3zm-2 12a2 2 0 0 0 4 0" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
            </svg>
            {attention > 0 && <span className="rail-badge">{attention}</span>}
          </span>
          <span className="rail-label">Activity</span>
        </button>
        <a className={`rail-item${selected === USAGE ? ' on' : ''}`} href="#/usage" title="Token use by worker and First mate">
          <span className="rail-icon" aria-hidden="true">
            <svg viewBox="0 0 20 20" width="20" height="20">
              <path d="M3.5 16.5h13M5.5 14V9.5m4 4.5V5m4 9v-6.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
            </svg>
          </span>
          <span className="rail-label">Usage</span>
        </a>
        <div className="rail-bottom">
          <button
            type="button"
            className="rail-round"
            aria-label="Create"
            title="Ask First mate to start a new worker"
            disabled={config?.readOnly ?? true}
            onClick={() => setNewWorkerOpen(true)}
          >
            +
          </button>
          <div className="theme-menu-wrap">
            <button
              type="button"
              className="rail-round"
              aria-label="Theme"
              aria-expanded={themeOpen}
              title="Light or dark"
              onClick={() => setThemeOpen(!themeOpen)}
            >
              <svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true">
                <path d="M15.5 12.5A6.5 6.5 0 0 1 7.5 4.5a6.5 6.5 0 1 0 8 8z" fill="currentColor" />
              </svg>
            </button>
            {themeOpen && (
              <div className="theme-menu" onMouseLeave={() => setThemeOpen(false)}>
                <ThemeSwitch onChosen={() => setThemeOpen(false)} />
              </div>
            )}
          </div>
          <span className="rail-me" title="You">
            You
            <span className="rail-me-dot" aria-hidden="true" />
          </span>
        </div>
      </nav>
      <Sidebar
        config={config}
        threads={threads}
        sorted={sorted}
        fm={fm}
        selected={selected}
        unreadOf={unreadOf}
        fmUnread={fmUnread}
        loadError={loadError}
        onNewWorker={() => setNewWorkerOpen(true)}
        filter={filter}
        setFilter={setFilter}
        starred={starred}
        view={view}
        setView={setView}
        onRowMenu={(t, x, y) => setMenu({ t, x, y })}
      />
      <main className="thread">
        {config && config.missing.length > 0 && (
          <div className="flash flash-warning" role="status" data-testid="missing-scripts">
            <strong>
              This Firstmate home lacks {config.missing.map((m) => m.script).join(', ')}, so these will not work:{' '}
              {config.missing.map((m) => m.needed).join('; ')}.
            </strong>
          </div>
        )}
        {flash && (
          <div className={`flash flash-${flash.tone}`} role="status">
            <div>
              <strong>{flash.text}</strong>
              {flash.detail && <pre className="notice-detail">{flash.detail}</pre>}
            </div>
            <button type="button" className="btn ghost small" onClick={() => setFlash(null)}>
              Dismiss
            </button>
          </div>
        )}
        {selected === USAGE ? (
          <UsageView />
        ) : selected === FIRSTMATE ? (
          <FirstmateView
            fm={fm}
            now={now}
            readOnly={readOnly}
            draft={noteDraft}
            setDraft={setNoteDraft}
            notices={notices[FIRSTMATE] ?? []}
            addNotice={(tone, title, r) => addNotice(FIRSTMATE, tone, title, r)}
            dismissNotice={(nid) => dismissNotice(FIRSTMATE, nid)}
          />
        ) : selected && detail && detail.summary.id === selected ? (
          <ThreadView
            key={selected}
            detail={detail}
            now={now}
            readOnly={readOnly}
            notices={notices[selected] ?? []}
            draft={drafts[selected] ?? ''}
            setDraft={(v) => setDrafts((p) => ({ ...p, [selected]: v }))}
            addNotice={(tone, title, r) => addNotice(selected, tone, title, r)}
            dismissNotice={(nid) => dismissNotice(selected, nid)}
            onCleanup={() => setCleanupFor(detail.summary)}
            onCancel={() => setCancelFor(detail.summary)}
            starred={starred.includes(selected)}
            onToggleStar={() => toggleStar(selected)}
            newFrom={openedAt?.id === selected ? openedAt.seen : null}
            onHidden={(hidden) => {
              void refreshThreads().then(() => {
                if (hidden) window.location.hash = '';
              });
            }}
          />
        ) : (
          <div className="empty center">
            {threads !== null && threads.length === 0 ? (
              <>
                <strong>Nothing to show yet</strong>
                <span>There are no live workers in this Firstmate home.</span>
              </>
            ) : (
              <span>Loading...</span>
            )}
          </div>
        )}
      </main>
      </div>
      {menu && <ContextMenu x={menu.x} y={menu.y} label={`Actions for ${menu.t.id}`} entries={workerMenu(menu.t)} onClose={closeMenu} />}
      {cancelFor && (
        <CancelDialog
          t={cancelFor}
          onClose={() => setCancelFor(null)}
          onSent={(r, hide) => {
            const t = cancelFor;
            setCancelFor(null);
            if (r.outcome === 'pending') addNotice(t.id, 'warning', PENDING_TEXT, noteAsWrite(r));
            void refreshFirstmate();
            if (hide) setHidden(t, true);
            else void refreshDetail(t.id);
            setFlash({ tone: 'good', text: `Asked First mate to cancel ${t.title}.` });
          }}
        />
      )}
      {newWorkerOpen && (
        <NewWorkerDialog
          projects={fm?.projects ?? []}
          onClose={() => setNewWorkerOpen(false)}
          onSent={(r) => {
            setNewWorkerOpen(false);
            if (r.outcome === 'pending') addNotice(FIRSTMATE, 'warning', PENDING_TEXT, noteAsWrite(r));
            void (async () => {
              await Promise.all([refreshFirstmate(), refreshThreads()]);
              // The request gets its own conversation, which is also where any planning happens.
              window.location.hash = r.noteId ? `#/t/request-${encodeURIComponent(r.noteId)}` : '#/firstmate';
            })();
          }}
        />
      )}
      {cleanupFor && (
        <CleanupDialog
          t={cleanupFor}
          onClose={(last) => {
            setCleanupFor(null);
            if (last && last.outcome !== 'cleaned' && last.outcome !== 'cleaned-with-warning') {
              addNotice(cleanupFor.id, 'error', last.outcome === 'refused' ? 'Clean up refused; the worker was kept' : 'Clean up did not complete', {
                ok: false,
                outcome: 'refused',
                exitCode: last.exitCode,
                stdout: last.stdout,
                stderr: last.stderr,
                error: last.error,
              });
            }
          }}
          onCleaned={(r) => {
            setCleanupFor(null);
            const warning = r.outcome === 'cleaned-with-warning';
            setFlash({
              tone: warning ? 'warning' : 'good',
              text: warning
                ? `Cleaned up ${cleanupFor.title}, with a warning from the cleanup script.`
                : `Cleaned up ${cleanupFor.title}. Its history stays under Done / stopped.`,
              detail: warning ? [r.stderr.trim(), r.stdout.trim()].filter(Boolean).join('\n') : undefined,
            });
            void refreshThreads();
          }}
        />
      )}
      {doc &&
        (isImagePath(doc.path) ? (
          <ImageViewer path={doc.path} thread={doc.thread} onClose={() => setDoc(null)} />
        ) : (
          <>
            <div className="drawer-scrim" onMouseDown={() => setDoc(null)} aria-hidden="true" />
            <DocViewer path={doc.path} thread={doc.thread} onClose={() => setDoc(null)} />
          </>
        ))}
    </div>
    </DocContext.Provider>
  );
}
