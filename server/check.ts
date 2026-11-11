import { accessSync, constants } from 'node:fs';
import path from 'node:path';

// The Firstmate scripts crew-chat calls, and what stops working without each.
// They are Firstmate internals, so a home from a much older or newer
// Firstmate may lack some; crew-chat reports that instead of failing later.
export const REQUIRED_SCRIPTS: Record<string, string> = {
  'fm-crew-state.sh': 'worker state badges',
  'fm-tasks-axi.sh': 'titles and the Queued and Finished lists',
  'fm-send.sh': 'Send and Answer',
  'fm-inbox.sh': 'First mate messages and New worker',
  'fm-teardown.sh': 'Clean up',
};

export function missingScripts(home: string): string[] {
  return Object.keys(REQUIRED_SCRIPTS).filter((name) => {
    try {
      accessSync(path.join(home, 'bin', name), constants.X_OK);
      return false;
    } catch {
      return true;
    }
  });
}
