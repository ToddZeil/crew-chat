// Drives the real page end to end against a fake Firstmate home. Every write
// lands on the fake home's stub scripts; tmux runs only on a private socket.
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test, type Browser, type Page } from '@playwright/test';
import { shellCommand } from '../../server/terminal.ts';
import { FakeHome } from '../support/fake-home.ts';

const ROOT = path.join(import.meta.dirname, '..', '..');
const SHOTS = path.join(ROOT, 'docs', 'screenshots');
const TRICKY = `Keep it "simple" & don't break $PATH or \`ls\`;\nsecond line with 100% of $5`;

const now = Math.floor(Date.now() / 1000);
const SEARCH_WORKTREE = '/fake/worktrees/search-sort';

// A Claude transcript for the search worker: one message before it was spawned
// (an earlier task in the same worktree) and two after.
function seedTranscript(projectsDir: string) {
  const dir = path.join(projectsDir, SEARCH_WORKTREE.replace(/[^A-Za-z0-9]/g, '-'));
  mkdirSync(dir, { recursive: true });
  const line = (id: string, at: number, usage: Record<string, number>) =>
    JSON.stringify({ type: 'assistant', timestamp: new Date(at * 1000).toISOString(), message: { id, model: 'claude-opus-5-5', usage } });
  const step = (at: number, type: string, content: unknown) => JSON.stringify({ type, timestamp: new Date(at * 1000).toISOString(), message: { content } });
  const history: string[] = [];
  for (let i = 0; i < 120; i++) history.push(step(now - 2900 + i, 'assistant', [{ type: 'text', text: `Checked search case ${i}.` }]));
  writeFileSync(
    path.join(dir, 'session.jsonl'),
    [
      line('old', now - 90_000, { input_tokens: 5_000_000, output_tokens: 5_000_000 }),
      line('a', now - 3000, { input_tokens: 2000, cache_creation_input_tokens: 40_000, cache_read_input_tokens: 0, output_tokens: 1500 }),
      ...history,
      step(now - 750, 'assistant', [{ type: 'tool_use', name: 'Bash', input: { command: 'npm test -- search' } }]),
      step(now - 740, 'user', [{ type: 'tool_result', content: 'Passed!  - Failed: 0, Passed: 42', is_error: false }]),
      line('b', now - 700, { input_tokens: 500, cache_creation_input_tokens: 3000, cache_read_input_tokens: 42_000, output_tokens: 2500 }),
    ].join('\n') + '\n',
  );
}

function seed(home: FakeHome) {
  home.writeProjects(
    '# Projects\n\n- mobile-app [no-mistakes-prod-only] - mobile app\n- storefront [no-mistakes-prod-only] - web shop\n- crew-chat [local-only] - this chat view\n',
  );
  home.add({
    id: 'search-sort',
    title: 'Storefront: add sort options to product search',
    meta: {
      window: 'crewtest:fm-search-sort',
      project: '/Users/dev/projects/storefront',
      kind: 'ship',
      harness: 'claude',
      model: 'opus',
      effort: 'high',
      worktree: SEARCH_WORKTREE,
      spawn_gen: `s${now - 4000}.1.1`,
    },
    crewState: 'state: parked · source: status-log · needs-decision open: sort-shape',
    status: [
      `working [at=${now - 3600}]: reading the search controller and its tests`,
      `working [at=${now - 2400}]: sorting works for a single field, tests green locally`,
      `needs-decision [key=sort-shape] [at=${now - 600}]: Should sort_by take one field or a list of fields? One field is simple and matches what the mobile app sends today. A list is more flexible but needs a new query parser, about a day more. I recommend one field for now.`,
    ],
    inbox: [{ body: 'Please keep the API backwards compatible.', at: new Date((now - 3000) * 1000).toISOString(), handled: true }],
  });
  home.add({
    id: 'checkout-polish',
    title: 'Mobile: checkout flow polish',
    meta: { window: 'crewtest:fm-checkout-polish', project: '/Users/dev/projects/mobile-app', kind: 'ship', harness: 'codex', effort: 'medium' },
    crewState: 'state: working · source: pane · harness busy (claude-hook)',
    status: [
      'working: picked up the checkout brief',
      'working: reproduced the double tap bug on Android',
      `working [at=${now - 300}]: fixing the double submit in lib/checkout/checkout_controller.dart`,
      `working [at=${now - 120}]: progress notes: ${'the submit button now disables itself while the request is in flight, and the retry path re-enables it only after the error banner is shown. '.repeat(5)}Next I will add a widget test.`,
    ],
    inbox: [{ body: 'When you are done, please also check iOS.', at: new Date((now - 60) * 1000).toISOString(), handled: false }],
  });
  home.add({
    id: 'invoice-export',
    title: 'Payments: CSV export for invoices',
    meta: { window: 'orca-ws:payments', backend: 'orca', project: '/Users/dev/projects/payments', kind: 'ship', pr: 'https://github.com/acme/payments/pull/42' },
    crewState: 'state: done · source: status-log · pr=https://github.com/acme/payments/pull/42',
    status: [
      `working [at=${now - 7200}]: mapping the invoice columns`,
      `blocked [key=ci-token] [at=${now - 6000}]: there is no CircleCI token on this machine, can you add one?`,
      `resolved [key=ci-token] [at=${now - 5000}]: answered: token added to the keychain`,
      `done [at=${now - 1800}]: shipped https://github.com/acme/payments/pull/42, all checks green. Report at data/invoice-export/report.md`,
    ],
  });
  home.add({
    id: 'cache-race',
    title: 'SHOP-306: cache warm-up race',
    meta: { window: 'gone-session:fm-cache-race', kind: 'ship' },
    crewState: 'state: unknown · source: none · backend target gone: gone-session:fm-cache-race',
  });
}

interface Running {
  child: ChildProcess;
  base: string;
}

async function startServer(env: NodeJS.ProcessEnv): Promise<Running> {
  const child = spawn(process.execPath, [path.join(ROOT, 'test', 'e2e', 'serve.ts')], { env, stdio: ['ignore', 'pipe', 'inherit'] });
  const port = await new Promise<string>((resolve, reject) => {
    let out = '';
    child.stdout!.on('data', (d: Buffer) => {
      out += d.toString();
      const m = /listening (\d+)/.exec(out);
      if (m) resolve(m[1]);
    });
    child.on('exit', (code) => reject(new Error(`server exited ${code}`)));
  });
  return { child, base: `http://127.0.0.1:${port}` };
}

let home: FakeHome;
let server: Running;
let tmuxDir: string;
let sock: string;
let tmuxEnv: NodeJS.ProcessEnv;
let terminalLog: string;
let uploadDir: string;
let ledgerFile: string;
let projectsDir: string;
let page: Page;

const tm = (...args: string[]) => execFileSync('tmux', ['-S', sock, ...args], { env: tmuxEnv, encoding: 'utf8' });
const row = (id: string) => page.locator(`.thread-row[data-thread-id="${id}"]`);
const composer = () => page.getByRole('textbox', { name: 'Message' });

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }) => {
  if (!existsSync(path.join(ROOT, 'dist', 'client', 'index.html'))) throw new Error('run vite build first (npm run test:e2e does)');
  home = new FakeHome('crewchat-e2e-');
  seed(home);
  tmuxDir = mkdtempSync(path.join(os.tmpdir(), 'crewchat-e2e-tmux-'));
  sock = path.join(tmuxDir, 'sock');
  tmuxEnv = { ...process.env, TMUX_TMPDIR: tmuxDir };
  delete tmuxEnv.TMUX;
  tm('new-session', '-d', '-s', 'crewtest', '-n', 'fm-search-sort');
  tm('new-window', '-d', '-t', 'crewtest:', '-n', 'fm-checkout-polish');
  // Stands in for First mate's own window: an agent-like program (node), at index 2.
  tm('new-window', '-d', '-t', 'crewtest:2', '-n', 'firstmate', process.execPath, '-e', "process.stdout.write('first-mate-screen-ok\\n'); setInterval(() => {}, 1 << 30)");
  uploadDir = mkdtempSync(path.join(os.tmpdir(), 'crewchat-e2e-uploads-'));
  projectsDir = mkdtempSync(path.join(os.tmpdir(), 'crewchat-e2e-claude-'));
  seedTranscript(projectsDir);
  ledgerFile = path.join(uploadDir, 'sent-ledger.jsonl');
  terminalLog = path.join(home.home, 'terminal.log');
  writeFileSync(terminalLog, '');
  server = await startServer({
    ...process.env,
    FM_HOME: home.home,
    CREW_CHAT_TERMINAL_LOG: terminalLog,
    CREW_CHAT_TMUX_SOCKET: sock,
    CREW_CHAT_UPLOAD_DIR: uploadDir,
    CREW_CHAT_CLAUDE_PROJECTS: projectsDir,
    CREW_CHAT_LEDGER: ledgerFile,
    CREW_CHAT_ARCHIVE: path.join(uploadDir, 'archive'),
    // Stands in for First mate's own window, on the private tmux server.
    CREW_CHAT_FIRSTMATE_WINDOW: 'crewtest:2',
    TMUX_TMPDIR: tmuxDir,
    TMUX: '',
  });
  page = await (browser as Browser).newPage({ colorScheme: 'light' });
  await page.goto(server.base);
  await page.evaluate(() => {
    (window as unknown as { __noReload: boolean }).__noReload = true;
  });
  await expect(page.locator('.thread-row[data-badge="checking"]')).toHaveCount(0);
});

test.afterAll(async () => {
  await page?.close();
  server?.child.kill('SIGTERM');
  if (sock) {
    try {
      tm('kill-session', '-t', '=crewtest');
    } catch {
      // already gone
    }
  }
  if (tmuxDir) rmSync(tmuxDir, { recursive: true, force: true });
  home?.cleanup();
  if (uploadDir) rmSync(uploadDir, { recursive: true, force: true });
  if (projectsDir) rmSync(projectsDir, { recursive: true, force: true });
});

async function noReloadHappened() {
  expect(await page.evaluate(() => (window as unknown as { __noReload?: boolean }).__noReload)).toBe(true);
}

test('sidebar sorts by who needs you and shows a badge per thread', async () => {
  const ids = await page.locator('.thread-row').evaluateAll((els) => els.map((e) => e.getAttribute('data-thread-id')));
  expect(ids).toEqual(['__firstmate__', 'search-sort', 'checkout-polish', 'invoice-export', 'cache-race']);
  const group = (g: string) => page.locator(`[data-group="${g}"] .thread-row`).evaluateAll((els) => els.map((e) => e.getAttribute('data-thread-id')));
  expect(await group('needs-you')).toEqual(['search-sort']);
  expect(await group('working')).toEqual(['checkout-polish']);
  // A worker with a pull request open has its own section.
  expect(await group('in-pr')).toEqual(['invoice-export']);
  expect(await group('done')).toEqual(['cache-race']);
  await expect(row('search-sort')).toHaveAttribute('data-badge', 'needs-you');
  await expect(row('search-sort').locator('.mention')).toHaveText('1');
  await expect(row('checkout-polish')).toHaveAttribute('data-badge', 'working');
  await expect(row('invoice-export')).toHaveAttribute('data-badge', 'ready');
  await expect(row('cache-race')).toHaveAttribute('data-badge', 'stopped');
  await expect(page.locator('.channel-head .badge')).toHaveText('Needs you');
  await expect(page.locator('.sub')).toHaveText('4 workers, 1 needs you');
});

test('the browser tab shows ! and a red badge on its icon while something needs you', async () => {
  await expect(page).toHaveTitle(/^! search-sort - Firstmate crew$/);
  await expect(page.locator('link[rel="icon"]')).toHaveAttribute('data-state', 'alert');
});

test('the top thread opens with its decision, labels, and times', async () => {
  await expect(page).toHaveURL(/#\/t\/search-sort$/);
  await expect(page.locator('.topic-title')).toHaveText('Storefront: add sort options to product search');
  await expect(page.locator('.decision-banner')).toContainText('waiting on a decision from you');
  const decision = page.locator('.msg[data-decision="open"]');
  await expect(decision.locator('.chip').first()).toHaveText('Needs your decision');
  await expect(decision.locator('time')).toHaveText('10 min ago');
  expect(await decision.locator('time').getAttribute('title')).toMatch(/\d{4}/);
  await expect(decision.getByRole('button', { name: 'Answer', exact: true })).toBeVisible();
  await expect(page.locator('.msg.out .receipt')).toHaveText('✓✓ Read');
  // Seeded straight into the inbox, so it came from the supervisor.
  const seeded = page.locator('.msg.out', { hasText: 'Please keep the API backwards compatible.' });
  await expect(seeded).toHaveAttribute('data-from', 'firstmate');
  await expect(seeded.locator('.author')).toHaveText('First mate');
});

test('screenshots: decision thread and done thread, light and dark', async ({ browser }) => {
  mkdirSync(SHOTS, { recursive: true });
  for (const scheme of ['light', 'dark'] as const) {
    const p = await browser.newPage({ colorScheme: scheme, viewport: { width: 1280, height: 800 } });
    await p.goto(`${server.base}/#/t/search-sort`);
    await expect(p.locator('.msg[data-decision="open"]')).toBeVisible();
    await expect(p.locator('.thread-row[data-badge="checking"]')).toHaveCount(0);
    await p.screenshot({ path: path.join(SHOTS, `decision-thread-${scheme}.png`) });
    await p.goto(`${server.base}/#/t/invoice-export`);
    await expect(p.locator('.topic-title')).toHaveText('Payments: CSV export for invoices');
    await p.screenshot({ path: path.join(SHOTS, `done-thread-${scheme}.png`) });
    await p.close();
  }
});

test('switching threads shows that worker, its unread message, and collapses long text', async () => {
  await row('checkout-polish').click();
  await expect(page).toHaveURL(/#\/t\/checkout-polish$/);
  await expect(page.locator('.topic-title')).toHaveText('Mobile: checkout flow polish');
  await expect(page.locator('.msg.in')).toHaveCount(4);
  await expect(page.locator('.msg.in').first().locator('.time')).toHaveText('earlier');
  // Consecutive untimed updates from the worker share one avatar and name.
  await expect(page.locator('.msg.in').nth(1)).toHaveClass(/grouped/);
  await expect(page.locator('.msg.in').nth(1).locator('.author')).toHaveCount(0);
  await expect(page.locator('.day-divider').first()).toBeVisible();
  await expect(page.locator('.msg.out .receipt')).toHaveText('✓ Sent');
  const long = page.locator('.msg.in').nth(3);
  await expect(long.getByRole('button', { name: 'Show more' })).toBeVisible();
  await expect(long).not.toContainText('Next I will add a widget test.');
  await long.getByRole('button', { name: 'Show more' }).click();
  await expect(long).toContainText('Next I will add a widget test.');
  await expect(page.locator('.path code', { hasText: 'lib/checkout/checkout_controller.dart' })).toBeVisible();
  await noReloadHappened();
});

test('Show terminal mirrors the worker terminal live beside the chat', async () => {
  tm('send-keys', '-t', 'crewtest:fm-checkout-polish', "printf '\\033[32mcrewchat-pane-ok\\033[0m step 1\\n'", 'Enter');
  await page.getByTestId('terminal-view').click();
  await expect(page.getByTestId('pane-reason')).toContainText('only read for Claude workers; this one runs codex');
  await page.getByRole('tab', { name: 'Screen' }).click();
  const body = page.getByTestId('pane-body');
  await expect(body).toContainText('crewchat-pane-ok step 1');
  const green = body.locator('span', { hasText: 'crewchat-pane-ok' }).last();
  expect(await green.evaluate((el) => getComputedStyle(el).color)).toBe('rgb(87, 171, 90)');
  tm('send-keys', '-t', 'crewtest:fm-checkout-polish', "printf 'crewchat-pane-step-2\\n'", 'Enter');
  await expect(body).toContainText('crewchat-pane-step-2');
  await expect(page.locator('.pane-live')).toHaveText('Live');
  await page.getByRole('tab', { name: 'Transcript' }).click();
  await page.getByTestId('terminal-view').click();
  await expect(page.getByTestId('terminal-panel')).toHaveCount(0);
  await noReloadHappened();
});

test('the Screen tab keeps lines that scroll off a full-screen program, so it scrolls back', async () => {
  await row('checkout-polish').click();
  await expect(page.locator('.topic-title')).toHaveText('Mobile: checkout flow polish');
  await page.getByTestId('terminal-view').click();
  await page.getByRole('tab', { name: 'Screen' }).click();
  // The alternate screen keeps no scrollback in tmux, like Claude Code's display.
  tm(
    'send-keys',
    '-t',
    'crewtest:fm-checkout-polish',
    "clear; printf '\\033[?1049h'; for i in $(seq -w 1 60); do echo alt-line-$i; sleep 0.25; done; sleep 4; printf '\\033[?1049l'",
    'Enter',
  );
  const body = page.getByTestId('pane-body');
  await expect(body).toContainText('alt-line-60', { timeout: 30_000 });
  expect(tm('capture-pane', '-p', '-t', 'crewtest:fm-checkout-polish')).not.toContain('alt-line-01');
  await expect(body).toContainText('alt-line-01');
  const text = await body.innerText();
  for (let i = 1; i <= 60; i++) expect(text).toContain(`alt-line-${String(i).padStart(2, '0')}`);
  expect(text.match(/alt-line-30/g)?.length).toBe(1);
  const m = await body.evaluate((el) => ({ sh: el.scrollHeight, ch: el.clientHeight }));
  expect(m.sh).toBeGreaterThan(m.ch);
  await page.getByRole('tab', { name: 'Transcript' }).click();
  await page.getByTestId('terminal-view').click();
});

test('the Transcript tab shows the worker session history and scrolls', async () => {
  await row('search-sort').click();
  await expect(page.locator('.topic-title')).toHaveText('Storefront: add sort options to product search');
  await page.getByTestId('terminal-view').click();
  const body = page.getByTestId('pane-body');
  await expect(body).toContainText('Checked search case 119.');
  await expect(body.locator('.act-tool').last()).toHaveText('Bash');
  await expect(body).toContainText('npm test -- search');
  await expect(body).toContainText('Passed!  - Failed: 0, Passed: 42');
  const m = await body.evaluate((el) => ({ sh: el.scrollHeight, ch: el.clientHeight, top: el.scrollTop }));
  expect(m.sh).toBeGreaterThan(m.ch);
  expect(m.top + m.ch).toBeGreaterThanOrEqual(m.sh - 2);
  await body.evaluate((el) => el.scrollTo(0, 0));
  await expect(body.locator('.act-say').first()).toBeInViewport();
  await expect(body.locator('.act-say').first()).toContainText('Checked search case 0.');
  await page.screenshot({ path: path.join(SHOTS, 'terminal-panel-light.png') });
  await page.getByTestId('terminal-view').click();
  await row('checkout-polish').click();
  await expect(page.locator('.topic-title')).toHaveText('Mobile: checkout flow polish');
});

test('a status line appended to the file appears live, and other threads count it as unread', async () => {
  home.appendStatus('checkout-polish', 'working: live line appended by the test');
  await expect(page.locator('.msg.in').last()).toContainText('live line appended by the test');
  await expect(page.locator('.msg.in').last()).toHaveAttribute('data-at-source', 'observed');
  await expect(page.locator('.msg.in').last().locator('time.time')).toHaveText('just now');

  home.appendStatus('invoice-export', `working [at=${Math.floor(Date.now() / 1000)}]: follow-up after the PR`);
  await expect(row('invoice-export').locator('.unread')).toHaveText('1');
  await expect(row('checkout-polish').locator('.unread')).toHaveCount(0);
  await noReloadHappened();
});

test('the read marker updates when the worker picks a message up', async () => {
  home.markHandled('checkout-polish', 1);
  await expect(page.locator('.msg.out .receipt')).toHaveText('✓✓ Read');
  await noReloadHappened();
});

test('Send passes the exact text to fm-send', async () => {
  const box = composer();
  await box.click();
  const [first, second] = TRICKY.split('\n');
  await box.pressSequentially(first);
  await box.press('Shift+Enter');
  await box.pressSequentially(second);
  await expect(box).toHaveValue(TRICKY);
  await box.press('Enter');
  await expect(box).toHaveValue('');
  await expect.poll(() => home.sendLog().at(-1)).toEqual(['checkout-polish', TRICKY]);
  await expect(page.locator('.msg.out').last()).toContainText('Keep it "simple"');
  await expect(page.locator('.msg.out').last().locator('.receipt')).toHaveText('✓ Sent');
});

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAYAAACp8Z5+AAAAEklEQVR4nGM4YRP1HxkzkC4AAAAXJdG9hqaJAAAAAElFTkSuQmCC';

test('pasting an image attaches it, and Send passes its saved path to the worker', async () => {
  const box = composer();
  await box.click();
  await box.evaluate((el, b64) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const dt = new DataTransfer();
    dt.items.add(new File([bytes], 'shot.png', { type: 'image/png' }));
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  }, PNG);
  const thumb = page.locator('.attachment img');
  await expect(thumb).toHaveCount(1);
  await box.fill('This is what I see on Android:');
  await box.press('Enter');
  await expect(page.locator('.attachment')).toHaveCount(0);
  await expect.poll(() => home.sendLog().at(-1)?.[1] ?? '').toMatch(/^This is what I see on Android:/);
  const sent = home.sendLog().at(-1)!;
  expect(sent[0]).toBe('checkout-polish');
  const m = /^This is what I see on Android:\n\[image: (.+\.png)\]$/.exec(sent[1]);
  expect(m).not.toBeNull();
  const saved = m![1];
  expect(path.dirname(saved)).toBe(path.resolve(uploadDir));
  expect(saved.startsWith(home.home)).toBe(false);
  expect(readFileSync(saved).equals(Buffer.from(PNG, 'base64'))).toBe(true);
  const img = page.locator('.msg.out').last().locator('.msg-image img');
  await expect(img).toBeVisible();
  expect(await img.evaluate((el) => (el as HTMLImageElement).naturalWidth)).toBe(4);
  // Clicking the image opens it full size in a lightbox over the page.
  await img.click();
  const viewerImg = page.getByTestId('image-viewer').locator('img.lightbox-img');
  await expect(viewerImg).toBeVisible();
  await expect.poll(() => viewerImg.evaluate((el) => (el as HTMLImageElement).naturalWidth)).toBe(4);
  await expect(page.getByTestId('doc-viewer')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('image-viewer')).toHaveCount(0);
});

test('Cmd+V pastes an image from the system clipboard, in the box or anywhere in the conversation', async ({ browser }) => {
  const ctx = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] });
  const p = await ctx.newPage();
  await p.goto(`${server.base}/#/t/checkout-polish`);
  const box = p.getByRole('textbox', { name: 'Message' });
  const copyImage = () =>
    p.evaluate(async (b64) => {
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': new Blob([bytes], { type: 'image/png' }) })]);
    }, PNG);
  await copyImage();
  await box.click();
  await p.keyboard.press('ControlOrMeta+V');
  await expect(p.locator('.attachment img')).toHaveCount(1);
  await p.locator('.messages').click();
  await copyImage();
  await p.keyboard.press('ControlOrMeta+V');
  await expect(p.locator('.attachment img')).toHaveCount(2);
  await p.getByRole('button', { name: 'Remove image' }).first().click();
  await p.getByRole('button', { name: 'Remove image' }).first().click();
  await ctx.close();
});

test('dropping an image on the composer attaches it, and a non-image is refused', async () => {
  const form = page.getByTestId('composer');
  const drop = (name: string, type: string, b64: string) =>
    form.evaluate(
      (el, [n, t, data]) => {
        const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
        const dt = new DataTransfer();
        dt.items.add(new File([bytes], n, { type: t }));
        el.dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true }));
        el.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
      },
      [name, type, b64],
    );
  await drop('notes.txt', 'text/plain', btoa('hello'));
  await expect(page.locator('.upload-error')).toHaveText('Only images can be dropped here.');
  await drop('drop.png', 'image/png', PNG);
  await expect(page.locator('.attachment img')).toHaveCount(1);
  await page.getByRole('button', { name: 'Remove image' }).click();
  await expect(page.locator('.attachment img')).toHaveCount(0);
  await drop('drop.png', 'image/png', PNG);
  await expect(page.locator('.attachment img')).toHaveCount(1);
  await composer().press('Enter');
  await expect(page.locator('.attachment')).toHaveCount(0);
  await expect.poll(() => home.sendLog().at(-1)?.[1] ?? '').toMatch(/^\[image: .+\.png\]$/);
});

test('the composer toolbar formats the selection, and + attaches an image from disk', async () => {
  const box = composer();
  await box.fill('ship it');
  await box.evaluate((el: HTMLTextAreaElement) => el.setSelectionRange(5, 7));
  await page.getByRole('button', { name: 'Bold', exact: true }).click();
  await expect(box).toHaveValue('ship **it**');
  // Bold reselects the wrapped text on the next frame; let that land first.
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  await box.fill('one\ntwo');
  await box.evaluate((el: HTMLTextAreaElement) => el.setSelectionRange(0, 7));
  await page.getByRole('button', { name: 'Bulleted list' }).click();
  await expect(box).toHaveValue('- one\n- two');
  await box.fill('');

  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Attach an image' }).click();
  await (await chooser).setFiles({ name: 'disk.png', mimeType: 'image/png', buffer: Buffer.from(PNG, 'base64') });
  await expect(page.locator('.attachment img')).toHaveCount(1);
  await page.getByRole('button', { name: 'Remove image' }).click();
  await expect(page.locator('.attachment img')).toHaveCount(0);
});

test('each worker shows its model, effort, and token use, with an overall total', async () => {
  await expect(page.getByTestId('model-line')).toContainText('only read for Claude workers; this one runs codex');
  await expect(page.getByTestId('model-line')).toContainText('medium effort');
  await row('search-sort').click();
  const line = page.getByTestId('model-line');
  await expect(line).toContainText('claude-opus-5-5');
  await expect(line).toContainText('high effort');
  // Latest response: 500 + 3000 + 42000 in context; totals skip the pre-spawn message.
  await expect(line).toContainText('46k in context');
  await expect(line).toContainText('92k tokens used');
  await expect(line).toContainText('4.0k output');
  await expect(page.getByTestId('token-total')).toContainText('92k tokens used, 4.0k output, across 1 worker');
  await row('checkout-polish').click();
  await expect(page.locator('.topic-title')).toHaveText('Mobile: checkout flow polish');
});

test('Send clears the box at once and shows the message as sending until the script answers', async () => {
  const box = composer();
  const text = 'Quick one while the script is slow [stub:slow]';
  await box.fill(text);
  const started = Date.now();
  await box.press('Enter');
  await expect(box).toHaveValue('', { timeout: 500 });
  expect(Date.now() - started).toBeLessThan(1000);
  const mine = page.locator('.msg.out', { hasText: 'Quick one while the script is slow' });
  await expect(mine).toHaveCount(1);
  await expect(mine.locator('.receipt')).toHaveText('Sending...');
  await expect(mine.locator('.receipt')).toHaveText('✓ Sent', { timeout: 8000 });
  await expect(mine).toHaveCount(1);
  await expect(page.locator('[data-pending="yes"]')).toHaveCount(0);
  expect(home.sendLog().at(-1)).toEqual(['checkout-polish', text]);
});

test('a refusal shows in the thread and keeps the text', async () => {
  const box = composer();
  await box.fill('please refuse');
  await box.press('Enter');
  const notice = page.locator('.notice-error');
  await expect(notice).toContainText('Your message was not sent');
  await expect(notice).toContainText('exit 4');
  await expect(notice).toContainText('stub refused this message on purpose');
  await expect(box).toHaveValue('please refuse');
  await notice.getByRole('button', { name: 'Dismiss' }).click();
  await expect(notice).toHaveCount(0);

  await box.fill('-starts with a dash');
  await box.press('Enter');
  await expect(page.locator('.notice-error')).toContainText('cannot start with "-"');
  await box.fill('');
});

test('Answer passes --resolve-key and the decision then shows resolved', async () => {
  await row('search-sort').click();
  const decision = page.locator('#item-s2');
  // The hover bar offers the same Answer action.
  await decision.hover();
  await decision.getByRole('button', { name: 'Answer this decision' }).click();
  await expect(decision.getByRole('textbox', { name: 'Your answer' })).toBeVisible();
  await decision.getByRole('button', { name: 'Cancel' }).click();
  await expect(decision.getByRole('textbox', { name: 'Your answer' })).toHaveCount(0);
  await decision.getByRole('button', { name: 'Answer', exact: true }).click();
  const answer = decision.getByRole('textbox', { name: 'Your answer' });
  await answer.fill('One field for now, and say "list" in the docs as a $later item.');
  await decision.getByRole('button', { name: 'Send answer' }).click();
  await expect.poll(() => home.sendLog().at(-1)).toEqual([
    'search-sort',
    '--resolve-key',
    'sort-shape',
    'One field for now, and say "list" in the docs as a $later item.',
  ]);
  await expect(decision).toHaveAttribute('data-decision', 'resolved');
  await expect(decision.locator('.chip-good')).toHaveText('Resolved');
  await expect(decision.locator('.resolution')).toContainText('answered: One field for now');
  await expect(decision.getByRole('button', { name: 'Answer', exact: true })).toHaveCount(0);
  await expect(page.locator('.decision-banner')).toHaveCount(0);
  await expect(row('search-sort').locator('.mention')).toHaveCount(0);
  await noReloadHappened();
});

test('Open terminal: enabled for a live tmux worker, disabled with a reason otherwise', async () => {
  await row('search-sort').click();
  const btn = page.getByTestId('open-terminal');
  await expect(btn).toBeEnabled();
  await btn.click();
  await expect.poll(() => readFileSync(terminalLog, 'utf8').trim().split('\n').filter(Boolean).length).toBe(1);
  const script = JSON.parse(readFileSync(terminalLog, 'utf8').trim()) as string;
  const grouped = /crewchat-search-sort-[0-9a-f]{6}/.exec(script)?.[0];
  expect(grouped).toBeTruthy();
  const tmuxBin = execFileSync('which', ['tmux'], { encoding: 'utf8' }).trim();
  const command = shellCommand({ bin: tmuxBin, socketArgs: ['-S', sock] }, { session: 'crewtest', window: 'fm-search-sort' }, grouped!);
  expect(script).toBe(command);
  expect(command).toContain(`'new-session' '-t' '=crewtest' '-s' '${grouped}'`);
  expect(command).toContain(`'select-window' '-t' '=${grouped}:=fm-search-sort'`);
  expect(command).toContain(`'set-option' '-t' '${grouped}:' 'destroy-unattached' 'on'`);
  expect(tm('list-sessions', '-F', '#{session_name}').trim()).toBe('crewtest');

  await row('invoice-export').click();
  await expect(page.getByTestId('open-terminal')).toBeDisabled();
  await page.getByTestId('terminal-view').click();
  await expect(page.getByTestId('pane-reason')).toContainText('No worktree is recorded for this worker.');
  await page.getByRole('tab', { name: 'Screen' }).click();
  await expect(page.getByTestId('pane-reason')).toHaveText('Runs on orca, not tmux, so there is no terminal to show.');
  await page.getByRole('tab', { name: 'Transcript' }).click();
  await page.getByTestId('terminal-view').click();
  await expect(page.locator('.btn-reason')).toHaveText('Runs on orca, not tmux, so there is no terminal to open here.');
  await expect(page.locator('a.pr-link').first()).toHaveAttribute('href', 'https://github.com/acme/payments/pull/42');
  await expect(page.locator('a.pr-link').first()).toHaveText('payments PR #42');
  await expect(row('invoice-export').locator('.unread')).toHaveCount(0);

  await row('cache-race').click();
  await expect(page.getByTestId('open-terminal')).toBeDisabled();
  await expect(page.locator('.btn-reason')).toHaveText('The tmux session "gone-session" is not running.');
  await expect(page.locator('.messages')).toContainText('No messages yet');
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

test('First mate thread: a note is delivered, seen, and answered live', async () => {
  await row('__firstmate__').click();
  await expect(page).toHaveURL(/#\/firstmate$/);
  await expect(page.locator('.channel-head h2')).toHaveText(/First mate$/);
  await expect(page.locator('.messages')).toContainText('No messages yet');
  const box = composer();
  await box.fill('Can you start a worker on the storefront sort bug? It costs $5 and "matters".');
  await box.press('Enter');
  await expect(box).toHaveValue('');
  await expect.poll(() => home.inboxLog().length).toBe(1);
  const sent = home.inboxLog().at(-1)!;
  expect(sent.slice(0, 2)).toEqual(['note', '--request-id']);
  expect(sent[2]).toMatch(UUID);
  expect(sent.slice(3)).toEqual(['--json', '--', 'Can you start a worker on the storefront sort bug? It costs $5 and "matters".']);
  const note = page.locator('[data-note-id="note-001"]');
  await expect(note.locator('.receipt')).toHaveText('✓ Delivered');

  home.ackNote('note-001');
  await expect(note.locator('.receipt')).toHaveText('✓✓ Seen');
  home.replyToNote('note-001', 'On it: starting a storefront worker now.', 1);
  await expect(page.locator('[data-reply-to="note-001"]')).toContainText('On it: starting a storefront worker now.');
  await expect(page.locator('[data-reply-to="note-001"] .author')).toHaveText('First mate');
  await noReloadHappened();
});

test('First mate: a refused note keeps its text and request id, and exit 3 shows as saved', async () => {
  const box = composer();
  await box.fill('please refuse');
  await box.press('Enter');
  await expect(page.locator('.notice-error')).toContainText('Your message to First mate was not sent');
  await expect(box).toHaveValue('please refuse');
  const before = home.inboxLog().length;
  await box.press('Enter');
  await expect.poll(() => home.inboxLog().length).toBe(before + 1);
  await expect(page.locator('.notice-error')).toHaveCount(2);
  const [a, b] = home.inboxLog().slice(-2);
  expect(a.at(-1)).toBe('please refuse');
  expect(a[2]).toBe(b[2]);
  await page.locator('.notice-error').first().getByRole('button', { name: 'Dismiss' }).click();
  await page.locator('.notice-error').first().getByRole('button', { name: 'Dismiss' }).click();

  await box.fill('check this later [stub:pending]');
  await box.press('Enter');
  await expect(box).toHaveValue('');
  await expect(page.locator('.notice-warning')).toContainText('Saved, but First mate has not been told yet');
  await expect(page.locator('[data-note-id="note-002"] .receipt')).toHaveText('Saved, not announced yet');
  expect(home.inboxLog().at(-1)![2]).not.toBe(a[2]);
});

test('New worker sends one request note to First mate', async () => {
  await row('checkout-polish').click();
  home.replyToNote('note-002', 'Noted.', 2);
  await expect(row('__firstmate__').locator('.unread')).toHaveText('1');

  await page.getByRole('button', { name: 'New worker' }).click();
  const dialog = page.getByRole('dialog');
  const select = dialog.getByRole('combobox', { name: 'Project' });
  expect(await select.locator('option').allTextContents()).toEqual(['mobile-app', 'storefront', 'crew-chat', 'Other / not sure']);
  await select.selectOption('crew-chat');
  await expect(dialog.getByRole('button', { name: 'Send to First mate' })).toBeDisabled();
  await expect(dialog.getByRole('combobox', { name: 'Model' })).toHaveValue('auto');
  expect(await dialog.getByRole('combobox', { name: 'Model' }).locator('option').allTextContents()).toEqual(['Auto (First mate picks)', 'Haiku', 'Sonnet', 'Opus']);
  await expect(dialog.getByRole('combobox', { name: 'Effort' })).toHaveValue('auto');
  expect(await dialog.getByRole('combobox', { name: 'Effort' }).locator('option').allTextContents()).toEqual([
    'Auto (First mate picks)',
    'Low',
    'Medium',
    'High',
    'Extra high',
    'Max',
  ]);
  await dialog.getByRole('textbox', { name: 'What should it do?' }).fill('Add a search box to the sidebar.');
  await dialog.getByRole('button', { name: 'Send to First mate' }).click();
  await expect(dialog).toHaveCount(0);
  // The request opens as its own conversation under Queued.
  await expect(page).toHaveURL(/#\/t\/request-note-\d+$/);
  const sent = home.inboxLog().at(-1)!;
  expect(sent[2]).toMatch(UUID);
  expect(sent.slice(3)).toEqual(['--json', '--', 'New worker request - project: crew-chat. Add a search box to the sidebar.\nModel: auto\nPlanning: no']);
  await expect(page.locator('.channel-head .badge')).toHaveText('Requested');
  await expect(page.locator('.messages')).toContainText('New worker request - project: crew-chat. Add a search box to the sidebar.');
  await expect(page.locator('.messages')).toContainText('Model: auto');
  await expect(page.locator('.messages')).toContainText('Waiting for First mate to pick this request up.');

  await page.getByRole('button', { name: 'New worker' }).click();
  await dialog.getByRole('combobox', { name: 'Project' }).selectOption('storefront');
  await dialog.getByRole('combobox', { name: 'Model' }).selectOption('opus');
  await dialog.getByRole('combobox', { name: 'Effort' }).selectOption('high');
  await dialog.getByRole('textbox', { name: 'What should it do?' }).fill('Speed up the search query.');
  await dialog.getByRole('button', { name: 'Send to First mate' }).click();
  await expect(dialog).toHaveCount(0);
  expect(home.inboxLog().at(-1)!.slice(3)).toEqual(['--json', '--', 'New worker request - project: storefront. Speed up the search query.\nModel: opus\nEffort: high\nPlanning: no']);
  await expect(page.locator('.msg.out').last()).toContainText('Model: opus');
  await expect(page.locator('.msg.out').last()).toContainText('Effort: high');

  await page.getByRole('button', { name: 'New worker' }).click();
  await dialog.getByRole('combobox', { name: 'Model' }).selectOption('haiku');
  await dialog.getByRole('combobox', { name: 'Effort' }).selectOption('xhigh');
  await dialog.getByRole('textbox', { name: 'What should it do?' }).fill('Tidy the README.');
  await dialog.getByRole('checkbox').check();
  await dialog.getByRole('button', { name: 'Send to First mate' }).click();
  await expect(dialog).toHaveCount(0);
  expect(home.inboxLog().at(-1)!.at(-1)).toMatch(/\nModel: haiku\nEffort: xhigh\nPlanning: yes$/);
  await expect(page.locator('.messages')).toContainText('You asked for a planning phase first');
  await expect(page.locator('.channel-head')).toContainText('planning first');
  await row('__firstmate__').click();
  await expect(row('__firstmate__').locator('.unread')).toHaveCount(0);
  await page.screenshot({ path: path.join(SHOTS, 'first-mate-light.png') });
});

test('queued work has its own conversation for planning with First mate, and the worker carries it on', async () => {
  const today = new Date().toISOString().slice(0, 10);
  home.setBacklog([{ id: 'search-cache-warmup', state: 'queued', repo: 'storefront', title: 'Storefront: warm the search cache on startup', created: today }]);
  home.writeNote(
    'fm-plan-1',
    'New worker request - project: storefront. Warm the search cache when the server starts.\nModel: auto\nPlanning: yes',
    true,
    'Queued as search-cache-warmup. Planning first: how fresh must the cache be?',
  );
  // First mate's newest word is a question, so the queued thread waits on you.
  await expect(page.locator('[data-group="needs-you"] .thread-row[data-thread-id="search-cache-warmup"]')).toHaveCount(1);
  await expect(row('search-cache-warmup').locator('.mention')).toHaveText('1');
  await row('search-cache-warmup').click();
  await expect(page).toHaveURL(/#\/t\/search-cache-warmup$/);
  await expect(page.locator('.channel-head .badge')).toHaveText('Needs you');
  await expect(page.getByTestId('open-terminal')).toHaveCount(0);
  const msgs = page.locator('.messages');
  await expect(msgs).toContainText('Warm the search cache when the server starts.');
  await expect(msgs).toContainText("Queued in First mate's backlog. A worker has not started yet.");
  await expect(msgs).toContainText('You asked for a planning phase first');
  await expect(page.locator('.msg.in', { hasText: 'how fresh must the cache be' }).locator('.author')).toHaveText('First mate');
  await page.screenshot({ path: path.join(SHOTS, 'queued-planning-light.png') });

  const box = composer();
  await box.fill('Five minutes is fine.');
  await box.press('Enter');
  await expect.poll(() => home.inboxLog().at(-1)?.at(-1)).toBe('[re: search-cache-warmup] Five minutes is fine.');
  await expect(page.locator('.msg.out', { hasText: 'Five minutes is fine.' })).toHaveCount(1);
  // The stub logs its arguments before it writes the note, so wait for the note itself.
  await expect.poll(() => home.noteIdFor('[re: search-cache-warmup] Five minutes is fine.')).not.toBeNull();
  const id = home.noteIdFor('[re: search-cache-warmup] Five minutes is fine.')!;
  // Once answered, it is back with the queued work.
  await expect(page.locator('[data-group="queued"] .thread-row[data-thread-id="search-cache-warmup"]')).toHaveCount(1);
  home.replyToNote(id, 'Agreed, starting the worker now.', 950);
  await expect(msgs).toContainText('Agreed, starting the worker now.');

  // The worker starts under the same id and the conversation carries on.
  home.add({
    id: 'search-cache-warmup',
    title: 'Storefront: warm the search cache on startup',
    meta: { window: 'crewtest:fm-search-sort', project: '/Users/dev/projects/storefront', kind: 'ship' },
    crewState: 'state: working · source: pane · harness busy (claude-hook)',
    status: [`working [at=${Math.floor(Date.now() / 1000)}]: starting on the cache warmup`],
  });
  await expect(page.locator('.channel-head .badge')).toHaveText('Working', { timeout: 15_000 });
  await expect(page.getByTestId('open-terminal')).toHaveCount(1);
  await expect(msgs).toContainText('starting on the cache warmup');
  await expect(msgs).toContainText('Five minutes is fine.');
  await expect(msgs).toContainText('Warm the search cache when the server starts.');
  await expect(page.locator('[data-group="working"] .thread-row[data-thread-id="search-cache-warmup"]')).toHaveCount(1);
});

test('Clean up warns about an active worker and Cancel runs nothing', async () => {
  await row('checkout-polish').click();
  await page.getByTestId('clean-up').click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('the worker is stopped');
  await expect(dialog).toContainText('its local copy of the code is cleaned up');
  await expect(dialog).toContainText('its backlog item is closed');
  await expect(dialog).toContainText('this thread disappears');
  await expect(dialog.getByTestId('cleanup-active-warning')).toContainText('still working right now');
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toHaveCount(0);

  await row('search-sort').click();
  await page.getByTestId('clean-up').click();
  await expect(dialog.getByTestId('cleanup-active-warning')).toContainText('waiting on you');
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toHaveCount(0);
  expect(home.teardownLog()).toEqual([]);
});

test('a refused Clean up that you back out of leaves the reason in the thread', async () => {
  home.refuseTeardown('checkout-polish', 'error: teardown refused: 1 uncommitted file\n  M lib/checkout/checkout_controller.dart');
  await row('checkout-polish').click();
  await page.getByTestId('clean-up').click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: 'Clean up', exact: true }).click();
  await expect(dialog.getByTestId('cleanup-output')).toContainText('1 uncommitted file');
  await dialog.getByRole('button', { name: 'Keep the worker' }).click();
  await expect(dialog).toHaveCount(0);
  const notice = page.locator('.notice-error', { hasText: 'Clean up refused' });
  await expect(notice).toContainText('Clean up refused; the worker was kept');
  await expect(notice).toContainText('exit 1');
  await expect(notice).toContainText('M lib/checkout/checkout_controller.dart');
  expect(home.teardownLog()).toEqual([['checkout-polish']]);
  await expect(row('checkout-polish')).toHaveCount(1);
  await notice.getByRole('button', { name: 'Dismiss' }).click();
});

test('Clean up refusal shows the reason, the typed id gates --force, and the thread leaves', async () => {
  home.refuseTeardown(
    'invoice-export',
    'error: teardown refused: invoice-export holds work that has not landed\n  unpushed commits:\n    a1b2c3d fix the invoice date column\n    d4e5f6a add the selftest',
  );
  await row('invoice-export').click();
  await page.getByTestId('clean-up').click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByTestId('cleanup-active-warning')).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Clean up', exact: true }).click();

  await expect(dialog).toContainText('The cleanup refused, and nothing was changed.');
  await expect(dialog.getByTestId('cleanup-output')).toContainText('a1b2c3d fix the invoice date column');
  expect(home.teardownLog().at(-1)).toEqual(['invoice-export']);

  const discard = dialog.getByRole('button', { name: 'Discard this work and clean up' });
  const idBox = dialog.getByRole('textbox', { name: 'Worker id to confirm' });
  await expect(discard).toBeDisabled();
  await idBox.fill('ats-autofil');
  await expect(discard).toBeDisabled();
  await idBox.press('Enter');
  await idBox.fill('ATS-AUTOFILL');
  await expect(discard).toBeDisabled();
  expect(home.teardownLog().filter((a) => a[0] === 'invoice-export')).toEqual([['invoice-export']]);

  await idBox.fill('invoice-export');
  await expect(discard).toBeEnabled();
  await page.screenshot({ path: path.join(SHOTS, 'cleanup-refused-light.png') });
  await discard.click();
  await expect(dialog).toHaveCount(0);
  expect(home.teardownLog().filter((a) => a[0] === 'invoice-export')).toEqual([['invoice-export'], ['invoice-export', '--force']]);
  await expect(page.locator('.flash')).toContainText('Cleaned up Payments: CSV export for invoices');
  // The worker is gone, but its history stays under Done / stopped.
  await expect(row('invoice-export')).toHaveAttribute('data-badge', 'finished');
  await expect(page.locator('[data-group="done"] .thread-row[data-thread-id="invoice-export"]')).toHaveCount(1);
  await noReloadHappened();
});

test('Clean up with nothing unlanded succeeds on the first try without --force', async () => {
  await row('cache-race').click();
  await page.getByTestId('clean-up').click();
  await page.getByRole('dialog').getByRole('button', { name: 'Clean up', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(home.teardownLog().at(-1)).toEqual(['cache-race']);
  await expect(row('cache-race')).toHaveAttribute('data-badge', 'finished');
  await expect(page.locator('.flash')).toContainText('Cleaned up SHOP-306: cache warm-up race');
  expect(home.teardownLog().filter((a) => a.includes('--force'))).toEqual([['invoice-export', '--force']]);
});

test('a cleaned-up worker keeps its thread as Finished, and can be removed from the list and put back', async () => {
  await row('invoice-export').click();
  await expect(page.locator('.channel-head .badge')).toHaveText('Finished');
  const msgs = page.locator('.messages');
  await expect(msgs).toContainText('mapping the invoice columns');
  await expect(msgs).toContainText('shipped');
  await expect(msgs).toContainText('This worker finished and was cleaned up. This is the copy crew-chat kept');
  await expect(page.getByTestId('open-terminal')).toHaveCount(0);
  await expect(composer()).toHaveAttribute('placeholder', 'Ask First mate about this');
  await page.screenshot({ path: path.join(SHOTS, 'finished-thread-light.png') });

  await page.getByTestId('hide-thread').click();
  await expect(row('invoice-export')).toHaveCount(0);
  const show = page.getByRole('button', { name: /^Show \d+ removed$/ });
  await expect(show).toBeVisible();
  await show.click();
  await row('invoice-export').click();
  await expect(page.getByTestId('hide-thread')).toHaveText('Put back in the list');
  await page.getByTestId('hide-thread').click();
  await expect(page.getByTestId('hide-thread')).toHaveText('Remove from list');
  await expect(row('invoice-export')).toHaveCount(1);
  // Nothing is removed any more, so the link to show removed threads goes away.
  await expect(page.getByRole('button', { name: /removed/ })).toHaveCount(0);
});

test('a task that finished before crew-chat kept a copy is rebuilt from its request, brief, and report', async () => {
  const today = new Date().toISOString().slice(0, 10);
  home.setBacklog([
    { id: 'search-cache-warmup', state: 'in_flight', repo: 'storefront', title: 'Storefront: warm the search cache on startup', created: today },
    { id: 'funnel-stats', state: 'done', kind: 'scout', repo: 'mobile-app', title: "Mobile: yesterday's checkout funnel stats", closed: today },
  ]);
  home.writeData('funnel-stats', 'brief.md', 'Pull the checkout funnel numbers for yesterday from BigQuery.');
  home.writeData(
    'funnel-stats',
    'report.md',
    '# Checkout funnel\n\nStarted 1,240, finished 980 (79%).\n\n| Platform | Started | Finished |\n| --- | ---: | ---: |\n| iOS | 700 | 560 |\n| Web | 540 | 420 |\n\n<img src=x onerror="window.__xss=1"><script>window.__xss=2</script>',
  );
  home.writeNote(
    'fm-stats-1',
    'New worker request - project: mobile-app. Get yesterday checkout funnel stats from BigQuery.\nModel: auto\nPlanning: no',
    true,
    'On it: a scout is pulling the funnel stats.',
  );
  await expect(row('funnel-stats')).toHaveAttribute('data-badge', 'finished');
  await row('funnel-stats').click();
  const msgs = page.locator('.messages');
  await expect(msgs).toContainText('Get yesterday checkout funnel stats from BigQuery.');
  await expect(msgs).toContainText('On it: a scout is pulling the funnel stats.');
  await expect(msgs).toContainText('Brief for this worker');
  await expect(msgs).toContainText('Pull the checkout funnel numbers for yesterday from BigQuery.');
  await expect(page.locator('.msg.out', { hasText: 'Brief for this worker' })).toHaveAttribute('data-from', 'firstmate');
  await expect(msgs).toContainText('Started 1,240, finished 980 (79%).');
  await expect(msgs).toContainText('finished and was cleaned up before crew-chat kept a copy');

  // The report's table shows as a table in the chat once the long message is opened up.
  const report = page.locator('.msg', { hasText: 'Report (' });
  await report.getByRole('button', { name: 'Show more' }).click();
  await expect(report.locator('.md-table table tr')).toHaveCount(3);

  // Clicking the file path opens a clean preview of it.
  await page.locator('.msg', { hasText: 'Report (' }).getByRole('button', { name: /report\.md/ }).click();
  const viewer = page.getByTestId('doc-viewer');
  await expect(viewer.locator('h1')).toHaveText('Checkout funnel');
  await expect(viewer.locator('table tr')).toHaveCount(3);
  await expect(viewer).toContainText('report.md');
  expect(await viewer.locator('script, [onerror]').count()).toBe(0);
  expect(await page.evaluate(() => (window as unknown as { __xss?: number }).__xss)).toBeUndefined();
  await page.screenshot({ path: path.join(SHOTS, 'markdown-preview-light.png') });
  await page.keyboard.press('Escape');
  await expect(viewer).toHaveCount(0);
});

test('tables in a reply show as tables: Markdown as a grid, box-drawn ones lined up', async () => {
  home.writeNote(
    'fm-table-1',
    'How did the checkout numbers look?',
    true,
    'Here are the numbers:\n| Day | Orders |\n| --- | ---: |\n| Mon | 120 |\n| Tue | 135 |\nAnd from the terminal:\n┌─────┬────────┐\n│ Day │ Orders │\n├─────┼────────┤\n│ Mon │    120 │\n└─────┴────────┘',
  );
  await row('__firstmate__').click();
  const reply = page.locator('.msg.in', { hasText: 'Here are the numbers:' });
  await expect(reply.locator('.md-table table tr')).toHaveCount(3);
  await expect(reply.locator('.md-table th').first()).toHaveText('Day');
  await expect(reply.locator('.box-table')).toContainText('│ Mon │    120 │');
  expect(await reply.locator('.box-table').evaluate((el) => getComputedStyle(el).whiteSpace)).toBe('pre');
});

test('the sidebar lists the newest activity first inside each section', async () => {
  const done = await page.locator('[data-group="done"] .thread-row').evaluateAll((els) => els.map((e) => e.getAttribute('data-thread-id')));
  const at = await page.evaluate(async () => {
    const list = (await (await fetch('/api/threads')).json()) as Array<{ id: string; lastAt: number | null; hidden?: boolean }>;
    return Object.fromEntries(list.map((t) => [t.id, t.lastAt ?? 0]));
  });
  const times = done.map((id) => at[id!]);
  expect(times).toEqual([...times].sort((a, b) => b - a));
  expect(done.length).toBeGreaterThan(1);
});

test('worker threads show your messages as You and the supervisor messages as First mate, after a restart too', async ({ browser }) => {
  home.writeInbox('checkout-polish', 'Firstmate here: please rebase onto main before you push.', false);
  await row('checkout-polish').click();
  const steer = page.locator('.msg.out', { hasText: 'please rebase onto main' });
  await expect(steer).toHaveAttribute('data-from', 'firstmate');
  await expect(steer.locator('.avatar-firstmate')).toHaveCount(1);
  const mine = page.locator('.msg.out', { hasText: 'Keep it "simple"' });
  await expect(mine).toHaveAttribute('data-from', 'you');

  const again = await startServer({
    ...process.env,
    FM_HOME: home.home,
    CREW_CHAT_TERMINAL_LOG: terminalLog,
    CREW_CHAT_TMUX_SOCKET: sock,
    CREW_CHAT_UPLOAD_DIR: uploadDir,
    CREW_CHAT_LEDGER: ledgerFile,
    TMUX_TMPDIR: tmuxDir,
    TMUX: '',
  });
  try {
    const p = await browser.newPage();
    await p.goto(`${again.base}/#/t/checkout-polish`);
    await expect(p.locator('.msg.out', { hasText: 'Keep it "simple"' })).toHaveAttribute('data-from', 'you');
    await expect(p.locator('.msg.out', { hasText: 'please rebase onto main' })).toHaveAttribute('data-from', 'firstmate');
    await expect(p.locator('.msg.out', { hasText: 'When you are done, please also check iOS.' })).toHaveAttribute('data-from', 'firstmate');
    await expect(p.locator('.msg.out', { hasText: 'This is what I see on Android:' })).toHaveAttribute('data-from', 'you');
    await p.close();
  } finally {
    again.child.kill('SIGTERM');
  }
});

test('starring, the Unreads view, and the New line', async () => {
  await row('search-sort').click();
  await page.getByRole('button', { name: 'Star conversation' }).click();
  await expect(page.locator('[data-group="starred"] .thread-row[data-thread-id="search-sort"]')).toHaveCount(1);
  await expect(page.locator('[data-group="needs-you"] .thread-row[data-thread-id="search-sort"]')).toHaveCount(0);

  // An update lands in another thread while you read this one.
  home.appendStatus('checkout-polish', `working [at=${Math.floor(Date.now() / 1000)}]: unread update for the New line`);
  await expect(row('checkout-polish').locator('.unread')).toHaveText('1');
  await page.getByRole('button', { name: 'Unreads' }).click();
  const ids = () => page.locator('.thread-row:not(.pinned)').evaluateAll((els) => els.map((e) => e.getAttribute('data-thread-id')));
  await expect.poll(ids).toEqual(expect.arrayContaining(['checkout-polish', 'search-sort']));
  expect((await ids()).length).toBe(2);
  // The way back is always in view: All workers, or Home on the rail.
  await expect(page.getByRole('button', { name: /^All workers/ })).toHaveAttribute('aria-pressed', 'false');
  await page.locator('.rail').getByRole('button', { name: 'Home' }).click();
  await expect(page.getByRole('button', { name: /^All workers/ })).toHaveAttribute('aria-pressed', 'true');
  expect((await ids()).length).toBeGreaterThan(2);
  await page.locator('.rail').getByRole('button', { name: /Activity/ }).click();
  await expect(page.getByRole('button', { name: /^Unreads/ })).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: /^All workers/ }).click();
  expect((await ids()).length).toBeGreaterThan(2);

  await composer().fill('half-written thought');
  await row('checkout-polish').click();
  await expect(page.locator('.new-divider')).toHaveCount(1);
  const afterNew = page.locator('.new-divider + .msg');
  await expect(afterNew).toContainText('unread update for the New line');

  await row('search-sort').click();
  await expect(composer()).toHaveValue('half-written thought');
  await composer().fill('');
  await page.getByRole('button', { name: 'Unstar conversation' }).click();
  await expect(page.locator('[data-group="starred"]')).toHaveCount(0);
});

test('hovering a message offers Copy and Quote in reply', async () => {
  await row('checkout-polish').click();
  const msg = page.locator('.msg.in', { hasText: 'unread update for the New line' });
  await msg.hover();
  await expect(msg.getByRole('button', { name: 'Copy message' })).toBeVisible();
  await msg.getByRole('button', { name: 'Quote in reply' }).click();
  await expect(composer()).toHaveValue('> unread update for the New line\n');
  await composer().fill('');
});

test('the theme menu on the rail picks light or dark over the system setting, and remembers it', async ({ browser }) => {
  const p = await browser.newPage({ colorScheme: 'dark' });
  await p.goto(server.base);
  const bg = () => p.evaluate(() => getComputedStyle(document.body).backgroundColor);
  const pick = async (name: string) => {
    await p.locator('.rail').getByRole('button', { name: 'Theme' }).click();
    await p.getByRole('group', { name: 'Theme' }).getByRole('button', { name }).click();
    await expect(p.getByRole('group', { name: 'Theme' })).toHaveCount(0);
  };
  // One place for it: nothing in the sidebar.
  await expect(p.locator('.sidebar').getByRole('group', { name: 'Theme' })).toHaveCount(0);
  expect(await bg()).toBe('rgb(26, 29, 33)');
  await pick('Light');
  expect(await bg()).toBe('rgb(255, 255, 255)');
  await p.reload();
  expect(await bg()).toBe('rgb(255, 255, 255)');
  await p.locator('.rail').getByRole('button', { name: 'Theme' }).click();
  await expect(p.getByRole('group', { name: 'Theme' }).getByRole('button', { name: 'Light' })).toHaveAttribute('aria-pressed', 'true');
  await p.getByRole('group', { name: 'Theme' }).getByRole('button', { name: 'Auto' }).click();
  expect(await bg()).toBe('rgb(26, 29, 33)');
  await p.close();

  const q = await browser.newPage({ colorScheme: 'light' });
  await q.goto(server.base);
  await q.locator('.rail').getByRole('button', { name: 'Theme' }).click();
  await q.getByRole('group', { name: 'Theme' }).getByRole('button', { name: 'Dark' }).click();
  expect(await q.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe('rgb(26, 29, 33)');
  await q.close();
});

test('right-clicking a worker opens a menu of quick actions', async () => {
  await row('search-sort').click();
  await expect(page.locator('.channel-head')).toContainText('search-sort');

  // Right-click a row that is not open: mark it unread, then read again.
  const unreadBefore = await row('checkout-polish').locator('.unread').count();
  expect(unreadBefore).toBe(0);
  await row('checkout-polish').click({ button: 'right' });
  const menu = page.getByRole('menu', { name: 'Actions for checkout-polish' });
  await expect(menu).toBeVisible();
  await expect(menu.getByRole('menuitem')).toHaveText([
    'Open conversation',
    'Show terminal beside the chat',
    'Open terminal window',
    'Star',
    'Mark as unread',
    'Copy name',
    'Copy link to conversation',
    'Clean up...',
  ]);
  await expect(menu.getByRole('menuitem').first()).toBeFocused();
  await menu.getByRole('menuitem', { name: 'Mark as unread' }).click();
  await expect(menu).toHaveCount(0);
  await expect(row('checkout-polish').locator('.unread')).toHaveText('1');
  await row('checkout-polish').click({ button: 'right' });
  await menu.getByRole('menuitem', { name: 'Mark as read' }).click();
  await expect(row('checkout-polish').locator('.unread')).toHaveCount(0);

  // Escape and a click elsewhere both close it.
  await row('checkout-polish').click({ button: 'right' });
  await page.keyboard.press('ArrowDown');
  await expect(menu.getByRole('menuitem', { name: 'Show terminal beside the chat' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
  await row('checkout-polish').click({ button: 'right' });
  await page.locator('.messages').click({ position: { x: 5, y: 5 } });
  await expect(menu).toHaveCount(0);

  // Star from the menu, through the hover button this time.
  await row('search-sort').hover();
  await page.getByRole('button', { name: 'More actions for search-sort' }).click();
  const own = page.getByRole('menu', { name: 'Actions for search-sort' });
  await own.getByRole('menuitem', { name: 'Star', exact: true }).click();
  await expect(page.locator('[data-group="starred"] .thread-row[data-thread-id="search-sort"]')).toHaveCount(1);
  await row('search-sort').click({ button: 'right' });
  await own.getByRole('menuitem', { name: 'Unstar' }).click();
  await expect(page.locator('[data-group="starred"]')).toHaveCount(0);

  // Terminal beside the chat, for the thread that is already open.
  await expect(page.getByRole('tab', { name: 'Screen' })).toHaveCount(0);
  await row('search-sort').click({ button: 'right' });
  await own.getByRole('menuitem', { name: 'Show terminal beside the chat' }).click();
  await expect(page.getByRole('tab', { name: 'Screen' })).toBeVisible();
  await page.getByTestId('terminal-view').click();
  await expect(page.getByRole('tab', { name: 'Screen' })).toHaveCount(0);

  // Open terminal window runs the same launcher as the header button.
  const before = readFileSync(terminalLog, 'utf8').trim().split('\n').filter(Boolean).length;
  await row('search-sort').click({ button: 'right' });
  await own.getByRole('menuitem', { name: 'Open terminal window' }).click();
  await expect.poll(() => readFileSync(terminalLog, 'utf8').trim().split('\n').filter(Boolean).length).toBe(before + 1);

  // A finished thread offers removing it from the list instead of terminals.
  await row('invoice-export').click({ button: 'right' });
  const done = page.getByRole('menu', { name: 'Actions for invoice-export' });
  await expect(done.getByRole('menuitem', { name: 'Remove from the list' })).toBeVisible();
  await expect(done.getByRole('menuitem', { name: 'Open terminal window' })).toHaveCount(0);
  await page.keyboard.press('Escape');

  // A worker with no tmux session cannot open one, and says why.
  home.add({
    id: 'lost-session',
    title: 'A worker whose tmux session is gone',
    meta: { window: 'lost-session:fm-lost', kind: 'ship' },
    crewState: 'state: unknown · source: none · backend target gone: lost-session:fm-lost',
    status: [`working [at=${now - 50}]: started`],
  });
  await row('lost-session').click({ button: 'right' });
  const gone = page.getByRole('menu', { name: 'Actions for lost-session' });
  await expect(gone.getByRole('menuitem', { name: 'Open terminal window' })).toBeDisabled();
  await expect(gone.getByRole('menuitem', { name: 'Open terminal window' })).toHaveAttribute('title', 'The tmux session "lost-session" is not running.');

  // Clean up asks first, as from the header; Cancel runs nothing.
  const teardowns = home.teardownLog().length;
  await gone.getByRole('menuitem', { name: 'Clean up...' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('lost-session');
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  expect(home.teardownLog().length).toBe(teardowns);

  // Queued or requested work can be cancelled through First mate, and taken off the list.
  await row('request-note-005').click({ button: 'right' });
  const req = page.getByRole('menu', { name: 'Actions for request-note-005' });
  await expect(req.getByRole('menuitem', { name: 'Open terminal window' })).toHaveCount(0);
  await req.getByRole('menuitem', { name: 'Ask First mate to cancel...' }).click();
  const cancel = page.getByRole('dialog');
  await expect(cancel).toContainText('This asks First mate not to start a worker for this request.');
  await cancel.getByRole('button', { name: 'Keep it' }).click();
  await expect(cancel).toHaveCount(0);
  const notes = home.inboxLog().length;
  await row('request-note-005').click({ button: 'right' });
  await req.getByRole('menuitem', { name: 'Ask First mate to cancel...' }).click();
  await cancel.getByRole('textbox', { name: 'Reason' }).fill('no longer needed');
  await cancel.getByRole('button', { name: 'Ask First mate to cancel' }).click();
  await expect(cancel).toHaveCount(0);
  await expect.poll(() => home.inboxLog().length).toBe(notes + 1);
  expect(home.inboxLog().at(-1)!.at(-1)).toMatch(/^\[re: request-note-005\] Please cancel this request \(".+"\): do not start a worker for it\. Reason: no longer needed$/);
  // Removed rows stay out of sight unless "Show removed" is on, as it was left by an earlier test.
  const hiddenFlag = async () =>
    ((await (await page.request.get(`${server.base}/api/threads`)).json()) as { id: string; hidden?: boolean }[]).find((x) => x.id === 'request-note-005')?.hidden ?? false;
  await expect.poll(hiddenFlag).toBe(true);
  await expect(row('request-note-005')).toHaveClass(/hidden-row/);
  await row('request-note-005').click({ button: 'right' });
  await req.getByRole('menuitem', { name: 'Show in the list again' }).click();
  await expect.poll(hiddenFlag).toBe(false);
  await expect(row('request-note-005')).not.toHaveClass(/hidden-row/);
});

test('Claude plan usage from a worker status bar shows small under the token total', async () => {
  tm('send-keys', '-t', 'crewtest:fm-search-sort', "clear; printf 'Opus | 5h:85%% (resets in 1h5m) 7d:42%% (resets in 2d3h)\\n'", 'Enter');
  await expect.poll(() => tm('capture-pane', '-p', '-t', 'crewtest:fm-search-sort')).toContain('resets in 2d3h');
  await page.reload();
  const usage = page.getByTestId('plan-usage');
  await expect(usage).toContainText('5h');
  await expect(usage).toContainText('85%');
  await expect(usage.locator('.meter').first()).toContainText(/resets \d{1,2}:\d{2}/);
  await expect(usage.locator('.meter').last()).toContainText(/resets [A-Z][a-z]{2} \d{1,2}:\d{2}/);
  await expect(usage).toHaveAttribute('title', /5-hour window: 85% used, resets .+ \(in 1h [45]m\)/);
  await expect(usage).toHaveAttribute('title', /7-day window: 42% used, resets .+ \(in 2d 3h\)/);
  await expect(usage).toContainText('7d');
  await expect(usage).toContainText('42%');
  await expect(usage.locator('.meter[data-level="high"]')).toHaveCount(1);
  await expect(usage).toHaveAttribute('title', /^Claude plan usage, from [a-z-]+'s status bar/);
});

test("a First mate reply that asks for a typed approval copies the words and opens First mate's terminal", async ({ browser }) => {
  // First mate's real reply, word for word.
  const replyText =
    'I checked before retrying: nothing has changed yet (the Jira permission file does not exist in the firstmate folder), so a retry would be refused exactly as before, and I promised not to keep retrying blocked calls. Fastest path: press "Copy and open First mate\'s terminal" on my earlier reply and send "go on phase 1" there, and I start it within a minute. Or paste the one-line settings command in that terminal so requests from here work in future (from my next session).';
  home.writeNote('note-approve', 'Is phase 1 ready to go?', true, replyText);
  const ctx = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'], colorScheme: 'light' });
  const p = await ctx.newPage();
  try {
    await p.goto(`${server.base}/#/firstmate`);
    const reply = p.locator('[data-reply-to="note-approve"]');
    const handoff = reply.getByTestId('handoff');
    const button = handoff.getByRole('button', { name: "Copy go on phase 1 and open First mate's terminal" });
    await expect(button).toBeVisible();
    // Something else is already on the clipboard, as when the reply itself was copied earlier.
    await p.evaluate((t) => navigator.clipboard.writeText(t), replyText);
    const before = readFileSync(terminalLog, 'utf8').trim().split('\n').filter(Boolean).length;
    await button.click();
    await expect(handoff.getByRole('status')).toHaveText(`Copied "go on phase 1". Opened First mate's terminal: paste it there and press Enter.`);
    expect(await p.evaluate(() => navigator.clipboard.readText())).toBe('go on phase 1');
    await expect.poll(() => readFileSync(terminalLog, 'utf8').trim().split('\n').filter(Boolean).length).toBe(before + 1);
    const command = JSON.parse(readFileSync(terminalLog, 'utf8').trim().split('\n').at(-1)!) as string;
    expect(command).toContain(`'new-session' '-t' '=crewtest' '-s' 'crewchat-firstmate-`);
    expect(command).toMatch(/'select-window' '-t' '=crewchat-firstmate-[0-9a-f]{6}:2'/);
    // Nothing is typed into First mate's terminal.
    expect(command).not.toContain('send-keys');
    await expect(p.locator('.msg', { hasText: 'Is phase 1 ready to go?' }).getByTestId('handoff')).toHaveCount(0);

    // The First mate chat shows its terminal read-only beside the messages.
    await p.getByTestId('terminal-view').click();
    await p.getByRole('tab', { name: 'Screen' }).click();
    await expect(p.getByTestId('pane-body')).toContainText('first-mate-screen-ok');
    await p.getByRole('tab', { name: 'Transcript' }).click();
    await expect(p.getByTestId('pane-reason')).toContainText("No Claude transcript was found for First mate's folder.");
    await p.getByTestId('terminal-view').click();

    // When that window holds only a shell, First mate runs in some other app:
    // the button only copies, and nothing is opened.
    tm('respawn-pane', '-k', '-t', 'crewtest:2', 'sh');
    await p.reload();
    const copyOnly = p.locator('[data-reply-to="note-approve"]').getByTestId('handoff');
    await expect(copyOnly.getByRole('button', { name: 'Copy go on phase 1', exact: true })).toBeVisible();
    await expect(copyOnly).toContainText("then paste it in First mate's terminal");
    await p.evaluate(() => navigator.clipboard.writeText('something else'));
    const opened = readFileSync(terminalLog, 'utf8').trim().split('\n').filter(Boolean).length;
    await copyOnly.getByRole('button', { name: 'Copy go on phase 1', exact: true }).click();
    await expect(copyOnly.getByRole('status')).toHaveText(`Copied "go on phase 1". Paste it in First mate's terminal and press Enter.`);
    expect(await p.evaluate(() => navigator.clipboard.readText())).toBe('go on phase 1');
    expect(readFileSync(terminalLog, 'utf8').trim().split('\n').filter(Boolean).length).toBe(opened);
    await p.getByTestId('terminal-view').click();
    await p.getByRole('tab', { name: 'Screen' }).click();
    await expect(p.getByTestId('pane-reason')).toContainText(/is running (ba)?sh, not First mate/);
  } finally {
    await ctx.close();
  }
});

test('the Usage page compares token use across workers and First mate', async () => {
  await page.getByTestId('token-total').click();
  await expect(page).toHaveURL(/#\/usage$/);
  const usage = page.getByTestId('usage-page');
  await expect(usage.locator('table')).toBeVisible();
  await expect(usage.locator('tr[data-row="search-sort"]')).toBeVisible();
  await expect(usage.locator('tr[data-row="firstmate"]')).toContainText('First mate');
  await expect(usage).toContainText('Cache reads');
  await page.goto(`${server.base}/#/t/search-sort`);
});

test('a decision with open questions lays them out one by one and sends them as one answer', async () => {
  home.writeData(
    'triage-plan',
    'report.md',
    [
      '# Triage bot plan',
      '',
      '## Open questions for the captain',
      '',
      '1. **Who can see the board?** Only you, or the whole team? (I recommend the whole team.)',
      '2. **History depth:** the last 12 months (recommended) or back to 2022?',
      '3. **Slack replies:** should the bot post "ticket created: <link>" in the thread, or stay silent as proposed?',
      '',
      '## Verified vs inferred',
      '',
      '1. not a question',
      '',
    ].join('\n'),
  );
  home.add({
    id: 'triage-plan',
    title: 'Plan: feedback triage bot',
    meta: { window: 'crewtest:fm-triage-plan', kind: 'plan', harness: 'claude' },
    crewState: 'state: parked · source: status-log · needs-decision open: plan-ok',
    status: [`needs-decision [key=plan-ok] [at=${now - 30}]: plan is in data/triage-plan/report.md. Captain still owes plan approval + 3 open questions`],
  });
  await row('triage-plan').click();
  const form = page.getByTestId('question-form');
  await expect(form).toContainText('3 questions to answer');
  await expect(form).toContainText('Open questions for the captain');
  await expect(form.getByTestId('question')).toHaveCount(3);
  await expect(form.getByTestId('question').nth(2)).toContainText('ticket created: <link>');
  await expect(form.getByRole('button', { name: /Send answers/ })).toBeDisabled();

  await form.getByRole('radio', { name: 'Approved', exact: true }).click();
  await form.getByRole('button', { name: /Suggested the whole team/ }).click();
  await expect(form.getByRole('textbox', { name: 'Answer to question 1' })).toHaveValue('the whole team');
  await form.getByRole('textbox', { name: 'Answer to question 3' }).fill('Reply once with the Jira link');
  await expect(form).toContainText('2 of 3 answered');
  await form.getByRole('button', { name: 'Preview' }).click();
  await expect(form.getByTestId('answer-preview')).toContainText('Not answered yet: 2.');
  const dismiss = page.getByRole('button', { name: 'Dismiss' });
  while ((await dismiss.count()) > 0) await dismiss.first().click();
  await form.evaluate((el) => el.scrollIntoView({ block: 'start' }));
  await page.screenshot({ path: path.join(SHOTS, 'decision-questions.png') });

  // A quick double click still sends once.
  const sends = home.sendLog().length;
  await form.getByRole('button', { name: 'Send answers' }).dblclick();
  await expect.poll(() => home.sendLog().length).toBe(sends + 1);
  await expect.poll(() => home.sendLog().at(-1)).toEqual([
    'triage-plan',
    '--resolve-key',
    'plan-ok',
    [
      'Plan: Approved.',
      '',
      'Answers to the open questions in report.md:',
      '1. Who can see the board? the whole team',
      '3. Slack replies: Reply once with the Jira link',
      'Not answered yet: 2.',
    ].join('\n'),
  ]);
  await expect(page.locator('#item-s0')).toHaveAttribute('data-decision', 'resolved');
  await expect(page.locator('#item-s0 .resolution')).toContainText('answered: Plan: Approved. Answers to the open questions in report.md: 1. Who can see the board? the whole team 3.');
  await expect(page.getByTestId('question-form')).toHaveCount(0);

  // A follow-up that names the one question still open, packed into one long line.
  home.appendStatus(
    'triage-plan',
    `needs-decision [key=plan-q2] [at=${now - 5}]: answers applied to report.md (whole team can see it; replies once with the link; approved as planned). Spike in a routine: db PASS, docx PASS, voice clips blocked. Only open call: Q2 history depth, which gates the first pull only.`,
  );
  const latest = page.locator('[data-decision="open"]');
  await expect(latest.getByTestId('decision-text').locator('li')).toHaveText([
    'whole team can see it',
    'replies once with the link',
    'approved as planned',
    'db PASS',
    'docx PASS',
    'voice clips blocked',
  ]);
  await expect(latest.getByTestId('question')).toHaveCount(1);
  await expect(latest.getByTestId('question')).toContainText('History depth');
});

test('a home with no workers shows an empty state', async ({ browser }) => {
  const empty = new FakeHome('crewchat-e2e-empty-');
  const log = path.join(empty.home, 'terminal.log');
  const s = await startServer({ ...process.env, FM_HOME: empty.home, CREW_CHAT_TERMINAL_LOG: log, CREW_CHAT_TMUX_SOCKET: sock, CREW_CHAT_UPLOAD_DIR: uploadDir, TMUX_TMPDIR: tmuxDir, TMUX: '' });
  try {
    const p = await browser.newPage();
    await p.goto(s.base);
    await expect(p.locator('.sidebar')).toContainText('No workers right now');
    await expect(p.locator('.thread')).toContainText('There are no live workers in this Firstmate home.');
    await p.close();
  } finally {
    s.child.kill('SIGTERM');
    empty.cleanup();
  }
});
