import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { missingScripts } from '../../server/check.ts';
import { pickLauncher } from '../../server/terminal.ts';
import { FakeHome } from '../support/fake-home.ts';

describe('startup self-check', () => {
  it('finds nothing missing in a complete home, and names what a partial one lacks', () => {
    const home = new FakeHome();
    try {
      expect(missingScripts(home.home)).toEqual([]);
      rmSync(path.join(home.home, 'bin', 'fm-teardown.sh'));
      chmodSync(path.join(home.home, 'bin', 'fm-inbox.sh'), 0o644);
      expect(missingScripts(home.home)).toEqual(['fm-inbox.sh', 'fm-teardown.sh']);
    } finally {
      home.cleanup();
    }
  });
});

describe('terminal launcher', () => {
  it('runs a configured command with the shell command as one argument', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'crewchat-launch-'));
    try {
      const out = path.join(dir, 'argv');
      const script = path.join(dir, 'fake-term');
      writeFileSync(script, `#!/bin/sh\nprintf '%s\\n' "$@" > '${out}'\n`);
      chmodSync(script, 0o755);
      const launch = pickLauncher(`${script} --title crew {cmd}`)!;
      expect((await launch("unset TMUX; 'tmux' 'new-session'")).exitCode).toBe(0);
      const { readFileSync } = await import('node:fs');
      expect(readFileSync(out, 'utf8').trim().split('\n')).toEqual(['--title', 'crew', "unset TMUX; 'tmux' 'new-session'"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses a template without {cmd}, and has no default on Linux without a terminal app', () => {
    expect(pickLauncher('gnome-terminal')).toBeNull();
    expect(pickLauncher(undefined, 'linux', '')).toBeNull();
    expect(pickLauncher(undefined, 'darwin', '')).not.toBeNull();
    const dir = mkdtempSync(path.join(os.tmpdir(), 'crewchat-xterm-'));
    try {
      mkdirSync(path.join(dir, 'bin'));
      writeFileSync(path.join(dir, 'bin', 'x-terminal-emulator'), '#!/bin/sh\n');
      chmodSync(path.join(dir, 'bin', 'x-terminal-emulator'), 0o755);
      expect(pickLauncher(undefined, 'linux', path.join(dir, 'bin'))).not.toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
