#!/bin/zsh
# Wrapper launchd runs to keep a Claude Code Remote Control server up for one
# repo. Arguments: the repo path, then an optional spawn mode (`same-dir`,
# the default, or `worktree`).
#
# Kept deliberately thin: launchd owns restart policy (KeepAlive +
# ThrottleInterval in the plist), so this script's whole job is to land in the
# right directory with a usable PATH and hand off. `exec` matters — without it
# launchd would supervise this shell rather than the server, and KeepAlive
# would not see the server die.
set -eu

REPO="${1:-}"
MODE="${2:-same-dir}"
if [ -z "$REPO" ]; then
  print -u2 "claude-rc-run: no repo path given"
  exit 64  # EX_USAGE
fi
if [ ! -d "$REPO" ]; then
  print -u2 "claude-rc-run: not a directory: $REPO"
  exit 66  # EX_NOINPUT
fi
case "$MODE" in
  same-dir|worktree) ;;
  *) print -u2 "claude-rc-run: spawn mode must be same-dir or worktree, got: $MODE"; exit 64 ;;
esac

# launchd agents get a minimal PATH that misses the usual install locations.
# ~/.local/bin is where the Claude Code CLI installs itself.
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

CLAUDE="$(command -v claude || true)"
if [ -z "$CLAUDE" ]; then
  print -u2 "claude-rc-run: claude CLI not on PATH ($PATH)"
  exit 127
fi

cd "$REPO"
print "claude-rc-run: starting Remote Control server in $REPO (--spawn $MODE) at $(date '+%Y-%m-%d %H:%M:%S')"

# same-dir (default): phone-started sessions share this checkout and land
# under its project key, so the Claude Code panel in a window on this repo can
# reopen them. worktree: each phone session gets its own worktree — isolated
# edits, but a transcript that window cannot restore. Installed plists written
# before the mode argument existed pass nothing and get same-dir.
exec "$CLAUDE" rc --spawn "$MODE"
