import { randomBytes } from 'node:crypto';
import { accessSync, constants } from 'node:fs';
import path from 'node:path';
import type { TerminalAvailability } from '../shared/types.ts';
import { run } from './fm.ts';

export interface TmuxConfig {
  // Absolute path of the tmux binary, so the Terminal.app shell's PATH does
  // not matter.
  bin: string;
  // Extra socket arguments (-L name or -S path) placed before every tmux
  // subcommand; empty means the default server.
  socketArgs: string[];
}

export function socketArgsFrom(spec: string | undefined): string[] {
  if (!spec) return [];
  return spec.includes('/') ? ['-S', spec] : ['-L', spec];
}

export function findOnPath(name: string, pathEnv = process.env.PATH ?? ''): string | null {
  for (const dir of pathEnv.split(':')) {
    if (!dir) continue;
    const candidate = path.join(dir, name);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // keep looking
    }
  }
  return null;
}

export interface TmuxTarget {
  session: string;
  window: string;
}

export function parseWindow(value: string | undefined): TmuxTarget | null {
  if (!value) return null;
  const colon = value.indexOf(':');
  if (colon <= 0 || colon === value.length - 1) return null;
  return { session: value.slice(0, colon), window: value.slice(colon + 1) };
}

export function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export function groupedSessionName(id: string): string {
  const safe = id.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 40);
  return `crewchat-${safe}-${randomBytes(3).toString('hex')}`;
}

// One tmux client invocation: attach a new session grouped with the worker's
// session (so other clients keep their current window), select the worker's
// window in that new session only, and mark only the new session to be
// destroyed once this client goes away. Every command names its target.
export function tmuxCommandArgs(target: TmuxTarget, grouped: string, socketArgs: string[]): string[] {
  return [
    ...socketArgs,
    'new-session', '-t', `=${target.session}`, '-s', grouped,
    ';', 'select-window', '-t', `=${grouped}:=${target.window}`,
    ';', 'set-option', '-t', `${grouped}:`, 'destroy-unattached', 'on',
  ];
}

// TMUX is unset first so a shell that already sits inside tmux still attaches
// instead of refusing to nest.
export function shellCommand(tmux: TmuxConfig, target: TmuxTarget, grouped: string): string {
  const tmuxCall = [tmux.bin, ...tmuxCommandArgs(target, grouped, tmux.socketArgs)]
    .map((a) => (a === ';' ? '\\;' : shq(a)))
    .join(' ');
  return `unset TMUX; ${tmuxCall}`;
}

export function appleScriptString(s: string): string {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

export function terminalAppleScript(command: string): string {
  return `tell application "Terminal"\nactivate\ndo script ${appleScriptString(command)}\nend tell`;
}

// Window names in the worker's session, or null when the session is gone.
export async function sessionWindows(tmux: TmuxConfig, session: string): Promise<string[] | null> {
  const r = await run(tmux.bin, [...tmux.socketArgs, 'list-windows', '-t', `=${session}:`, '-F', '#{window_name}'], {
    timeoutMs: 5_000,
  });
  return r.exitCode === 0 ? r.stdout.split('\n').filter(Boolean) : null;
}

export async function availability(
  tmux: TmuxConfig | null,
  meta: Record<string, string>,
  canLaunch = true,
): Promise<TerminalAvailability> {
  const backend = meta.backend || 'tmux';
  if (backend !== 'tmux') {
    return { available: false, reason: `Runs on ${backend}, not tmux, so there is no terminal to open here.` };
  }
  const target = parseWindow(meta.window);
  if (!target) return { available: false, reason: 'No tmux window is recorded for this worker.' };
  if (!tmux) return { available: false, reason: 'tmux is not installed or not on PATH.' };
  if (!canLaunch) {
    return { available: false, reason: 'No terminal app to open it in. Set CREW_CHAT_TERMINAL_CMD, for example "gnome-terminal -- sh -c {cmd}".' };
  }
  const windows = await sessionWindows(tmux, target.session);
  if (windows === null) return { available: false, reason: `The tmux session "${target.session}" is not running.` };
  if (!windows.includes(target.window)) {
    return { available: false, reason: `The worker's tmux window "${target.window}" no longer exists.` };
  }
  return { available: true };
}

// A read-only copy of what the worker's tmux window shows right now, with
// its colours, and the recent scrollback above it.
export async function capturePane(
  tmux: TmuxConfig,
  target: TmuxTarget,
  lines = 400,
): Promise<{ ok: boolean; text: string; error?: string }> {
  const r = await run(
    tmux.bin,
    [...tmux.socketArgs, 'capture-pane', '-p', '-J', '-e', '-t', `=${target.session}:=${target.window}`, '-S', `-${lines}`],
    { timeoutMs: 5_000 },
  );
  if (r.exitCode !== 0) return { ok: false, text: '', error: (r.stderr || r.error || 'capture failed').trim() };
  return { ok: true, text: r.stdout.replace(/\n+$/, '\n') };
}

// Opens a new terminal window running a shell command.
export type Launcher = (command: string) => Promise<{ exitCode: number | null; stderr: string; error?: string }>;

// CREW_CHAT_TERMINAL_CMD, when set, is an argument list with a {cmd}
// placeholder, for example "gnome-terminal -- sh -c {cmd}" or
// "kitty sh -c {cmd}"; {cmd} becomes one argument. Otherwise macOS uses
// Terminal.app and Linux uses x-terminal-emulator when it exists.
export function pickLauncher(template: string | undefined, platform = process.platform, pathEnv = process.env.PATH): Launcher | null {
  if (template && template.trim()) {
    const parts = template.trim().split(/\s+/);
    if (!parts.includes('{cmd}')) return null;
    return (command) => {
      const argv = parts.map((p) => (p === '{cmd}' ? command : p));
      return run(argv[0], argv.slice(1), { timeoutMs: 15_000 });
    };
  }
  if (platform === 'darwin') return (command) => run('osascript', ['-e', terminalAppleScript(command)], { timeoutMs: 15_000 });
  if (findOnPath('x-terminal-emulator', pathEnv)) return (command) => run('x-terminal-emulator', ['-e', 'sh', '-c', command], { timeoutMs: 15_000 });
  return null;
}
