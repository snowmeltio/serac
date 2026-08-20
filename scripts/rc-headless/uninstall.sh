#!/bin/bash
# Remove the launchd agent installed by install.sh.
#
#   ./uninstall.sh [repo-path]   # defaults to the current directory
#   ./uninstall.sh --list        # show every claude-rc agent installed
#
# Stops and unloads the agent. Leaves logs in place (they are the record of
# what happened) and never touches the repo, its worktrees, or your account's
# Remote Control enrolment.
set -euo pipefail

if [ "${1:-}" = "--list" ]; then
  found=0
  for plist in "$HOME"/Library/LaunchAgents/io.snowmelt.claude-rc.*.plist; do
    [ -e "$plist" ] || continue
    found=1
    label="$(basename "$plist" .plist)"
    if launchctl print "gui/$UID/$label" >/dev/null 2>&1; then state="loaded"; else state="not loaded"; fi
    echo "$label  ($state)"
  done
  [ "$found" = "1" ] || echo "No claude-rc agents installed."
  exit 0
fi

if [ "${1:-}" = "-h" ] || [ "${1:-}" = "--help" ]; then
  sed -n '2,9p' "$0"
  exit 0
fi

REPO="$(cd "${1:-$PWD}" 2>/dev/null && pwd)" || { echo "error: no such directory: ${1:-$PWD}" >&2; exit 1; }
if git -C "$REPO" rev-parse --show-toplevel >/dev/null 2>&1; then
  REPO="$(git -C "$REPO" rev-parse --show-toplevel)"
fi
SLUG="$(basename "$REPO" | tr -cs 'A-Za-z0-9-' '-' | sed 's/-*$//')"
LABEL="io.snowmelt.claude-rc.$SLUG"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

if launchctl print "gui/$UID/$LABEL" >/dev/null 2>&1; then
  launchctl bootout "gui/$UID/$LABEL"
  echo "unloaded $LABEL"
else
  echo "$LABEL was not loaded"
fi

if [ -f "$PLIST" ]; then
  rm "$PLIST"
  echo "removed $PLIST"
else
  echo "no plist at $PLIST"
fi

echo
echo "Logs kept at ~/Library/Logs/claude-rc/$SLUG.{out,err}.log — delete them yourself if you want them gone."
