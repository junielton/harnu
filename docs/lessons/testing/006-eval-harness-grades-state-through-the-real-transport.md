# 006-eval-harness-grades-state-through-the-real-transport: an "eval harness" grades disk state, through the real transport, and proves its graders can fail

**Category:** testing
**Discovered in:** T358 S5 — `scripts/eval/mission-behavior/` (2026-09-28)
**Status:** active

## The house term

Before T358 this repo had no "eval harness" (design
`docs/specs/2026-09-26-mission-progress/design.md` §12 found zero precedent). It now means
something specific, and four layers carry the name:

| Layer         | What it checks                                                 | Where                                  |
| ------------- | -------------------------------------------------------------- | -------------------------------------- |
| contract eval | each verb's input schema + ACK shape, in-process               | `tests/mission-verbs-contract.test.ts` |
| migration     | the legacy goal-file importer on a copied corpus               | S7                                     |
| behavior eval | real `claude -p` sessions → real MCP transport → state on disk | `npm run eval:mission` (this lesson)   |
| shadow phase  | legacy goal file vs structured mission, divergence per tick    | S8, part of the behavior harness       |

> **Superseded 2026-10-01 (Mission v3, T381; closes T371):** the shadow-phase layer was retired. The
> `mission` skill no longer mirrors into a legacy goal file, and the divergence checker, its
> scenario and `npm run eval:shadow` are gone. Three layers remain. The rules below still hold,
> and they apply to the behavior eval unchanged.

A **behavior eval** here is not a `claude plugin eval` case and not a vitest file: it boots a
throwaway, isolated Harnu instance, points scripted headless sessions at that instance's own
`harnu.mcp.json` (port + bearer token), and grades what they left in `.harnu/missions/*.md`.

## The bug class it exists to prevent

Three ways an eval reports green while the product is broken:

1. **Graded through a mock.** `claude plugin eval` only starts MCP servers a plugin declares;
   Harnu's server is a loopback HTTP server handed to each session per spawn, so a plugin eval
   can only reach a mock of it — and a grader checking a mocked ACK checks the mock. The
   contract suite skips the HTTP transport and bearer auth entirely. Neither can see drift
   between the catalog schema a session actually receives and what the handler does with it.
2. **Graded by a model's verdict.** An LLM grader reading a transcript grades what the agent
   _said_ happened. A verb that ACKs `ok: true` and writes nothing passes it.
3. **A grader that cannot fail.** An assertion on a field nobody writes, a selector that
   matches nothing, a template placeholder left unresolved — each turns into a pass.

## The rules (and why)

- **Grade state, never a verdict.** `grade.mjs` reads `.harnu/missions/*.md` with `js-yaml`
  directly — not through `mission-core.ts`, so a drift in the product's parser cannot make
  the grader agree with it. ACKs and transcripts are kept as evidence, never graded.
- **Every grade runs against deliberately broken copies too.** Each scenario lists `breaks`
  (the fixed end re-labelled `self-verified`, one concurrent link dropped, a withheld marker
  appended…); the harness writes each as real mission files and the grade MUST fail on it.
  A break the grader passes fails the scenario. This runs on every run, not once.
- **Go through the real transport and the real spawn paths.** Agents get `--mcp-config` from
  the instance's own `harnu.mcp.json` and no built-in tools (`--tools ""`), so the only way to
  change a mission file is a verb. Spawn-shape checks go through Harnu's own `create_session`
  and manifest dispatch, never through an emulated argv.
- **The harness plays the operator only where the product has no verb** (draft → active, the
  approved re-scope, the workspace-trust dialog in its own throwaway repo) — and uses the
  product's own `mission-core.ts` transitions for it, not a copy of them.
- **Keep scenarios minimal and cheap.** Haiku by default, exact calls spelled out, one run
  per actor; the full suite is ~$0.25 and ~2.5 minutes.

## Gotchas this harness hit

- **An eval launched from inside a Claude Code session inherits `CLAUDE_CODE_CHILD_SESSION`.**
  Every session the isolated Harnu spawned then ran with transcript saving OFF, so
  `create_session` never saw a transcript and returned `SPAWN_NOT_MATERIALIZED`. Scrub
  `CLAUDECODE`, `CLAUDE_CODE_*` and `CLAUDE_PID` from the environment of the instance and of
  every `claude -p` (`cleanEnv()` in `harnu.mjs`).
- **Workspace trust is per path, with no inheritance into a nested repo.** A session Harnu
  spawns into a fresh throwaway repo sits on "Do you trust this folder?" forever. The sandbox
  path is stable per checkout so the dialog is answered once, not every run.
- **A PTY replay buffer renders spaces as cursor moves.** Matching screen text needs escapes
  stripped first — whitespace-stripping alone never matched `Yes, I trust this folder`.
- **`--remote-debugging-port` flips the main process into dev mode** (see
  `testing/002-…`), so the instance serves `out/renderer` itself and sets
  `ELECTRON_RENDERER_URL` to `127.0.0.1`, never `localhost`.

## How to detect in reviews

- A new eval scenario with no `breaks`, or a break that mutates a field no assertion reads.
- A grader that imports product code to parse the state it is grading.
- An eval that asserts on an ACK, a transcript line or a model's reply instead of the file.
- A scenario that emulates a spawn shape (hand-built argv, a `claude -p` without
  `--mcp-config`) instead of driving Harnu's own spawn path.

## Related

- `docs/specs/2026-09-26-mission-progress/design.md` §12 (decision 19)
- `docs/plans/2026-09-26-mission-progress.md` — Review Focus, Slice S5
- `scripts/eval/mission-behavior/README.md` — how to run and extend it
- `testing/001-blind-assertion-false-green.md`, `testing/005-mcp-gate-tests-never-exercised-the-renderer-actuation-path.md`
