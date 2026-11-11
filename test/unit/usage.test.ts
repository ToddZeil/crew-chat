import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseActivityLine, parseUsageLine, projectSlug, spawnTime, UsageReader } from '../../server/usage.ts';

const line = (id: string, at: string, usage: Record<string, number>, model = 'claude-opus-5-5') =>
  JSON.stringify({ type: 'assistant', timestamp: at, message: { id, model, usage } }) + '\n';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'crewchat-usage-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('usage', () => {
  it('maps a worktree path to its Claude projects folder', () => {
    expect(projectSlug('/Users/dev/.pool/crew-chat-1a2b/2/crew-chat')).toBe('-Users-dev--pool-crew-chat-1a2b-2-crew-chat');
  });

  it('reads the spawn time from spawn_gen', () => {
    expect(spawnTime({ spawn_gen: 's1794366976.61499.2196' })).toBe(1794366976000);
    expect(spawnTime({})).toBeNull();
  });

  it('ignores lines that are not assistant usage', () => {
    expect(parseUsageLine('{"type":"user","message":{"usage":{}}}')).toBeNull();
    expect(parseUsageLine('not json "usage"')).toBeNull();
    expect(parseUsageLine('{"type":"assistant"}')).toBeNull();
  });

  it('sums usage since spawn across sessions, counts each message once, and follows appends', () => {
    const worktree = '/work/slot-2/repo';
    const proj = path.join(dir, projectSlug(worktree));
    mkdirSync(proj);
    writeFileSync(
      path.join(proj, 'old.jsonl'),
      line('m0', '2026-11-10T00:00:00Z', { input_tokens: 999, output_tokens: 999 }) + 'garbage line\n',
    );
    writeFileSync(
      path.join(proj, 'a.jsonl'),
      line('m1', '2026-11-11T01:00:00Z', { input_tokens: 10, cache_creation_input_tokens: 100, cache_read_input_tokens: 1000, output_tokens: 5 }) +
        // The same API message written as a second line must not double count.
        line('m1', '2026-11-11T01:00:00Z', { input_tokens: 10, cache_creation_input_tokens: 100, cache_read_input_tokens: 1000, output_tokens: 5 }) +
        JSON.stringify({ type: 'user', timestamp: '2026-11-11T01:00:01Z', message: { content: 'hi' } }) + '\n',
    );
    const reader = new UsageReader(dir);
    const since = Date.parse('2026-11-11T00:00:00Z');
    expect(reader.read(worktree, since)).toEqual({
      model: 'claude-opus-5-5',
      contextTokens: 1110,
      inputTokens: 110,
      cacheReadTokens: 1000,
      outputTokens: 5,
      messages: 1,
      lastAt: Date.parse('2026-11-11T01:00:00Z'),
    });
    appendFileSync(path.join(proj, 'a.jsonl'), line('m2', '2026-11-11T02:00:00Z', { input_tokens: 1, cache_read_input_tokens: 2000, output_tokens: 50 }, 'claude-sonnet-5-5'));
    expect(reader.read(worktree, since)).toMatchObject({ model: 'claude-sonnet-5-5', contextTokens: 2001, inputTokens: 111, cacheReadTokens: 3000, outputTokens: 55, messages: 2 });
    expect(reader.read('/no/such/worktree', since)).toBeNull();
  });
});

describe('activity', () => {
  const at = '2026-11-11T01:00:00Z';
  const msg = (type: string, content: unknown) => JSON.stringify({ type, timestamp: at, message: { content } });

  it('reads what the worker said, ran, got back, and was told', () => {
    expect(parseActivityLine(msg('assistant', [{ type: 'thinking', thinking: 'hidden' }, { type: 'text', text: 'Running the tests.' }]))).toEqual([
      { at: Date.parse(at), kind: 'say', text: 'Running the tests.' },
    ]);
    expect(parseActivityLine(msg('assistant', [{ type: 'tool_use', name: 'Bash', input: { command: 'npm test', description: 'Run tests' } }]))).toEqual([
      { at: Date.parse(at), kind: 'tool', tool: 'Bash', text: 'npm test' },
    ]);
    expect(parseActivityLine(msg('assistant', [{ type: 'tool_use', name: 'Edit', input: { file_path: '/repo/a.ts' } }]))[0].text).toBe('/repo/a.ts');
    expect(parseActivityLine(msg('user', [{ type: 'tool_result', content: [{ type: 'text', text: '2 failed' }], is_error: true }]))).toEqual([
      { at: Date.parse(at), kind: 'result', text: '2 failed', error: true },
    ]);
    expect(parseActivityLine(msg('user', 'Firstmate instruction waiting'))).toEqual([{ at: Date.parse(at), kind: 'prompt', text: 'Firstmate instruction waiting' }]);
    expect(parseActivityLine(msg('assistant', [{ type: 'server_tool_use', name: 'advisor', input: {} }]))).toEqual([]);
    expect(parseActivityLine(JSON.stringify({ type: 'user', isMeta: true, timestamp: at, message: { content: 'meta' } }))).toEqual([]);
    expect(parseActivityLine('{"type":"summary"}')).toEqual([]);
  });

  it('returns the latest steps since spawn, oldest first', () => {
    const worktree = '/work/slot-3/repo';
    const proj = path.join(dir, projectSlug(worktree));
    mkdirSync(proj);
    const line = (t: string, text: string) => JSON.stringify({ type: 'assistant', timestamp: t, message: { content: [{ type: 'text', text }] } }) + '\n';
    writeFileSync(path.join(proj, 's.jsonl'), line('2026-11-10T00:00:00Z', 'old task') + line('2026-11-11T01:00:00Z', 'one') + line('2026-11-11T02:00:00Z', 'two'));
    const reader = new UsageReader(dir);
    expect(reader.activity(worktree, Date.parse('2026-11-11T00:00:00Z'))!.map((e) => e.text)).toEqual(['one', 'two']);
    expect(reader.activity(worktree, null, 1)!.map((e) => e.text)).toEqual(['two']);
    expect(reader.activity('/nowhere', null)).toBeNull();
  });
});
