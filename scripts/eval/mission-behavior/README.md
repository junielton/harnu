# Mission behavior eval

Layer 3 of the mission eval harness (design `docs/specs/2026-09-26-mission-progress/design.md`
§12, lesson `docs/lessons/testing/006-…`): scripted `claude -p` sessions call the `mission_*`
verbs through a throwaway Harnu instance's **real** MCP transport, and the result is graded by
reading `.harnu/missions/*.md` (plus any plain file an assertion names — S7's legacy goal files,
which an import must leave untouched) — never by a model's verdict.

```bash
npm run eval:mission                         # every scenario (builds the app first)
npm run eval:mission -- happy-path           # one or more by name
npm run eval:mission -- --list               # what exists, what is skipped and why
npm run eval:mission -- --no-build           # reuse the current out/ build
npm run eval:mission -- --model sonnet       # agent model (default haiku)
```

Exit code `0` when every non-skipped scenario passes, `1` on any grading failure, `2` when the
harness itself crashed. It spends real API time (haiku: ~$1.20, ~10 min for the full suite of 12
scenarios, measured 2026-09-29).

**Known model limit — `end-before-dispatch` needs sonnet.** The owner-turn scenarios test whether a
model follows a bundled skill, and real orchestrations run on sonnet/opus. On haiku,
`end-before-dispatch` fails: the owner writes the unit packets and links the child sessions in the
same turn it creates the mission, then asks the end question (or does not ask at all), even with
the skill's explicit "ask, then stop" rule — measured twice on 2026-09-29. On sonnet it passes
(`npm run eval:mission -- --model sonnet end-before-dispatch`, ~$0.40). The grader is not loosened
for haiku: a failure there is the model limit, recorded, not a regression. Every other scenario
passes on haiku.

**Mission v3 run, 2026-10-01, `--model sonnet`:** 12/12 scenarios pass ($1.81 for the full run of
11 passes, plus $0.12 for one rerun). `signoff-as-check` failed on the first pass only because the
agent allowlist (`MISSION_VERBS` in `agent.mjs`) still lacked `mission_add_check`. The owner chose
that verb and `claude` refused it. With the allowlist fixed and nothing else changed, the rerun passed
8/8. `tests/mission-v3-eval-scenarios.test.ts` now pins the allowlist to the catalog's
`mission_*` verbs. The graders were then tightened: end-before-dispatch counts exactly one step per unit
and checks the plan came from `mission_create`, and signoff-as-check requires a label that names the
sign-off and treats any truthy `ticked` as a tick. Regraded offline against these recorded runs,
every recorded pass still passes. The only failure is the pre-fix `signoff-as-check` run, which
fails the same two assertions as it did live. The end-before-dispatch checkpoint's two file
assertions could not be re-read, because the sandbox only keeps the final files.

**Needs:** a logged-in `claude` on `PATH`, `node_modules` installed, and on Linux `xvfb-run` (no
window opens). It launches its own isolated instance (`--user-data-dir` under the run dir), so a
running Harnu is never touched.

## What a run leaves behind

`.harnu/eval/mission-behavior/<timestamp>/` (gitignored): `harnu.log`, Harnu's own `mcp-audit.json`
(every verb call), `summary.json`, and per scenario the agents' stream-json output, the spawned
children's transcripts and screens, and the graded mission files (`final/missions`, plus each
`checkpoint-*/`) with every deliberately broken copy under `breaks/`.

The throwaway repos live at `$TMPDIR/harnu-mission-eval-<hash of this checkout>/<scenario>`. The
path is stable on purpose: Claude Code asks for workspace trust once per path, and the harness
answers that dialog (as the operator) only the first time.

## What it kills, and when

Everything the harness starts bills the operator, so everything it starts is killed — and
nothing it did not start. The instance is launched as its own process group, and its process
tree (including the `claude` sessions it spawns, which node-pty puts in their own sessions) is
recorded by pid **and** kernel start time while it is intact (`procs.mjs`), so a recycled pid is
never signalled.

- **Scripted agents** (`claude -p`): `--max-turns 12`, a 180 s deadline, SIGTERM then SIGKILL.
- **Spawned sessions** (`create_session`, manifest dispatch): killed when their spawn phase ends
  — done, timed out (240 s) or failed — and again before the scenario is graded: Harnu destroys
  their PTYs, then any recorded process still running in the sandbox gets SIGTERM, then SIGKILL.
- **The instance:** graceful quit, then SIGTERM → SIGKILL on its process group and on every
  recorded process. A boot that never comes up is torn down the same way.
- **Ctrl-C / SIGTERM** on the harness kills all of the above, cleans the sandbox transcripts and
  exits `130`.

**Known limitation — the sandbox can show up in your own Harnu during a run.** Spawned sessions
write their transcripts to the shared `~/.claude/projects/` (Harnu has no config-dir isolation), so
while a spawn scenario runs, its throwaway folder can appear in a live Harnu's sidebar. The harness
removes those transcript directories as each scenario ends (and on failure or interruption); only
the exact sandbox paths are touched. Scripted agents run with `--no-session-persistence` and
never write one.

## Files

| File               | Role                                                                             |
| ------------------ | -------------------------------------------------------------------------------- |
| `run.mjs`          | CLI, scenario replay, operator doors (via `src/main/mission-core.ts`), reporting |
| `harnu.mjs`        | the isolated instance: build, xvfb, static renderer, CDP, MCP client, teardown   |
| `agent.mjs`        | one scripted `claude -p` turn (no built-in tools, only `mcp__harnu__mission_*`)  |
| `grade.mjs`        | reads the mission files with `js-yaml` and evaluates assertions + breaks         |
| `procs.mjs`        | the process ledger and SIGTERM → SIGKILL escalation (unit-tested)                |
| `scenarios/*.json` | the T358 Review Focus items, the happy path, S6's stall rule, v2/v3 owner turns  |
| `fixtures/*`       | synthetic inputs an owner turn works from (Mission v2 S4), copied in by `copyIn` |

## Writing a scenario

```jsonc
{
  "name": "my-scenario",          // also the sandbox folder name
  "order": 6,                     // run order
  "title": "…", "reviewFocus": 2, "description": "…", // or "label" when no Review Focus
  "skip": false, "skipReason": "…", // a skipped entry is still listed, visibly
  "agents": ["A", "B"],           // each gets a fresh session UUID: {{session.A}}
  "phases": [ … ],
  "assert": [ … ],                // graded on the final state
  "breaks": [ … ]                 // each MUST make the grade fail
}
```

**Phases** run in order:

- `{ "agent": "A", "prompt": "1. mcp__harnu__mission_create with …" }` — one `claude -p` turn.
  Keep the prompt to the exact calls; `{{self}}` is the agent's own session UUID, `{{self8}}` its
  first 8 characters. `"tools": ["Read", "Write"]` grants those built-ins (default: none — only
  the `mission_*` verbs).
- `{ "agent": "A", "role": "owner", "tools": ["Read"], "prompt": "Skill file: … <the situation>" }`
  — a BEHAVIOR turn (Mission v2 S4): the frame lists no calls; the agent reads a bundled skill the
  scenario `copyIn`s and decides its own calls from it. The frame only states what the sandbox
  lacks (every verb but `mission_*`, and `AskUserQuestion`, which `claude -p` does not have — a
  question to the operator goes in the final reply) and that each turn starts with no memory.
  Never name the verb the scenario grades in an owner prompt. Up to 18 turns.
  `"record": { "mission": slug | "*", "tag" }` makes the harness (not the model) `mission_log`
  `EVAL-TURN[<tag>] asked=<b> tools=<calls in order>` after the turn — `asked` is true when the
  final reply holds a `?` or the word "confirm". Every agent's final reply is kept as
  `agent-<n>-<X>-reply.txt`.
- `{ "parallel": [phase, …] }` — run phases at the same time.
- `{ "burst": { "tool", "count", "args" } }` — `count` concurrent calls straight through the
  transport (`{{i}}` = 1..count), for writes that must overlap.
- `{ "operator": "approve-rescope", "mission": slug | [slugs] }` — the UI-only re-scope door,
  applied through `mission-core`. Mission v3 has no draft → active door: a mission is born `active`.
- `{ "seed": spec | [specs] }` — write a mission straight to disk through `mission-core`'s builder,
  for a state no verb reaches: AGE (backdated timestamps), or a LEGACY file written before Mission
  v3 (`"legacy": true` — a fixed start "Scope confirmed" before the end; with `"status": "draft"`,
  no approval stamp), which a v3 reader must still parse. Never seed `status: "stale"`: since S6
  `stale` is a derived flag with no file state (design §3), so a seeded `stale` is a status no real
  mission can have — probe it instead (below). `spec` = `{ slug, status, ageMinutes, legacy?,
owner?, links?: [{ step: "fixed-start" | "fixed-end", kind, ref }] }`; the seeded `updatedAt` is
  kept as `{{seeded.<slug>.updatedAt}}`.
- `{ "probe": { "missions": [slugs], "into": ledgerSlug, "tag" } }` — for a DERIVED signal that is
  never stored (`derived.stale`): the harness calls `mission_get` itself through the transport and
  `mission_log`s `EVAL-PROBE[<tag>] <slug> stale=<b> status=<s>` into the ledger mission, so the
  grade still reads only mission files and no model transcribes the value.
- `{ "legacyFile": { "name", "fixture", "path" } | [...] }` — plant a legacy `.harnu/goals/*.md`
  goal file at `path` (sandbox-relative), byte-for-byte from `tests/fixtures/mission-migration/<fixture>`
  — the unit suite's SYNTHETIC fixtures; the real corpus holds client identifiers and is never
  used. Kept as `{{legacy.<name>.path}}`, `.abs` and `.sha256` (hex of the bytes).
- `{ "copyIn": { "from": repoPath, "to": sandboxPath } | [...] }` — copy a file of this checkout
  into the sandbox (an owner turn reads a shipped skill there, so no read leaves its cwd). Synthetic inputs an owner works from live in `fixtures/`.
- `{ "checkpoint": "name", "assert": [...], "breaks": [...] }` — grade mid-scenario.
- `{ "spawn": "agent-controlled", "prompt": "…" }` — Harnu's `create_session` (agentControlled).
- `{ "spawn": "manifest", "title", "prompt", "waitFor": { "mission", "logContains" } }` — a card
  dispatched through `create_card` → `move_card` → `submit_manifest` (spawnedBy `agent`).

**Placeholders** (`{{…}}`) resolve in prompts, assertions and breaks: `folder`, `session.<X>`,
`m.<slug>.id`, `m.<slug>.end`, `m.<slug>.custom.<n>` (and `m._only.*` when the
repo holds exactly one mission — an owner names its own), `seeded.<slug>.updatedAt`,
`legacy.<name>.path|abs|sha256`. An unresolved one fails
the scenario rather than comparing against the literal text.

**Assertions** — `{ "missionCount": n }`, or `{ "mission": slug, "step"?: sel, "path"?: "a.b", <matcher> }`
with a matcher of `equals` (deep-partial), `notEquals`, `oneOf`, `exists`, `length`, `includes`
(list contains, deep-partial), `excludes`, `sha256` (hex of the field's UTF-8 bytes — byte-for-byte
checks); or `{ "mission": slug, "anyBlocker" | "anyLink": {…}, "present"?: bool }` — some blocker
(the mission's or any step's) / some step link matches, for a behavior the model may place
anywhere; or
`{ "mission": slug, "logContains" | "logNotContains": "…" }`; or `{ "mission": slug, "logLine": "<prefix>",
"contains"?: "…", "notContains"?: "…" }` — some Log line starts with the prefix and every such line
contains / lacks the text (a recorded turn's tool list); or `{ "mission": slug, "stepCount": {…},
"equals": n }` — exactly n steps deep-partially match; or `{ "file": path, "sha256" | "exists" }`
for a plain sandbox file (read byte-exact). Any deep-partial value may be an operator instead of a
literal: `{ "$exists": bool }`, `{ "$truthy": bool }` (any truthy value — `true`, a stamp object, a
date string) or `{ "$match": "regex", "$flags"?: "i" }`. Step selectors: `fixed-end`, `custom:<n>`,
`title:<exact title>`, and `fixed-start` — only a legacy (pre-v3) file has one. `"mission": "*"` is the repo's
single mission (it fails unless exactly one exists). `label` overrides the report line.

**Breaks** — `{ "name", "mutate": [ { "mission", "step"?, "set": { "a.b": v }, "unset": "a.b",
"logAppend": "…", "logRemove": "…" } | { "drop": slug } | { "duplicate": slug } | { "file", "write": "…" }
| { "file", "delete": true } | { "mission", "clearBlockers": true } | { "mission", "eachBlocker": { "set": {…} } }
| { "mission", "eachLink": { "match": {…}, "remove": true } } ] }`. Write one per regression the
scenario exists to catch.

**Check a grader offline before a live run.** A live run costs real API time, so iterate on a new
scenario's grader in the unit suite instead: build the state a correct session leaves on disk,
grade it with `gradeState`, and grade every break through `applyBreak` — the good state must pass
and every break must fail. `tests/mission-v3-eval-scenarios.test.ts` does this for EVERY
scenario, and fails when a scenario file exists that it does not grade.
