import { describe, expect, it } from 'vitest';
import { typedApproval } from '../../client/handoff.ts';

describe('typedApproval', () => {
  it('finds the quoted words to type in the main terminal', () => {
    const reply =
      'Yes: phase 1 is ready, but its first step creates a ZL Jira ticket, and Claude Code only accepts your approval for that when it is typed in the main terminal, not here. Type "go on phase 1" in the main terminal and it starts straight away.';
    expect(typedApproval(reply)).toEqual({ words: 'go on phase 1' });
  });

  it("accepts other quotes and First mate's terminal", () => {
    expect(typedApproval("Please type 'approve spike' into First mate's terminal.")).toEqual({ words: 'approve spike' });
    expect(typedApproval('Type “yes, merge” in the supervisor pane')).toEqual({ words: 'yes, merge' });
  });

  it('reads "send ... there" when the reply is about First mate\'s terminal', () => {
    const reply =
      'I checked before retrying: nothing has changed yet. Fastest path: press "Copy and open First mate\'s terminal" on my earlier reply and send "go on phase 1" there, and I start it within a minute. Or paste the one-line settings command in that terminal so requests from here work in future.';
    expect(typedApproval(reply)).toEqual({ words: 'go on phase 1' });
  });

  it('still offers the terminal when no words are quoted', () => {
    expect(typedApproval('That approval has to be typed in the main terminal, not here.')).toEqual({ words: null });
  });

  it('ignores replies that do not ask for a typed approval', () => {
    expect(typedApproval('Noted. The worker is running in its terminal now.')).toBeNull();
    expect(typedApproval('Noted. The worker is running in the terminal now.')).toBeNull();
    expect(typedApproval('Type the id to confirm the cleanup.')).toBeNull();
  });
});
