#!/bin/zsh
# Wrapper launchd runs to keep a Claude Code Remote Control server up for one
# repo. Takes the repo path as its only argument.
#
# Kept deliberately thin: launchd owns restart policy (KeepAlive +
# ThrottleInterval in the plist), so this script's whole job is to land in the
# right directory with a usable PATH and hand off. `exec` matters — without it
# launchd would supervise this shell rather than the server, and KeepAlive
# would not see the server die.
set -eu

REPO="${1:-}"
if [ -z "$REPO" ]; then
  print -u2 "claude-rc-run: no repo path given"
  exit 64  # EX_USAGE
fi
if [ ! -d "$REPO" ]; then
  print -u2 "claude-rc-run: not a directory: $REPO"
  exit 66  # EX_NOINPUT
fi

# launchd agents get a minimal PATH that misses the usual install locations.
# ~/.local/bin is where the Claude Code CLI installs itself.
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

CLAUDE="$(command -v claude || true)"
if [ -z "$CLAUDE" ]; then
  print -u2 "claude-rc-run: claude CLI not on PATH ($PATH)"
  exit 127
fi

cd "$REPO"
print "claude-rc-run: starting Remote Control server in $REPO at $(date '+%Y-%m-%d %H:%M:%S')"

# --spawn worktree: each session started from the phone gets its own worktree,
# so remote work never collides with whatever is checked out here.
exec "$CLAUDE" rc --spawn worktree
