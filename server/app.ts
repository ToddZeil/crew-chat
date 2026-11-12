import { randomBytes } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import type { AppConfig, ClaudeLimits, CleanupResult, DocResult, NoteResult, PaneSnapshot, ThreadSummary, UploadResult, WriteResult } from '../shared/types.ts';
import { parseStatusBar } from './limits.ts';
import { send, sendNote, teardown, validateText } from './fm.ts';
import { missingScripts, REQUIRED_SCRIPTS } from './check.ts';
import { SentLedger } from './ledger.ts';
import { ID_RE, Store } from './store.ts';

const IMAGE_TYPES: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };
const UPLOAD_NAME = /^[A-Za-z0-9-]+\.(png|jpg|gif|webp)$/;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_DOC_BYTES = 1024 * 1024;
const LIMITS_MS = 30_000;

function inside(root: string, file: string): boolean {
  return file === root || file.startsWith(root + path.sep);
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
import {
  capturePane,
  groupedSessionName,
  parseWindow,
  shellCommand,
  pickLauncher,
  type Launcher,
  type TmuxConfig,
} from './terminal.ts';

export interface AppOptions {
  home: string;
  readOnly: boolean;
  tmux: TmuxConfig | null;
  staticDir: string | null;
  // Where pasted images are saved; never inside FM_HOME.
  uploadDir: string;
  claudeProjectsDir?: string | null;
  // The app's record of what it sent; null leaves every inbox record
  // attributed to the supervisor.
  ledgerFile: string | null;
  archiveDir?: string | null;
  // Opens the worker's terminal; defaults to the platform's terminal app.
  launch?: Launcher | null;
  store?: Store;
  // How long one status-bar reading of plan usage is reused.
  limitsMs?: number;
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
};

function json(res: http.ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(data);
}

function readBody(req: http.IncomingMessage, limit = 256 * 1024): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('Request body is too large.'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch {
        reject(new Error('Request body is not valid JSON.'));
      }
    });
    req.on('error', reject);
  });
}

// The server only listens on 127.0.0.1, but any web page the browser has open
// could still POST to it. Requiring JSON forces a CORS preflight, and the
// Origin check refuses cross-site requests outright.
function sameOrigin(req: http.IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    const host = new URL(origin).host;
    return host === req.headers.host || /^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host);
  } catch {
    return false;
  }
}

function refused(message: string): WriteResult {
  return { ok: false, outcome: 'refused', exitCode: null, stdout: '', stderr: '', error: message };
}

export function createApp(opts: AppOptions): { server: http.Server; store: Store } {
  const store =
    opts.store ??
    new Store({
      home: opts.home,
      tmux: opts.tmux,
      claudeProjectsDir: opts.claudeProjectsDir ?? null,
      ledger: opts.ledgerFile ? new SentLedger(opts.ledgerFile) : null,
      canLaunch: (opts.launch === undefined ? pickLauncher(process.env.CREW_CHAT_TERMINAL_CMD) : opts.launch) !== null,
      archiveDir: opts.archiveDir ?? null,
    });
  const launch = opts.launch === undefined ? pickLauncher(process.env.CREW_CHAT_TERMINAL_CMD) : opts.launch;
  const clients = new Set<http.ServerResponse>();
  // Several open pages polling one worker share one capture.
  const panes = new Map<string, Promise<PaneSnapshot>>();

  function pane(id: string): Promise<PaneSnapshot> {
    const cached = panes.get(id);
    if (cached) return cached;
    const p = (async (): Promise<PaneSnapshot> => {
      const meta = store.meta(id) ?? {};
      const at = Date.now();
      const backend = meta.backend || 'tmux';
      if (backend !== 'tmux') return { available: false, reason: `Runs on ${backend}, not tmux, so there is no terminal to show.`, text: '', at };
      const target = parseWindow(meta.window);
      if (!target) return { available: false, reason: 'No tmux window is recorded for this worker.', text: '', at };
      if (!opts.tmux) return { available: false, reason: 'tmux is not installed or not on PATH.', text: '', at };
      const r = await capturePane(opts.tmux, target);
      if (!r.ok) return { available: false, reason: `The worker's terminal is not running (${r.error}).`, text: '', at };
      return { available: true, text: r.text, at };
    })();
    panes.set(id, p);
    setTimeout(() => panes.delete(id), 700);
    return p;
  }

  // Plan usage from the status bar of the most recently active Claude worker,
  // read at most every LIMITS_MS however many pages ask.
  let limitsCache: { at: number; value: Promise<ClaudeLimits | null> } | null = null;
  function limits(): Promise<ClaudeLimits | null> {
    if (limitsCache && Date.now() - limitsCache.at < (opts.limitsMs ?? LIMITS_MS)) return limitsCache.value;
    const value = (async () => {
      const rank = (t: ThreadSummary) => (t.badge === 'working' ? 0 : t.badge === 'needs-you' ? 1 : 2);
      const candidates = store
        .summaries()
        .filter((t) => !t.placeholder && t.terminal.available && (t.harness ?? 'claude') === 'claude')
        .sort((a, b) => rank(a) - rank(b) || (b.lastAt ?? 0) - (a.lastAt ?? 0))
        .slice(0, 4);
      for (const t of candidates) {
        const snap = await pane(t.id);
        const found = snap.available ? parseStatusBar(snap.text, snap.at) : null;
        if (found) return { ...found, from: t.id };
      }
      return null;
    })();
    limitsCache = { at: Date.now(), value };
    return value;
  }

  store.on('change', (ids: string[]) => {
    const data = `event: change\ndata: ${JSON.stringify({ ids })}\n\n`;
    for (const c of clients) c.write(data);
  });
  const heartbeat = setInterval(() => {
    for (const c of clients) c.write(': ping\n\n');
  }, 25_000);
  heartbeat.unref();

  async function handlePost(req: http.IncomingMessage, res: http.ServerResponse, id: string, action: string) {
    if (!sameOrigin(req)) return json(res, 403, refused('Cross-site request refused.'));
    if (!(req.headers['content-type'] ?? '').startsWith('application/json')) {
      return json(res, 415, refused('Send JSON.'));
    }
    if (opts.readOnly) {
      return json(res, 403, refused('This crew-chat is running read-only, so it cannot send or open anything.'));
    }
    let body: Record<string, unknown>;
    try {
      body = (await readBody(req)) as Record<string, unknown>;
    } catch (err) {
      return json(res, 400, refused((err as Error).message));
    }

    if (action === 'messages' || action === 'answer') {
      const text = body.text;
      const problem = validateText(text);
      if (problem) return json(res, 400, refused(problem));
      let key: string | undefined;
      if (action === 'answer') {
        if (typeof body.key !== 'string' || !/^[A-Za-z0-9._-]+$/.test(body.key)) {
          return json(res, 400, refused('That decision has no valid key to answer.'));
        }
        key = body.key;
      }
      const before = new Set(store.inboxRecords(id).map((r) => r.seq));
      const entry = store.ledger?.begin(store.home, id, text as string);
      const result = await send(store.home, id, text as string, key);
      if (store.ledger && entry) {
        if (result.outcome === 'refused') store.ledger.cancel(entry);
        else {
          const added = store.inboxRecords(id).filter((r) => !before.has(r.seq) && r.body === text);
          if (added.length) store.ledger.confirm(entry, Math.max(...added.map((r) => r.seq)));
        }
      }
      store.nudge(id);
      return json(res, result.ok ? 200 : 502, result);
    }

    if (action === 'cleanup') {
      const force = body.force === true;
      // The discard path must carry the worker id typed by the person, so a
      // stray request can never force a teardown.
      if (force && body.confirmId !== id) {
        const r: CleanupResult = { outcome: 'error', exitCode: null, stdout: '', stderr: '', error: 'Type the worker id exactly to confirm discarding its work.' };
        return json(res, 400, r);
      }
      const result = await teardown(store.home, id, force);
      store.nudge(id);
      return json(res, result.outcome === 'cleaned' || result.outcome === 'cleaned-with-warning' ? 200 : 502, result);
    }

    if (action === 'terminal') {
      const meta = store.meta(id) ?? {};
      const summary = store.summary(id);
      const target = parseWindow(meta.window);
      if (!opts.tmux || !target || !summary?.terminal.available) {
        return json(res, 409, refused(summary?.terminal.reason ?? 'No terminal is available for this worker.'));
      }
      const command = shellCommand(opts.tmux, target, groupedSessionName(id));
      if (!launch) return json(res, 409, refused('No terminal app to open it in. Set CREW_CHAT_TERMINAL_CMD.'));
      const r = await launch(command);
      if (r.exitCode !== 0) {
        return json(res, 502, { ok: false, outcome: 'refused', exitCode: r.exitCode, stdout: '', stderr: r.stderr, error: r.error ?? 'Terminal did not open.' } satisfies WriteResult);
      }
      return json(res, 200, { ok: true, outcome: 'sent', exitCode: 0, stdout: '', stderr: '' } satisfies WriteResult);
    }
    return json(res, 404, refused('Unknown action.'));
  }

  async function handleNote(req: http.IncomingMessage, res: http.ServerResponse) {
    const refuse = (status: number, error: string) =>
      json(res, status, { outcome: 'refused', exitCode: null, noteId: null, stdout: '', stderr: '', error } satisfies NoteResult);
    if (!sameOrigin(req)) return refuse(403, 'Cross-site request refused.');
    if (!(req.headers['content-type'] ?? '').startsWith('application/json')) return refuse(415, 'Send JSON.');
    if (opts.readOnly) return refuse(403, 'This crew-chat is running read-only, so it cannot send anything.');
    let body: Record<string, unknown>;
    try {
      body = (await readBody(req)) as Record<string, unknown>;
    } catch (err) {
      return refuse(400, (err as Error).message);
    }
    if (typeof body.text !== 'string' || body.text.trim() === '') return refuse(400, 'Type a message first.');
    if (typeof body.requestId !== 'string' || !UUID_RE.test(body.requestId)) return refuse(400, 'Missing request id.');
    const result = await sendNote(store.home, body.text, body.requestId);
    await store.refreshNotes();
    return json(res, result.outcome === 'refused' ? 502 : 200, result);
  }

  // Files a message mentions, for the preview: only under the Firstmate home,
  // the worker's own worktree, or crew-chat's uploads, resolved through
  // symlinks first so a path cannot step outside them.
  function resolveFile(asked: string, thread: string): { file: string; size: number } | null {
    const roots: string[] = [store.home, opts.uploadDir];
    if (thread && ID_RE.test(thread)) {
      const wt = store.meta(thread)?.worktree;
      if (wt) roots.push(wt);
    }
    const real = (p: string) => {
      try {
        return realpathSync(p);
      } catch {
        return null;
      }
    };
    const realRoots = roots.map(real).filter((r): r is string => r !== null);
    const candidates = path.isAbsolute(asked) ? [asked] : roots.map((r) => path.join(r, asked.replace(/^~\//, '')));
    for (const c of candidates) {
      const file = real(c);
      if (!file || !realRoots.some((r) => inside(r, file))) continue;
      const st = statSync(file);
      if (st.isFile()) return { file, size: st.size };
    }
    return null;
  }

  function readDoc(url: URL): DocResult {
    const asked = url.searchParams.get('path') ?? '';
    if (!/\.(md|markdown)$/i.test(asked)) return { ok: false, error: 'Only Markdown files can be previewed.' };
    const found = resolveFile(asked, url.searchParams.get('thread') ?? '');
    if (!found) return { ok: false, error: `Cannot find ${asked} in the Firstmate home or this worker's worktree.` };
    if (found.size > MAX_DOC_BYTES) return { ok: false, path: found.file, error: 'The file is larger than 1 MB.' };
    return { ok: true, path: found.file, text: readFileSync(found.file, 'utf8') };
  }

  function serveImage(url: URL, res: http.ServerResponse) {
    const asked = url.searchParams.get('path') ?? '';
    const ext = /\.(png|jpe?g|gif|webp)$/i.exec(asked)?.[1].toLowerCase();
    if (!ext) return json(res, 400, { error: 'Only images can be previewed this way.' });
    const found = resolveFile(asked, url.searchParams.get('thread') ?? '');
    if (!found || found.size > 25 * 1024 * 1024) return json(res, 404, { error: 'No such image here.' });
    res.writeHead(200, { 'content-type': `image/${ext === 'jpg' ? 'jpeg' : ext}`, 'cache-control': 'no-store' });
    createReadStream(found.file).pipe(res);
  }

  async function handleUpload(req: http.IncomingMessage, res: http.ServerResponse) {
    const refuse = (status: number, error: string) => json(res, status, { ok: false, error } satisfies UploadResult);
    if (!sameOrigin(req)) return refuse(403, 'Cross-site request refused.');
    if (!(req.headers['content-type'] ?? '').startsWith('application/json')) return refuse(415, 'Send JSON.');
    if (opts.readOnly) return refuse(403, 'This crew-chat is running read-only, so it cannot save images.');
    let body: Record<string, unknown>;
    try {
      body = (await readBody(req, 15 * 1024 * 1024)) as Record<string, unknown>;
    } catch (err) {
      return refuse(400, (err as Error).message);
    }
    const ext = typeof body.type === 'string' ? IMAGE_TYPES[body.type] : undefined;
    if (!ext) return refuse(400, 'Only PNG, JPEG, GIF, and WebP images can be pasted.');
    if (typeof body.data !== 'string') return refuse(400, 'The image data is missing.');
    const bytes = Buffer.from(body.data, 'base64');
    if (bytes.length === 0) return refuse(400, 'The image is empty.');
    if (bytes.length > MAX_IMAGE_BYTES) return refuse(413, 'The image is larger than 10 MB.');
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*$/, '').replace('T', '-');
    const name = `${stamp}-${randomBytes(4).toString('hex')}.${ext}`;
    mkdirSync(opts.uploadDir, { recursive: true });
    const file = path.join(path.resolve(opts.uploadDir), name);
    writeFileSync(file, bytes, { mode: 0o600 });
    return json(res, 200, { ok: true, path: file, url: `/api/uploads/${name}` } satisfies UploadResult);
  }

  function serveStatic(req: http.IncomingMessage, res: http.ServerResponse, pathname: string) {
    if (!opts.staticDir) {
      res.writeHead(404).end('No built page. Run npm run build, or use npm run dev.');
      return;
    }
    const root = path.resolve(opts.staticDir);
    let file = path.resolve(root, `.${decodeURIComponent(pathname)}`);
    if (!file.startsWith(root + path.sep) && file !== root) {
      res.writeHead(403).end();
      return;
    }
    if (!existsSync(file) || statSync(file).isDirectory()) file = path.join(root, 'index.html');
    if (!existsSync(file)) {
      res.writeHead(404).end('No built page. Run npm run build.');
      return;
    }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream' });
    if (req.method === 'HEAD') return res.end();
    createReadStream(file).pipe(res);
  }

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const parts = url.pathname.split('/').filter(Boolean);
    const route = async () => {
      if (parts[0] !== 'api') return serveStatic(req, res, url.pathname);
      if (req.method === 'GET' && parts[1] === 'limits' && parts.length === 2) return json(res, 200, { limits: await limits() });
      if (req.method === 'GET' && parts[1] === 'config' && parts.length === 2) {
        const missing = missingScripts(store.home).map((script) => ({ script, needed: REQUIRED_SCRIPTS[script] }));
        return json(res, 200, { readOnly: opts.readOnly, home: store.home, uploadDir: path.resolve(opts.uploadDir), missing } satisfies AppConfig);
      }
      if (req.method === 'GET' && parts[1] === 'events' && parts.length === 2) {
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-store',
          connection: 'keep-alive',
        });
        res.write('retry: 2000\n\n');
        clients.add(res);
        req.on('close', () => clients.delete(res));
        return;
      }
      if (parts[1] === 'uploads' && parts.length === 2 && req.method === 'POST') return handleUpload(req, res);
      if (parts[1] === 'uploads' && parts.length === 3 && (req.method === 'GET' || req.method === 'HEAD')) {
        const name = decodeURIComponent(parts[2]);
        const file = path.join(opts.uploadDir, name);
        if (!UPLOAD_NAME.test(name) || !existsSync(file)) return json(res, 404, { error: 'No such image.' });
        res.writeHead(200, { 'content-type': `image/${name.endsWith('jpg') ? 'jpeg' : path.extname(name).slice(1)}`, 'cache-control': 'private, max-age=31536000' });
        if (req.method === 'HEAD') return res.end();
        createReadStream(file).pipe(res);
        return;
      }
      if (parts[1] === 'doc' && parts.length === 2 && req.method === 'GET') return json(res, 200, readDoc(url));
      if (parts[1] === 'image' && parts.length === 2 && req.method === 'GET') return serveImage(url, res);
      if (parts[1] === 'firstmate' && parts.length === 2 && req.method === 'GET') return json(res, 200, store.firstmate());
      if (parts[1] === 'firstmate' && parts[2] === 'notes' && parts.length === 3 && req.method === 'POST') {
        return handleNote(req, res);
      }
      if (parts[1] !== 'threads') return json(res, 404, { error: 'Not found.' });
      if (req.method === 'GET' && parts.length === 2) return json(res, 200, store.summaries());
      const id = parts[2] ? decodeURIComponent(parts[2]) : '';
      if (!ID_RE.test(id) || !store.exists(id)) return json(res, 404, { error: 'No such worker.' });
      if (req.method === 'GET' && parts.length === 3) return json(res, 200, store.detail(id));
      if (req.method === 'GET' && parts.length === 4 && parts[3] === 'pane') return json(res, 200, await pane(id));
      if (req.method === 'GET' && parts.length === 4 && parts[3] === 'activity') return json(res, 200, store.activity(id));
      if (req.method === 'POST' && parts.length === 4 && parts[3] === 'hide') {
        if (!sameOrigin(req)) return json(res, 403, refused('Cross-site request refused.'));
        if (!(req.headers['content-type'] ?? '').startsWith('application/json')) return json(res, 415, refused('Send JSON.'));
        if (opts.readOnly) return json(res, 403, refused('This crew-chat is running read-only.'));
        if (!store.canHide || !store.canHideThread(id)) return json(res, 409, refused('Only finished, queued, or requested threads can be removed from the list.'));
        const body = (await readBody(req)) as { hidden?: unknown };
        store.setHidden(id, body.hidden !== false);
        return json(res, 200, { ok: true, outcome: 'sent', exitCode: 0, stdout: '', stderr: '' } satisfies WriteResult);
      }
      if (req.method === 'POST' && parts.length === 4) {
        if (!store.isLive(id)) {
          return json(res, 409, refused('No worker is running for this yet. Messages here go to First mate as notes instead.'));
        }
        return handlePost(req, res, id, parts[3]);
      }
      return json(res, 404, { error: 'Not found.' });
    };
    route().catch((err) => {
      console.error(err);
      if (!res.headersSent) json(res, 500, refused(`Server error: ${(err as Error).message}`));
      else res.end();
    });
  });
  server.on('close', () => {
    clearInterval(heartbeat);
    for (const c of clients) c.end();
    store.stop();
  });
  return { server, store };
}
