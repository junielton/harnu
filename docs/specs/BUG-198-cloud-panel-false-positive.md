# BUG-198 — "This session lives in the cloud" false positive on a fresh session

> Draft spec (revised after measurement). The executor lands this file at
> `docs/specs/BUG-198-cloud-panel-false-positive.md` as the FIRST commit of the branch.

## Symptom

Open a new session. Two seconds later the terminal is replaced by `CloudSessionPanel`
("This session lives in the cloud — … nothing recorded on disk yet"). The session is
lost: the panel has no action, and restarting the app shows the same panel for that
session. Reported by a teammate as "every time, ~2 s after opening" on their machine;
reproduced intermittently on the maintainer's machine.

## Root cause (verified in code)

1. `src/main/claude-reader.ts:1168` classifies a transcript as a cloud stub purely by
   turn count: `resumable: header.turnCount > 0`. (The legacy `sessions-index.json`
   path does the same with `messageCount`, `:270`.)
2. Claude Code creates the `.jsonl` and writes metadata lines (`last-prompt`, `mode`,
   `permission-mode`, `atis-latch`, `queue-operation`…) BEFORE the first `user` line.
3. The watcher fires on that file. `sessions.ts:5242/5251` (`collapseSyntheticInto`)
   renames the live synthetic row to the real id; the next `reconcileSessions`
   (`sessions.ts:4340`) copies the disk row's `resumable: false` onto it —
   `resumable` is not in `RENDERER_ONLY_SESSION_KEYS`, so disk wins.
4. `App.vue:333` (`showCloudSession`) swaps `TerminalPane` for `CloudSessionPanel`;
   `TerminalPane.vue:566` refuses to spawn for `resumable === false`. The live PTY is
   detached (not killed) and invisible.
5. Lock-in: with no terminal the user cannot send the first prompt, so the file never
   gains a turn, so the classification never flips back. `design.md:7048` — the
   panel has "no clickable actions in v1".

## Measurement (maintainer machine, CLI 2.1.304, 120 most recent transcripts, 2026-10-19)

`stat -c %W <jsonl>` (birth) vs. timestamp of the first non-sidechain `user` line:

| Session kind                                            | JSONL exists before first `user` line |
| ------------------------------------------------------- | ------------------------------------- |
| Interactive (no initial prompt)                         | 0.0 – 0.9 s                           |
| Argv-prompt (`queue-operation` first; Harnu dispatches) | 2 – 7 s                               |

So the race window is sub-second for a hand-opened session (explains "sometimes") and
seconds-wide for every agent-dispatched session. The teammate's "every time, ~2 s"
suggests a CLI build that creates the file at boot rather than at first prompt — open
question Q1 below. The Harnu defect is identical in both cases.

Discarded hypotheses: Remote Control / `bridge-session` is NOT the trigger — nearly
every local transcript carries `bridge-session`, and the teammate's screenshot shows the
`bodyNoBridge` copy, i.e. the file was read before any bridge line existed.

## Design

Three independent guards; each one alone would have prevented the lock-in.

**G1 — A row with a live terminal in this app run is never a cloud stub.** The cloud
panel predicate must require "no `LiveTerminal` for this id" in addition to
`resumable === false`. Disk truth about turn count is irrelevant while the process that
will write the turns is alive.

**G2 — Reconcile never downgrades `resumable` on a row born synthetic in this app run**
(`bornSyntheticIds`). Disk may upgrade it (false → true) at any time. Scope: this app
run only; after a restart disk truth applies (G3 then decides).

**G3 — Reader: zero turns alone does not mean cloud.** A zero-turn transcript is a cloud
stub only when it also carries a `bridge-session` line AND its mtime is older than a
grace window (proposed 60 s). A zero-turn file younger than that, or without a bridge
line, is `resumable: true` — if `claude --resume` then fails, the CLI's own error is
visible in the terminal, which is strictly better than a silent panel.

**G4 — No dead end.** `CloudSessionPanel` gains one secondary action, "Resume anyway",
which spawns the terminal regardless of `resumable`. `design.md` §6 "Cloud session
panel" is updated in the same change (button spec; the "no clickable actions in v1"
line is removed). i18n keys in BOTH `en.json` and `pt-BR.json`.

**G5 — Self-heal.** When a transcript classified cloud gains its first turn, the next
index update flips `resumable` to true and the terminal pane re-attaches the cached
`LiveTerminal` (or spawns `claude-resume` if none).

## Acceptance criteria

- [ ] AC-1 — A session with a live `LiveTerminal` never renders `CloudSessionPanel`, whatever disk says about turn count — verify: test (store/App predicate unit test) — source: this spec G1
- [ ] AC-2 — `reconcileSessions` with a disk row `resumable:false` for an id in `bornSyntheticIds` leaves the row `resumable:true`; a disk row `resumable:true` still upgrades a `false` row — verify: test — source: G2
- [ ] AC-3 — Reader: zero-turn JSONL without `bridge-session` → `resumable:true`; zero-turn with `bridge-session` and mtime < 60 s → `resumable:true`; zero-turn with `bridge-session` and mtime ≥ 60 s → `resumable:false` — verify: test (fixture JSONLs, mtime set via `utimes`) — source: G3
- [ ] AC-4 — `CloudSessionPanel` shows a "Resume anyway" action that mounts the terminal for that session; copy exists in `en.json` and `pt-BR.json`; `design.md` §6 updated — verify: visual (screenshot of the panel attached to the card) + review — source: G4
- [ ] AC-5 — Regression test reproducing the race end-to-end in the store: synthetic created → watcher surfaces real id with a zero-turn disk row → the cloud predicate stays false and the row keeps `resumable:true` — verify: test — source: §Root cause steps 3–4
- [ ] AC-6 — Self-heal: a row classified cloud whose next disk reconcile carries `resumable:true` re-renders the terminal pane — verify: test — source: G5
- [ ] AC-7 (provisional) — Premise check recorded in the spec: run `claude --resume <id>` against a synthetic zero-turn JSONL in a THROWAWAY project dir (never a real project) on the installed CLI and record whether it fails ("No conversation found") or opens — verify: manual (output pasted into the spec's Q2) — source: orchestrator; derived from the panel's own justification comment
- [ ] AC-8 — `CHANGELOG.md` entry under today's date (`### Fixed`), `docs/user/` page for sessions updated for the new "Resume anyway" action — verify: review — source: CLAUDE.md contracts

## Open questions

- Q1 — Teammate's CLI version and file-birth timing. One-liner for them to run after opening a fresh session and typing one prompt: `f=$(ls -t ~/.claude/projects/*/*.jsonl | head -1); echo "$(claude --version) birth=$(stat -c %W "$f" 2>/dev/null || stat -f %B "$f") first_user=$(grep -m1 '"type":"user"' "$f" | grep -oE '"timestamp":"[^"]+"')"`
- Q2 — Does `claude --resume` on a zero-turn local transcript still fail on 2.1.304? (AC-7 answers it.) If it does NOT fail, a follow-up card should drop the local-file cloud classification entirely and keep the panel for bridge-only stubs.

## Out of scope

Sidebar cloud affordance (§6 Session status → cloud), hibernation, `sessions-index.json`
fast path beyond mirroring G3's rule, any refactor of `reconcileSessions`.
