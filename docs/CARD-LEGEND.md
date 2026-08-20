# Card legend

Every mark on a Serac session card: what it's telling you, and what you'd do about it.

> **See it rendered.** GitHub and the VS Code marketplace both strip stylesheets, so the chips below are described rather than shown. For the specimen sheet — every chip drawn at its real size in its real colours — open [`docs/card-legend.html`](card-legend.html) in a browser.

## Anatomy

Four zones, always in this order. Everything in the meta row is conditional, so a quiet local session shows almost none of it.

```
┌─────────────────────────────────────────────────┐
│ Fix the worktree picker              [RUNNING]  │  name · status pill
│ Fable 5  ⚡auto  WP  🤖3→              📜  ×     │  meta row
│ ⎇ feat/worktree-picker                          │  branch
│ Reading src/worktreeRows.ts                     │  activity
├━━━━━━━━━━━━━━━━━━━━━━━━─────────────────────────┤  context bar (bottom edge)
└─────────────────────────────────────────────────┘
```

| | |
|---|---|
| **Name** | Custom title, else AI title, else the first message |
| **Status pill** | The one element always present |
| **Meta row** | Model, permission mode, worktree, agents, conflicts, actions |
| **Branch** | Its own row — it's the longest thing on a card |
| **Activity** | What it's doing, or what it finished with |
| **Context bar** | A hairline along the card's bottom edge, filling toward the auto-compact threshold |

## Status

Status is carried twice: as a word in the pill, and as a colour stripe down the card's left edge, so a column of cards can be triaged by stripe alone. Elapsed time is always *time in this state* — the actual question when several cards are blocked at once.

| Pill | Colour | Means |
|---|---|---|
| `Waiting · 4m` | peach, pulsing | Blocked on you — a permission prompt or a question. **The only status that wants something.** The sidebar badge counts these. |
| `Running` | blue | Actively working. No age shown; for a healthy session it isn't interesting. |
| `Running · quiet 12m` | blue | Still running, but nothing written for a while. Deliberately **"quiet", not "stalled"** — a long silent build is legitimate, you just want to know it's been twelve minutes. Suppressed when the card owns a live workflow, whose agents churn on a separate track. |
| `Done · 3m` | teal | The turn ended and you haven't looked yet. Holds until you actually acknowledge it — **no time-based decay**, because clearing unseen finished work on a timer is how you miss it. |
| `Seen · 2h` | grey | Done, and acknowledged. The whole card dims so live work reads louder. |
| `8m…` | grey | **Low confidence.** Serac thinks it's live but can't tell running from waiting well enough to claim it, so it shows only elapsed time. The ellipsis means "not sure". |

On terminal cards only, a further qualifier:

- **`· live`** — the process is still attached; you can resume it where it sits.
- **`· ended`** — the process is gone; picking this up means a cold start.
- **Neither** — the registry can't say, and Serac won't guess. Absence is "unknown", not "no".

## The meta row

Left to right, in render order. Learn the sequence and position reads as well as shape.

### Model pill — e.g. `Fable 5`

Which model is answering, coloured by **relative cost**: blue is cheap, orange is dear. Hue is a separate register from status — saturation and lightness are fixed, so a model pill never reads as a state.

Also the copy affordance: **click it to copy the session's transcript path**. A path is self-identifying when pasted into another Claude session, where a bare UUID gets mistaken for other kinds of id.

A trailing `*` means the model was inferred rather than confirmed. An unrecognised family still gets its own stable colour rather than falling into one bucket.

### Permission mode

How much the session asks before it acts. Each mode has its own colour, so the badge is never mistaken for a status signal.

| Badge | Mode | Means |
|---|---|---|
| ✋ `manual` | `default` | Asks every time |
| `</>` `edits` | `acceptEdits` | Accepts file edits without asking |
| 📋 `plan` | `plan` | Read-only until you approve a plan |
| ⚡ `auto` | `auto` | Decides for itself |
| 🔀 `bypass` | `bypassPermissions` | Asks nothing at all — borrows the conflict red on purpose |

### Worktree chip — e.g. `WP`, `RL`

Two letters and a tint, shown **only when the session is in a different worktree than the one you have open**. Most cards carry none.

Letters come from the tail of the folder name (`fix-workflow-resume-liveness` → `RL`); the tint is hashed from it. **Identity comes from the folder, never the branch** — branches get renamed and rebased away, and a chip that changed colour under you is worse than no chip. Hover for the full path.

### 📡 — started from your phone

The session was spawned remotely and lives in a throwaway `bridge-cse_*` worktree created just for it. It gets a fixed dish rather than initials, because a monogram of a random id looks like identity while carrying none.

### Still going, quietly

Three ways a finished-looking card isn't finished. All tinted with the running colour: a *done* card that will start itself again in four minutes is idle, not finished. None of them change the status.

| Badge | Means |
|---|---|
| `2 🐚` | Background shells still running after the turn ended |
| `💤 4m` | A scheduled wake-up, with the countdown |
| `loop · 3` | Session crons that will re-invoke it |

### `3 shared files`

Another **active** session is editing the same files — a merge conflict in the making. Hover for the list. Off by default (`serac.show.fileCollisions`). Finished sessions are ignored; their edits aren't a live conflict.

### 🤖 `3` → — agents

Work happening underneath: workflow agents, subagents, or teammates, collapsed into **one chip** rather than competing for the row. Click to drill into the detail panel, which offers a switcher across them.

The number is how many are **live right now**; no number means none are. The chip is tinted by *its own* state, not the card's — live agents under an idle session still read as running.

### ⚠ and ⛔ — two windows, one session

| Chip | Means |
|---|---|
| **⛔** | **Active in another VS Code window.** The card dims, but this chip stays full strength — a dimmed card with nothing bright on it just reads as unexplained greying. Click to switch to that window. |
| **⚠** | **Live in two windows at once.** Two processes can append to the same conversation file. Click for a picker: keep it here, or release it. The card is *not* dimmed — this window's claim is as real as the other's. |

Both are gated behind `serac.experimental.externalWriterBlock` (default off).

### 📜 and × — actions

Always last. **📜** opens the transcript. **×** archives the card; on a live session it reads "Archive" and is the escape hatch for a status that's got stuck.

## The rows underneath

**⎇ branch** — gets a line to itself because it's the widest, most variable thing on a card. Inline, it pushed the action buttons into wrapping. Hidden when there's no branch, and controlled by `serac.show.gitBranch`.

**Context bar** — a 2px hairline across the card's **bottom edge** (not a row in the body), filling left to right with how full the context window is. Measured against the **auto-compact threshold** rather than the model's raw capacity, since the threshold is what actually interrupts the session. Past 60% of that threshold it brightens. Hover anywhere on the bar for both numbers.

**Activity line** — what the session is doing. On a finished card it switches to **what it finished with**: the last thing it said, not the last tool it ran, because that's the useful line once work has stopped. Controlled by `serac.show.previewText`.

## States that change the whole card

| State | Treatment |
|---|---|
| **Focused** | The card you last clicked, or one auto-focused because a single new chat arrived. The tint follows the status, so focus never overwrites the state colour. |
| **Another window has it** | Everything fades except the ⛔ chip. The preview line is dropped too — another window's live activity isn't useful here. |
| **Spent** | A phone-started session whose process has ended. Its worktree was made for that one session and won't be reused, so **nothing will ever resume this card**; it recedes rather than competing for attention. Only remote cards get this — an ordinary worktree session that ended is resumable and stays at full strength. |

## The top bar

**Counts** — one number per state in the same colours the cards use. A state with nothing in it is omitted rather than shown as a zero.

**📡 Remote Control** — at the far right, whether a `claude rc` server is serving this workspace: that is, whether you can **start a new session here from your phone** right now. Filled teal dot and a bright dish when it is; hollow dot and a faded dish when it isn't. The two states differ by the dot's *fill* as well as its colour, so it survives a colour-blind read, and it's wordless by design — hover for the explanation.

Worth knowing: sessions you started *here* are reachable from the phone either way. The server is only needed to **start new ones**. See [`scripts/rc-headless/`](../scripts/rc-headless/) for keeping one running without a terminal open.

## Four rules the whole thing follows

1. **Status colour is reserved.** Peach, blue, teal, and grey mean waiting, running, done, and seen — nothing else may use them that way. Model hue and worktree tint are separate registers on purpose.
2. **Shape carries the signal too.** Filled pill, outlined chip, hollow dot. Nothing depends on colour alone, so the panel still reads without it.
3. **Absence means unknown.** A missing annotation is never "no". Serac shows what it can confirm and stays quiet about the rest rather than guessing.
4. **The tooltip carries the words.** Chips are small because sidebars are narrow. Every one has a hover that says it in full — the glyph is the index, not the whole entry.
