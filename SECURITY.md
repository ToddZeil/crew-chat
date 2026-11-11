# Security

crew-chat is a local tool for one person at one machine.

- **Localhost only, no login.** The server listens on 127.0.0.1 only and has no accounts or authentication. Anyone who can reach that port can act as you. Do not expose it through a tunnel, a reverse proxy, or `0.0.0.0`.
- **Requests from other sites are refused.** Write requests must be JSON and come from the page itself; requests from other sites are refused, so a web page open in your browser cannot drive it.
- **What it can change.** Every change goes through your Firstmate home's own scripts:
  - `fm-send.sh` (send and answer)
  - `fm-inbox.sh note` (messages to First mate)
  - `fm-teardown.sh` (clean up, with `--force` only after you type the worker's id)

  crew-chat never writes inside `FM_HOME`.
- **What it reads.**
  - Your Firstmate home's state, backlog, and data folders.
  - Your Claude Code transcripts under `~/.claude/projects` (for token use and the Transcript tab).
  - Markdown and image files that a message names, but only inside the Firstmate home, that worker's worktree, or crew-chat's uploads folder, after resolving symlinks.

  None of this leaves your machine.
- **What it stores.** Its own data folder, `~/.crew-chat` by default, holds:
  - the list of messages it sent
  - a saved copy of each worker conversation
  - pasted images
- **Untrusted text.** Worker messages and Markdown files are treated as untrusted. Markdown is rendered and then sanitised with DOMPurify, and links open in a new tab.

## Reporting a problem

Please report security problems privately through the repository's private vulnerability reporting (the Security tab, then "Report a vulnerability") rather than in a public issue.
