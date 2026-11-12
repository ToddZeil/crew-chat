import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { StartWorkerResult } from '../shared/types.ts';
import { run, validateText, type RunResult } from './fm.ts';

// A worker started from here works on a local branch that Firstmate merges
// later (no push, no PR). Tool approvals stay on, so nothing is approved
// unless someone is watching its terminal.
export const DIRECT_MODE = 'local-only';
export const DIRECT_YOLO = 'off';
export const DIRECT_MODELS = ['auto', 'haiku', 'sonnet', 'opus'];
export const DIRECT_EFFORTS = ['auto', 'low', 'medium', 'high', 'xhigh', 'max'];

const FIRSTMATE_SPEC =
  "None beyond the captain's intent above: this task was started directly from crew-chat with no First mate intake, so work from that ask alone.";

export interface DirectStart {
  project: string;
  text: string;
  model: string;
  effort: string;
}

interface DispatchRecord {
  status?: string;
  profile?: { harness?: string; model?: string; effort?: string } | null;
}

// The task id names the backlog row, the brief folder, and the worker's state files.
export function directTaskId(now: number = Date.now()): string {
  return `direct-${now.toString(36)}`;
}

// The first line of the ask, cut short; it is the thread's title.
export function directTitle(text: string): string {
  const line = text.split('\n')[0].trim();
  return line.length > 90 ? `${line.slice(0, 87)}...` : line;
}

// Fills both placeholders in one pass, so a placeholder typed into the ask is
// never filled a second time.
export function fillBrief(brief: string, text: string): string {
  return brief.replace(/\{TASK\}|\{FIRSTMATE_SPEC\}/g, (m) => (m === '{TASK}' ? text : FIRSTMATE_SPEC));
}

function explicitFlags(model: string, effort: string): string[] {
  const out: string[] = [];
  if (model !== 'auto') out.push('--model', model);
  if (effort !== 'auto') out.push('--effort', effort);
  return out;
}

function profileFlags(profile: DispatchRecord['profile']): string[] {
  const out: string[] = [];
  if (profile?.harness) out.push('--harness', profile.harness);
  if (profile?.model) out.push('--model', profile.model);
  if (profile?.effort) out.push('--effort', profile.effort);
  return out;
}

function readDispatchRecord(file: string): DispatchRecord | null {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as DispatchRecord;
  } catch {
    return null;
  }
}

function callFm(home: string, name: string, args: string[], timeoutMs: number): Promise<RunResult> {
  return run(path.join(home, 'bin', name), args, { env: { ...process.env, FM_HOME: home }, cwd: home, timeoutMs });
}

// Starts a worker through Firstmate's own scripts, in the order fm-spawn.sh
// needs them: file the task as Queued, scaffold and fill its brief, settle the
// dispatch profile, then spawn. Firstmate's spawn moves the task to In flight
// and writes state/<id>.meta, which is how the worker appears as a thread.
export async function startDirect(home: string, input: DirectStart, now: number = Date.now()): Promise<StartWorkerResult> {
  const { project } = input;
  const text = input.text.trim();
  const refused = (error: string, id: string | null = null, r?: RunResult): StartWorkerResult => ({
    ok: false,
    outcome: 'refused',
    id,
    exitCode: r?.exitCode ?? null,
    stdout: r?.stdout ?? '',
    stderr: r?.stderr ?? '',
    error: r?.error ? `${error} (${r.error})` : error,
  });

  const bad = validateText(text);
  if (bad) return refused(bad);

  const projectDir = path.join(home, 'projects', project);
  if (!existsSync(projectDir)) {
    return refused(`projects/${project} is not cloned in this Firstmate home, so there is nowhere to start the worker.`);
  }

  const id = directTaskId(now);
  const dataDir = path.join(home, 'data', id);

  const filed = await callFm(home, 'fm-tasks-axi.sh', ['add', id, directTitle(text), '--kind', 'ship', '--repo', project, '--queue'], 30_000);
  if (filed.exitCode !== 0) return refused('Filing the task in the backlog failed.', null, filed);

  const scaffold = await callFm(home, 'fm-brief.sh', [id, project, '--mode', DIRECT_MODE], 30_000);
  if (scaffold.exitCode !== 0) {
    return refused(`Writing the brief failed. The task ${id} is still filed in the backlog as Queued.`, id, scaffold);
  }
  const briefPath = path.join(dataDir, 'brief.md');
  try {
    writeFileSync(briefPath, fillBrief(readFileSync(briefPath, 'utf8'), text));
  } catch (err) {
    return refused(`Could not fill in ${briefPath}: ${(err as Error).message}. The task ${id} is still filed as Queued.`, id);
  }

  let flags = explicitFlags(input.model, input.effort);
  if (existsSync(path.join(home, 'config', 'crew-dispatch.json'))) {
    // Firstmate's dispatch rules pick the profile unless a model or effort was
    // chosen here, which is then the captain's own call.
    if (flags.length > 0) {
      flags = [...flags, '--dispatch-override', 'model and effort chosen in crew-chat'];
    } else {
      const resolved = await callFm(home, 'fm-dispatch-resolve.sh', [briefPath, '--project', project], 120_000);
      const record = readDispatchRecord(path.join(dataDir, 'dispatch-resolution.json'));
      if (record?.status !== 'clear') {
        return refused(
          `Firstmate's dispatch rules did not pick a profile for ${id} (${record?.status ?? 'no result'}), and no model or effort was chosen. Choose one, or start it through First mate.`,
          id,
          resolved,
        );
      }
      flags = profileFlags(record.profile);
    }
  }

  const spawn = await callFm(home, 'fm-spawn.sh', [id, projectDir, '--mode', DIRECT_MODE, '--yolo', DIRECT_YOLO, ...flags], 5 * 60_000);
  if (spawn.exitCode !== 0) {
    return refused(`The worker did not start. The task ${id} stays filed as Queued in the backlog.`, id, spawn);
  }
  return { ok: true, outcome: 'sent', id, exitCode: 0, stdout: spawn.stdout, stderr: spawn.stderr };
}
