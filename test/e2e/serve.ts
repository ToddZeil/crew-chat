// Test launcher: the real app (real store, routes, and page) with one change,
// "Open terminal" records the shell command it would open instead of opening
// a terminal window.
import { appendFileSync } from 'node:fs';
import path from 'node:path';
import { createApp } from '../../server/app.ts';
import { findOnPath, socketArgsFrom } from '../../server/terminal.ts';

const home = process.env.FM_HOME;
const log = process.env.CREW_CHAT_TERMINAL_LOG;
const socket = process.env.CREW_CHAT_TMUX_SOCKET;
const uploadDir = process.env.CREW_CHAT_UPLOAD_DIR;
if (!home || !log || !socket || !uploadDir) {
  throw new Error('FM_HOME, CREW_CHAT_TERMINAL_LOG, CREW_CHAT_TMUX_SOCKET and CREW_CHAT_UPLOAD_DIR are required');
}
if (!socket.includes('/')) throw new Error('the e2e tmux socket must be a private socket path');

const tmuxBin = findOnPath('tmux');
const { server, store } = createApp({
  home,
  readOnly: false,
  tmux: tmuxBin ? { bin: tmuxBin, socketArgs: socketArgsFrom(socket) } : null,
  staticDir: path.join(import.meta.dirname, '..', '..', 'dist', 'client'),
  uploadDir,
  ledgerFile: process.env.CREW_CHAT_LEDGER ?? null,
  archiveDir: process.env.CREW_CHAT_ARCHIVE ?? null,
  claudeProjectsDir: process.env.CREW_CHAT_CLAUDE_PROJECTS ?? null,
  launch: async (command) => {
    appendFileSync(log, `${JSON.stringify(command)}\n`);
    return { exitCode: 0, stderr: '' };
  },
});
server.listen(0, '127.0.0.1', () => {
  store.start();
  const addr = server.address();
  console.log(`listening ${typeof addr === 'object' && addr ? addr.port : ''}`);
});
process.on('SIGTERM', () => {
  server.close();
  process.exit(0);
});
