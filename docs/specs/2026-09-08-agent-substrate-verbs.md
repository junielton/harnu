# Agent substrate verbs — Scheduler workers and the orchestrator guard

Status: in delivery · 2026-09-08 · integration branch `feat/agent-substrate-verbs`

This spec is committed on the integration branch on purpose: `.capy/` is
gitignored, so the roadmap cards that own this work (`T308`, `T309`) are
invisible from a fresh worktree. This file is what a dispatched session can
actually read.

## Why these two, together

An agent driving a delivery inside Capy can dispatch sessions, cut worktrees and
write the board. It cannot do two things it now needs:

1. **Create a Scheduler worker** — the only heartbeat that outlives the
   orchestrating session. The `orchestrate-delivery` skill prescribes one as the
   third layer of its heartbeat and can currently only ask the operator to make
   it by hand, which means the backstop exists precisely when a human remembers
   to set it up. A delivery already lost ~15 hours to a dead heartbeat with
   nothing watching.
2. **Arm its own orchestrator guard** — "Promote to orchestrator" is a
   context-menu gesture with no verb behind it, so a session told to orchestrate
   cannot arm the brake the orchestration contract assumes.

They ship as one wave because they touch the same hub files
(`tool-catalog.ts`, `validate.ts`, `tool-handlers.ts`, `deny-hint.ts`,
`plan-input.ts`, `scheduler-core.ts`). Both units' PRs target this integration
branch, merges into it are serialized, and `feat/agent-substrate-verbs → main` is
a single final PR.

Conflicts between the two units on those hub files are **expected and planned
for** — rebasing onto the integration branch after the other unit merges is a
step of this delivery, not an incident.

## Unit 1 — `create_worker` / `list_workers` (card T308)

### Safety shape, which the API must not flatten

`observe` and `act` are not equivalent risks.

- **`observe`** is read-only by an explicit allowlist (`OBSERVE_MCP_ALLOW` in
  `scheduler-core.ts`): read memory and fleet, write a card, notify. Creating one
  unattended is proportionate.
- **`act`** runs with permissions bypassed and the full toolset, and **does not
  stop at the Approval Inbox**. An agent minting an unattended `act` worker is an
  agent granting itself a permanent, unsupervised second body.

So `create_worker` makes `observe` workers freely, like every other mutating
verb; `act` faces the operator, the same class as `plan_mission` and
`delete_card`. And `create_worker` itself belongs in `OBSERVE_MCP_DENY` — an
observe tick that can mint workers is an observe tick that can escape its own
allowlist.

### Acceptance criteria

- AC-1 — `create_worker` creates an enabled `observe` worker from
  `{ folder, name, prompt, everyMinutes, model?, effort? }` and returns its id;
  it appears in the Scheduler UI and fires on cadence — verify: test
- AC-2 — `create_worker` with `mode: "act"` does not run unattended: it faces the
  operator as a confirm whose disclosure names folder, cadence and prompt —
  verify: test
- AC-3 — `create_worker` and `list_workers` are both in `OBSERVE_MCP_DENY`,
  asserted by name in the existing deny test — verify: test
- AC-4 — `list_workers { folder? }` returns id, name, folder, mode, cadence,
  enabled state and last run outcome, redacted like other fleet reads —
  verify: test
- AC-5 — Creating a worker in a blocked folder refuses with `FOLDER_NOT_ALLOWED`
  before anything is written — verify: test
- AC-6 — A worker whose prompt names a skill mention that resolves to nothing
  on this machine is reported in the ACK as a warning, not silently accepted —
  verify: test. (Criterion corrected from its original "not enabled for that
  folder" wording: a merely-disabled bundled skill still resolves and stages —
  naming it is an explicit request, per the 2026-09-08 skills-picker change —
  so it was never in scope for this warning; the operator agreed to fix the
  criterion rather than the code.)
- AC-7 — `docs/capy-features.md` documents both verbs and the `observe`/`act`
  asymmetry; marker bumped — verify: review
- AC-8 — `docs/user/agent-control.md` and `docs/user/scheduler.md` say in plain
  prose that an agent can create observe workers and that act workers still
  require the operator — verify: review

### Scope boundary

`src/main/mcp/{tool-catalog,validate,tool-handlers,deny-hint,plan-input}.ts`,
`src/main/scheduler-core.ts`, their tests, and the three docs above. Do not
change the Scheduler's execution semantics, the existing membership of the
observe allowlist, or any other verb.

## Unit 2 — `orchestrator_arm` (card T309)

### Why arming mid-session actually works

Promotion is two separable things and only one is spawn-time:

1. **The brake** is a `PreToolUse` hook (matcher `Edit|Write|NotebookEdit`)
   registered in the folder's `.claude/settings.local.json`, gated by the
   `armed.json` flag file keyed by session id (`orchestrator-guard.ts`). The hook
   consults the flag on every matching call, so arming mid-session takes effect
   on the next one. It is live, not baked.
2. **The doc** (`CAPY_ORCHESTRATOR_DOC`) is prepended to the system prompt at
   spawn (`pty.ts:781`) and cannot be retrofitted.

When the trigger is the orchestration skill, the doc half is already covered —
the skill body _is_ the coordinator contract. Only the brake is missing, and that
is the half a verb can flip live. The guard fails OPEN by design (a behavioural
drift brake, not a security boundary), so a failed arm degrades to an ordinary
session, never a bricked one.

### The design question to settle FIRST

Capy's MCP transport has **no per-session identity** — `tool-handlers.ts` states
this, and it is why `message_session` cannot refuse a session messaging itself.
The server cannot infer who is calling, so a naive `orchestrator_arm()` cannot
self-target. Choose:

- **(a) Explicit `sessionId`** — simple, but any session could arm any other and
  block an unrelated session's edits. Mild (fails open, same machine, same user)
  but genuinely surprising.
- **(b) Explicit `sessionId`, restricted** to the same folder, or to a session
  Capy spawned for an agent — narrower, still not self-identifying.
- **(c) Stamp the caller at spawn**, the way `spawnOriginForSession` already
  stamps ownership for `message_session`, and derive the caller from it — the
  only option that makes true self-arming possible, and the largest change.

Record the choice as an ADR. If none is sound, report `blocked` with the reason
rather than shipping a verb with a surprising blast radius.

### Acceptance criteria

- AC-1 — The addressing decision is settled and recorded as an ADR under
  `docs/adr/`, naming the option chosen and why the others were rejected —
  verify: review
- AC-2 — `orchestrator_arm` arms the guard for the intended session and the next
  `Edit`/`Write`/`NotebookEdit` there is blocked by the hook — verify: test
- AC-3 — A matching disarm path exists, reachable by the same caller —
  verify: test
- AC-4 — Arming is idempotent and registers the folder hook if absent, exactly as
  `arm()` does today — verify: test
- AC-5 — Promoted state is visible where promotion is already visible (session
  row badge, topbar pill, `orchestrator` in `get_fleet`/`get_session`) with no
  separate code path — verify: test
- AC-6 — Arming in a blocked folder refuses with `FOLDER_NOT_ALLOWED` —
  verify: test
- AC-7 — `orchestrator_arm` is in `OBSERVE_MCP_DENY` — an observe tick has no
  business changing another session's tool permissions — verify: test
- AC-8 — `docs/capy-features.md` documents the verb and says plainly that the
  guard is a drift brake that fails open, not a security boundary; marker
  bumped — verify: review
- AC-9 — `docs/user/agent-control.md` describes what it means for a user when a
  session promotes itself — verify: review

### Scope boundary

`src/main/mcp/{tool-catalog,validate,tool-handlers,deny-hint,plan-input}.ts`,
`src/main/orchestrator-guard.ts`, `src/main/scheduler-core.ts` (deny list only),
their tests, one ADR, and the two docs above. Do not change what the guard
blocks, do not touch the spawn-time doc injection, do not alter any other verb.

## Honest exit clause — applies to both units

If an acceptance criterion cannot be satisfied — the spec is contradictory, the
data does not exist, an answer is missing — report it as `AC-n: unmet` with the
reason, or `blocked` with the question. Never quietly drop an AC, never weaken a
test to make one pass, never edit an acceptance criterion to match what was
built.
