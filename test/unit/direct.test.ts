import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../server/app.ts';
import { directTaskId, directTitle, fillBrief, startDirect } from '../../server/direct.ts';
import { FakeHome } from '../support/fake-home.ts';

const NOW = 1794456000000;
const ID = directTaskId(NOW);
const ASK = 'Fix the "double submit" on the apply screen & add a $widget test\nsecond line of the ask';
const TITLE = 'Fix the "double submit" on the apply screen & add a $widget test';

let home: FakeHome;
let uploadDir: string;

beforeEach(() => {
  uploadDir = mkdtempSync(path.join(os.tmpdir(), 'crewchat-direct-uploads-'));
  home = new FakeHome('crewchat-direct-');
  home.makeProject('crew-chat');
  home.writeProjects('- crew-chat [local-only] - Local browser chat view of firstmate workers\n');
});

afterEach(() => {
  home.cleanup();
  rmSync(uploadDir, { recursive: true, force: true });
});

const start = (overrides: Partial<{ project: string; text: string; model: string; effort: string }> = {}) =>
  startDirect(
    home.home,
    { project: 'crew-chat', text: ASK, model: 'auto', effort: 'auto', ...overrides },
    NOW,
  );

describe('startDirect', () => {
  it('files the task, scaffolds and fills its brief, and spawns it local-only with approvals on', async () => {
    const r = await start();
    expect(r).toMatchObject({ ok: true, outcome: 'sent', id: ID, exitCode: 0 });

    expect(home.tasksAddLog()).toEqual([['add', ID, TITLE, '--kind', 'ship', '--repo', 'crew-chat', '--queue']]);
    expect(home.briefLog()).toEqual([[ID, 'crew-chat', '--mode', 'local-only']]);

    const brief = readFileSync(path.join(home.home, 'data', ID, 'brief.md'), 'utf8');
    expect(brief).toContain(ASK);
    expect(brief).not.toContain('{TASK}');
    expect(brief).not.toContain('{FIRSTMATE_SPEC}');
    expect(brief).toContain("None beyond the captain's intent above");

    expect(home.spawnLog()).toEqual([[ID, path.join(home.home, 'projects', 'crew-chat'), '--mode', 'local-only', '--yolo', 'off']]);
    expect(home.dispatchLog()).toEqual([]);
  });

  it('passes an explicit model and effort with a dispatch override, and leaves Firstmate to pick otherwise', async () => {
    home.enableDispatch();
    home.setDispatchAnswer({ task: ID, status: 'clear', profile: { harness: 'claude', model: 'sonnet', effort: 'medium' } });

    const chosen = await start({ model: 'opus', effort: 'high' });
    expect(chosen.ok).toBe(true);
    expect(home.dispatchLog()).toEqual([]);
    expect(home.spawnLog()[0]).toEqual([
      ID,
      path.join(home.home, 'projects', 'crew-chat'),
      '--mode',
      'local-only',
      '--yolo',
      'off',
      '--model',
      'opus',
      '--effort',
      'high',
      '--dispatch-override',
      'model and effort chosen in crew-chat',
    ]);
  });

  it('takes the profile Firstmate dispatch rules settle on when no model was chosen', async () => {
    home.enableDispatch();
    home.setDispatchAnswer({ task: ID, status: 'clear', profile: { harness: 'claude', model: 'sonnet', effort: 'medium' } });

    const r = await start();
    expect(r.ok).toBe(true);
    expect(home.dispatchLog()).toEqual([[path.join(home.home, 'data', ID, 'brief.md'), '--project', 'crew-chat']]);
    // The argv is [id, project dir, --mode, local-only, --yolo, off, ...profile].
    expect(home.spawnLog()[0].slice(6)).toEqual(['--harness', 'claude', '--model', 'sonnet', '--effort', 'medium']);
  });

  it('does not spawn when Firstmate dispatch rules do not settle a profile, and says the task is still queued', async () => {
    home.enableDispatch();
    home.setDispatchAnswer({ task: ID, status: 'ambiguous', profile: null });

    const r = await start();
    expect(r).toMatchObject({ ok: false, outcome: 'refused', id: ID });
    expect(r.error).toContain('ambiguous');
    expect(home.spawnLog()).toEqual([]);
  });

  it('reports a failed spawn with its output, and says the task stays Queued', async () => {
    home.refuseSpawn('error: spawn refused: the pool slot is busy\n');
    const r = await start();
    expect(r).toMatchObject({ ok: false, outcome: 'refused', id: ID, exitCode: 1 });
    expect(r.stderr).toContain('the pool slot is busy');
    expect(r.error).toContain('stays filed as Queued');
    expect(existsSync(path.join(home.state, `${ID}.meta`))).toBe(false);
    expect(home.tasksAddLog()).toHaveLength(1);
  });

  it('stops before filing anything when the project is not cloned here', async () => {
    const r = await start({ project: 'not-cloned' });
    expect(r).toMatchObject({ ok: false, outcome: 'refused', id: null });
    expect(home.tasksAddLog()).toEqual([]);
    expect(home.spawnLog()).toEqual([]);
  });

  it('reports a refused backlog filing and starts nothing', async () => {
    home.refuseTasksAdd('error: backlog is locked\n');
    const r = await start();
    expect(r).toMatchObject({ ok: false, outcome: 'refused', id: null, exitCode: 2 });
    expect(r.stderr).toContain('backlog is locked');
    expect(home.briefLog()).toEqual([]);
    expect(home.spawnLog()).toEqual([]);
  });

  it('keeps the task Queued and starts nothing when the brief cannot be written', async () => {
    home.refuseBrief('error: no template\n');
    const r = await start();
    expect(r).toMatchObject({ ok: false, outcome: 'refused', id: ID });
    expect(r.error).toContain('still filed in the backlog as Queued');
    expect(home.spawnLog()).toEqual([]);
  });

  it('refuses an ask that opens with a dash, before anything is filed', async () => {
    const r = await start({ text: '--yolo everything' });
    expect(r.ok).toBe(false);
    expect(home.tasksAddLog()).toEqual([]);
  });

  it('gives the title the first line of the ask, cut short', () => {
    expect(directTitle(ASK)).toBe(TITLE);
    const long = `${'word '.repeat(40)}`;
    expect(directTitle(long).length).toBe(90);
    expect(directTitle(long).endsWith('...')).toBe(true);
  });

  it('fills both placeholders in one pass, so a placeholder typed into the ask is left alone', () => {
    const filled = fillBrief('A {TASK} B {FIRSTMATE_SPEC}', 'ask {FIRSTMATE_SPEC} $& $1');
    expect(filled.startsWith('A ask {FIRSTMATE_SPEC} $& $1 B ')).toBe(true);
    expect(filled).toContain("None beyond the captain's intent above");
  });
});

describe('POST /api/workers/direct', () => {
  async function serve(readOnly: boolean) {
    const { server } = createApp({ home: home.home, readOnly, tmux: null, staticDir: null, uploadDir, ledgerFile: path.join(uploadDir, 'ledger.jsonl') });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    return { server, base };
  }

  const post = (url: string, body: unknown, headers: Record<string, string> = {}) =>
    fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

  const good = { project: 'crew-chat', text: ASK, model: 'auto', effort: 'auto' };

  it('starts the worker and lists it as a thread like any other', async () => {
    const { server, base } = await serve(false);
    try {
      const r = await post(`${base}/api/workers/direct`, good);
      expect(r.status).toBe(200);
      const body = (await r.json()) as { ok: boolean; outcome: string; id: string };
      expect(body).toMatchObject({ ok: true, outcome: 'sent' });
      expect(body.id).toMatch(/^direct-[0-9a-z]+$/);
      const threads = (await (await fetch(`${base}/api/threads`)).json()) as Array<{ id: string }>;
      expect(threads.map((t) => t.id)).toContain(body.id);
    } finally {
      server.close();
    }
  });

  it('returns a refused spawn as 502 with the output', async () => {
    home.refuseSpawn('error: no worktree\n');
    const { server, base } = await serve(false);
    try {
      const r = await post(`${base}/api/workers/direct`, good);
      expect(r.status).toBe(502);
      const body = (await r.json()) as { id: string };
      expect(body).toMatchObject({ ok: false, outcome: 'refused', exitCode: 1 });
      expect(body.id).toMatch(/^direct-[0-9a-z]+$/);
    } finally {
      server.close();
    }
  });

  it('refuses without calling any script: read-only, cross-site, unlisted project, bad model or effort, empty ask', async () => {
    const ro = await serve(true);
    try {
      expect((await post(`${ro.base}/api/workers/direct`, good)).status).toBe(403);
    } finally {
      ro.server.close();
    }
    const { server, base } = await serve(false);
    try {
      expect((await post(`${base}/api/workers/direct`, good, { origin: 'https://evil.example' })).status).toBe(403);
      expect((await post(`${base}/api/workers/direct`, { ...good, project: 'nope' })).status).toBe(400);
      expect((await post(`${base}/api/workers/direct`, { ...good, model: 'gpt-9' })).status).toBe(400);
      expect((await post(`${base}/api/workers/direct`, { ...good, effort: 'ultra' })).status).toBe(400);
      expect((await post(`${base}/api/workers/direct`, { ...good, text: '   ' })).status).toBe(400);
      expect((await post(`${base}/api/workers/direct`, null)).status).toBe(400);
      const plain = await fetch(`${base}/api/workers/direct`, { method: 'POST', body: JSON.stringify(good) });
      expect(plain.status).toBe(415);
    } finally {
      server.close();
    }
    expect(home.tasksAddLog()).toEqual([]);
    expect(home.spawnLog()).toEqual([]);
  });
});
