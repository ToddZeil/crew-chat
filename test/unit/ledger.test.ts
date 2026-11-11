import { appendFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SentLedger } from '../../server/ledger.ts';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'crewchat-ledger-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const T = Date.parse('2026-11-11T04:00:00Z');

describe('SentLedger', () => {
  it('attributes by sequence, falls back to body and time, and survives a reload', () => {
    const file = path.join(dir, 'sub', 'ledger.jsonl');
    const a = new SentLedger(file);
    const k1 = a.begin('/home', 'w1', 'hello', T);
    a.confirm(k1, 3);
    a.begin('/home', 'w1', 'no sequence known', T);
    const k3 = a.begin('/home', 'w1', 'refused one', T);
    a.cancel(k3);
    a.begin('/other-home', 'w1', 'same id, other home', T);
    const records = [
      { seq: 1, body: 'from the supervisor', at: T - 60_000 },
      { seq: 3, body: 'hello', at: T },
      { seq: 4, body: 'no sequence known', at: T + 2000 },
      { seq: 5, body: 'refused one', at: T + 3000 },
      { seq: 6, body: 'same id, other home', at: T },
      { seq: 7, body: 'no sequence known', at: T + 60 * 60_000 },
    ];
    expect([...a.sentSeqs('/home', 'w1', records)].sort()).toEqual([3, 4]);
    const b = new SentLedger(file);
    expect([...b.sentSeqs('/home', 'w1', records)].sort()).toEqual([3, 4]);
    expect(b.sentSeqs('/home', 'w2', records).size).toBe(0);
    expect(readFileSync(file, 'utf8').trim().split('\n')).toHaveLength(6);
  });

  it('skips a torn last line', () => {
    const file = path.join(dir, 'ledger.jsonl');
    const a = new SentLedger(file);
    a.confirm(a.begin('/h', 'w', 'x', T), 1);
    appendFileSync(file, '{"op":"sent","key":"half');
    expect(new SentLedger(file).sentSeqs('/h', 'w', [{ seq: 1, body: 'x', at: T }]).has(1)).toBe(true);
  });
});
