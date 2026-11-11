// A throwaway Firstmate home for tests. Its bin/ scripts are stubs: fm-send.sh
// records its argv (NUL-separated, so quotes, $ and newlines survive intact)
// and imitates the real script's visible effects on this fake state only.
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SEND_STUB = `#!/usr/bin/env bash
set -euo pipefail
[ -f "$FM_HOME/.fake-home" ] || { echo "stub refuses: FM_HOME is not a fake home" >&2; exit 90; }
log="$FM_HOME/send-log"
mkdir -p "$log"
n=$(( $(find "$log" -name '*.argv' | wc -l) + 1 ))
printf '%s\\0' "$@" > "$log/$(printf %03d "$n").argv"
id=$1; shift
key=
if [ "\${1-}" = --resolve-key ]; then key=$2; shift 2; fi
text=$1
if [ "$text" = "please refuse" ]; then
  echo "error: stub refused this message on purpose" >&2
  exit 4
fi
slow=
case "$text" in *"[stub:slow]"*) slow=1; sleep 1.5 ;; esac
inbox="$FM_HOME/state/$id.inbox"
mkdir -p "$inbox/handled"
seq=$(( $(find "$inbox" -name '*.msg' | wc -l) + 1 ))
printf 'schema=fm-task-inbox.v1\\nat=%s\\nbody-terminator=1\\n--\\n%s\\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$text" > "$inbox/$(printf %03d "$seq").msg"
if [ -n "$key" ]; then
  printf 'resolved [key=%s] [at=%s]: answered: %s\\n' "$key" "$(date +%s)" "\${text%%$'\\n'*}" >> "$FM_HOME/state/$id.status"
fi
# The real script rings the worker after saving the record, which takes a moment.
[ -z "$slow" ] || sleep 1
echo "sent to $id"
`;

const TEARDOWN_STUB = `#!/usr/bin/env bash
set -euo pipefail
[ -f "$FM_HOME/.fake-home" ] || { echo "stub refuses: FM_HOME is not a fake home" >&2; exit 90; }
log="$FM_HOME/teardown-log"
mkdir -p "$log"
n=$(( $(find "$log" -name '*.argv' | wc -l) + 1 ))
printf '%s\\0' "$@" > "$log/$(printf %03d "$n").argv"
id=$1
if [ "\${2-}" != --force ] && [ -f "$FM_HOME/teardown-refuse/$id" ]; then
  cat "$FM_HOME/teardown-refuse/$id" >&2
  exit 1
fi
rm -f "$FM_HOME/state/$id.meta"
echo "teardown: $id cleaned up"
`;

const INBOX_STUB = String.raw`#!/usr/bin/env bash
set -euo pipefail
[ -f "$FM_HOME/.fake-home" ] || { echo "stub refuses: FM_HOME is not a fake home" >&2; exit 90; }
inbox="$FM_HOME/state/inbox"
mkdir -p "$inbox/handled" "$inbox/.announced" "$inbox/.replies" "$FM_HOME/inbox-log" "$FM_HOME/inbox-requests"
sub=$1
if [ "$sub" = note ]; then
  n=$(( $(find "$FM_HOME/inbox-log" -name '*.argv' | wc -l) + 1 ))
  printf '%s\0' "$@" > "$FM_HOME/inbox-log/$(printf %03d "$n").argv"
  [ "$2" = --request-id ] && [ "$4" = --json ] && [ "$5" = -- ] || { echo "stub: unexpected note arguments" >&2; exit 2; }
  rid=$3
  text=$6
  if [ "$text" = "please refuse" ]; then echo "fm-inbox: stub refused this note on purpose" >&2; exit 1; fi
  if [ -f "$FM_HOME/inbox-requests/$rid" ]; then
    id=$(cat "$FM_HOME/inbox-requests/$rid")
    printf '{"schema":"fm-inbox-note.v1","outcome":"replay","id":"%s","saved":true,"announced":true,"acknowledged":false}\n' "$id"
    exit 0
  fi
  id="note-$(printf %03d "$(( $(find "$inbox" -name '*.note' | wc -l) + 1 ))")"
  printf '%s' "$id" > "$FM_HOME/inbox-requests/$rid"
  printf 'id=%s\nat=%s\nrequest_id=%s\nannounce_marker=1\n--\n%s\n' "$id" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$rid" "$text" > "$inbox/$id.note"
  case "$text" in
    *"[stub:pending]"*)
      printf '{"schema":"fm-inbox-note.v1","outcome":"created","id":"%s","saved":true,"announced":false,"acknowledged":false}\n' "$id"
      exit 3 ;;
  esac
  : > "$inbox/.announced/$id"
  printf '{"schema":"fm-inbox-note.v1","outcome":"created","id":"%s","saved":true,"announced":true,"acknowledged":false}\n' "$id"
  exit 0
fi
if [ "$sub" = receipts ]; then
  exec python3 -I - "$inbox" <<'PY'
import json, sys
from pathlib import Path
inbox = Path(sys.argv[1])
def read(path):
    head, _, body = path.read_text().partition("\n--\n")
    meta = dict(l.split("=", 1) for l in head.splitlines() if "=" in l)
    return meta, body[:-1] if body.endswith("\n") else body
def notes(folder, acked):
    out = []
    for p in sorted(folder.glob("*.note")):
        meta, body = read(p)
        nid = meta["id"]
        reply = None
        rp = inbox / ".replies" / nid
        if rp.is_file():
            rmeta, rbody = read(rp)
            reply = {"id": nid, "at": rmeta.get("at"), "body": rbody, "cursor": "%012d" % int(rmeta["seq"])}
        out.append({"id": nid, "at": meta.get("at"), "source": "stub", "request_id": meta.get("request_id"), "body": body,
                    "acknowledged": acked, "announced": (inbox / ".announced" / nid).is_file(), "reply": reply})
    return out
handled = notes(inbox / "handled", True)
done = {n["id"] for n in handled}
pending = [n for n in notes(inbox, False) if n["id"] not in done]
replies = sorted([n["reply"] for n in pending + handled if n["reply"]], key=lambda r: r["cursor"])
json.dump({"schema": "fm-inbox-receipts.v1", "home": "fake", "generated": "now", "pending": pending, "handled": handled,
           "replies": replies, "reply_cursor": replies[-1]["cursor"] if replies else "", "omitted": []}, sys.stdout)
print()
PY
fi
echo "stub: unsupported subcommand $sub" >&2
exit 2
`;

const CREW_STUB = `#!/usr/bin/env bash
f="$FM_HOME/crew-states/$1"
if [ -f "$f" ]; then cat "$f"; else echo "state: unknown · source: none · stub has no state for $1"; fi
`;

const TASKS_STUB = `#!/usr/bin/env bash
if [ "$1" = list ]; then
  if [ -f "$FM_HOME/backlog-list.txt" ]; then cat "$FM_HOME/backlog-list.txt"
  else printf 'count: 0\\ntasks[0]{id,state,kind,repo,title,created,closed,held,hold_kind,hold_reason,blocked,blocked_by}:\\n'; fi
  exit 0
fi
[ "$1" = show ] || exit 2
f="$FM_HOME/titles/$2"
if [ -f "$f" ]; then
  printf 'task:\\n  id: %s\\n  title: "%s"\\n  state: in_flight\\n' "$2" "$(cat "$f")"
else
  printf 'error: "Task \\\\"%s\\\\" not found in this backlog"\\ncode: NOT_FOUND\\n' "$2"
fi
`;

export interface WorkerSeed {
  id: string;
  title?: string;
  meta: Record<string, string>;
  status?: string[];
  crewState?: string;
  inbox?: Array<{ body: string; at: string; handled: boolean }>;
}

export class FakeHome {
  readonly home: string;
  readonly state: string;

  constructor(prefix = 'crewchat-home-') {
    this.home = mkdtempSync(path.join(os.tmpdir(), prefix));
    this.state = path.join(this.home, 'state');
    mkdirSync(this.state);
    mkdirSync(path.join(this.home, 'bin'));
    mkdirSync(path.join(this.home, 'crew-states'));
    mkdirSync(path.join(this.home, 'titles'));
    writeFileSync(path.join(this.home, '.fake-home'), '');
    for (const [name, body] of [
      ['fm-send.sh', SEND_STUB],
      ['fm-crew-state.sh', CREW_STUB],
      ['fm-tasks-axi.sh', TASKS_STUB],
      ['fm-teardown.sh', TEARDOWN_STUB],
      ['fm-inbox.sh', INBOX_STUB],
    ]) {
      const file = path.join(this.home, 'bin', name);
      writeFileSync(file, body);
      chmodSync(file, 0o755);
    }
  }

  add(w: WorkerSeed): void {
    writeFileSync(
      path.join(this.state, `${w.id}.meta`),
      Object.entries(w.meta).map(([k, v]) => `${k}=${v}\n`).join(''),
    );
    if (w.status) writeFileSync(path.join(this.state, `${w.id}.status`), w.status.map((l) => `${l}\n`).join(''));
    if (w.title) writeFileSync(path.join(this.home, 'titles', w.id), w.title);
    if (w.crewState) this.setCrewState(w.id, w.crewState);
    const inbox = path.join(this.state, `${w.id}.inbox`);
    mkdirSync(path.join(inbox, 'handled'), { recursive: true });
    (w.inbox ?? []).forEach((m, i) => {
      const name = `${String(i + 1).padStart(3, '0')}.msg`;
      writeFileSync(
        path.join(inbox, m.handled ? 'handled' : '', name),
        `schema=fm-task-inbox.v1\nat=${m.at}\nbody-terminator=1\n--\n${m.body}\n`,
      );
    });
  }

  // Write an inbox record directly, the way the supervisor's own fm-send does
  // when it steers a worker.
  writeInbox(id: string, body: string, handled: boolean): number {
    const inbox = path.join(this.state, `${id}.inbox`);
    mkdirSync(path.join(inbox, 'handled'), { recursive: true });
    const count = readdirSync(inbox).filter((f) => f.endsWith('.msg')).length + readdirSync(path.join(inbox, 'handled')).filter((f) => f.endsWith('.msg')).length;
    const seq = count + 1;
    writeFileSync(
      path.join(inbox, handled ? 'handled' : '', `${String(seq).padStart(3, '0')}.msg`),
      `schema=fm-task-inbox.v1\nat=${new Date().toISOString().replace(/\.\d+Z$/, 'Z')}\nbody-terminator=1\n--\n${body}\n`,
    );
    return seq;
  }

  // Rows for the stub's `tasks-axi list`, in the real output's shape.
  setBacklog(rows: Array<{ id: string; state: string; kind?: string; repo: string; title: string; created?: string; closed?: string; held?: boolean; holdReason?: string }>): void {
    const q = (v: string) => JSON.stringify(v);
    const lines = [
      `count: ${rows.length}`,
      `tasks[${rows.length}]{id,state,kind,repo,title,created,closed,held,hold_kind,hold_reason,blocked,blocked_by}:`,
      ...rows.map(
        (r) =>
          `  ${r.id},${r.state},${r.kind ?? 'ship'},${r.repo},${q(r.title)},${r.created ?? '"-"'},${r.closed ?? '"-"'},${r.held ? 'yes' : 'no'},${r.held ? 'captain' : '"-"'},${q(r.holdReason ?? '-')},no,none`,
      ),
    ];
    writeFileSync(path.join(this.home, 'backlog-list.txt'), `${lines.join('\n')}\n`);
  }

  appendStatus(id: string, line: string): void {
    appendFileSync(path.join(this.state, `${id}.status`), `${line}\n`);
  }

  setCrewState(id: string, line: string): void {
    writeFileSync(path.join(this.home, 'crew-states', id), `${line}\n`);
  }

  markHandled(id: string, seq: number): void {
    const name = `${String(seq).padStart(3, '0')}.msg`;
    const inbox = path.join(this.state, `${id}.inbox`);
    renameSync(path.join(inbox, name), path.join(inbox, 'handled', name));
  }

  refuseTeardown(id: string, explanation: string): void {
    mkdirSync(path.join(this.home, 'teardown-refuse'), { recursive: true });
    writeFileSync(path.join(this.home, 'teardown-refuse', id), explanation);
  }

  sendLog(): string[][] {
    return this.argvLog('send-log');
  }

  inboxLog(): string[][] {
    return this.argvLog('inbox-log');
  }

  inboxNoteCount(): number {
    try {
      return readdirSync(path.join(this.state, 'inbox')).filter((f) => f.endsWith('.note')).length +
        readdirSync(path.join(this.state, 'inbox', 'handled')).filter((f) => f.endsWith('.note')).length;
    } catch {
      return 0;
    }
  }

  // A note in First mate's inbox written directly, as if sent earlier.
  writeNote(id: string, body: string, acknowledged: boolean, reply?: string): void {
    const inbox = path.join(this.state, 'inbox');
    mkdirSync(path.join(inbox, 'handled'), { recursive: true });
    mkdirSync(path.join(inbox, '.announced'), { recursive: true });
    mkdirSync(path.join(inbox, '.replies'), { recursive: true });
    const at = new Date(Date.now() - 120_000).toISOString().replace(/\.\d+Z$/, 'Z');
    if (reply) this.replyToNote(id, reply, 900 + this.inboxNoteCount());
    writeFileSync(path.join(inbox, '.announced', id), '');
    writeFileSync(path.join(inbox, acknowledged ? 'handled' : '', `${id}.note`), `id=${id}\nat=${at}\nannounce_marker=1\n--\n${body}\n`);
  }

  writeData(id: string, name: string, text: string): void {
    mkdirSync(path.join(this.home, 'data', id), { recursive: true });
    writeFileSync(path.join(this.home, 'data', id, name), text);
  }

  noteIdFor(body: string): string | null {
    const inbox = path.join(this.state, 'inbox');
    for (const dir of [inbox, path.join(inbox, 'handled')]) {
      let names: string[] = [];
      try {
        names = readdirSync(dir).filter((f) => f.endsWith('.note'));
      } catch {
        continue;
      }
      for (const n of names) if (readFileSync(path.join(dir, n), 'utf8').includes(body)) return n.slice(0, -5);
    }
    return null;
  }

  ackNote(id: string): void {
    const inbox = path.join(this.state, 'inbox');
    renameSync(path.join(inbox, `${id}.note`), path.join(inbox, 'handled', `${id}.note`));
  }

  replyToNote(id: string, body: string, seq: number): void {
    writeFileSync(path.join(this.state, 'inbox', '.replies', id), `id=${id}
at=${new Date().toISOString()}
seq=${seq}
--
${body}
`);
  }

  writeProjects(md: string): void {
    mkdirSync(path.join(this.home, 'data'), { recursive: true });
    writeFileSync(path.join(this.home, 'data', 'projects.md'), md);
  }

  teardownLog(): string[][] {
    return this.argvLog('teardown-log');
  }

  private argvLog(name: string): string[][] {
    const dir = path.join(this.home, name);
    let files: string[];
    try {
      files = readdirSync(dir).sort();
    } catch {
      return [];
    }
    return files.map((f) => {
      const parts = readFileSync(path.join(dir, f), 'utf8').split('\0');
      parts.pop();
      return parts;
    });
  }

  cleanup(): void {
    rmSync(this.home, { recursive: true, force: true });
  }
}
