export type Badge = 'needs-you' | 'working' | 'ready' | 'stopped' | 'checking' | 'queued' | 'requested' | 'finished';

// Where an incoming message's time came from: the line's own [at=] stamp, or
// the server seeing an unstamped line appear while it was running.
export type TimeSource = 'stamp' | 'observed';

export interface TerminalAvailability {
  available: boolean;
  reason?: string;
}

export interface WorkerUsage {
  // The model named on the worker's latest API response.
  model: string | null;
  // Tokens the latest request sent, cached or not: how full the context is.
  contextTokens: number;
  // Totals since the worker started: fresh input (including cache writes),
  // cache reads, and output.
  inputTokens: number;
  cacheReadTokens: number;
  outputTokens: number;
  messages: number;
  lastAt: number;
}

export interface ThreadSummary {
  id: string;
  title: string;
  badge: Badge;
  stateLine: string | null;
  project: string | null;
  kind: string | null;
  backend: string;
  pr: string | null;
  lastText: string | null;
  lastVerb: string | null;
  lastAt: number | null;
  incomingCount: number;
  openDecisions: number;
  unreadByWorker: number;
  terminal: TerminalAvailability;
  harness: string | null;
  model: string | null;
  effort: string | null;
  usage: WorkerUsage | null;
  // Why there is no usage, when there is none.
  usageNote: string | null;
  // Set for threads with no live worker: a task queued in First mate's
  // backlog, a New worker request First mate has not picked up, or a worker
  // that finished and was cleaned up (shown from crew-chat's saved copy).
  placeholder: 'queued' | 'requested' | 'finished' | null;
  // A finished thread the user removed from the list.
  hidden?: boolean;
}

export type DecisionState = 'open' | 'resolved' | 'closed-by-result' | 'replaced';

export interface IncomingItem {
  type: 'incoming';
  id: string;
  verb: string;
  text: string;
  at: number | null;
  atSource: TimeSource | null;
  key: string | null;
  decision: DecisionState | null;
  resolution: string | null;
  // Set when the message is First mate's rather than the worker's.
  author?: 'firstmate';
  // For an open decision: its questions laid out one by one.
  form?: DecisionForm | null;
}

export interface DecisionQuestion {
  n: string;
  // The full question, as Markdown.
  text: string;
  // Short form used in the compiled answer.
  label: string;
  recommendation: string | null;
}

export interface DecisionForm {
  // Where the questions came from, when not the decision text itself.
  source: { path: string; heading: string } | null;
  questions: DecisionQuestion[];
  // Lettered choices offered in the decision text, such as (A) and (B).
  options: { label: string; text: string }[];
  // The decision asks for a plan to be approved.
  approval: boolean;
}

export interface OutgoingItem {
  type: 'outgoing';
  id: string;
  seq: number;
  at: number | null;
  body: string;
  read: boolean;
  // Who wrote it: the app's own sends are 'you'; anything else in the inbox
  // came from the supervisor.
  from: 'you' | 'firstmate';
}

export type ChatItem = IncomingItem | OutgoingItem;

export interface ThreadDetail {
  summary: ThreadSummary;
  items: ChatItem[];
}

export interface WriteResult {
  ok: boolean;
  // 'unconfirmed' is fm-send's exit 3: the text reached the worker's terminal
  // but submission could not be confirmed.
  outcome: 'sent' | 'unconfirmed' | 'refused';
  exitCode: number | null;
  stdout: string;
  stderr: string;
  error?: string;
}

export interface CleanupResult {
  // fm-teardown.sh exit 0 is 'cleaned', exit 4 is 'cleaned-with-warning'
  // (cleaned up, but a pool slot was lost), exit 1 is 'refused', and
  // anything else is 'error'.
  outcome: 'cleaned' | 'cleaned-with-warning' | 'refused' | 'error';
  exitCode: number | null;
  stdout: string;
  stderr: string;
  error?: string;
}

export interface FirstmateNote {
  id: string;
  requestId: string | null;
  at: number | null;
  body: string;
  // Firstmate has taken the note off its queue.
  acknowledged: boolean;
  // A wake was queued for it; null when the home cannot tell.
  announced: boolean | null;
  reply: { at: number | null; body: string } | null;
}

export interface Project {
  name: string;
  mode: string;
  description: string;
}

export interface FirstmateDetail {
  notes: FirstmateNote[];
  projects: Project[];
  error: string | null;
}

export interface NoteResult {
  // 'sent' covers a new note and a replayed retry; 'pending' is exit 3,
  // saved but not yet announced to Firstmate.
  outcome: 'sent' | 'pending' | 'refused';
  exitCode: number | null;
  noteId: string | null;
  stdout: string;
  stderr: string;
  error?: string;
}

// One step of a worker's session, from its Claude transcript: what it said,
// a tool it ran, what came back, or a prompt it received.
export interface ActivityEntry {
  at: number;
  kind: 'say' | 'tool' | 'result' | 'prompt';
  text: string;
  tool?: string;
  error?: boolean;
}

export interface ActivityLog {
  available: boolean;
  reason?: string;
  entries: ActivityEntry[];
}

export interface PaneSnapshot {
  available: boolean;
  reason?: string;
  // Terminal text with ANSI colour codes, as tmux shows it.
  text: string;
  at: number;
}

export interface DocResult {
  ok: boolean;
  path?: string;
  text?: string;
  error?: string;
}

export interface AppConfig {
  readOnly: boolean;
  home: string;
  uploadDir: string;
  // Firstmate scripts this home lacks, each with what it is needed for.
  missing: Array<{ script: string; needed: string }>;
}

export interface UploadResult {
  ok: boolean;
  path?: string;
  url?: string;
  error?: string;
}

// Plan usage as the newest Claude worker's status bar showed it.
export interface ClaudeLimits {
  // Percent used of the five-hour and weekly windows.
  fiveHour: number | null;
  sevenDay: number | null;
  // When the five-hour window resets (epoch ms), estimated from its countdown.
  resetsAt: number | null;
  // When the weekly window resets, when the status bar shows it.
  weekResetsAt: number | null;
  // The worker whose status bar it came from, and when it was read.
  from: string;
  at: number;
}
