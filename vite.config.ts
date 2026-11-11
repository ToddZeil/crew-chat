import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const apiPort = process.env.CREW_CHAT_API_PORT ?? '4477';

export default defineConfig({
  root: 'client',
  plugins: [react()],
  build: { outDir: '../dist/client', emptyOutDir: true },
  server: {
    proxy: { '^/api/': { target: `http://127.0.0.1:${apiPort}`, changeOrigin: false } },
  },
});
