# Headless Remote Control server

Keeps a Claude Code **Remote Control** server running for one repo via a
launchd agent, so you can start sessions there from the phone without leaving
a terminal open.

Not part of the extension — these scripts are for the machine, and are
excluded from the packaged `.vsix`.

## What this is for

Two different things get confused:

- **Sessions you started here** (VS Code, terminal) are visible and steerable
  from the mobile app already. No server needed.
- **Starting a *new* session in this repo from the phone** needs a Remote
  Control server running on this machine, in this repo. That is what `claude
  rc` provides, and what this makes permanent.

Each phone-started session gets its own worktree under
`<repo>/.claude/worktrees/bridge-cse_<id>` (that's `--spawn worktree`), so
remote work never disturbs whatever you have checked out.

## Install

```sh
scripts/rc-headless/install.sh                # current repo
scripts/rc-headless/install.sh ~/repos/thing  # a specific one
scripts/rc-headless/install.sh --smoke-only   # run the checks, install nothing
```

The installer:

1. Resolves the repo's main checkout and derives a label,
   `io.snowmelt.claude-rc.<repo-slug>`.
2. Checks the Claude CLI exists and that Remote Control is enabled on your
   account (`remoteDialogSeen` in `~/.claude.json`).
3. **Smoke tests headless startup** — spawns `claude rc --spawn worktree` with
   no TTY, waits for a hosted session to appear in the process registry, then
   kills it. This is the condition launchd will run it under, so it's worth
   proving before making it permanent.
4. Writes and loads the agent (`RunAtLoad`, `KeepAlive`, `ThrottleInterval 30`).

### It will not enable Remote Control for you

Enabling it is a one-time interactive consent. A script that seeded the flag
would be answering a security question on your behalf. If it isn't enabled the
installer stops and tells you to run `claude rc` once by hand.

## Manage

```sh
launchctl print gui/$UID/io.snowmelt.claude-rc.<slug> | head -20   # status
tail -f ~/Library/Logs/claude-rc/<slug>.err.log                    # logs
launchctl kickstart -k gui/$UID/io.snowmelt.claude-rc.<slug>       # restart
scripts/rc-headless/uninstall.sh [repo]                            # remove
scripts/rc-headless/uninstall.sh --list                            # what's installed
```

One agent per repo — run the installer again in another repo to serve that one
too. Each server consumes a slot against your account's concurrent-session
capacity (the phone shows it as "N of M").

## Serac's indicator

The sidebar's top bar shows two phone-signal bars and 📡. The tall bar is
this server: lit when one is serving the open workspace. (The short bar is
Claude Code's own "Enable Remote Control for all sessions" setting.) Serac
infers the server from the sessions it hosts (they register with
`entrypoint: "sdk-cli"`), so a server that has not yet hosted anything can
read as off — see `src/rcDetector.ts` and ARCHITECTURE.md.

These scripts ship inside the extension. Clicking the indicator while the
tall bar is unlit offers to run `install.sh` for the open repo in a VS Code
terminal (macOS), or to start a plain `claude rc --spawn worktree` in a
terminal for this VS Code session only. Serac starts; it never stops a
server — that is the terminal's close button or `uninstall.sh`.

## Caveats

- **macOS only.** launchd. A Linux equivalent would be a systemd user unit.
- **Moving the checkout breaks the agent.** The plist points at the wrapper
  script by absolute path. Re-run the installer after moving this repo.
- **Auth expiry looks like a restart loop.** `KeepAlive` restarts the server,
  `ThrottleInterval` holds it to once per 30s. The `.err.log` says why.
- **Bridge sessions can fall off** the mobile app's list. Unresolved, under
  investigation; restarting the agent is the current blunt fix.
