import { useEffect, useState } from 'react';
import type { UsageReport, UsageRow } from '../shared/types.ts';
import { formatTokens } from './format.tsx';

const POLL_MS = 30_000;
const BIG_CONTEXT = 300_000;

function total(r: UsageRow): number {
  const u = r.usage;
  return u ? u.inputTokens + u.cacheReadTokens + u.outputTokens : 0;
}

function money(n: number): string {
  return `$${n.toFixed(n < 10 ? 2 : 0)}`;
}

// Plain-language pointers at where the tokens go, from the numbers alone.
export function usageHints(rows: UsageRow[]): string[] {
  const used = rows.filter((r) => r.usage && total(r) > 0);
  const all = used.reduce((n, r) => n + total(r), 0);
  if (!all) return [];
  const hints: string[] = [];
  const top = [...used].sort((a, b) => total(b) - total(a))[0];
  const share = Math.round((total(top) / all) * 100);
  if (share >= 30) hints.push(`${top.kind === 'firstmate' ? 'First mate' : top.id} used ${share}% of all tokens here.`);
  const reads = used.reduce((n, r) => n + r.usage!.cacheReadTokens, 0);
  const readShare = Math.round((reads / all) * 100);
  if (readShare >= 80) {
    hints.push(
      `${readShare}% of all tokens are cache reads: every response re-reads the whole conversation so far. They cost about a tenth of fresh input, but long sessions make them add up, so context size is the main thing to trim.`,
    );
  }
  for (const r of used) {
    if (r.usage!.contextTokens >= BIG_CONTEXT) {
      hints.push(
        `${r.kind === 'firstmate' ? 'First mate' : r.id} carries ${formatTokens(r.usage!.contextTokens)} tokens of context into every response. A fresh session or /compact would shrink every response after it.`,
      );
    }
  }
  return hints;
}

export function UsageView() {
  const [report, setReport] = useState<UsageReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    const load = () =>
      void fetch('/api/usage', { cache: 'no-store' })
        .then((r) => r.json() as Promise<UsageReport>)
        .then(
          (d) => {
            if (!live) return;
            setReport(d);
            setError(null);
          },
          (err: Error) => live && setError(`Cannot reach crew-chat: ${err.message}`),
        );
    load();
    const timer = setInterval(load, POLL_MS);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, []);

  const rows = report ? [...report.rows].sort((a, b) => total(b) - total(a)) : [];
  const all = rows.reduce((n, r) => n + total(r), 0);
  const out = rows.reduce((n, r) => n + (r.usage?.outputTokens ?? 0), 0);
  const reads = rows.reduce((n, r) => n + (r.usage?.cacheReadTokens ?? 0), 0);
  const costs = rows.filter((r) => r.cost !== null);
  const hints = usageHints(rows);

  return (
    <>
      <header className="channel-head">
        <div className="head-row">
          <div className="head-main">
            <h2>Usage</h2>
            <div className="topic">
              <span>
                Tokens each worker has used since it started, and First mate over the last {report?.firstmateHours ?? 24} hours, from the
                Claude session logs on this machine.
              </span>
            </div>
          </div>
        </div>
      </header>
      <div className="usage-page" data-testid="usage-page">
        {error && <div className="pane-reason">{error}</div>}
        {!report && !error && <p className="hint">Loading...</p>}
        {report && (
          <>
            <div className="usage-tiles">
              <div className="usage-tile">
                <span className="usage-tile-label">Tokens</span>
                <strong>{formatTokens(all)}</strong>
              </div>
              <div className="usage-tile">
                <span className="usage-tile-label">Output</span>
                <strong>{formatTokens(out)}</strong>
              </div>
              <div className="usage-tile">
                <span className="usage-tile-label">Cache reads</span>
                <strong>{all ? Math.round((reads / all) * 100) : 0}%</strong>
              </div>
              <div className="usage-tile" title="Summed from the status bars that print a session cost">
                <span className="usage-tile-label">Session cost</span>
                <strong>{costs.length ? money(costs.reduce((n, r) => n + r.cost!, 0)) : 'n/a'}</strong>
                {costs.length > 0 && <span className="usage-tile-note">{costs.length} with a cost shown</span>}
              </div>
            </div>

            {hints.length > 0 && (
              <ul className="usage-hints" data-testid="usage-hints">
                {hints.map((h) => (
                  <li key={h}>{h}</li>
                ))}
              </ul>
            )}

            <div className="usage-table-wrap">
              <table className="usage-table">
                <thead>
                  <tr>
                    <th>Who</th>
                    <th>Model</th>
                    <th className="num">Responses</th>
                    <th className="num" title="New input, including what was written to the cache">
                      Fresh input
                    </th>
                    <th className="num">Cache reads</th>
                    <th className="num">Output</th>
                    <th className="num">Total</th>
                    <th>Share</th>
                    <th className="num" title="How full the context is now: what every next response re-reads">
                      Context now
                    </th>
                    <th className="num">Per response</th>
                    <th className="num" title="From the worker's status bar, when it prints one">
                      Cost
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => {
                    const u = r.usage;
                    const t = total(r);
                    const share = all ? (t / all) * 100 : 0;
                    return (
                      <tr key={`${r.kind}-${r.id}`} data-row={r.id}>
                        <td>
                          {r.kind === 'firstmate' ? (
                            <a href="#/firstmate">First mate</a>
                          ) : (
                            <a href={`#/t/${encodeURIComponent(r.id)}`} title={r.title}>
                              {r.id}
                            </a>
                          )}
                          {r.kind === 'firstmate' && <span className="usage-sub">last {report.firstmateHours}h</span>}
                        </td>
                        <td>
                          {u?.model ?? r.model ?? '-'}
                          {r.effort && <span className="usage-sub">{r.effort} effort</span>}
                        </td>
                        <td className="num">{u ? u.messages.toLocaleString() : '-'}</td>
                        <td className="num">{u ? formatTokens(u.inputTokens) : '-'}</td>
                        <td className="num">{u ? formatTokens(u.cacheReadTokens) : '-'}</td>
                        <td className="num">{u ? formatTokens(u.outputTokens) : '-'}</td>
                        <td className="num strong">{u ? formatTokens(t) : '-'}</td>
                        <td>
                          <span className="share-bar" aria-label={`${Math.round(share)}% of all tokens`}>
                            <span style={{ width: `${share}%` }} />
                          </span>
                          <span className="share-num">{Math.round(share)}%</span>
                        </td>
                        <td className={`num${u && u.contextTokens >= BIG_CONTEXT ? ' warn' : ''}`}>{u ? formatTokens(u.contextTokens) : '-'}</td>
                        <td className="num">{u && u.messages ? formatTokens(Math.round(t / u.messages)) : '-'}</td>
                        <td className="num">{r.cost !== null ? money(r.cost) : '-'}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
    </>
  );
}
