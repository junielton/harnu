# ADR-0025: The bake-off harness is a `claude -p` script in this repo, and its holdout lives outside it

**Status:** Accepted (2026-11-07, operator; spec decisions D-1 and D-2)
**Date:** 2026-11-07
**Author:** agent (T676 spec)
**Technical context:** [`docs/specs/2026-11-07-bakeoff-harness/spec.md`](../specs/2026-11-07-bakeoff-harness/spec.md), [`docs/prds/T676-bakeoff-harness.md`](../prds/T676-bakeoff-harness.md), `scripts/eval/mission-behavior/agent.mjs`, `scripts/eval/mission-behavior/harnu.mjs` (`cleanEnv`), `scripts/eval/mission-behavior/procs.mjs` (`escalate`), `docs/lessons/testing/006-eval-harness-grades-state-through-the-real-transport.md`, `docs/specs/2026-11-harnu-spec/bakeoff/protocol.md`

---

## 1. Context

The T601 S-10 bake-off was run by hand. One orchestrating session started the contestants, relayed every question to a simulated operator and every answer back, wrote the hidden truth, and kept it out of the working tree by deleting it during the runs and restoring it afterwards. T676 makes that mechanical and repeatable across many problems. Two choices shape everything else, and the slices cannot settle them one at a time:

- **How the harness drives Claude**, and in particular how a simulated operator answers a contestant that stops to ask a question, with no session in the middle.
- **Where the holdout corpus lives.** The holdout is the part of the corpus that confirms a skill version and must never be read by a session tuning the skill. This repo is public, and every session that edits the skill can read all of it.

The repo already has one harness that drives headless Claude: the mission behavior eval. It runs `claude -p` through `vite-node`, keeps stream-json as evidence, scrubs the inherited Claude Code environment (`cleanEnv`), and kills what it starts with a SIGTERM → SIGKILL ledger (`escalate`).

## 2. Decision

**(a) The harness is a set of ES modules under `scripts/eval/bakeoff/`, run by `vite-node` as `npm run eval:bakeoff`, and it drives every role with `claude -p` (D-1).**
Every role is a headless `claude -p` run: contestant, simulated operator, judge and builder. Each run sends its prompt over stdin (never argv, so a large bundle cannot overflow the argument limit), and uses `--output-format stream-json --verbose`, `--setting-sources project`, the role's model, tool allowlist and turn cap, `cleanEnv()`, and a deadline that escalates through `escalate`. A session starts with `--session-id` and continues with `--resume <id>`. The simulated operator works through that resume. The contestant ends a turn with a `QUESTION TO OPERATOR:` line. The harness passes the question to the operator's own session, which is resumed per question so it remembers earlier answers. It then sends only the operator's `ANSWER` text back into the contestant's session with `claude -p --resume <contestant session id>`. Sessions persist because resume needs their transcripts: the harness does not pass `--no-session-persistence`. After each unit it moves the transcripts from `~/.claude/projects/` into the unit's directory. Token usage is read from those transcripts with the S-10 method. The modules import only `node:` built-ins, their siblings and the two mission-behavior helpers, so the directory can be lifted into its own package later without untangling a dependency graph.

**(b) The holdout is a private GitHub repo, cloned outside this repo, named by `HARNU_BAKEOFF_HOLDOUT`, and nothing derived from it is written into this repo (D-2).**
Before any work, the harness resolves the variable, the cache directory and the holdout work directory (`HARNU_BAKEOFF_WORK`, default `~/.cache/harnu-bakeoff/work`) to their realpaths, and refuses any of them that equals or lies under this worktree's toplevel or the main checkout (`HOLDOUT_INSIDE_REPO`, `CACHE_INSIDE_REPO`, `WORK_NOT_CONTAINED`); the work directory must also be outside the cache and the holdout clone. Everything a holdout problem produces while it runs goes under `$HARNU_BAKEOFF_WORK/rounds/<round-id>/` (the contestant's clone, the transcripts, the artifact, the judgments, the build), and its validation results under `$HARNU_BAKEOFF_WORK/validation/`, so no contestant runs inside the holdout clone; holdout authoring happens under the holdout clone's `.rounds/authoring/`. Holdout scores do reach this repo, in the round's report under the gitignored `.harnu/eval/bakeoff/`. They arrive only as per-contestant aggregates (mean, spread, `n`), with no per-problem row or label (decision D-12), and never as text: no request, atom, judge note, assumption or failing test name. Per-problem numbers stay in the holdout clone's `.rounds/<round-id>/`. Privacy from another session on this machine is by convention: no session tuning the skill is handed the path, and there is no OS sandbox. No contestant, operator, judge or builder runs with a working directory inside this repo, for dev problems either: the spec fixes each role's cwd and `--add-dir` list, and a contestant or builder cwd is a clone outside the problem directory. A cwd here would load this repo's `CLAUDE.md` and put the dev corpus's hidden tests one `Read` away.

## 3. Consequences

**Positive**

- No session sits in the middle. The S-10 confound "the orchestrator relayed" disappears, and a round needs nobody once it starts.
- One eval convention in the repo: same runner, same environment scrub, same kill discipline, same evidence format as `eval:mission`. A contributor who knows one knows the other.
- No new dependency in `package.json`, and the harness exercises the same `claude` binary and flags a real session uses.
- The holdout files are kept out of this repo by a mechanical check: a path inside it is refused. A session editing the skill in this repo is not handed the holdout's path.
- Reports can be shared, holdout numbers included, without leaking the holdout. They are written under the gitignored `.harnu/eval/bakeoff/`, so sharing one is a deliberate copy; only the dry-run and reproduction reports are committed, under `docs/specs/2026-11-07-bakeoff-harness/`.

**Negative and accepted costs**

- Session persistence means transcripts appear briefly under `~/.claude/projects/` while a unit runs (a live Harnu may list their folders), and the move-out step must run on every exit path, Ctrl-C included.
- Detecting a question depends on the contestant following the `QUESTION TO OPERATOR:` / `ARTIFACT DONE:` protocol. A contestant that ignores it is nudged, then ends `incomplete`. That is a measured outcome, not a harness error, but it is a frame every contestant shares.
- The Agent SDK would give in-process control of each turn and typed usage. We give that up and parse stream-json and transcripts, which can drift when the CLI's formats change. The transcript fixtures in the unit tests are the guard.
- The holdout's privacy from a session on the same machine is by convention, not enforcement: a session given the path could read the files, because there is no OS sandbox.
- The holdout needs an operator action: create the private repo, author its problems in the sandbox, clone it outside the repo. It also needs a second place to back up. A contributor without access can run dev rounds only.
- `.mjs` without types is weaker than TypeScript for a harness of this size. The mission-behavior eval made the same trade, and the vitest suite over the harness compensates.

## 4. Alternatives considered

| option                                                              | one line                                                                                                           | verdict          |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ---------------- |
| **`scripts/eval/bakeoff/` on `claude -p`, operator via `--resume`** | The repo's existing eval convention, no dependency                                                                 | **Chosen** (D-1) |
| `tools/bakeoff/` in TypeScript on the Claude Agent SDK              | Programmatic turns and usage, but a new dependency and a second convention beside `eval:mission`                   | Rejected (D-1)   |
| **A private GitHub repo outside this repo**                         | Private by construction, versioned, backed up; containment is a realpath check                                     | **Chosen** (D-2) |
| A local untracked directory                                         | Nothing to create, but no history, no backup, and inside the repo it is one `git add -f` from public               | Rejected (D-2)   |
| Encrypted holdout files in this repo                                | One place for everything, but a key to manage and a ciphertext in plain view of every session that edits the skill | Rejected (D-2)   |

## 5. Revisit when

- The `claude` CLI changes its stream-json events or its transcript layout in a way the fixtures cannot follow: reconsider the Agent SDK (a new ADR).
- The harness is extracted into its own package: the import rule in (a) is what makes that a move, not a rewrite.
- A second maintainer needs the holdout: they get access to the private repo. A shared holdout that has to be read in this repo would reopen (b).
