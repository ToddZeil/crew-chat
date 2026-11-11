// Development runner: the API server under node --watch plus the Vite dev
// server (hot reload) proxying /api to it. Stopping this process stops both.
import { spawn, type ChildProcess } from 'node:child_process';

const port = Number(process.env.CREW_CHAT_DEV_PORT ?? 5180);
const apiPort = Number(process.env.CREW_CHAT_PORT ?? port + 1);
if (!process.env.FM_HOME) {
  console.error('crew-chat: FM_HOME is not set.');
  process.exit(2);
}
const env = { ...process.env, CREW_CHAT_PORT: String(apiPort), CREW_CHAT_NO_STATIC: '1', CREW_CHAT_API_PORT: String(apiPort) };
const children: ChildProcess[] = [
  spawn(process.execPath, ['--watch', 'server/main.ts'], { stdio: 'inherit', env }),
  spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
    stdio: 'inherit',
    env,
  }),
];
const stop = () => {
  for (const c of children) c.kill('SIGTERM');
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
for (const c of children) c.on('exit', (code) => {
  console.error(`crew-chat dev: a child exited (${code}); stopping.`);
  stop();
});
