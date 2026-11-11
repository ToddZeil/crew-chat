import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../server/app.ts';
import { send } from '../../server/fm.ts';
import { FakeHome } from '../support/fake-home.ts';

const TRICKY = `He said "ship it" & it's $HOME $(echo nope) \`whoami\` 100%\nsecond line\\n`;

let home: FakeHome;
let uploadDir: string;

beforeEach(() => {
  uploadDir = mkdtempSync(path.join(os.tmpdir(), 'crewchat-uploads-'));
  home = new FakeHome();
  home.add({
    id: 'search-sort',
    meta: { window: 'nope:fm-search-sort', kind: 'ship' },
    status: ['needs-decision [key=sort-shape] [at=1788576000]: list or one field?'],
  });
});

afterEach(() => {
  home.cleanup();
  rmSync(uploadDir, { recursive: true, force: true });
});

describe('send through the stub fm-send.sh', () => {
  it('passes the id and text as two exact arguments', async () => {
    const r = await send(home.home, 'search-sort', TRICKY);
    expect(r).toMatchObject({ ok: true, outcome: 'sent', exitCode: 0 });
    expect(home.sendLog()).toEqual([['search-sort', TRICKY]]);
  });

  it('passes --resolve-key and the key before the answer text', async () => {
    const r = await send(home.home, 'search-sort', 'one "field" for $now', 'sort-shape');
    expect(r.ok).toBe(true);
    expect(home.sendLog()).toEqual([['search-sort', '--resolve-key', 'sort-shape', 'one "field" for $now']]);
  });

  it('surfaces a refusal with its exit status and stderr', async () => {
    const r = await send(home.home, 'search-sort', 'please refuse');
    expect(r).toMatchObject({ ok: false, outcome: 'refused', exitCode: 4 });
    expect(r.stderr).toContain('stub refused this message on purpose');
  });
});

describe('HTTP write routes', () => {
  async function serve(readOnly: boolean) {
    const { server } = createApp({ home: home.home, readOnly, tmux: null, staticDir: null, uploadDir, ledgerFile: path.join(uploadDir, 'ledger.jsonl') });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    return { server, base };
  }

  const post = (url: string, body: unknown, headers: Record<string, string> = {}) =>
    fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

  it('sends a message and an answer with exact argv', async () => {
    const { server, base } = await serve(false);
    try {
      const a = await post(`${base}/api/threads/search-sort/messages`, { text: TRICKY });
      expect(a.status).toBe(200);
      const b = await post(`${base}/api/threads/search-sort/answer`, { key: 'sort-shape', text: 'one field' });
      expect(b.status).toBe(200);
      expect(home.sendLog()).toEqual([
        ['search-sort', TRICKY],
        ['search-sort', '--resolve-key', 'sort-shape', 'one field'],
      ]);
      const detail = (await (await fetch(`${base}/api/threads/search-sort`)).json()) as {
        items: Array<{ type: string; decision?: string; read?: boolean }>;
      };
      expect(detail.items.find((i) => i.type === 'incoming' && i.decision)?.decision).toBe('resolved');
      expect(detail.items.filter((i) => i.type === 'outgoing')).toHaveLength(2);
    } finally {
      server.close();
    }
  });

  it('returns the script refusal to the page', async () => {
    const { server, base } = await serve(false);
    try {
      const r = await post(`${base}/api/threads/search-sort/messages`, { text: 'please refuse' });
      expect(r.status).toBe(502);
      const body = (await r.json()) as { exitCode: number; stderr: string };
      expect(body.exitCode).toBe(4);
      expect(body.stderr).toContain('refused');
    } finally {
      server.close();
    }
  });

  it('refuses without calling the script: read-only, leading dash, bad key, cross-site, unknown worker', async () => {
    const ro = await serve(true);
    try {
      expect((await post(`${ro.base}/api/threads/search-sort/messages`, { text: 'hi' })).status).toBe(403);
      expect((await post(`${ro.base}/api/firstmate/notes`, { text: 'hi', requestId: '1b4e28ba-2fa1-4d2b-883f-0016d3cca427' })).status).toBe(403);
    } finally {
      ro.server.close();
    }
    const { server, base } = await serve(false);
    try {
      expect((await post(`${base}/api/threads/search-sort/messages`, { text: '--key Enter' })).status).toBe(400);
      expect((await post(`${base}/api/threads/search-sort/answer`, { key: 'bad key', text: 'x' })).status).toBe(400);
      expect((await post(`${base}/api/threads/search-sort/messages`, { text: 'hi' }, { origin: 'https://evil.example' })).status).toBe(403);
      expect((await post(`${base}/api/threads/nobody/messages`, { text: 'hi' })).status).toBe(404);
      const plain = await fetch(`${base}/api/threads/search-sort/messages`, { method: 'POST', body: '{"text":"hi"}' });
      expect(plain.status).toBe(415);
    } finally {
      server.close();
    }
    expect(home.sendLog()).toEqual([]);
  });

  it('cleans up without --force first, and forces only with the typed id', async () => {
    home.refuseTeardown('search-sort', 'error: teardown refused: 2 unpushed commits');
    const { server, base } = await serve(false);
    try {
      const first = await post(`${base}/api/threads/search-sort/cleanup`, {});
      expect(first.status).toBe(502);
      expect(await first.json()).toMatchObject({ outcome: 'refused', exitCode: 1, stderr: 'error: teardown refused: 2 unpushed commits' });
      expect((await post(`${base}/api/threads/search-sort/cleanup`, { force: true })).status).toBe(400);
      expect((await post(`${base}/api/threads/search-sort/cleanup`, { force: true, confirmId: 'search-sor' })).status).toBe(400);
      expect(home.teardownLog()).toEqual([['search-sort']]);
      const forced = await post(`${base}/api/threads/search-sort/cleanup`, { force: true, confirmId: 'search-sort' });
      expect(forced.status).toBe(200);
      expect(await forced.json()).toMatchObject({ outcome: 'cleaned', exitCode: 0 });
      expect(home.teardownLog()).toEqual([['search-sort'], ['search-sort', '--force']]);
      expect((await fetch(`${base}/api/threads/search-sort`)).status).toBe(404);
    } finally {
      server.close();
    }
  });

  it('sends a note to First mate with one request id, replays a retry, and reports exit 3 as pending', async () => {
    const { server, base } = await serve(false);
    try {
      const rid = '1b4e28ba-2fa1-4d2b-883f-0016d3cca427';
      const first = await post(`${base}/api/firstmate/notes`, { text: TRICKY, requestId: rid });
      expect(first.status).toBe(200);
      expect(await first.json()).toMatchObject({ outcome: 'sent', exitCode: 0, noteId: 'note-001' });
      const retry = await post(`${base}/api/firstmate/notes`, { text: TRICKY, requestId: rid });
      expect(await retry.json()).toMatchObject({ outcome: 'sent', noteId: 'note-001' });
      expect(home.inboxNoteCount()).toBe(1);
      expect(home.inboxLog()).toEqual([
        ['note', '--request-id', rid, '--json', '--', TRICKY],
        ['note', '--request-id', rid, '--json', '--', TRICKY],
      ]);
      const pending = await post(`${base}/api/firstmate/notes`, { text: 'later [stub:pending]', requestId: '2b4e28ba-2fa1-4d2b-883f-0016d3cca427' });
      expect(await pending.json()).toMatchObject({ outcome: 'pending', exitCode: 3 });
      const refused = await post(`${base}/api/firstmate/notes`, { text: 'please refuse', requestId: '3b4e28ba-2fa1-4d2b-883f-0016d3cca427' });
      expect(refused.status).toBe(502);
      expect(await refused.json()).toMatchObject({ outcome: 'refused', exitCode: 1 });
      expect((await post(`${base}/api/firstmate/notes`, { text: 'hi', requestId: 'not-a-uuid' })).status).toBe(400);
      expect(home.inboxLog()).toHaveLength(4);
    } finally {
      server.close();
    }
  });

  it('saves a pasted image outside FM_HOME and serves it back', async () => {
    const { server, base } = await serve(false);
    try {
      const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
      const r = await post(`${base}/api/uploads`, { type: 'image/png', data: png.toString('base64') });
      expect(r.status).toBe(200);
      const body = (await r.json()) as { path: string; url: string };
      expect(path.dirname(body.path)).toBe(path.resolve(uploadDir));
      expect(body.path.startsWith(home.home)).toBe(false);
      expect(readFileSync(body.path).equals(png)).toBe(true);
      const served = await fetch(`${base}${body.url}`);
      expect(served.headers.get('content-type')).toBe('image/png');
      expect(Buffer.from(await served.arrayBuffer()).equals(png)).toBe(true);
      expect((await post(`${base}/api/uploads`, { type: 'text/html', data: 'PGI+' })).status).toBe(400);
      expect((await fetch(`${base}/api/uploads/..%2F..%2Fetc%2Fpasswd`)).status).toBe(404);
    } finally {
      server.close();
    }
    const ro = await serve(true);
    try {
      expect((await post(`${ro.base}/api/uploads`, { type: 'image/png', data: 'AAAA' })).status).toBe(403);
    } finally {
      ro.server.close();
    }
  });

  it('labels the app sends as you and anything else in the inbox as First mate, across a restart', async () => {
    const first = await serve(false);
    try {
      expect((await post(`${first.base}/api/threads/search-sort/messages`, { text: 'mine' })).status).toBe(200);
      expect((await post(`${first.base}/api/threads/search-sort/answer`, { key: 'sort-shape', text: 'my answer' })).status).toBe(200);
    } finally {
      first.server.close();
    }
    home.writeInbox('search-sort', 'steer from the supervisor', false);
    const second = await serve(false);
    try {
      const detail = (await (await fetch(`${second.base}/api/threads/search-sort`)).json()) as {
        items: Array<{ type: string; body?: string; from?: string }>;
      };
      const out = detail.items.filter((i) => i.type === 'outgoing').map((i) => [i.body, i.from]);
      expect(out).toEqual([
        ['mine', 'you'],
        ['my answer', 'you'],
        ['steer from the supervisor', 'firstmate'],
      ]);
    } finally {
      second.server.close();
    }
  });

  it('previews Markdown and images only from the home, the worktree, or uploads, never through a symlink out', async () => {
    const wt = mkdtempSync(path.join(os.tmpdir(), 'crewchat-wt-'));
    const outside = mkdtempSync(path.join(os.tmpdir(), 'crewchat-outside-'));
    try {
      home.writeData('search-sort', 'report.md', '# Report\n\n| a | b |\n| - | - |');
      writeFileSync(path.join(wt, 'PLAN.md'), '# Plan');
      writeFileSync(path.join(outside, 'secret.md'), '# Secret');
      symlinkSync(path.join(outside, 'secret.md'), path.join(wt, 'escape.md'));
      writeFileSync(path.join(home.state, 'search-sort.meta'), `window=nope:fm-search-sort\nkind=ship\nworktree=${wt}\n`);
      const { server, base } = await serve(false);
      try {
        const get = async (p: string, thread = 'search-sort') =>
          (await (await fetch(`${base}/api/doc?${new URLSearchParams({ path: p, thread })}`)).json()) as { ok: boolean; text?: string; error?: string };
        expect(await get('data/search-sort/report.md')).toMatchObject({ ok: true, text: '# Report\n\n| a | b |\n| - | - |' });
        expect(await get(path.join(home.home, 'data/search-sort/report.md'))).toMatchObject({ ok: true });
        expect(await get('PLAN.md')).toMatchObject({ ok: true, text: '# Plan' });
        expect(await get(path.join(wt, 'PLAN.md'), '')).toMatchObject({ ok: false });
        expect(await get('escape.md')).toMatchObject({ ok: false });
        expect(await get(path.join(outside, 'secret.md'))).toMatchObject({ ok: false });
        expect(await get('../../../../etc/passwd.md')).toMatchObject({ ok: false });
        expect((await get('state/search-sort.meta')).error).toBe('Only Markdown files can be previewed.');
        writeFileSync(path.join(uploadDir, 'shot.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
        writeFileSync(path.join(outside, 'secret.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
        const img = await fetch(`${base}/api/image?${new URLSearchParams({ path: path.join(uploadDir, 'shot.png') })}`);
        expect(img.status).toBe(200);
        expect(img.headers.get('content-type')).toBe('image/png');
        expect((await fetch(`${base}/api/image?${new URLSearchParams({ path: path.join(outside, 'secret.png') })}`)).status).toBe(404);
        expect((await fetch(`${base}/api/image?${new URLSearchParams({ path: 'state/search-sort.meta' })}`)).status).toBe(400);
      } finally {
        server.close();
      }
    } finally {
      rmSync(wt, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('never runs cleanup in read-only mode', async () => {
    const { server, base } = await serve(true);
    try {
      expect((await post(`${base}/api/threads/search-sort/cleanup`, {})).status).toBe(403);
    } finally {
      server.close();
    }
    expect(home.teardownLog()).toEqual([]);
  });
});
