import os from 'node:os';
import path from 'node:path';
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'test/e2e',
  outputDir: path.join(os.tmpdir(), 'crew-chat-playwright'),
  timeout: 60_000,
  expect: { timeout: 8_000 },
  workers: 1,
  reporter: [['list']],
  use: { viewport: { width: 1280, height: 800 }, headless: true },
});
