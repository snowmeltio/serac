# Upstream report: Remote Control sessions cannot be reopened in the VS Code panel

Status: draft for anthropics/claude-code (GitHub issue or `/feedback`). Not yet filed.

## Summary

A session created from the phone through a `claude rc` server is written as an ordinary
local transcript, but the Claude Code VS Code panel refuses to reopen it. Clicking a
restore for that session id logs `restore_declined` and falls through to a fresh chat.

Cause (Claude Code 2.1.258): the panel host sets `includeProgrammaticSessions = false`,
so the session lister drops every transcript whose `entrypoint` is `sdk-cli`, `sdk-ts`,
or `sdk-py`. RC-hosted sessions are stamped `sdk-cli` on every record and in the
`~/.claude/sessions/<pid>.json` registry entry. The webview's activate path only finds
sessions that survive that list, so the id is never found.

There is no setting or env var that changes the field. Spawn mode does not matter: this
reproduces with `claude rc` in same-dir mode, where the transcript is under the open
folder's own project key.

## Repro

1. Start `claude rc` in a folder that is open in VS Code (same-dir spawn).
2. From the mobile app, create a new session on that server and send one prompt.
3. In VS Code, open that session (for example via the panel's history list, or any
   extension calling `claude-vscode.editor.open(sessionId)`).
4. Observe in the exthost log:
   `update_panel_host_session {"kind":"restore_declined","sessionId":"<id>"}` followed
   by `launch_claude` with no resume.

The transcript is a normal JSONL and should resume from a terminal with `claude --resume <id>` once the RC
process has exited (not yet verified by us); the panel filter is the only gate we found.

## Ask

Exempt RC-hosted sessions from the programmatic filter, or make the filter a setting.
A distinguishing signal already exists: the registry entry carries `bridgeSessionId`,
and the transcript is written from a `--sdk-url .../code/sessions/cse_*` process. Any
of these would separate "phone session I want to continue on my laptop" from
"headless SDK run nobody should reopen".

## Why we want it

We build Serac (https://github.com/snowmeltio/serac), a VS Code sidebar for Claude Code
sessions. The Remote Control promise is "continue here, on your phone, or at
claude.ai/code". Today "here" is the only place it does not work for phone-originated
sessions. Serac users see the phone session as a card and click it expecting the chat.

Serac already handles the collision case the filter may be guarding against:

- Live process elsewhere: Serac resolves which process owns a session
  (`src/writerOwnership.ts`, `src/writerActivity.ts`) and blocks or hands off the open
  instead of opening a second writer. RC-hosted `sdk-cli` writers are recognised
  (`src/rcDetector.ts`) and excluded from window-ownership verdicts.
- No live process: the transcript is idle, and a resume is the normal
  `--resume` path. Where two windows both claim a session, Serac offers a keep/release
  transfer between them rather than letting both write.

Relevant Serac source, for anyone reading along with their own Claude:

- https://github.com/snowmeltio/serac/blob/main/src/rcDetector.ts
- https://github.com/snowmeltio/serac/blob/main/src/writerOwnership.ts
- https://github.com/snowmeltio/serac/blob/main/src/writerActivity.ts
- https://github.com/snowmeltio/serac/blob/main/ARCHITECTURE.md

## Spike: rewriting the entrypoint (2026-09-03, confirmed)

Two copies of a phone session were placed under the same project key with new ids: a
control (entrypoint left as `sdk-cli`) and a variant (every `entrypoint` rewritten to
`claude-vscode`, nothing else changed). Result, Claude Code 2.1.258:

- Control: absent from the panel's Local session list.
- Variant: listed, opened with the full conversation, no `restore_declined` in the
  exthost log, resumed as a normal `claude-vscode` process.

So the entrypoint string is the only discriminator. This confirms the filter is the whole
gate and that the transcript itself is fully restorable.

## Spike 2: releasing a live RC-hosted session (2026-09-03, confirmed)

Sent `SIGTERM` to the idle `sdk-cli` child of the `claude rc` server for a real phone
session (same-dir, Claude Code 2.1.258), then rewrote the entrypoint in place and opened
it from the Serac card.

- Child exited within 2 s; its `~/.claude/sessions/<pid>.json` entry cleared at the same
  tick. The transcript gained one ordinary `last-prompt` record, nothing partial.
- The `claude rc` server stayed up and did not respawn a child for that session.
- After the rewrite the panel restored the session (no `restore_declined`), spawned a
  normal `claude-vscode` process, and this window's Remote Control re-enrolled it under a
  new `bridgeSessionId`. It was visible and usable from the phone again.

So a "bring this phone session here" action is feasible end to end: graceful release of
the RC child, entrypoint rewrite, ordinary restore. The upstream ask stands because the
rewrite step should not be necessary.

## Serac workaround (v1.25.0, experimental)

Serac now ships the two spikes as a feature behind `serac.experimental.transferPhoneSessions`:
a 📡→ chip on phone-originated cards that releases the idle `sdk-cli` child (SIGTERM, never
forced), rewrites the transcript's entrypoint, and opens the session in the panel. The
rewrite step exists only because of the filter above; the ask stands.
