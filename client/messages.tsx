import { Fragment, useState, type ReactNode } from 'react';
import { exactTime, hue, initials, TimeAgo } from './format.tsx';

export interface Author {
  key: string;
  name: string;
  kind: 'worker' | 'you' | 'firstmate';
  // A worker's title, for its avatar initials.
  seed?: string;
}

export interface Row {
  key: string;
  author: Author;
  at: number | null;
  className: string;
  attrs?: Record<string, string | undefined>;
  body: ReactNode;
  // Inline status tags: beside the author line, or above the text when the
  // message is grouped under the previous one.
  tags?: ReactNode;
  actions?: ReactNode;
  // Plain text for the hover bar's Copy and Quote actions.
  copyText?: string;
}

function CopyButton({ text }: { text: string }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  return (
    <button
      type="button"
      className="bar-btn"
      aria-label="Copy message"
      title="Copy message"
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(
          () => setState('copied'),
          () => setState('failed'),
        );
        setTimeout(() => setState('idle'), 1500);
      }}
    >
      {state === 'copied' ? 'Copied' : state === 'failed' ? 'Copy failed' : 'Copy'}
    </button>
  );
}

const GROUP_GAP_MS = 5 * 60_000;

function dayKey(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

export function dayLabel(ms: number, now: number): string {
  if (dayKey(ms) === dayKey(now)) return 'Today';
  if (dayKey(ms) === dayKey(now - 86_400_000)) return 'Yesterday';
  const sameYear = new Date(ms).getFullYear() === new Date(now).getFullYear();
  return new Date(ms).toLocaleDateString(undefined, {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: sameYear ? undefined : 'numeric',
  });
}

function clock(ms: number): string {
  return new Date(ms).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

// presence: true shows the filled "active" dot, false the hollow "away" one,
// and undefined no dot at all.
export function Avatar({ author, size = 36, presence, className }: { author: Author; size?: number; presence?: boolean; className?: string }) {
  const style = { width: size, height: size, fontSize: Math.round(size * 0.38) } as Record<string, string | number>;
  if (author.kind === 'worker') style['--h'] = hue(author.key);
  const text = author.kind === 'you' ? 'You' : author.kind === 'firstmate' ? 'FM' : initials(author.seed ?? author.name);
  const avatar = (
    <span className={`avatar avatar-${author.kind}`} style={style} aria-hidden="true">
      {text}
    </span>
  );
  if (presence === undefined) return avatar;
  return (
    <span className={`avatar-wrap${className ? ` ${className}` : ''}`}>
      {avatar}
      <span className={`presence${presence ? ' presence-on' : ''}`} aria-hidden="true" />
    </span>
  );
}

// Team-chat style list: a day divider when the date changes, and consecutive
// messages from one author within a few minutes share one avatar and name.
export function MessageList({
  rows,
  now,
  newKey = null,
  onQuote,
}: {
  rows: Row[];
  now: number;
  newKey?: string | null;
  onQuote?: (text: string) => void;
}) {
  let lastDay: string | null = null;
  let prev: Row | null = null;
  return (
    <>
      {rows.map((row) => {
        let divider: ReactNode = null;
        if (row.at !== null) {
          const k = dayKey(row.at);
          if (k !== lastDay) {
            // The rule stays in place; only the pill sticks while scrolling.
            divider = (
              <>
                <div className="day-rule" aria-hidden="true" />
                <div className="day-divider" role="separator">
                  <span>{dayLabel(row.at, now)}</span>
                </div>
              </>
            );
            lastDay = k;
          }
        }
        const isNew = row.key === newKey;
        const grouped =
          prev !== null &&
          divider === null &&
          !isNew &&
          prev.author.key === row.author.key &&
          (row.at === null || prev.at === null || row.at - prev.at < GROUP_GAP_MS);
        prev = row;
        return (
          <Fragment key={row.key}>
            {divider}
            {isNew && (
              <div className="new-divider" role="separator" aria-label="New messages">
                <span>New</span>
              </div>
            )}
            <div className={`msg ${row.className}${grouped ? ' grouped' : ''}`} id={`item-${row.key}`} {...row.attrs}>
              <div className="gutter">
                {grouped ? (
                  row.at !== null && (
                    <span className="gutter-time" title={exactTime(row.at)}>
                      {clock(row.at)}
                    </span>
                  )
                ) : (
                  <Avatar author={row.author} />
                )}
              </div>
              <div className="msg-main">
                {!grouped && (
                  <div className="msg-head">
                    <span className="author">{row.author.name}</span>
                    <TimeAgo at={row.at} now={now} />
                    {row.tags && <span className="tags">{row.tags}</span>}
                  </div>
                )}
                {grouped && row.tags && <div className="tags">{row.tags}</div>}
                {row.body}
              </div>
              {(row.actions || row.copyText) && (
                <div className="hover-bar">
                  {row.actions}
                  {row.copyText && onQuote && (
                    <button type="button" className="bar-btn" aria-label="Quote in reply" title="Quote in reply" onClick={() => onQuote(row.copyText!)}>
                      Quote
                    </button>
                  )}
                  {row.copyText && <CopyButton text={row.copyText} />}
                </div>
              )}
            </div>
          </Fragment>
        );
      })}
    </>
  );
}
