// tmux safety: every tmux process here runs against a private server socket
// in a temp dir, with TMUX removed and TMUX_TMPDIR redirected, so nothing can
// reach the default server even if a socket argument were forgotten.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  appleScriptString,
  availability,
  capturePane,
  findOnPath,
  groupedSessionName,
  parseWindow,
  shellCommand,
  shq,
  socketArgsFrom,
  terminalAppleScript,
  tmuxCommandArgs,
} from '../../server/terminal.ts';

const tmuxBin = findOnPath('tmux');
const hasOsascript = process.platform === 'darwin' && findOnPath('osascript') !== null;

describe('command building', () => {
  it('splits a window record into session and window', () => {
    expect(parseWindow('firstmate-0:fm-search')).toEqual({ session: 'firstmate-0', window: 'fm-search' });
    expect(parseWindow('firstmate')).toBeNull();
    expect(parseWindow(undefined)).toBeNull();
  });

  it('reads the socket setting', () => {
    expect(socketArgsFrom(undefined)).toEqual([]);
    expect(socketArgsFrom('crewchat-test')).toEqual(['-L', 'crewchat-test']);
    expect(socketArgsFrom('/tmp/x/sock')).toEqual(['-S', '/tmp/x/sock']);
  });

  it('names an explicit target on every tmux command', () => {
    const args = tmuxCommandArgs({ session: 'firstmate-0', window: 'fm-search' }, 'crewchat-search-abc123', []);
    const commands: string[][] = [[]];
    for (const a of args) {
      if (a === ';') commands.push([]);
      else commands[commands.length - 1].push(a);
    }
    expect(commands).toEqual([
      ['new-session', '-t', '=firstmate-0', '-s', 'crewchat-search-abc123'],
      ['select-window', '-t', '=crewchat-search-abc123:=fm-search'],
      ['set-option', '-t', 'crewchat-search-abc123:', 'destroy-unattached', 'on'],
    ]);
  });

  it('makes grouped session names tmux accepts', () => {
    expect(groupedSessionName('a.b:c')).toMatch(/^crewchat-a-b-c-[0-9a-f]{6}$/);
  });

  it('quotes for the shell', () => {
    expect(shq(`it's`)).toBe(`'it'\\''s'`);
    const cmd = shellCommand({ bin: '/opt/tmux', socketArgs: [] }, { session: 's', window: 'w' }, 'g');
    expect(cmd).toBe(`unset TMUX; '/opt/tmux' 'new-session' '-t' '=s' '-s' 'g' \\; 'select-window' '-t' '=g:=w' \\; 'set-option' '-t' 'g:' 'destroy-unattached' 'on'`);
  });

  it.skipIf(!hasOsascript)('escapes the command so AppleScript hands it to Terminal unchanged', () => {
    const cmd = shellCommand({ bin: '/opt/homebrew/bin/tmux', socketArgs: [] }, { session: `we"ird\\s`, window: `w'n` }, 'g');
    // `return` evaluates the same string literal Terminal's `do script` would get, without opening anything.
    const echoed = execFileSync('osascript', ['-e', `return ${appleScriptString(cmd)}`], { encoding: 'utf8' }).replace(/\n$/, '');
    expect(echoed).toBe(cmd);
    expect(terminalAppleScript(cmd)).toContain(`do script ${appleScriptString(cmd)}`);
  });
});

describe('availability', () => {
  it('disables non-tmux backends and missing windows with a reason', async () => {
    const tmux = { bin: '/bin/false', socketArgs: ['-L', 'unused'] };
    expect(await availability(tmux, { backend: 'orca', window: 's:w' })).toEqual({
      available: false,
      reason: 'Runs on orca, not tmux, so there is no terminal to open here.',
    });
    expect((await availability(tmux, {})).reason).toBe('No tmux window is recorded for this worker.');
    expect((await availability(null, { window: 's:w' })).reason).toBe('tmux is not installed or not on PATH.');
  });
});

describe.skipIf(!tmuxBin)('on a private tmux server', () => {
  let dir: string;
  let sock: string;
  let env: NodeJS.ProcessEnv;
  const created = ['firstmate-0', 'firstmate', 'outer'];

  const tm = (...args: string[]) => {
    if (!sock) throw new Error('private socket not set');
    return execFileSync(tmuxBin!, ['-S', sock, ...args], { env, encoding: 'utf8' }).trim();
  };
  const tmOk = (...args: string[]) => {
    try {
      tm(...args);
      return true;
    } catch {
      return false;
    }
  };
  const sessions = () => tm('list-sessions', '-F', '#{session_name}|#{session_group}|#{window_name}').split('\n');
  const waitFor = async (pred: () => boolean, ms = 5000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (pred()) return true;
      await new Promise((r) => setTimeout(r, 100));
    }
    return pred();
  };

  beforeAll(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'crewchat-tmux-'));
    sock = path.join(dir, 'sock');
    env = { ...process.env, TMUX_TMPDIR: dir };
    delete env.TMUX;
    delete env.TMUX_PANE;
    tm('new-session', '-d', '-s', 'firstmate-0', '-n', 'fm-a', '-x', '100', '-y', '30');
    tm('new-window', '-d', '-t', 'firstmate-0:', '-n', 'fm-b');
    tm('new-session', '-d', '-s', 'firstmate', '-n', 'other');
  });

  afterAll(() => {
    if (!sock) return;
    for (const s of tm('list-sessions', '-F', '#{session_name}').split('\n')) {
      if (created.includes(s) || s.startsWith('crewchat-')) tmOk('kill-session', '-t', `=${s}`);
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it('reports a running session as available and a missing one with a reason', async () => {
    const tmux = { bin: tmuxBin!, socketArgs: ['-S', sock] };
    const prevTmux = process.env.TMUX;
    expect(await availability(tmux, { window: 'firstmate-0:fm-b' })).toEqual({ available: true });
    expect(await availability(tmux, { window: 'firstmate-:fm-b' })).toEqual({
      available: false,
      reason: 'The tmux session "firstmate-" is not running.',
    });
    expect(await availability(tmux, { window: 'firstmate-0:fm-gone' })).toEqual({
      available: false,
      reason: 'The worker\'s tmux window "fm-gone" no longer exists.',
    });
    expect(process.env.TMUX).toBe(prevTmux);
  });

  it('captures the worker window with its colours, and reports a missing window', async () => {
    const tmux = { bin: tmuxBin!, socketArgs: ['-S', sock] };
    tm('send-keys', '-t', 'firstmate-0:fm-b', "printf '\\033[31mcrewchat-red\\033[0m done\\n'", 'Enter');
    let text = '';
    for (let i = 0; i < 30 && !text.includes('crewchat-red\x1b'); i++) {
      text = (await capturePane(tmux, { session: 'firstmate-0', window: 'fm-b' })).text;
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(text).toMatch(/\x1b\[31mcrewchat-red\x1b\[39m done/);
    const gone = await capturePane(tmux, { session: 'firstmate-0', window: 'fm-gone' });
    expect(gone.ok).toBe(false);
    expect(gone.error).toContain('fm-gone');
  });

  it('opens a grouped session on the worker window without disturbing the original', async () => {
    const grouped = groupedSessionName('search');
    const cmd = shellCommand({ bin: tmuxBin!, socketArgs: ['-S', sock] }, { session: 'firstmate-0', window: 'fm-b' }, grouped);
    // A tmux client needs a terminal, so run the exact command inside a pane
    // of the same private server, as Terminal.app would run it.
    tm('new-session', '-d', '-s', 'outer', '-x', '120', '-y', '40', `${cmd}; sleep 60`);
    expect(await waitFor(() => sessions().some((s) => s.startsWith(`${grouped}|`)))).toBe(true);

    const row = sessions().find((s) => s.startsWith(`${grouped}|`))!;
    expect(row).toBe(`${grouped}|firstmate-0|fm-b`);
    expect(sessions()).toContain('firstmate-0|firstmate-0|fm-a');
    expect(sessions()).toContain('firstmate||other');
    expect(tm('display-message', '-p', '-t', `${grouped}:`, '#{destroy-unattached}')).toBe('on');
    expect(tm('display-message', '-p', '-t', 'firstmate-0:', '#{destroy-unattached}')).toBe('off');
    expect(tm('display-message', '-p', '-t', 'firstmate:', '#{destroy-unattached}')).toBe('off');

    tm('kill-session', '-t', '=outer');
    expect(await waitFor(() => !sessions().some((s) => s.startsWith(`${grouped}|`)))).toBe(true);
    expect(sessions().map((s) => s.split('|')[0]).sort()).toEqual(['firstmate', 'firstmate-0']);
  });
});
