import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  badgeFor,
  crewStateOf,
  inboxSeq,
  parseInboxMessage,
  parseMeta,
  parseProjects,
  parseReceipts,
  parseStatusLine,
  parseStatusLog,
  parseTaskList,
  parseTaskTitle,
  parseWorkerRequest,
  taskKind,
} from '../../server/parse.ts';

const fixtures = path.join(import.meta.dirname, '..', 'fixtures');
const read = (f: string) => readFileSync(path.join(fixtures, f), 'utf8');

describe('parseStatusLine', () => {
  it('reads an old line without [at=]', () => {
    const l = parseStatusLine('working: started on the search endpoint');
    expect(l).toMatchObject({ verb: 'working', at: null, key: 'default', keyed: false, text: 'started on the search endpoint' });
  });

  it('reads the stamp and a key before the colon', () => {
    const l = parseStatusLine('needs-decision [key=sort-shape] [at=1788576000]: should sort_by accept a list?');
    expect(l).toMatchObject({ verb: 'needs-decision', key: 'sort-shape', keyed: true, at: 1788576000_000, text: 'should sort_by accept a list?' });
  });

  it('reads a key at the head of the note and strips it from the text', () => {
    const l = parseStatusLine('blocked: [key=ci-red] [at=1788576100] CI is red on main');
    expect(l).toMatchObject({ verb: 'blocked', key: 'ci-red', keyed: true, text: '[at=1788576100] CI is red on main' });
  });

  it('keeps a readable stamp from moving the head/note separator', () => {
    const l = parseStatusLine('working [at=10:30]: readable stamps must not move the colon');
    expect(l).toMatchObject({ verb: 'working', at: null, text: 'readable stamps must not move the colon' });
  });

  it('treats a key deep inside the note as prose', () => {
    const l = parseStatusLine('resolved: closes default only [key=ci-red]');
    expect(l).toMatchObject({ verb: 'resolved', key: 'default', keyed: false });
  });

  it('skips a correlation token after the verb', () => {
    expect(parseStatusLine('needs-decision corr=0123456789abcdef [key=x]: q').verb).toBe('needs-decision');
    expect(parseStatusLine('needs-decision corr=nothex [key=x]: q').verb).toBe('needs-decision corr=nothex');
  });

  it('rejects a malformed key slug', () => {
    expect(parseStatusLine('needs-decision [key=bad key]: q').key).toBeNull();
  });

  it('rejects malformed or duplicate stamps', () => {
    expect(parseStatusLine('done [at=<epoch>]: x').at).toBeNull();
    expect(parseStatusLine('done [at=012]: x').at).toBeNull();
    expect(parseStatusLine('done [at=1] [at=2]: x').at).toBeNull();
  });
});

describe('parseStatusLog', () => {
  const log = parseStatusLog(read('worker.status'), 'ship');

  it('parses every line, old and new', () => {
    expect(log.lines).toHaveLength(14);
    expect(log.lines[0].at).toBeNull();
    expect(log.lines[3].at).toBe(1788576000_000);
  });

  it('closes a decision once a later resolved line names its key', () => {
    expect(log.open.has('sort-shape')).toBe(false);
  });

  it('keeps unresolved decisions open, including corr-token ones', () => {
    expect([...log.open.keys()].sort()).toEqual(['ci-red', 'texte-du-mur']);
    expect(log.open.get('ci-red')?.line).toBe(4);
    expect(log.open.get('ci-red')?.verb).toBe('blocked');
  });

  it('closes a keyless decision with a bare resolved line', () => {
    expect(log.open.has('default')).toBe(false);
  });

  it('ignores a reserved key used without its owner vocabulary', () => {
    expect(log.open.has('pending-reply-abc')).toBe(false);
  });

  it('lets a ship done line supersede earlier decisions', () => {
    const l = parseStatusLog('needs-decision [key=a]: q\ndone: shipped\n', 'ship');
    expect(l.open.size).toBe(0);
    const s = parseStatusLog('needs-decision [key=a]: q\ndone: shipped\n', 'secondmate');
    expect(s.open.has('a')).toBe(true);
  });

  it('opens, resolves, and reopens the same key', () => {
    const l = parseStatusLog('needs-decision [key=a]: one\nresolved [key=a]: yes\nblocked [key=a]: again\n');
    expect(l.open.get('a')).toEqual({ key: 'a', verb: 'blocked', line: 2 });
  });

  it('records what became of each decision line', () => {
    expect(log.fates.get(3)).toEqual({ state: 'resolved', by: 6 });
    expect(log.fates.get(4)).toEqual({ state: 'open', by: null });
    expect(log.fates.get(8)).toEqual({ state: 'resolved', by: 9 });
    expect(log.fates.has(10)).toBe(false);
    expect(log.fates.has(13)).toBe(false);
    const done = parseStatusLog('needs-decision [key=a]: q\ndone: shipped\n', 'ship');
    expect(done.fates.get(0)).toEqual({ state: 'closed-by-result', by: 1 });
    const again = parseStatusLog('needs-decision [key=a]: q\nneeds-decision [key=a]: q2\n');
    expect(again.fates.get(0)).toEqual({ state: 'replaced', by: 1 });
  });

  it('lets captain-held close a decision', () => {
    const l = parseStatusLog('needs-decision [key=a]: q\ncaptain-held [key=a]: transferred\n');
    expect(l.open.size).toBe(0);
  });
});

describe('parseMeta', () => {
  it('reads key=value lines and keeps = inside values', () => {
    const m = parseMeta(read('worker.meta') + 'note=a=b\n');
    expect(m.window).toBe('firstmate-0:fm-search-sort');
    expect(m.pr).toBe('https://github.com/acme/storefront/pull/512');
    expect(m.backend).toBeUndefined();
    expect(m.note).toBe('a=b');
    expect(taskKind(m)).toBe('ship');
    expect(taskKind({})).toBe('ship');
    expect(taskKind({ kind: 'odd' })).toBe('unknown');
  });
});

describe('parseInboxMessage', () => {
  it('reads a handled record and drops only the synthetic terminator', () => {
    const m = parseInboxMessage(read('inbox/handled/001.msg'));
    expect(m.headers.schema).toBe('fm-task-inbox.v1');
    expect(m.at).toBe(Date.parse('2026-11-11T02:53:50Z'));
    expect(m.body).toBe('Use one field.\nIt costs "less" & saves $5.\n');
  });

  it('reads a legacy record through the end of the file', () => {
    const m = parseInboxMessage(read('inbox/002.msg'));
    expect(m.body).toBe('legacy record without a terminator');
  });

  it('reads sequence numbers from file names only', () => {
    expect(inboxSeq('007.msg')).toBe(7);
    expect(inboxSeq('007.msg.tmp')).toBeNull();
  });
});

describe('crew state and titles', () => {
  it('maps the first line of fm-crew-state.sh to a badge', () => {
    expect(badgeFor(crewStateOf('state: parked · source: run-step · gate'))).toBe('needs-you');
    expect(badgeFor(crewStateOf('state: blocked · source: status-log · x'))).toBe('needs-you');
    expect(badgeFor(crewStateOf('state: working · source: pane · busy'))).toBe('working');
    expect(badgeFor(crewStateOf('state: done · source: status-log · x'))).toBe('ready');
    expect(badgeFor(crewStateOf('state: unknown · source: none · gone'))).toBe('stopped');
    expect(badgeFor(crewStateOf('garbage'))).toBe('stopped');
  });

  it('reads the backlog title and falls back on a missing task', () => {
    expect(parseTaskTitle('task:\n  id: x\n  title: "Fix the \\"sort\\" \\nbug"\n')).toBe('Fix the "sort" bug');
    expect(parseTaskTitle('error: "Task \\"x\\" not found"\ncode: NOT_FOUND\n')).toBeNull();
  });
});

describe('First mate inbox', () => {
  it('reads project lines from projects.md', () => {
    const md = '# Projects\n\n- storefront [no-mistakes-prod-only] - web shop (added 2026-08-25)\n- crew-chat [local-only] - chat view\nnot a project\n- broken line\n';
    expect(parseProjects(md)).toEqual([
      { name: 'storefront', mode: 'no-mistakes-prod-only', description: 'web shop (added 2026-08-25)' },
      { name: 'crew-chat', mode: 'local-only', description: 'chat view' },
    ]);
  });

  it('reads receipts into notes, oldest first, with replies and states', () => {
    const json = JSON.stringify({
      schema: 'fm-inbox-receipts.v1',
      pending: [{ id: 'b', at: '2026-11-11T03:00:00Z', body: 'second', request_id: 'r2', acknowledged: false, announced: false, reply: null }],
      handled: [{ id: 'a', at: '2026-11-11T02:00:00Z', body: 'first', request_id: null, acknowledged: true, announced: null, reply: { id: 'a', at: '2026-11-11T02:05:00Z', body: 'on it', cursor: '000000000001' } }],
      replies: [],
      omitted: [],
    });
    expect(parseReceipts(json)).toEqual([
      { id: 'a', requestId: null, at: Date.parse('2026-11-11T02:00:00Z'), body: 'first', acknowledged: true, announced: null, reply: { at: Date.parse('2026-11-11T02:05:00Z'), body: 'on it' } },
      { id: 'b', requestId: 'r2', at: Date.parse('2026-11-11T03:00:00Z'), body: 'second', acknowledged: false, announced: false, reply: null },
    ]);
  });
});

describe('backlog', () => {
  const out = [
    'count: 3',
    'tasks[3]{id,state,kind,repo,title,created,closed,held,hold_kind,hold_reason,blocked,blocked_by}:',
    '  crew-chat-ui,in_flight,ship,crew-chat,"crew-chat v1: local browser chat view, one thread per firstmate worker (restart \\n... (truncated, 96 chars total - use show crew-chat-ui --full to see complete text)",2026-11-11,"-",no,"-","-",no,none',
    '  main-build-fix,queued,ship,storefront,"Main does not compile",2026-08-31,"-",yes,captain,"PREMISE HAS DISSOLVED, \\"quoted\\", and a, comma",no,none',
    '  question-length,queued,ship,storefront,"Storefront: remove the 100-character limit",2026-11-12,"-",no,"-","-",yes,main-build-fix',
    'help[1]:',
    '  - Run `tasks-axi show <id>` for full notes on a task',
  ].join('\n');

  it('reads list rows with quoted fields, escapes, and commas', () => {
    const tasks = parseTaskList(out);
    expect(tasks.map((t) => t.id)).toEqual(['crew-chat-ui', 'main-build-fix', 'question-length']);
    expect(tasks[0].title).toBe('crew-chat v1: local browser chat view, one thread per firstmate worker (restart ...');
    expect(tasks[1]).toMatchObject({ state: 'queued', held: true, holdKind: 'captain', holdReason: 'PREMISE HAS DISSOLVED, "quoted", and a, comma' });
    expect(tasks[2]).toMatchObject({ repo: 'storefront', created: '2026-11-12', held: false, holdReason: null, blocked: true, blockedBy: 'main-build-fix' });
    expect(parseTaskList('error: nothing')).toEqual([]);
  });

  it('reads a New worker request note', () => {
    expect(parseWorkerRequest('New worker request - project: crew-chat. Add a box.\nModel: auto')).toEqual({ project: 'crew-chat', text: 'Add a box.\nModel: auto' });
    expect(parseWorkerRequest('hello')).toBeNull();
  });
});
