# Session hibernation — capping the live-PTY fleet

**Date:** 2026-07-11
**Status:** implemented + live-verified (see §9b)
**Problem owner:** Junielton

## 1. Problem

Every session the operator touches spawns a `claude` process that lives until it is
_explicitly_ closed. Measured on 2026-07-11 against the running AppImage (pid 2687620):

| Process                         | RSS        |
| ------------------------------- | ---------- |
| `claude` session A (20 min old) | **434 MB** |
| `claude` session B (2 min old)  | **414 MB** |
| Capy main                       | 276 MB     |

**Each live session costs ~420 MB.** `src/main/pty.ts` kills a PTY in exactly three
places — `pty:destroy` (explicit close), `beforeunload`, and `before-quit` (`killAllPtys`).
There is no cap, no eviction, and no timeout. Switching sessions calls
`detachLiveTerminal` and deliberately leaves the process running (documented in
`CLAUDE.md` → "Switching sessions detaches, it does not dispose").

That is correct behavior — background streaming and preserved context are the point —
but it is **unbounded**. Ten touched sessions ≈ 4 GB; twenty ≈ 8 GB.

### 1.1 Not a leak

Diagnosis confirmed with the operator: this is **accumulation, not orphaning**. A
`get_fleet` snapshot showed 581 sessions on disk against exactly 2 live `claude`
processes, both legitimately open. No process outlives its session today. The missing
thing is a **ceiling**, not a reaper.

## 2. The enabling insight

**A Claude session is already rehydratable from disk.** The JSONL under
`~/.claude/projects/` is the source of truth, and `claude --resume <uuid>` reconstructs
the conversation. Killing an idle session's process therefore loses _no conversation_.

Better: the return path **already exists and is already exercised**. When the operator
clicks a session that was never opened this run, `activate(id)` takes the create branch
with `kind: 'claude-resume'`. A hibernated session is **indistinguishable from a
never-opened disk session**. Hibernation is therefore:

```
disposeLiveTerminal(key)   // without removing the session from the store
```

No new state machine. No new resume path.

## 3. Policy

Two triggers, one pure decision function.

### 3.1 The decision function

```ts
// src/main/fleet-policy.ts — pure. No electron, no node-pty, no clock.
// Mirrors the PtySessionIndex precedent (unit-testable in isolation, vitest node env).
evaluateFleet(
  sessions: LiveSession[],
  now: number,
  policy: Policy,
  trigger: 'cap' | 'sweep'
): string[]  // victim keys
```

The two triggers share the immunity list but differ in threshold and in how many they
take — this is the whole difference between them:

|                   | `'cap'`                                 | `'sweep'`                       |
| ----------------- | --------------------------------------- | ------------------------------- |
| Coldness required | `lruIdleMs` (15 min)                    | `hardIdleMs` (60 min)           |
| How many victims  | exactly enough to get back to `maxLive` | **all** that qualify            |
| Fires when        | `pty:create` at the ceiling             | every 60 s, regardless of count |

`now` is **injected**, never read from `Date.now()` inside. Time travel in tests is
passing a different integer — no fake timers, no sleeps, no flake.

```ts
interface LiveSession {
  sessionKey: string
  kind: PtyKind
  taskState: 'working' | 'needs-input' | 'idle' | null
  lastFocusedAt: number // operator attention (renderer → main on session switch)
  lastActivityAt: number // session pulse (PTY byte flush OR hook-bridge event)
  isSelected: boolean
  hasPendingApproval: boolean
}

interface Policy {
  maxLive: number // default 5
  lruIdleMs: number // default 15 min — tie-break coldness for the cap trigger
  hardIdleMs: number // default 60 min — the sweep's own ceiling
}
```

### 3.2 Trigger A — the cap (growth)

Enforced **in `pty:create`**, the exact moment the fleet grows. `pty:create` is also
where the existing dedup guard (I1) lives, so the invariant stays in one place.

- Live count `< maxLive` → spawn, no evaluation. Hot path untouched.
- Live count `>= maxLive` → evict the coldest eligible session(s), then spawn.

### 3.3 Trigger B — the sweep (decay)

A `setInterval` (60 s) **in the main process**. This exists because the cap alone does
not fire when the fleet is _quiet_: open five sessions, walk away for three hours, and
nothing is created, so nothing is evaluated, and 2 GB sits idle. That is the actual
zombie the operator described.

The sweep hibernates any session idle beyond `hardIdleMs` **even below the cap**.

**It must live in main, not the renderer.** Renderer timers are throttled when the
window is backgrounded — precisely when sessions go cold and the sweep matters most.
Main-process timers are not throttled. (See also the background-timer flags in
`docs/dev/live-verify-second-instance.md`.)

Implementation is a `setInterval` over a `Map` of a few dozen entries comparing two
integers. **No job library** (`node-cron` / `bull` / `agenda`) — that would add a
dependency to an Electron app that already carries native-module pain, for a timer.

### 3.4 Eligibility — the immunity list

A session is a candidate **only if all** hold:

| Rule                                                           | Why                                                                                                                                                                                                                                                                                                                                                                           |
| -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `taskState === 'working'` → **strict threshold, not immunity** | Killing a genuinely working session destroys real work. But the hook FSM **lies** (BUG-1): a resumed session latches `working` while emitting nothing, forever. An absolute veto makes the feature inert — see **§9b**, which live verification forced. So a `working` claim buys the 60-min bar instead of immunity, and the pulse is what actually protects a busy session. |
| `kind` is not synthetic (`synthetic-*`)                        | A synthetic session that has not yet migrated to its real uuid **has no JSONL on disk**. `--resume` cannot bring it back — killing it loses the conversation for real.                                                                                                                                                                                                        |
| not the selected session                                       | Never kill what the operator is looking at, regardless of LRU.                                                                                                                                                                                                                                                                                                                |
| `!hasPendingApproval`                                          | Hibernating would strand the confirm in the Approval Inbox.                                                                                                                                                                                                                                                                                                                   |
| `now - lastFocusedAt > T` **and** `now - lastActivityAt > T`   | Both sources must be cold. `T` is `lruIdleMs` for the `'cap'` trigger, `hardIdleMs` for `'sweep'` (§3.1).                                                                                                                                                                                                                                                                     |

**Two independent cold sources** is stricter than `taskState` alone, and deliberately so:

- _"I left it running and went to lunch"_ — no focus for 40 min, but the hook is emitting
  `PreToolUse` every 10 s → `lastActivityAt` is hot → **immune**.
- _"I just looked at it but it's parked"_ — `lastFocusedAt` is hot → **immune**.
- It **degrades safely**: if the hook is not installed or dies, raw PTY bytes still supply
  the pulse. The policy does not depend on the hook being alive.

Among eligible sessions, the victim is the **least recently used** —
`max(now - lastFocusedAt, now - lastActivityAt)` descending. LRU, not FIFO: the oldest
session is often the main orchestrator, which is the _last_ thing to kill. Age punishes
longevity; coldness predicts disposability.

### 3.5 The cap yields

If **no** session is eligible (e.g. five sessions, all `working`), `evaluateFleet` returns
`[]` and `pty:create` **spawns anyway**, surfacing a footer note. A ceiling that blocks the
operator's work is worse than the problem it solves.

## 4. What is actually lost

| Lost on hibernate                                          | Recovered?                                                    |
| ---------------------------------------------------------- | ------------------------------------------------------------- |
| `claude` process (~420 MB)                                 | Yes — that is the goal                                        |
| Conversation                                               | **Not lost** — it is in the JSONL                             |
| xterm scrollback (10 000 lines/terminal — not free either) | Repainted by `--resume`                                       |
| **A typed-but-unsent input line**                          | **Lost.** Mitigated by the 15-min grace + never-selected rule |
| Time                                                       | A few seconds of `--resume` on the next click                 |

The main-process `RingBuffer` (256 KiB) dies with the PTY. We deliberately do **not**
persist it: `--resume` repaints its own UI, so persisting the ring is complexity with no
return.

## 5. Data flow

```
renderer                          main
────────                          ────
select(session) ──────────────▶  touchFocus(key, now)     [lastFocusedAt]
                                 pty.onData flush ─────▶  [lastActivityAt]
                                 hook-bridge event ────▶  [lastActivityAt]

pty:create ───────────────────▶  evaluateFleet(...) ──▶ victims
                                 victims.forEach(kill + sessionIndex.removeByPtyId)
◀───── pty:hibernated {key} ───  emit
disposeLiveTerminal(key)         setInterval(60s) ────▶ evaluateFleet(...) (same fn)
store.markHibernated(key)
```

Two new fields on `PtyRec` (`pty.ts:258`) — `startedAt`, `lastActivityAt` — and a
focus map. `PtySessionIndex` stays a pure key↔ptyId index; the timestamps ride on
`PtyRec` where the process lives.

### 5.1 The hibernated set must OUTLIVE the PTY (recon finding)

A hibernated session has **no live PTY**, and two existing mechanisms erase it precisely
when we want to report it:

- `pty.ts` calls **`pruneTaskState(key)` on every teardown** (`onExit`, `pty:destroy`,
  `killAllPtys`), so the hook FSM entry is wiped the moment we kill.
- `taskStateRecord()` (`mcp/server.ts:569-578`) filters `getTaskStates()` through
  **`liveSessionKeys()`**, so anything without a live PTY is dropped from the disclosure.

Therefore `hibernated` **cannot** be derived from PTY liveness or task state. It needs its
own main-process registry that survives the kill:

```ts
// src/main/hibernation.ts
const hibernated = new Set<string>() // session keys
export function markHibernated(key: string): void
export function clearHibernated(key: string): void // called on pty:create for that key (wake)
export function isHibernated(key: string): boolean
export function hibernatedKeys(): ReadonlySet<string>
```

A hibernated session reports `hibernated: true` with **no** `taskState` — which is honest:
the process is not running, so we genuinely do not know what it is doing. The flag is the
whole point (`§6`): it tells an orchestrator "not dead, just parked".

`clearHibernated` fires on `pty:create` for that key, so waking is self-healing — no way to
leave a live session flagged as hibernated.

### 5.2 Never hibernate a pre-migration synthetic (recon finding)

`resolveSpawnSpec` (`renderer/src/components/spawn-spec.ts:77-113`) tests
`synthetic === true` **before** the `claude-resume` branch. So a synthetic session that were
hibernated before migrating to its real uuid would wake into `claude-new` — spawning a fresh
`claude` and **orphaning its transcript**.

The §3.4 immunity list already excludes synthetics, so this is covered — but by policy, not
by construction. It gets an explicit regression test (§8.1) so a future relaxation of the
immunity list cannot silently reintroduce it.

## 6. Agent-facing surface (required by the repo contract)

`get_fleet` gains a **`hibernated`** flag per session.

This is not cosmetic. An orchestrator polling `get_fleet` must distinguish _hibernated_
from _dead/stuck_ — otherwise it concludes the session it dispatched died and respawns on
top of it. That is exactly the failure recorded in the `orchestrator-idle-not-stalled`
lesson.

Per `CLAUDE.md` → "Self-awareness doc is mandatory", this makes the change **agent-facing**:
`docs/capy-features.md` must be updated **and its `<!-- capy-features vN -->` marker bumped**
in the same change, or `scripts/ci/awareness-gate.mjs` fails the build.

## 7. UI

- Sidebar: hibernated sessions render a discreet `💤` state (dimmed row, not an error).
  Clicking rehydrates. **New visual state → `design.md` §6 must be edited first**, per the
  design contract.
- Footer: a live meter — `5 vivas · 2.1 GB`. This is the manual-control option (approach B)
  arriving for free, but as **information**, not as another chore the operator must remember
  (cf. the open card on the Approval Inbox being too easy to forget).
- Settings: `maxLive`, `hardIdleMs` configurable.
- i18n: every new string in **both** `en.json` and `pt-BR.json` (schema parity — the build
  breaks otherwise).

## 8. Test plan (TDD)

The policy is pure, so the RED tests come first and **are** the spec.

### 8.1 Unit — `tests/fleet-policy.test.ts`

| Test                                    | Rule locked                        |
| --------------------------------------- | ---------------------------------- |
| below cap → `[]`                        | hot path untouched                 |
| at cap, one cold → evicts it            | LRU basics                         |
| coldest is `working` → picks the next   | **the disaster guard**             |
| candidate is `synthetic-*` → immune     | no JSONL, `--resume` can't restore |
| candidate is selected → immune          | never kill what's on screen        |
| candidate has pending approval → immune | no orphaned confirm                |
| **all** ineligible → `[]`               | the cap yields, never blocks       |
| below cap, idle 61 min → victim         | the sweep (trigger B)              |
| unfocused 40 min but hook hot → immune  | **"went to lunch"**                |
| focused recently, no activity → immune  | both sources must be cold          |
| N+3 sessions → exactly 3 victims        | never over-kills                   |

### 8.2 What TDD does **not** cover

Honestly: unit tests prove the _decision_, not the _reclamation_. None of them prove that
`kill()` actually returned 420 MB, that `--resume` rehydrated, or that the main-process
timer is not throttled in background. Those need integration:

- Playwright `_electron` (the T05 safety net) for the hibernate → click → rehydrate loop.
- The second-instance CDP recipe (`docs/dev/live-verify-second-instance.md`) to observe real
  RSS drop after an eviction.

## 9. Idle-pulse spike — RESOLVED 2026-07-11

**Verdict: no idle pulse. Raw PTY bytes are a valid `lastActivityAt` source. The design stands.**

The risk was that Claude's TUI might repaint while parked at the prompt — periodic bytes
with no semantic activity behind them would keep `lastActivityAt` permanently hot and the
sweep would never fire, failing _silently_.

Measured by spawning `claude` on a real pty (`pty.openpty`, 120x30, `TERM=xterm-256color`),
sending nothing, and logging every read for 150 s with a 20 s settle window to discard the
boot paint:

```
boot/first-paint bytes (t < 20s, discarded): 4643
IDLE-WINDOW reads : 0
IDLE-WINDOW bytes : 0
```

**Zero bytes across 130 s of idle.** Consequences:

- `lastActivityAt` is driven by the PTY byte flush, as designed in §3.4.
- The T92 hook stays a **second, independent** source — graceful degradation, not a hard
  dependency. If the hook is missing or dies, raw bytes still supply the pulse.
- The byte-volume threshold contemplated as a middle ground is **not needed**. Dropped (YAGNI).

## 9b. Live verification found the design's real flaw — BUG-1 is load-bearing

The unit tests all passed while the feature was **completely inert**. Only driving the real
app caught it.

**What happened.** Spawning three real sessions against a cap of 2 parked nobody. The
main-process fleet snapshot showed why:

```
{"k":"195892c6","kind":"claude-resume","ts":"working","idleFocus":119030,"idleAct":107975}
```

A freshly-resumed session reports **`taskState: 'working'` while emitting ZERO bytes for
108+ seconds** — and it never relaxes. `claude --resume` appears to replay the transcript's
tool-call hooks (`PreToolUse`/`PostToolUse` → `working` in `reduceTaskState`), and with no
`Stop` to follow, the FSM latches. (A second session in the same run resolved correctly to
`idle`, so it is session-dependent, not universal.)

This is **BUG-1** — already in the backlog as _"Status ≠ activity — the board lies upward"_.
The tests passed because they mocked `taskState: 'idle'`.

**Why it was fatal.** With `taskState !== 'working'` as an absolute immunity rule, a session
with a latched FSM is **unparkable forever** — and it holds a slot in the cap permanently,
which is precisely the leak this feature exists to close.

**The fix: corroborate the claim, don't trust it.** A `working` session now gets the STRICT
threshold (`hardIdleMs`, 60 min) instead of immunity, even under the lenient `cap` trigger:

```ts
const effectiveThreshold = s.taskState === 'working' ? policy.hardIdleMs : thresholdMs
return idleMs(s, now) > effectiveThreshold
```

The claim this leans on is deliberately weak: **real work is never SILENT for a full hour**
(any turn, tool call, or spinner tick writes bytes). A `working` session that has emitted
nothing for an hour is a stale FSM or a stall, and parking it is safe either way —
`--resume` restores the conversation.

We do **not** claim "work is never silent for 15 minutes". That was spiked and came back
**inconclusive** (the probe captured only the prompt echo, never a real turn). The one-hour
bar is the one the evidence supports. If someone later proves the stronger claim, the
`working` branch can be tightened to `thresholdMs` and the cap gets sharper.

**Consequence for BUG-1:** hibernation now degrades gracefully around it rather than
depending on it. But BUG-1 remains worth fixing — a latched `working` session still shows a
lying green dot in the sidebar for up to an hour.

### Measured result (live, second instance)

Three real sessions spawned against a cap of 2:

|                | Live PTYs          | `claude` child processes | RSS        |
| -------------- | ------------------ | ------------------------ | ---------- |
| Before the fix | **3** (cap broken) | 3                        | ~1290 MB   |
| After the fix  | **2**              | **2**                    | **863 MB** |

`pty:hibernated` fired for the LRU session, it left the live index, its process died, and
clicking it back produced **68 331 bytes of replayed transcript** — the conversation came
back intact.

## 10. Out of scope (YAGNI)

- RSS-based eviction. RSS is noisy and cross-platform hostile (`/proc` on Linux, `ps` on mac).
  Measure it for the **footer display**; never put it in the decision path.
- Persisting the ring buffer across hibernation (§4).
- A reaper for orphaned processes — there are none (§1.1). Revisit only if one is observed.

## 11. Definition of done

- [ ] **§9 idle-pulse spike run and its outcome recorded here** — gates everything below
- [ ] `tests/fleet-policy.test.ts` green (§8.1), written first
- [ ] `evaluateFleet` pure, `now` injected
- [ ] cap enforced in `pty:create`; sweep in main-process `setInterval`
- [ ] `get_fleet` exposes `hibernated`
- [ ] `docs/capy-features.md` updated + version marker bumped (CI gate)
- [ ] `design.md` §6 hibernated row state, edited **before** the Vue
- [ ] i18n keys in `en.json` **and** `pt-BR.json`
- [ ] `CHANGELOG.md` entry under `## 2026-07-11`
- [ ] `npm run typecheck` and `npm run build` pass
