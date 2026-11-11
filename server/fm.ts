import { execFile } from 'node:child_process';
import path from 'node:path';
import type { CleanupResult, NoteResult, WriteResult } from '../shared/types.ts';

export interface RunResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  error?: string;
}

export function run(
  file: string,
  args: string[],
  opts: { env?: NodeJS.ProcessEnv; timeoutMs?: number; cwd?: string } = {},
): Promise<RunResult> {
  const timeout = opts.timeoutMs ?? 30_000;
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      { env: opts.env ?? process.env, cwd: opts.cwd, timeout, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (!err) {
          resolve({ exitCode: 0, stdout, stderr });
          return;
        }
        const e = err as NodeJS.ErrnoException & { code?: number | string; killed?: boolean };
        const exitCode = typeof e.code === 'number' ? e.code : null;
        let error: string | undefined;
        if (e.killed) error = `timed out after ${timeout / 1000}s`;
        else if (exitCode === null) error = e.message;
        resolve({ exitCode, stdout, stderr, error });
      },
    );
  });
}

function fmEnv(home: string): NodeJS.ProcessEnv {
  return { ...process.env, FM_HOME: home };
}

export function crewState(home: string, id: string): Promise<RunResult> {
  return run(path.join(home, 'bin', 'fm-crew-state.sh'), [id], { env: fmEnv(home), cwd: home, timeoutMs: 30_000 });
}

export function taskList(home: string): Promise<RunResult> {
  return run(
    path.join(home, 'bin', 'fm-tasks-axi.sh'),
    ['list', '--fields', 'created,closed,held,hold_kind,hold_reason,blocked,blocked_by,links', '--limit', '500'],
    { env: fmEnv(home), cwd: home, timeoutMs: 15_000 },
  );
}

export function taskShow(home: string, id: string): Promise<RunResult> {
  return run(path.join(home, 'bin', 'fm-tasks-axi.sh'), ['show', id, '--full'], {
    env: fmEnv(home),
    cwd: home,
    timeoutMs: 15_000,
  });
}

// fm-send.sh has no `--` terminator and reads a leading --resolve-key,
// --fire-and-forget, or --key as its own flag, so such text would not arrive
// as the message.
export function validateText(text: unknown): string | null {
  if (typeof text !== 'string' || text.trim() === '') return 'Type a message first.';
  if (text.startsWith('-')) {
    return 'A message cannot start with "-" because the send script would read it as an option. Add a word or a space in front.';
  }
  return null;
}

export function sendArgs(id: string, text: string, resolveKey?: string): string[] {
  return resolveKey === undefined ? [id, text] : [id, '--resolve-key', resolveKey, text];
}

export async function send(home: string, id: string, text: string, resolveKey?: string): Promise<WriteResult> {
  const r = await run(path.join(home, 'bin', 'fm-send.sh'), sendArgs(id, text, resolveKey), {
    env: fmEnv(home),
    cwd: home,
    timeoutMs: 60_000,
  });
  const outcome = r.exitCode === 0 ? 'sent' : r.exitCode === 3 ? 'unconfirmed' : 'refused';
  return { ok: r.exitCode === 0, outcome, exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr, error: r.error };
}

export function teardownArgs(id: string, force: boolean): string[] {
  return force ? [id, '--force'] : [id];
}

export async function teardown(home: string, id: string, force: boolean): Promise<CleanupResult> {
  const r = await run(path.join(home, 'bin', 'fm-teardown.sh'), teardownArgs(id, force), {
    env: fmEnv(home),
    cwd: home,
    timeoutMs: 10 * 60_000,
  });
  const outcome =
    r.exitCode === 0 ? 'cleaned' : r.exitCode === 4 ? 'cleaned-with-warning' : r.exitCode === 1 ? 'refused' : 'error';
  return { outcome, exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr, error: r.error };
}

export function noteArgs(text: string, requestId: string): string[] {
  return ['note', '--request-id', requestId, '--json', '--', text];
}

export async function sendNote(home: string, text: string, requestId: string): Promise<NoteResult> {
  const r = await run(path.join(home, 'bin', 'fm-inbox.sh'), noteArgs(text, requestId), {
    env: fmEnv(home),
    cwd: home,
    timeoutMs: 60_000,
  });
  let noteId: string | null = null;
  try {
    const parsed = JSON.parse(r.stdout.trim().split('\n').pop() ?? '') as { id?: unknown };
    if (typeof parsed.id === 'string') noteId = parsed.id;
  } catch {
    // Not JSON: the exit status and stderr still say what happened.
  }
  const outcome = r.exitCode === 0 ? 'sent' : r.exitCode === 3 ? 'pending' : 'refused';
  return { outcome, exitCode: r.exitCode, noteId, stdout: r.stdout, stderr: r.stderr, error: r.error };
}

export function receipts(home: string): Promise<RunResult> {
  return run(path.join(home, 'bin', 'fm-inbox.sh'), ['receipts', '--all-pending', '--all-handled', '--all-replies'], {
    env: fmEnv(home),
    cwd: home,
    timeoutMs: 30_000,
  });
}
