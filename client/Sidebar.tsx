import { useEffect, useState } from 'react';
import type { AppConfig, ClaudeLimits, FirstmateDetail, ThreadSummary } from '../shared/types.ts';
import { api } from './api.ts';
import { BADGE_LABELS, formatTokens } from './format.tsx';
import { Avatar } from './messages.tsx';
import { FIRSTMATE, GROUPS, groupOf, loadJson, saveJson, type GroupKey } from './model.ts';

const COLLAPSE_KEY = 'crewchat.collapsed.v1';
const THEME_KEY = 'crewchat.theme.v1';

export type Theme = 'system' | 'light' | 'dark';
const THEME_EVENT = 'crewchat-theme';

export function setThemeChoice(t: Theme): void {
  saveJson(THEME_KEY, t);
  applyTheme(t);
  window.dispatchEvent(new Event(THEME_EVENT));
}

export function currentTheme(): Theme {
  return loadJson<Theme>(THEME_KEY, 'system');
}

function applyTheme(t: Theme): void {
  if (t === 'system') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = t;
}

export function ThemeSwitch({ onChosen }: { onChosen?: () => void }) {
  const [theme, setTheme] = useState<Theme>(() => loadJson<Theme>(THEME_KEY, 'system'));
  // The rail's theme button changes the same setting.
  useEffect(() => {
    const sync = () => setTheme(loadJson<Theme>(THEME_KEY, 'system'));
    window.addEventListener(THEME_EVENT, sync);
    return () => window.removeEventListener(THEME_EVENT, sync);
  }, []);
  const choose = (t: Theme) => {
    setThemeChoice(t);
    onChosen?.();
  };
  return (
    <span className="theme-switch" role="group" aria-label="Theme">
      {(['system', 'light', 'dark'] as const).map((t) => (
        <button key={t} type="button" aria-pressed={theme === t} onClick={() => choose(t)}>
          {t === 'system' ? 'Auto' : t === 'light' ? 'Light' : 'Dark'}
        </button>
      ))}
    </span>
  );
}

interface SidebarProps {
  config: AppConfig | null;
  threads: ThreadSummary[] | null;
  sorted: ThreadSummary[];
  fm: FirstmateDetail | null;
  selected: string | null;
  unreadOf: (id: string) => number;
  fmUnread: number;
  loadError: string | null;
  onNewWorker: () => void;
  filter: string;
  setFilter: (v: string) => void;
  starred: string[];
  view: View;
  setView: (v: View) => void;
  onRowMenu: (t: ThreadSummary, x: number, y: number) => void;
}

export type View = 'all' | 'unreads';

export function Sidebar({
  config,
  threads,
  sorted,
  fm,
  selected,
  unreadOf,
  fmUnread,
  loadError,
  onNewWorker,
  filter,
  setFilter,
  starred,
  view,
  setView,
  onRowMenu,
}: SidebarProps) {
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>(() => loadJson(COLLAPSE_KEY, {}));
  const [showHidden, setShowHidden] = useState(false);
  const toggle = (k: GroupKey) => {
    const next = { ...collapsed, [k]: !collapsed[k] };
    setCollapsed(next);
    saveJson(COLLAPSE_KEY, next);
  };

  const q = filter.trim().toLowerCase();
  const isUnread = (t: ThreadSummary) => unreadOf(t.id) > 0 || t.openDecisions > 0;
  const unreadCount = sorted.filter(isUnread).length;
  const visible = sorted
    .filter((t) => !q || t.title.toLowerCase().includes(q) || t.id.toLowerCase().includes(q) || (t.project ?? '').toLowerCase().includes(q))
    .filter((t) => view === 'all' || isUnread(t) || t.id === selected);
  const sections = [
    { key: 'starred', label: 'Starred', match: (t: ThreadSummary) => starred.includes(t.id) },
    ...GROUPS.map((g) => ({ key: g.key, label: g.label, match: (t: ThreadSummary) => !starred.includes(t.id) && groupOf(t) === g.key })),
  ];
  const attention = sorted.filter((t) => groupOf(t) === 'needs-you').length;
  const lastNote = fm?.notes[fm.notes.length - 1];
  const withUsage = sorted.filter((t) => t.usage);
  const total = withUsage.reduce((acc, t) => acc + t.usage!.inputTokens + t.usage!.cacheReadTokens + t.usage!.outputTokens, 0);
  const totalOut = withUsage.reduce((acc, t) => acc + t.usage!.outputTokens, 0);

  return (
    <aside className="sidebar" aria-label="Workers">
      <header className="workspace">
        <div className="workspace-name">
          <h1>
            Firstmate <span className="ws-caret" aria-hidden="true">▾</span>
          </h1>
          <p className="sub">
            {threads === null
              ? 'Loading workers...'
              : `${threads.length} worker${threads.length === 1 ? '' : 's'}${attention ? `, ${attention} need${attention === 1 ? 's' : ''} you` : ''}`}
          </p>
        </div>
        <button
          type="button"
          className="compose"
          onClick={onNewWorker}
          disabled={config?.readOnly ?? true}
          title={config?.readOnly ? 'Read-only mode' : 'Ask First mate to start a new worker'}
          aria-label="New worker"
        >
          <svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true">
            <path d="M15 11v4.5a1 1 0 0 1-1 1H4.5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1H9" fill="none" stroke="currentColor" strokeWidth="1.6" />
            <path d="m8 12 .5-2.5 6.5-6.5 2 2-6.5 6.5z" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
          </svg>
        </button>
      </header>
      <div className="sidebar-search">
        <input type="search" placeholder="Find a conversation..." value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Find a worker" />
      </div>
      <nav className="thread-list">
        <a
          className={`thread-row pinned${selected === FIRSTMATE ? ' active' : ''}${fmUnread > 0 ? ' unread-row' : ''}`}
          href="#/firstmate"
          aria-current={selected === FIRSTMATE ? 'page' : undefined}
          data-thread-id={FIRSTMATE}
          title={lastNote ? (lastNote.reply ? `First mate: ${lastNote.reply.body}` : `You: ${lastNote.body}`) : 'Your conversation with the supervisor'}
        >
          <Avatar author={{ key: 'firstmate', name: 'First mate', kind: 'firstmate' }} size={20} presence={true} />
          <span className="row-name">First mate</span>
          {fmUnread > 0 && (
            <span className="unread" aria-label={`${fmUnread} unread`}>
              {fmUnread}
            </span>
          )}
        </a>
        <button
          type="button"
          className={`nav-row${view === 'all' ? ' on' : ''}`}
          onClick={() => setView('all')}
          aria-pressed={view === 'all'}
          title="Every worker"
        >
          <svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true">
            <path d="M3.5 5h13M3.5 10h13m-13 5h13" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          </svg>
          <span className="row-name">All workers</span>
          <span className="nav-count">{sorted.filter((t) => !t.hidden).length}</span>
        </button>
        <button
          type="button"
          className={`nav-row${view === 'unreads' ? ' on' : ''}`}
          onClick={() => setView(view === 'unreads' ? 'all' : 'unreads')}
          aria-pressed={view === 'unreads'}
          title="Only conversations with unread updates or open decisions"
        >
          <svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true">
            <path d="M3 5.5h14v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1zm0 0 7 5 7-5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
          </svg>
          <span className="row-name">Unreads</span>
          {unreadCount > 0 && <span className="nav-count">{unreadCount}</span>}
        </button>
        {view !== 'all' && (
          <div className="view-note">
            Showing unreads only.{' '}
            <button type="button" onClick={() => setView('all')}>
              Show all
            </button>
          </div>
        )}
        {loadError && <div className="side-empty">Cannot reach the crew-chat server: {loadError}</div>}
        {threads !== null && threads.length === 0 && (
          <div className="side-empty">
            <strong>No workers right now</strong>
            <span>When Firstmate starts a worker, its channel appears here.</span>
          </div>
        )}
        {sections.map((g) => {
          const all = visible.filter(g.match);
          const hiddenCount = all.filter((t) => t.hidden).length;
          const rows = all.filter((t) => showHidden || !t.hidden || t.id === selected);
          if (rows.length === 0 && hiddenCount === 0) return null;
          const isCollapsed = collapsed[g.key as GroupKey] === true;
          return (
            <section key={g.key} className="group" data-group={g.key}>
              <button type="button" className="group-head" onClick={() => toggle(g.key as GroupKey)} aria-expanded={!isCollapsed}>
                <span className={`caret${isCollapsed ? ' closed' : ''}`} aria-hidden="true">
                  ▾
                </span>
                {g.label}
                <span className="group-count">{rows.length}</span>
              </button>
              {rows
                .filter((t) => !isCollapsed || t.id === selected)
                .map((t) => (
                  <ChannelRow key={t.id} t={t} active={t.id === selected} unread={unreadOf(t.id)} onMenu={(x, y) => onRowMenu(t, x, y)} />
                ))}
              {hiddenCount > 0 && !isCollapsed && (
                <button type="button" className="show-hidden" onClick={() => setShowHidden(!showHidden)}>
                  {showHidden ? 'Hide removed threads' : `Show ${hiddenCount} removed`}
                </button>
              )}
            </section>
          );
        })}
        {threads !== null && threads.length > 0 && visible.length === 0 && <div className="side-empty">No worker matches "{filter}".</div>}
      </nav>
      {withUsage.length > 0 && (
        <a
          className="token-total"
          href="#/usage"
          data-testid="token-total"
          title={withUsage.map((t) => `${t.id}: ${formatTokens(t.usage!.inputTokens + t.usage!.cacheReadTokens + t.usage!.outputTokens)}`).join('\n')}
        >
          <strong>{formatTokens(total)}</strong> tokens used, {formatTokens(totalOut)} output, across {withUsage.length} worker
          {withUsage.length === 1 ? '' : 's'}
        </a>
      )}
      <PlanUsage first={withUsage.length === 0} />
      <footer className="sidebar-foot">
        {config?.readOnly && (
          <span className="ro" title="Started with CREW_CHAT_READ_ONLY=1">
            Read-only
          </span>
        )}
      </footer>
    </aside>
  );
}

// Team-chat style presence: a filled dot while the worker is active.
export function isActive(badge: string): boolean {
  return badge === 'working' || badge === 'needs-you';
}

function ChannelRow({ t, active, unread, onMenu }: { t: ThreadSummary; active: boolean; unread: number; onMenu: (x: number, y: number) => void }) {
  const badge = t.openDecisions > 0 && t.badge !== 'needs-you' ? 'needs-you' : t.badge;
  // The context-menu key and Shift+F10 report no pointer position, so the menu opens by the row.
  const atRow = (el: Element, e: { clientX: number; clientY: number }) => {
    if (e.clientX || e.clientY) return onMenu(e.clientX, e.clientY);
    const r = el.getBoundingClientRect();
    onMenu(r.left + 24, r.bottom);
  };
  return (
    <div className="row-wrap">
    <a
      onContextMenu={(e) => {
        e.preventDefault();
        atRow(e.currentTarget, e);
      }}
      className={`thread-row${active ? ' active' : ''}${unread > 0 ? ' unread-row' : ''}${t.hidden ? ' hidden-row' : ''}`}
      href={`#/t/${encodeURIComponent(t.id)}`}
      aria-current={active ? 'page' : undefined}
      data-thread-id={t.id}
      data-badge={badge}
      title={[
        t.title,
        `${BADGE_LABELS[badge]}${t.stateLine ? ` (${t.stateLine})` : ''}`,
        [t.usage?.model ?? (t.model && t.model !== 'default' ? t.model : null), t.effort ? `${t.effort} effort` : null].filter(Boolean).join(', '),
        t.usage ? `${formatTokens(t.usage.contextTokens)} in context, ${formatTokens(t.usage.inputTokens + t.usage.cacheReadTokens + t.usage.outputTokens)} tokens used` : null,
      ]
        .filter(Boolean)
        .join('\n')}
    >
      <Avatar author={{ key: t.id, name: t.id, kind: 'worker', seed: t.title }} size={20} presence={isActive(badge)} />
      <span className="row-name">{t.id}</span>
      {t.openDecisions > 0 ? (
        <span className="mention" aria-label={`${t.openDecisions} open decision${t.openDecisions === 1 ? '' : 's'}`}>
          {t.openDecisions}
        </span>
      ) : (
        unread > 0 && (
          <span className="unread" aria-label={`${unread} unread`}>
            {unread}
          </span>
        )
      )}
    </a>
    <button
      type="button"
      className="row-more"
      aria-label={`More actions for ${t.id}`}
      title="More actions"
      onClick={(e) => {
        const r = e.currentTarget.getBoundingClientRect();
        onMenu(r.left, r.bottom + 2);
      }}
    >
      ⋯
    </button>
    </div>
  );
}

const LIMITS_POLL_MS = 30_000;

function level(p: number): 'ok' | 'warn' | 'high' {
  return p >= 80 ? 'high' : p >= 50 ? 'warn' : 'ok';
}

function untilText(ms: number): string {
  const m = Math.max(0, Math.round(ms / 60_000));
  const d = Math.floor(m / 1440);
  if (d > 0) return `${d}d ${Math.floor((m % 1440) / 60)}h`;
  return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`;
}

// The clock time a window resets: "2:40 PM" today, else "Thu 9:00 AM".
export function resetClock(at: number, now = Date.now()): string {
  const d = new Date(at);
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return new Date(now).toDateString() === d.toDateString() ? time : `${d.toLocaleDateString([], { weekday: 'short' })} ${time}`;
}

function resetLine(at: number | null): { short: string; long: string } | null {
  if (at === null) return null;
  const left = at - Date.now();
  if (left <= 0) return { short: 'reset due', long: 'reset due now' };
  return { short: `resets ${resetClock(at)}`, long: `resets ${resetClock(at)} (in ${untilText(left)})` };
}

function Meter({ label, value, extra }: { label: string; value: number; extra?: string }) {
  return (
    <span className="meter" data-level={level(value)}>
      <span className="meter-label">{label}</span>
      <span className="meter-bar" aria-hidden="true">
        <span style={{ width: `${Math.min(100, value)}%` }} />
      </span>
      <span className="meter-value">{Math.round(value)}%</span>
      {extra && <span className="meter-extra">{extra}</span>}
    </span>
  );
}

// Claude plan usage (five-hour and weekly windows) as the newest Claude
// worker's status bar shows it. Nothing shows when no status bar has it.
export function PlanUsage({ first }: { first: boolean }) {
  const [limits, setLimits] = useState<ClaudeLimits | null>(null);
  useEffect(() => {
    let live = true;
    const load = () =>
      void api.limits().then(
        (l) => live && setLimits(l),
        () => undefined,
      );
    load();
    const timer = setInterval(load, LIMITS_POLL_MS);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, []);
  if (!limits || (limits.fiveHour === null && limits.sevenDay === null)) return null;
  const five = resetLine(limits.resetsAt);
  const week = resetLine(limits.weekResetsAt ?? null);
  const title = [
    `Claude plan usage, from ${limits.from}'s status bar (read ${new Date(limits.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}).`,
    limits.fiveHour !== null ? `5-hour window: ${Math.round(limits.fiveHour)}% used${five ? `, ${five.long}` : ''}.` : null,
    limits.sevenDay !== null
      ? `7-day window: ${Math.round(limits.sevenDay)}% used${week ? `, ${week.long}` : ". Its reset time is not in the status bar"}.`
      : null,
  ]
    .filter(Boolean)
    .join('\n');
  return (
    <div className={first ? 'plan-usage first' : 'plan-usage'} data-testid="plan-usage" title={title} aria-label={title}>
      {limits.fiveHour !== null && <Meter label="5h" value={limits.fiveHour} extra={five?.short} />}
      {limits.sevenDay !== null && <Meter label="7d" value={limits.sevenDay} extra={week?.short} />}
    </div>
  );
}
