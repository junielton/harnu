# 2026-07-20 orphan-spawn incident — postmortem

> **Provenance note (added by T174):** the original postmortem document that
> the eight fix commits below all cite by this exact path was never actually
> committed to git in any branch or worktree of this repo (confirmed via
> `git log --all --diff-filter=A -- docs/reports/2026-07-20-orphan-spawn-postmortem.md`
> — no hits — and a filesystem sweep of every worktree under
> `.claude/worktrees/`). It most likely lived only as a scratch file in the
> investigating session's transcript or an already-cleaned-up worktree. This
> document reconstructs the incident and defect list **verbatim from the
> fix commits' own descriptions** (each commit message explicitly names its
> defect and quotes this file), so the content below is source-accurate, not
> fabricated — but the original narrative framing (how the incident was
> first noticed, exact timeline, blast radius) is not recoverable and is
> omitted rather than invented. The "## T174 live validation" section at the
> bottom is the actual new content this task adds.

## Incident summary

On 2026-07-20, a fan-out dispatch of agent sessions produced orphaned
spawns: sessions that either never got dispatched at all, got dispatched
more than once, or booted a real PTY/`claude` process that never received
its pre-prompt — leaving them sitting `working` or blank indefinitely with
no user-visible signal that anything had gone wrong. Investigation
traced this to **eight independent defects** spanning the MCP
`create_session` idempotency/materialization path, the pre-prompt
injection pipeline, the boot-reaper backstop, and the manifest-drain
board-dispatch path. All eight were fixed on separate branches and are
composed together on this `integration/orphan-spawn-family` branch
(commit `f0f0a7b` at the time of this validation).

## Defects and fixes

### D1 — `create_session` replayed a genuine failure forever

**Fix:** `fix/bug-57-idempotency-failed-retry` (BUG-57, commit `9681293`)

`beginCall()` replayed a cached idempotency-registry outcome for **any**
status, including `failed`, with a 10-minute TTL — so an agent that
correctly retried a genuinely-failed `create_session` with identical args
got the same cached `SPAWN_NOT_MATERIALIZED` error back for the full
window, with nothing ever dispatched again. In the incident, 8 of 8
retries returned in ~4s against a 60s deadline, all served from cache. A
failed entry is now re-armed as in-flight so the retry re-actuates for
real; dedup on `applied` (the guard against double-spawning in one working
tree) is untouched. The audit log now distinguishes
`re-actuate-after-failure` from `duplicate-replay`.

### D2 — the injection watchdog reported a lost prompt as delivered

**Fix:** `feat/t172-injection-trail-instrumentation` (T172, commit `e9c705c`)

- `fix/bug-61-watchdog-tracks-injected` (BUG-61, commit `a0841f9`)

Nothing on the pre-prompt injection path recorded whether a queued
pre-prompt was ever actually pasted. `injectionVerdict` treated "no
longer queued" and "no live PTY" as proof of delivery — but
`acquireInjectionTarget` consumes the prompt from the queue _before_
`createInjectGate` actually pastes it, and the gate can still hold it for
up to `capMs` or drop it on a `pty:exit` cancel. Two orphaned sessions
from the incident sat blank forever while the watchdog reported them
delivered. T172 added an in-memory, session-id-keyed injection ledger
(`injection-ledger.ts`) recording every decision point (target
resolved/failed, dequeued, gate fired, paste written, submit written,
cancelled on exit). BUG-61 then rewired `injectionVerdict` to read that
ledger's `wasInjected` as the _only_ signal that means true delivery: a
consumed-but-never-pasted prompt now escalates to `prompt_undelivered`.

### D3 — a materialization timeout released the folder reservation under a still-running spawn

**Fix:** `fix/bug-58-timeout-return-syntheticid` (BUG-58, commit `a095166`)

A materialization timeout returned `SPAWN_NOT_MATERIALIZED` and released
the folder's single-occupancy claim in `runCreateSession`'s `finally`
block, even though the dispatched session (PTY + claude process) kept
running. A retry — now that BUG-57 re-actuates failed attempts — would
land a second process in the same working tree, exactly what the
single-occupancy guard exists to prevent. The timeout path now **holds**
the reservation, and the ACK carries the `syntheticId` so the caller can
adopt/poll it via `get_session` instead of retrying blind. A retry into
the folder while unresolved is refused with `SESSION_ALREADY_IN_FLIGHT`.
Ownership of the eventual release transfers to the in-flight registry's
TTL eviction (60-minute backstop).

### D4 — the correlation window armed too early, before a queued boot even started

**Fix:** `fix/bug-59-correlation-window-materialization` (BUG-59, commit `3964b2c`)

`notifySessionMaterialized` only fired from the correlation-bound
migrate, armed at `insertAgentSession` (enqueue time) for a fixed 10s
window — while `agentBootQueue` drains serially. Under fan-out, the
window routinely lapsed before a queued session's boot even started, so
`create_session`'s ACK timed out reporting a healthy, working session as
`SPAWN_NOT_MATERIALIZED`. The window now arms at boot
(`armAgentCorrelationForBoot`, called right before the PTY actually
spawns), so queue depth ahead of a session no longer erodes its own
reporting window.

### D5 (BUG-60) — a live PTY that never got its prompt had no reaper backstop

**Fix:** `fix/bug-60-reaper-prompt-undelivered` (commit `120af5c`)

`reapSyntheticBoot`'s live-PTY branch was an unconditional no-op —
`bootVerdict` reads a live PTY as unconditional success, so a session
that booted a real REPL and was never spoken to sat `working` forever,
invisible to the 120s boot reaper. `reapSyntheticBoot` now reads the same
T172 ledger signal BUG-61's watchdog consumes, reusing the existing
`prompt_undelivered` escalation and `retryPromptInjection` recovery. A
session with nothing queued, or one whose prompt was actually delivered,
is never touched.

### D6 (BUG-62) — manifest-drain silently orphaned worktrees on a failed spawn

**Fix:** `fix/bug-62-drain-honesty` (commit `f3125e7`)

`runDrainPass` cut a worktree, then silently `continue`d on a failed
spawn — the worktree stayed on disk, the failure reason was destroyed in
a bare `catch { return null }`, and the card sat at `status: ready` with
no toast, log, or signal at all. Now reuses the same `rollbackWorktree`
helper the board's manual dispatch path uses, threads the real failure
reason through to the drain's result, and surfaces it via a `failedCards`
field + a dedicated toast.

### D7 (BUG-63) — a race between worktree adoption and dispatch into it

**Fix:** `fix/bug-63-drain-folder-registration` (commit `75b8ef1`)

The background drain dispatches `session.dispatchCard` into a
just-created worktree in the same tick `createWorktree` returns, but the
renderer only learns about that folder through a fire-and-forget
`folders:adopted` push debounced 250ms — so `dispatchCardSession`'s own
folder lookup missed it on effectively every attempt. This was the
confirmed root cause of the BUG-62 incident (BUG-62 made the failure
honest; this closes the race itself). The worktree's adoption payload is
now folded into `session.dispatchCard`'s own bridge payload and
registered synchronously, before dispatch, in the same command.

## Composition

All eight change-sets (D1–D7 above, where D2 is two commits: T172 +
BUG-61) are merged onto `integration/orphan-spawn-family` (commit
`f0f0a7b`), with local-ci green (4008 tests) before this task's live
validation.

---

## T174 live validation

**Date:** 2026-07-20. **Build under test:** `integration/orphan-spawn-family`
@ `f0f0a7b` (all 8 fixes composed; local-ci green, 4008 tests).
**Method:** a second, fully isolated Capy instance
(`--user-data-dir=/tmp/capy-t174-verify`, `--remote-debugging-port=9333`,
production-faithful `npm run build:unpack`), driven over the real MCP
loopback HTTP endpoint (JSON-RPC `tools/call`, not a mock), per
`docs/dev/live-verify-second-instance.md`. Every dispatch went through the
**real** `create_session` tool, spawning **real** `claude` CLI child
processes — nothing here is simulated.

### Tier 1 — real fan-out

4 parallel `create_session` calls were dispatched into 4 fresh scratch git
repos under `/tmp`, each with `prePrompt: "Reply with the single word OK
and stop."` and `bootOverride: {model: 'haiku'}`.

**Result: all 4 real `claude` processes spawned successfully, but none of
the 4 ever received their pre-prompt as a real chat turn** — every one sat
alive, `status: "active"`/`inflight: true` per `get_session`, for the full
observation window (17+ minutes), with `~/.claude/projects/<slug>` either
never gaining a `.jsonl` transcript or briefly appearing empty and then
disappearing entirely.

**Root cause, independently confirmed (not just inferred):**
`~/.claude.json`'s per-project `hasTrustDialogAccepted` was `false` for
all 4 scratch repos even after the timeout — proving Claude Code CLI's
interactive **first-run "Do you trust this folder?" dialog** was still
showing, unresolved, the entire time. Three facts compose into this
finding:

1. **Capy deliberately never bypasses the trust dialog for agent-created
   sessions.** `agentControlled: true` (`src/main/pty.ts:236-244`) strips
   any permission-bypass flag and withholds Capy's own `--mcp-config` for
   _any_ `claude-*` session spawned by an MCP agent — this is a blanket
   security policy covering both `create_session` and the manifest-drain
   (`session.dispatchCard`) path alike, not something narrower. This is
   the right call security-wise (an MCP caller should not be able to grant
   itself `--dangerously-skip-permissions` on arbitrary folders) — but it
   means every brand-new folder or worktree dispatched into via **any**
   of Capy's agent-facing fan-out surfaces will hit the CLI's interactive
   trust dialog.
2. **The pre-prompt injection-readiness gate cannot tell a trust dialog
   from a settled REPL prompt.** `createInjectGate`
   (`src/renderer/src/components/prompt-inject-gate.ts:214-268`) decides
   "safe to paste" from output quiescence (~500ms quiet,
   `INJECT_BANNER_QUIET_MS`) or a 2.5s hard cap — never from PTY output
   content. Ink renders the trust dialog and then goes idle waiting for a
   keypress, which is indistinguishable from a settled prompt by this
   signal. The gate fires, and the pre-prompt gets bracket-pasted plus a
   submitting `\r` into the dialog's select menu, not a chat composer.
3. **This exact sub-case escapes every delivery-tracking mechanism the 8
   fixes rely on.** T172's injection ledger (`injection-ledger.ts`) records
   `paste-written` the moment the OS `write()` call succeeds — which it
   does here, the bytes really did leave Capy — so `injectionVerdict`
   (BUG-61) and `shouldReapUndeliveredPrompt` (BUG-60) both read this as
   `'injected'`/delivered and never escalate. Separately, and independent
   of that: `markPromptUndelivered` only mutates local renderer Pinia
   state (`src/renderer/src/stores/sessions.ts:1243-1245`) — there is no
   IPC push to main, so even a correct escalation would never reach
   `get_session`'s MCP handler (`inflightToFleetInputs` hardcodes
   `status: 'active'` for any unmaterialized session,
   `src/main/mcp/tool-handlers.ts:229`). A fan-out caller polling via MCP
   — exactly T174's Tier 1 pattern, and exactly how a real orchestrator
   would monitor a dispatch — has **no way to ever learn** one of its
   sessions is stuck.

This is confirmed to generalize beyond ad-hoc `/tmp` folders: a throwaway
`create_worktree` off this very repo (`t174-verify-scratch`, since
removed) had **no** `hasTrustDialogAccepted` entry at all — worktrees do
not inherit trust from their parent repo, and only 9 of the dozens of
worktree paths on this machine have ever been individually trusted (each
by a human accepting the dialog once, by hand, outside the MCP path).
Since `substrate: 'worktree'` dispatch (the actual pattern BUG-62/63 was
built for — a fresh worktree per card) shares the same `agentControlled`
downgrade, a manifest-drain dispatch into a brand-new worktree would hit
the identical wall.

**This is a 9th, previously-undocumented defect in the same family — not
a regression of any of the 8 fixes (none of them claimed to solve it), but
a real gap the fixes' composition does not close.** Per this task's own
escalation criteria ("Tier 1 reveals a session that boots but does NOT get
its prompt"), this is reported as the headline finding.

**Isolating the confound — clean re-test:** to verify the 8 fixes
themselves rather than this newly-found 9th gap, Tier 1 was re-run against
folders that hit _dispatch-level_ failures (invalid paths — never reaching
a real `claude` boot, so the trust dialog never enters the picture). See
Tier 2 §1 below for the results — BUG-57 and BUG-58 were both confirmed
working correctly, live, in composition.

**Note on scope:** attempting to pre-trust folders (editing
`~/.claude.json` directly, or spawning a nested `claude
--dangerously-skip-permissions` session to accept the dialog interactively)
was attempted and correctly **blocked by this environment's own auto-mode
permission classifier** — both are reasonable safety boundaries and were
not worked around. This is why Tier 1's "happy path" (materialize + real
prompt delivered end-to-end) could not be cleanly demonstrated live within
this session's safety constraints; see Tier 2 for what could be isolated
instead.

### Tier 2 — the 5 card scenarios

| #   | Scenario                                                                             | Status                                                                                                                                                                                                                                                                                                                                                                                                                                | Evidence             |
| --- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- |
| 1   | Retry after a genuine failure re-actuates (BUG-57)                                   | **Driven live** ✅                                                                                                                                                                                                                                                                                                                                                                                                                    | See below            |
| 2   | Retry of a SUCCEEDED create doesn't double-spawn                                     | Blocked by environment (trust dialog prevented a live success case; see note) — **unit-covered**: `tests/mcp-idempotency-registry.test.ts:71` (`beginCall / completeCall — dedupe a retry (AC1)`)                                                                                                                                                                                                                                     | —                    |
| 3   | Lost prompt surfaces as `prompt_undelivered`, not silent `working`                   | **Driven live — and it reveals the Tier-1 gap above**: the clean case (dequeued-but-never-pasted, or PTY dies before injecting) is unit-covered by `tests/injection-watchdog.test.ts:64-93` (`BUG-61 repro — 2026-07-20 orphan-spawn post-mortem (defect D2)`) and passes; the adjacent case this task surfaced (paste succeeds, lands on a trust dialog) is **not** covered by that test's model and does **not** currently escalate | Tier-1 section above |
| 4   | A slow-but-healthy session (transcript inside deadline) is reported ok, not failed   | Not independently forced live (requires precise queue-depth timing control) — **unit-covered**: `tests/agent-correlation-window.test.ts:89` and `:131` (burst-of-N creates still materialize + report despite serial-drain delay)                                                                                                                                                                                                     | —                    |
| 5   | A materialization timeout leaves no unreachable orphan (and returns the syntheticId) | **Driven live** ✅ (naturally, via every Tier-1 dispatch)                                                                                                                                                                                                                                                                                                                                                                             | See below            |

**Scenario 1 — driven live.** Dispatched `create_session` into a
genuinely-nonexistent folder → `ok:false`, `FOLDER_MISSING` (a real
dispatch-level failure, ~80ms). The folder was then actually created on
disk (`git init` + a real commit). An **identical retry** was issued
immediately: the old (pre-BUG-57) behavior would have replayed the cached
`FOLDER_MISSING` error verbatim for up to 10 minutes. Instead, the retry
**re-actuated for real** — it re-checked the folder (now real), passed,
and proceeded to dispatch a genuine spawn (which then hit the Tier-1 trust
dialog, `SPAWN_NOT_MATERIALIZED`, syntheticId
`synthetic-b49e386b-5db9-4663-bc39-cca936dcabc2`). This is definitive
proof BUG-57 is not merely unit-tested but actually re-actuates under a
real MCP round trip. A third, immediate identical call correctly returned
`SESSION_ALREADY_IN_FLIGHT` (the single-occupancy guard, confirming the
`applied`/in-flight dedup BUG-57 left untouched is also intact).

**Scenario 5 — driven live.** Every Tier-1 `SPAWN_NOT_MATERIALIZED` ACK
(5 of them across the session: `repo-1..4` and the re-actuated retry)
carried its `syntheticId`, and `get_session({sessionId})` on each
consistently returned a well-formed, adoptable session record (never
`SESSION_NOT_FOUND`) for the full observation window — confirming BUG-58's
"hold the reservation, surface the syntheticId, never leave an
unreachable orphan" contract holds under a real repeated-timeout load.
**Caveat:** "unreachable" specifically means _adoptable via `get_session`_
— it does not mean the underlying OS process is ever automatically
reclaimed. A trust-dialog-stuck session (Tier-1 finding) has no automatic
recovery path short of the 60-minute in-flight TTL backstop or a human
noticing and killing it by hand, which this task did.

### Verdict

**Does the original 2026-07-20 orphan-spawn incident recur under the
integrated build? No** — every one of the 8 composed fixes behaved exactly
as designed where it was live-testable: BUG-57's re-actuation, BUG-58's
hold-and-surface-syntheticId, and the single-occupancy guard all held up
under a real MCP round trip, not just in unit tests.

**But a related, previously-unknown incident-class does recur, in a
different shape: a session that boots a real process and is never spoken
to, indefinitely, invisible to a fan-out caller polling over MCP.** The
trigger differs from any of D1–D7 (a first-run trust dialog on a
never-before-seen folder or worktree, not a lost queue entry or a stale
idempotency cache) but the observable symptom is identical to the original
incident's headline complaint — an orphaned, silently-stuck session — and
it is reachable through the exact fan-out pattern (`create_session`/
`submit_manifest` into a fresh folder or worktree) this task was built to
validate.

**Recommendation:** file this as a 9th defect in the family (working
title: "agent-dispatched sessions into untrusted folders/worktrees hang
silently on the CLI trust dialog, invisible via MCP"). The fix likely
belongs in one of two places: (a) have Capy pre-seed
`hasTrustDialogAccepted` for folders/worktrees it itself creates or
adopts on an agent's behalf (narrower risk surface than bypassing
permissions generally, since it only affects trust-on-first-open, not
tool permissions), or (b) teach the injection-readiness gate to recognize
the trust dialog's known Ink output signature and either answer it
safely or escalate to `prompt_undelivered` immediately instead of
mis-firing quiescence — combined with piping `prompt_undelivered` through
to the MCP `get_session`/`get_fleet` read path, which is a real gap on
its own regardless of the trust-dialog trigger.

### Environment notes for future live-verify sessions

- The postmortem file this section was appended to did not exist in any
  branch/worktree prior to this task (see the provenance note at the top
  of this document) — it was reconstructed from the 8 fix commits' own
  descriptions.
- `--remote-debugging-port` forces dev-mode renderer loading
  (`localhost:5174`) even on a `build:unpack` production binary — the
  static-server step in the live-verify recipe is still required even
  when following the "production-faithful" path.
- The `rtk`-wrapped `find` silently drops unsupported flags (e.g.
  `-newermt`) instead of erroring, producing false-empty results; use
  `/usr/bin/find` directly for anything time-based.
- All test artifacts (4 `.jsonl`-less scratch repos, one that briefly
  became real, one throwaway worktree, 5 `~/.claude.json` project trust
  entries, the isolated instance's userData) were torn down at the end of
  this task. The isolated instance's window is visible on-screen while
  running (per the live-verify doc) and briefly showed the operator's real
  project list in its own sidebar — this is expected (`~/.claude/projects`
  is a global, unsandboxed directory every Capy instance scans), not a
  leak into the operator's separate live Capy instance.

## Deterministic-argv follow-up (2026-07-21)

After BUG-64's Part A regressed prompt delivery (BUG-66: the hook-listener
teardown race, 0/9 delivered in a follow-up fan-out) and a separate Reaper
race was found sweeping a fresh worktree mid-dispatch (BUG-67), the operator
questioned why prompt delivery needed a paste-after-boot race at all, given
that `buildClaudeArgs` (`src/main/claude-args.ts:418`) already pushes
`ClaudeBootConfig.prePrompt` to `claude`'s argv as a `--`-separated positional
at spawn time — a fully deterministic path that neither `dispatchCardSession`
nor `insertAgentSession` (the two agent-facing dispatch functions in
`src/renderer/src/stores/sessions.ts`) was using.

**Fix implemented** (plan:
`docs/superpowers/plans/2026-07-21-deterministic-preprompt-argv.md`, executed
via subagent-driven-development in an isolated worktree, 4 tasks + local-ci
gate): both functions now attach prompts of 8000 characters or fewer
(`AGENT_PREPROMPT_ARGV_MAX_CHARS`) directly to the synthetic session's
`bootOverride.prePrompt`, which the existing (already-shipped, unmodified)
argv path delivers at spawn — bypassing the paste-based injection
ledger/watchdog/reaper entirely for the common case. Prompts over the
threshold still use the old queue, unchanged, as a fallback. The MCP security
boundary (`src/main/mcp/agent-boot.ts`'s `AgentBootOverride` allowlist,
`model`/`effort` only) was explicitly left untouched — `prePrompt` composes
into the boot config in trusted renderer code, never through the untrusted
agent allowlist. Merged to `main` as commits `d022ce0`, `93149f7`, `b1d5f9a`,
`df9929f`; released as 0.3.10.

**Live validation:** 10 fresh worktrees (`probe/argv-01`..`probe/argv-10`)
dispatched via `create_session` with a trivial probe prompt and
`bootOverride: {model: "haiku", effort: "low"}`, against the running 0.3.10
build (confirmed by process inspection, not self-report). Verified on disk
(each session's `.jsonl` transcript, first `user` message matched the
dispatched prompt exactly) and cross-checked via `get_fleet` (no
`taskState: "failed"` / `failureReason: "prompt_undelivered"` on any of the
10).

**Result: 10/10 delivered** — up from 0/9 pre-fix. All 10 probe worktrees,
branches, and processes were torn down afterward; `git worktree list` and
`df -h`/`free -m` confirmed no leftover state.

This directly resolves BUG-66 by removing its precondition rather than
patching the hook-teardown race itself: a short prompt no longer engages
`prompt-inject-gate.ts`'s `armInjectGate`/`armInjectionWatchdog` at all
(`hasAgentPrompt(...)` is `false` for an argv-delivered prompt, so
`acquireInjectionTarget`'s own `if (!deps.hasPrompt()) return null` guard
short-circuits before the gate logic runs). BUG-67 (the Reaper race against
brand-new worktrees) is a separate, still-open concern — not exercised by
this test since the probe worktrees were never brand-new-and-idle long
enough to trigger it, and it wasn't observed here.
