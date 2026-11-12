import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import type { ActivityEntry, ActivityLog, PaneSnapshot } from '../shared/types.ts';
import { Ansi } from './ansi.tsx';
import { addFrame, historyText, type ScreenHistory } from './screen.ts';
import { Blocks, exactTime, RichText } from './format.tsx';
import { splitBlocks } from './blocks.ts';
import { loadJson, saveJson } from './model.ts';

const POLL_MS = 1500;
// The screen is polled faster: lines that scroll past between two captures
// cannot be kept, so a quicker look keeps more of them.
const SCREEN_POLL_MS = 1000;
const TAB_KEY = 'crewchat.pane-tab.v1';

type Tab = 'transcript' | 'screen';

function usePoll<T>(url: string | null, every = POLL_MS): { data: T | null; error: string | null } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setData(null);
    if (!url) return;
    let stopped = false;
    let timer: number | undefined;
    const tick = async () => {
      if (document.visibilityState === 'visible') {
        try {
          const res = await fetch(url, { cache: 'no-store' });
          if (!res.ok) throw new Error(`the server answered ${res.status}`);
          const next = (await res.json()) as T;
          if (!stopped) {
            setData(next);
            setError(null);
          }
        } catch (err) {
          if (!stopped) setError(`Cannot reach crew-chat: ${(err as Error).message}`);
        }
      }
      if (!stopped) timer = window.setTimeout(() => void tick(), every);
    };
    void tick();
    return () => {
      stopped = true;
      window.clearTimeout(timer);
    };
  }, [url, every]);
  return { data, error };
}

// Keeps a scroll box pinned to the bottom while new output arrives, unless the
// reader has scrolled up to look at something.
function useStickToBottom<E extends HTMLElement>(dep: unknown) {
  const ref = useRef<E>(null);
  const stick = useRef(true);
  useLayoutEffect(() => {
    const el = ref.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [dep]);
  const onScroll = () => {
    const el = ref.current;
    if (el) stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  };
  return { ref, onScroll };
}

// What the worker's terminal shows, beside the chat: its session history from
// the Claude transcript (scrollable), or the live screen from tmux.
export interface PaneSource {
  pane: string;
  activity: string;
  // Who the terminal belongs to, in the notes: "the worker" or "First mate".
  who: string;
}

export function workerSource(id: string): PaneSource {
  const enc = encodeURIComponent(id);
  return { pane: `/api/threads/${enc}/pane`, activity: `/api/threads/${enc}/activity`, who: 'the worker' };
}

export const FIRSTMATE_SOURCE: PaneSource = { pane: '/api/firstmate/pane', activity: '/api/firstmate/activity', who: 'First mate' };

export function TerminalPanel({ id, onClose, source = workerSource(id) }: { id: string; onClose: () => void; source?: PaneSource }) {
  const [tab, setTab] = useState<Tab>(() => loadJson<Tab>(TAB_KEY, 'transcript'));
  const choose = (t: Tab) => {
    setTab(t);
    saveJson(TAB_KEY, t);
  };
  const activity = usePoll<ActivityLog>(tab === 'transcript' ? source.activity : null);
  const screen = usePoll<PaneSnapshot>(tab === 'screen' ? source.pane : null, SCREEN_POLL_MS);
  const whose = source.who === 'the worker' ? "The worker's" : `${source.who}'s`;
  const live = tab === 'screen' ? screen.data?.available : activity.data?.available;

  return (
    <aside className="pane-panel" aria-label="Live terminal" data-testid="terminal-panel">
      <header className="pane-head">
        <div className="pane-tabs" role="tablist">
          <button type="button" role="tab" aria-selected={tab === 'transcript'} className="pane-tab" onClick={() => choose('transcript')}>
            Transcript
          </button>
          <button type="button" role="tab" aria-selected={tab === 'screen'} className="pane-tab" onClick={() => choose('screen')}>
            Screen
          </button>
          <span className={live ? 'pane-live on' : 'pane-live'}>{live ? 'Live' : live === false ? 'Unavailable' : 'Loading'}</span>
        </div>
        <button type="button" className="btn ghost small" onClick={onClose} aria-label="Close terminal view">
          ×
        </button>
      </header>
      {tab === 'transcript' ? (
        <>
          <p className="pane-note">Everything {source.who} said, ran, and got back{source.who === 'the worker' ? ' since it started' : ''}. Scroll up for history.</p>
          {activity.error && <div className="pane-reason">{activity.error}</div>}
          {activity.data && !activity.data.available ? (
            <div className="pane-reason" data-testid="pane-reason">
              {activity.data.reason} Use the Screen tab to see its terminal.
            </div>
          ) : (
            <TranscriptView entries={activity.data?.entries ?? null} />
          )}
        </>
      ) : (
        <>
          <p className="pane-note">
            {whose} screen, live and read-only. Lines that scroll off the top stay here while this view is open, so you can scroll back.
          </p>
          {screen.error && <div className="pane-reason">{screen.error}</div>}
          {screen.data && !screen.data.available ? (
            <div className="pane-reason" data-testid="pane-reason">
              {screen.data.reason}
            </div>
          ) : (
            <ScreenView id={id} text={screen.data?.text ?? null} />
          )}
        </>
      )}
    </aside>
  );
}

function ScreenView({ id, text }: { id: string; text: string | null }) {
  // Lines that scrolled off the worker's screen, kept while this view is open.
  const history = useRef<{ id: string; h: ScreenHistory; last: string | null }>({ id, h: { past: [], frame: [] }, last: null });
  if (history.current.id !== id) history.current = { id, h: { past: [], frame: [] }, last: null };
  if (text !== null && text !== history.current.last) {
    history.current.h = addFrame(history.current.h, text);
    history.current.last = text;
  }
  const shown = text !== null ? historyText(history.current.h) : null;
  const { ref, onScroll } = useStickToBottom<HTMLPreElement>(shown);
  return (
    <pre className="pane-body" ref={ref} onScroll={onScroll} data-testid="pane-body">
      {shown !== null ? <Ansi text={shown} /> : 'Loading the terminal...'}
    </pre>
  );
}

function Clamped({ text, lines: max, children }: { text: string; lines: number; children?: (shown: string) => ReactNode }) {
  const [open, setOpen] = useState(false);
  const lines = text.replace(/\n+$/, '').split('\n');
  const long = lines.length > max;
  const shown = (open || !long ? lines : lines.slice(0, max)).join('\n');
  return (
    <>
      {children ? children(shown) : shown}
      {long && (
        <button type="button" className="act-more" onClick={() => setOpen(!open)}>
          {open ? 'Show less' : `+${lines.length - max} lines`}
        </button>
      )}
    </>
  );
}

function ResultBlock({ e }: { e: ActivityEntry }) {
  return (
    <div className={`act act-result${e.error ? ' act-error' : ''}`} title={exactTime(e.at)}>
      <span className="act-mark" aria-hidden="true">
        ⎿
      </span>
      <div className="act-text">{e.text.trim() ? <Clamped text={e.text} lines={6} /> : '(no output)'}</div>
    </div>
  );
}

function TranscriptView({ entries }: { entries: ActivityEntry[] | null }) {
  const { ref, onScroll } = useStickToBottom<HTMLDivElement>(entries?.length);
  return (
    <div className="pane-body transcript" ref={ref} onScroll={onScroll} data-testid="pane-body">
      {entries === null && 'Loading the transcript...'}
      {entries !== null && entries.length === 0 && 'Nothing in the transcript yet.'}
      {entries?.map((e, i) =>
        e.kind === 'result' ? (
          <ResultBlock key={i} e={e} />
        ) : (
          <div key={i} className={`act act-${e.kind}`} title={exactTime(e.at)}>
            <span className="act-mark" aria-hidden="true">
              {e.kind === 'prompt' ? '>' : '⏺'}
            </span>
            <div className="act-text">
              {e.kind === 'tool' ? (
                <Clamped text={e.text} lines={3}>
                  {(shown) => (
                    <>
                      <strong className="act-tool">{e.tool}</strong>({shown})
                    </>
                  )}
                </Clamped>
              ) : e.text.includes('[image: ') ? (
                <div className="act-blocks">
                  <RichText text={e.text} />
                </div>
              ) : e.kind === 'say' && splitBlocks(e.text).some((b) => b.kind !== 'text') ? (
                <div className="act-blocks">
                  <Blocks text={e.text} />
                </div>
              ) : (
                <Clamped text={e.text} lines={e.kind === 'prompt' ? 6 : 40} />
              )}
            </div>
          </div>
        ),
      )}
    </div>
  );
}
