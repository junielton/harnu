# Mission behavior eval

Layer 3 of the mission eval harness (lesson `docs/lessons/testing/006-…`): scripted `claude -p`
sessions call the `mission_*` verbs through a throwaway Harnu instance's **real** MCP transport, and
the result is graded by reading the v4 records in `.harnu/missions-v4/` (plus any plain file an
assertion names) — never by a model's verdict.

```bash
npm run eval:mission                         # every scenario (builds the app first)
npm run eval:mission -- cold-start           # one or more by name
npm run eval:mission -- --list               # what exists
npm run eval:mission -- --no-build           # reuse the current out/ build
npm run eval:mission -- --model sonnet       # agent model (default haiku)
```

Exit code `0` when every non-skipped scenario passes, `1` on any grading failure, `2` when the
harness itself crashed. It spends real API time.

## The scenarios (Missions v4, S-33)

| Scenario            | Role      | What it shows                                                                                                                          | Spec  |
| ------------------- | --------- | -------------------------------------------------------------------------------------------------------------------------------------- | ----- |
| `create-milestones` | scripted  | a plan with milestones lands as a v4 record: criteria on every step, the leader attached, a decision in the Log                        | AC-81 |
| `attach`            | scripted  | a session that is not attached asks to join: one pending request, never attached, never the leader                                     | AC-81 |
| `settle`            | scripted  | a second session settles a criterion, the builder only self-checks, the operator's criterion stays open                                | AC-81 |
| `hand-off`          | `session` | a leader near its context limit asks the operator for a hand-off and never switches itself                                             | AC-81 |
| `cold-start`        | `cold`    | a fresh session started from the mission summary alone answers: the goal, the next step, what is blocked, what waits, what was decided | AC-78 |
| `proactive-creates` | `session` | a multi-step request with no mission makes the session `mission_create`, with its steps, before the work, without asking first         | AC-79 |
| `proactive-none`    | `session` | a one-line question creates no mission                                                                                                 | AC-80 |

There is no scenario for a campaign or a steward: neither exists in v4 (AC-81).

**Models and cost.** The `session` scenarios test whether a model follows a bundled skill, and real
sessions run on sonnet or opus: run them with `--model sonnet`. A model run is stochastic, so a result
is reported with its model and its count (one pass is not a proof): run each of `cold-start`,
`proactive-creates` and `proactive-none` three times. Measured on 2026-10-01, a full v3 run on sonnet
cost $1.81 for 12 scenarios; the three live ones here are a read of one skill (about 130 lines plus the
writing contract) and one to five tool calls each.

**What `npm test` proves, and what it cannot.** `tests/mission-v4-eval-scenarios.test.ts` proves the
scenarios' shape, the graders (a good run passes, every planted fault fails), the seeding and the
framing. It proves nothing about what a model does. The live runs are the only behavioural proof.

**Needs:** a logged-in `claude` on `PATH` (its login is read from the operator's normal `~/.claude`, or
from `CLAUDE_CONFIG_DIR` when that is set: the harness never gives `claude` another HOME and never
copies, links or rewrites a credential), `node_modules` installed, and on Linux `xvfb-run` (no window
opens). A login that arrives as a `CLAUDE_CODE_*` environment variable (for example
`CLAUDE_CODE_OAUTH_TOKEN`) is stripped by `cleanEnv`, so use the on-disk login or `ANTHROPIC_API_KEY`.
It launches its own isolated instance (`--user-data-dir` under the run dir), so a running Harnu is
never touched.

**The instance never touches the operator's `~/.claude`.** Harnu installs its hooks and statusLine into
`~/.claude/settings.json` at boot and removes them at exit, so the instance the harness starts gets its
own throwaway HOME, XDG directories and no `CLAUDE_CONFIG_DIR`, all under `<run dir>/home`
(`instanceEnv` in `harnu.mjs`), and `assertInstanceIsolated` stops the run before the spawn if any of
them points at the operator's. Nothing from the real `~/.claude` is needed: the scenarios work on the
sandbox repo's `.harnu/`. Only the scripted `claude` agents keep the operator's environment, because they
need its on-disk login (nothing is copied, linked or moved). The only thing the harness still does under
`~/.claude` is delete the exact sandbox folders' transcript directories (`projects/<sandbox slug>`) that
Claude wrote for spawned children.

## What a run leaves behind

`.harnu/eval/mission-behavior/<timestamp>/` (gitignored): `harnu.log`, Harnu's own `mcp-audit.json`
(every verb call), `summary.json`, and per scenario the agents' stream-json output and replies, the
summary a `cold` turn was given (`summary-<name>.txt`), and the graded records (`final/missions-v4`
plus `final/eval`, and each `checkpoint-*/`) with every deliberately broken copy under `breaks/`.

The throwaway repos live at `$TMPDIR/harnu-mission-eval-<hash of this checkout>/<scenario>`. The path is
stable on purpose: Claude Code asks for workspace trust once per path.

## What it kills, and when

Everything the harness starts bills the operator, so everything it starts is killed — and nothing it did
not start. The instance is launched as its own process group, and its process tree is recorded by pid
**and** kernel start time while it is intact (`procs.mjs`), so a recycled pid is never signalled.

- **Scripted agents** (`claude -p`): `--max-turns 12` (18 for a `session` or `owner` turn, 3 for a
  `cold` one), a 180 s deadline, SIGTERM then SIGKILL.
- **The instance:** graceful quit, then SIGTERM → SIGKILL on its process group and on every recorded
  process. A boot that never comes up is torn down the same way.
- **Ctrl-C / SIGTERM** on the harness kills all of the above, cleans the sandbox transcripts and exits
  `130`.

Scripted agents run with `--no-session-persistence` and never write a transcript.

## Files

| File               | Role                                                                                                                                 |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| `run.mjs`          | CLI, scenario replay, reporting                                                                                                      |
| `harnu.mjs`        | the isolated instance: build, xvfb, static renderer, CDP, MCP client, teardown                                                       |
| `agent.mjs`        | one `claude -p` turn: the roles, their frames and arguments, the v4 verb allowlist, the turn record                                  |
| `grade.mjs`        | reads the v4 records with `js-yaml` and evaluates assertions + breaks                                                                |
| `seed-v4.mjs`      | writes a v4 record through the product's own writer, for a state no verb reaches cheaply                                             |
| `procs.mjs`        | the process ledger and SIGTERM → SIGKILL escalation (unit-tested)                                                                    |
| `scenarios/*.json` | the seven v4 scenarios above                                                                                                         |
| `fixtures/*`       | synthetic inputs a turn works from (`notes-spec.md`, `codename.txt`) and one product-written v4 record (`v4/`) the grader tests read |

`run.mjs` still imports `src/main/mission-core.ts` and still carries the v3-only phases that use it
(`seed`, `operator`, `legacyFile`, `probe`, `precondition`, `burst`, `spawn`, `gateCache`): no v4
scenario uses them, and they go with that import when `mission-core` is removed (S-40).

## Writing a scenario

```jsonc
{
  "name": "my-scenario",          // also the sandbox folder name
  "order": 6,                     // run order
  "title": "…", "label": "…", "description": "…",
  "skip": false, "skipReason": "…", // a skipped entry is still listed, visibly
  "agents": ["A", "B"],           // each gets a fresh session UUID: {{session.A}}
  "phases": [ … ],
  "assert": [ … ],                // graded on the final state
  "breaks": [ … ]                 // each MUST make the grade fail
}
```

**Phases** run in order:

- `{ "agent": "A", "prompt": "1. mcp__harnu__mission_create with …" }` — one scripted `claude -p` turn.
  Keep the prompt to the exact calls; `{{self}}` is the agent's own session UUID. `"tools": ["Read", "Write"]`
  grants those built-ins (default: none — only the `mission_*` verbs).
- `{ "agent": "A", "role": "owner" | "session", "tools": ["Read"], "prompt": "Skill file: … <the situation>" }`
  — a BEHAVIOR turn: the frame lists no calls; the agent reads a bundled skill the scenario `copyIn`s and
  decides its own calls. `owner` frames it as an orchestration; `session` frames it as an ordinary session
  (use it to test a rule the frame must not announce, like the proactive one). Never name the verb the
  scenario grades in the prompt. A question to the operator goes in the final reply (`claude -p` has no
  `AskUserQuestion`).
- `{ "agent": "B", "role": "cold", "prompt": "…" }` — a fresh session with NO tool, NO Harnu server and no
  memory: it answers from its prompt alone.
- `"record": { "tag", "file"?: true, "mission"?: slug | "*", "as"?: "A" }` on an agent phase: the harness
  (never the model) records the turn. `file: true` writes `.eval/turn-<tag>.txt` (`tools=<calls in order>`,
  `asked=<b>`, `---`, the reply), which needs no mission; with `mission` it also `mission_log`s
  `EVAL-TURN[<tag>] asked=<b> tools=<calls>` into it. `asked` is true when the reply holds a `?` or the
  word "confirm". Every agent's final reply is also kept as `agent-<n>-<X>-reply.txt`.
- `{ "seedV4": spec | [specs] }` — write a v4 record straight to `.harnu/missions-v4/` through the product's
  writer (see the header of `seed-v4.mjs` for the spec: milestones, steps with criteria, links and
  blockers, sessions, a Log of decisions). `startedAt: "now"` stamps a step as started.
- `{ "summary": { "mission": slug, "as": "A", "name": "main" } }` — the harness reads `mission_get`'s
  `summary` through the real transport as session A and keeps it as `{{summary.main}}`.
- `{ "copyIn": { "from": repoPath, "to": sandboxPath } | [...] }` — copy a file of this checkout into the
  sandbox (a behavior turn reads a shipped skill there, so no read leaves its cwd).
- `{ "parallel": [phase, …] }` — run phases at the same time.
- `{ "checkpoint": "name", "assert": [...], "breaks": [...] }` — grade mid-scenario.

**Placeholders** (`{{…}}`) resolve in prompts, assertions, breaks and seeds: `folder`, `session.<X>`,
`m.<slug>.id` (the slug is the record file name's), `m._only.id` (when the repo holds exactly one
mission), `summary.<name>`. An unresolved one fails the scenario rather than comparing against the
literal text.

**Assertions** — `{ "missionCount": n }` (v4 records), `{ "legacyMissionCount": n }` (files in the v3
directory, which nothing grades), or `{ "mission": slug, "step"?: sel, "path"?: "a.b", <matcher> }` with a
matcher of `equals` (deep-partial), `notEquals`, `oneOf`, `exists`, `length`, `lengthAtLeast`, `includes`
(list contains, deep-partial), `excludes`, `sha256`. A step selector is `id:<stp-n>`, `index:<n>` or
`title:<exact>`; a path may index a list (`acs.0.settled.by`). Also `{ "mission", "anyBlocker" | "anyLink" |
"anyCriterion": {…}, "present"?: bool }`; `{ "mission", "logContains" | "logNotContains": "…" }`;
`{ "mission", "logLine": "<prefix>", "contains"?, "notContains"?, "matches"?, "notMatches"?, "flags"? }` —
some Log line starts with the prefix and every such line passes; `{ "mission", "stepCount" | "criterionCount":
{…}, "equals": n }`; and `{ "file": path, "exists" | "sha256" | "contains" | "notContains" | "matches" |
"notMatches", "flags"? }` for a plain sandbox file. Any deep-partial value may be an operator: `{ "$exists":
bool }`, `{ "$truthy": bool }` or `{ "$match": "regex", "$flags"?: "i" }`. `"mission": "*"` is the repo's
single mission. `label` overrides the report line.

**Breaks** — `{ "name", "mutate": [ { "mission", "step"?, "set": { "a.b": v }, "unset": "a.b", "logAppend":
"…", "logRemove": "…" } | { "drop": slug } | { "duplicate": slug } | { "addMission": slug } | { "addV3Mission":
file } | { "file", "write": "…" } | { "file", "delete": true } | { "mission", "clearBlockers": true } |
{ "mission", "eachBlocker": { "set": {…} } } | { "mission", "eachLink": { "match": {…}, "remove": true } } |
{ "mission", "removeSteps": {…} } | { "mission", "eachStep" | "eachCriterion": { "match": {…}, "set"?, "unset"? } } ] }`.
Write one per regression the scenario exists to catch.

**Check a grader offline before a live run.** A live run costs real API time, so iterate on a new
scenario's grader in the unit suite instead: build the state a correct session leaves on disk, grade it
with `gradeState`, and grade every break through `applyBreak` — the good state must pass and every break
must fail. `tests/mission-v4-eval-scenarios.test.ts` does this for EVERY scenario, and fails when a
scenario file exists that it does not grade. It also grades a v4 record the product's own writer produced
(`fixtures/v4/`), to prove the grader reads what Harnu writes.
