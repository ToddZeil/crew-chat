import { existsSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.ts';
import { findOnPath, socketArgsFrom } from './terminal.ts';
import { missingScripts, REQUIRED_SCRIPTS } from './check.ts';
import { defaultProjectsDir } from './usage.ts';

const home = process.env.FM_HOME;
if (!home) {
  console.error('crew-chat: FM_HOME is not set. Point it at your Firstmate home, for example:\n  FM_HOME=/path/to/firstmate npm start');
  process.exit(2);
}
const absHome = path.resolve(home);
if (!existsSync(path.join(absHome, 'state')) || !statSync(path.join(absHome, 'state')).isDirectory()) {
  console.error(`crew-chat: ${absHome} has no state/ directory, so it is not a Firstmate home.`);
  process.exit(2);
}

const port = Number(process.env.CREW_CHAT_PORT ?? 4477);
const readOnly = process.env.CREW_CHAT_READ_ONLY === '1';
const tmuxBin = findOnPath('tmux');
const tmux = tmuxBin ? { bin: tmuxBin, socketArgs: socketArgsFrom(process.env.CREW_CHAT_TMUX_SOCKET) } : null;
const here = path.dirname(fileURLToPath(import.meta.url));
const staticDir = process.env.CREW_CHAT_NO_STATIC === '1' ? null : path.join(here, '..', 'dist', 'client');

const dataDir = path.resolve(process.env.CREW_CHAT_DATA_DIR || path.join(os.homedir(), '.crew-chat'));
const uploadDir = path.resolve(process.env.CREW_CHAT_UPLOAD_DIR || path.join(dataDir, 'uploads'));
for (const [name, dir] of [
  ['CREW_CHAT_DATA_DIR', dataDir],
  ['CREW_CHAT_UPLOAD_DIR', uploadDir],
]) {
  if (dir === absHome || dir.startsWith(absHome + path.sep)) {
    console.error(`crew-chat: ${name} must be outside FM_HOME; crew-chat never writes into the Firstmate home.`);
    process.exit(2);
  }
}
const ledgerFile = path.join(dataDir, 'sent-ledger.jsonl');
const archiveDir = path.join(dataDir, 'archive');
const claudeProjectsDir = process.env.CREW_CHAT_NO_USAGE === '1' ? null : process.env.CREW_CHAT_CLAUDE_PROJECTS || defaultProjectsDir();

const missing = missingScripts(absHome);
if (missing.length) {
  console.warn(
    `crew-chat: this Firstmate home lacks ${missing.join(', ')}; these features will not work: ${missing.map((m) => REQUIRED_SCRIPTS[m]).join('; ')}.`,
  );
}

const { server, store } = createApp({ home: absHome, readOnly, tmux, staticDir, uploadDir, claudeProjectsDir, ledgerFile, archiveDir });
server.listen(port, '127.0.0.1', () => {
  store.start();
  const addr = server.address();
  const actual = typeof addr === 'object' && addr ? addr.port : port;
  console.log(`crew-chat: http://127.0.0.1:${actual} (FM_HOME=${absHome}${readOnly ? ', read-only' : ''})`);
});
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    server.close();
    process.exit(0);
  });
}
