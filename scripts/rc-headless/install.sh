#!/bin/bash
# Install a launchd agent that keeps a Claude Code Remote Control server
# running for one repo, so the phone can start sessions there without a
# terminal open.
#
#   ./install.sh [repo-path]     # defaults to the current directory
#   ./install.sh --smoke-only    # run the checks, install nothing
#
# What it will NOT do: enable Remote Control on your account. That is a
# one-time interactive consent, and a script that seeds the flag for you would
# be answering a security question on your behalf. If you haven't enabled it,
# this exits and tells you to run `claude rc` once by hand.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WRAPPER="$SCRIPT_DIR/claude-rc-run.sh"
TEMPLATE="$SCRIPT_DIR/io.snowmelt.claude-rc.plist.template"
CLAUDE_JSON="$HOME/.claude.json"
SESSIONS_DIR="$HOME/.claude/sessions"
SMOKE_TIMEOUT=45

SMOKE_ONLY=0
REPO_ARG=""
for arg in "$@"; do
  case "$arg" in
    --smoke-only) SMOKE_ONLY=1 ;;
    -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
    -*) echo "unknown option: $arg" >&2; exit 64 ;;
    *) REPO_ARG="$arg" ;;
  esac
done

die() { echo "error: $*" >&2; exit 1; }
note() { echo "  $*"; }

# ─── Resolve the repo ──────────────────────────────────────────────────
REPO="$(cd "${REPO_ARG:-$PWD}" 2>/dev/null && pwd)" || die "no such directory: ${REPO_ARG:-$PWD}"
git -C "$REPO" rev-parse --git-dir >/dev/null 2>&1 || die "not a git repository: $REPO"
# The main checkout, even when invoked from inside a linked worktree — the RC
# server should serve the repo, and --spawn worktree makes its own anyway.
REPO="$(git -C "$REPO" rev-parse --show-toplevel)"
SLUG="$(basename "$REPO" | tr -cs 'A-Za-z0-9-' '-' | sed 's/-*$//')"
[ -n "$SLUG" ] || die "could not derive a label from $REPO"
LABEL="io.snowmelt.claude-rc.$SLUG"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

echo "Remote Control headless install"
note "repo   : $REPO"
note "label  : $LABEL"
note "logs   : ~/Library/Logs/claude-rc/$SLUG.{out,err}.log"
echo

# ─── Preconditions ─────────────────────────────────────────────────────
echo "Checking preconditions..."
[ -f "$WRAPPER" ] || die "wrapper script missing: $WRAPPER"
[ -f "$TEMPLATE" ] || die "plist template missing: $TEMPLATE"

CLAUDE_BIN="$(PATH="$HOME/.local/bin:$PATH" command -v claude || true)"
[ -n "$CLAUDE_BIN" ] || die "claude CLI not found (looked on PATH and in ~/.local/bin)"
note "claude CLI: $CLAUDE_BIN"

[ -f "$CLAUDE_JSON" ] || die "$CLAUDE_JSON not found — has Claude Code ever run on this account?"
ENROLLED="$(python3 -c "
import json, sys
try:
    d = json.load(open('$CLAUDE_JSON'))
except Exception:
    print('unreadable'); sys.exit(0)
print('yes' if d.get('remoteDialogSeen') is True else 'no')
")"
if [ "$ENROLLED" = "unreadable" ]; then
  die "could not parse $CLAUDE_JSON"
elif [ "$ENROLLED" != "yes" ]; then
  cat >&2 <<'EOF'
error: Remote Control has not been enabled on this account.

  Run this once, interactively, and answer the prompt:

      cd <your repo> && claude rc

  Then re-run this installer. (Deliberately not automated: enabling remote
  access to your machine should be an answer you gave, not one a script gave
  for you.)
EOF
  exit 1
fi
note "account enrolled for Remote Control (remoteDialogSeen)"
echo

# ─── Bounded non-interactive smoke ─────────────────────────────────────
# Proves `claude rc` actually starts with no TTY — which is exactly the
# condition launchd will run it under — before we make it permanent.
echo "Smoke test: starting a server with no terminal attached (up to ${SMOKE_TIMEOUT}s)..."
SMOKE_LOG="$(mktemp -t claude-rc-smoke)"
set +e
( cd "$REPO" && PATH="$HOME/.local/bin:$PATH" "$CLAUDE_BIN" rc --spawn worktree </dev/null >"$SMOKE_LOG" 2>&1 ) &
SMOKE_PID=$!
set -e

serving() {
  python3 - "$SESSIONS_DIR" "$REPO" <<'PY'
import json, os, sys
sessions_dir, repo = sys.argv[1], os.path.realpath(sys.argv[2])
spawn_dir = os.path.join(repo, '.claude', 'worktrees')
try:
    names = os.listdir(sessions_dir)
except OSError:
    sys.exit(1)
for name in names:
    if not name.endswith('.json'):
        continue
    try:
        with open(os.path.join(sessions_dir, name)) as fh:
            rec = json.load(fh)
    except Exception:
        continue
    if rec.get('entrypoint') != 'sdk-cli':
        continue
    cwd = rec.get('cwd')
    if not isinstance(cwd, str):
        continue
    cwd = os.path.realpath(cwd)
    if cwd == repo or os.path.commonpath([cwd, spawn_dir]) == spawn_dir:
        # Same rule as the panel's indicator (src/rcDetector.ts).
        sys.exit(0)
sys.exit(1)
PY
}

OK=0
for _ in $(seq 1 "$SMOKE_TIMEOUT"); do
  if ! kill -0 "$SMOKE_PID" 2>/dev/null; then
    echo "  server exited early. Output:" >&2
    sed 's/^/    /' "$SMOKE_LOG" >&2
    rm -f "$SMOKE_LOG"
    die "claude rc did not stay up without a terminal"
  fi
  if serving; then OK=1; break; fi
  sleep 1
done

# Kill the whole process group: the server spawns session children.
kill "$SMOKE_PID" 2>/dev/null || true
wait "$SMOKE_PID" 2>/dev/null || true

if [ "$OK" != "1" ]; then
  echo "  no hosted session registered within ${SMOKE_TIMEOUT}s. Output:" >&2
  sed 's/^/    /' "$SMOKE_LOG" >&2
  rm -f "$SMOKE_LOG"
  die "could not confirm the server was serving this repo"
fi
rm -f "$SMOKE_LOG"
note "server started headlessly and registered a hosted session"
echo

if [ "$SMOKE_ONLY" = "1" ]; then
  echo "Smoke test passed. Nothing installed (--smoke-only)."
  exit 0
fi

# ─── Install ───────────────────────────────────────────────────────────
echo "Installing agent..."
mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs/claude-rc"
chmod +x "$WRAPPER"

if launchctl print "gui/$UID/$LABEL" >/dev/null 2>&1; then
  note "replacing the agent already loaded under this label"
  launchctl bootout "gui/$UID/$LABEL" 2>/dev/null || true
fi

python3 - "$TEMPLATE" "$PLIST" "$SLUG" "$WRAPPER" "$REPO" "$HOME" <<'PY'
import sys
template, out, slug, wrapper, repo, home = sys.argv[1:7]
text = open(template).read()
for token, value in (('@SLUG@', slug), ('@WRAPPER@', wrapper), ('@REPO@', repo), ('@HOME@', home)):
    text = text.replace(token, value)
open(out, 'w').write(text)
PY
plutil -lint "$PLIST" >/dev/null || die "generated plist is malformed: $PLIST"
note "wrote $PLIST"

launchctl bootstrap "gui/$UID" "$PLIST"
launchctl kickstart "gui/$UID/$LABEL" >/dev/null 2>&1 || true
note "loaded $LABEL"
echo

echo "Done. The server starts at login and restarts if it stops."
echo
echo "  status : launchctl print gui/$UID/$LABEL | head -20"
echo "  logs   : tail -f ~/Library/Logs/claude-rc/$SLUG.err.log"
echo "  remove : $SCRIPT_DIR/uninstall.sh $REPO"
echo
echo "Serac's top bar shows a filled dot and dish when the server is serving a"
echo "workspace. Give it a poll cycle or two to notice."
