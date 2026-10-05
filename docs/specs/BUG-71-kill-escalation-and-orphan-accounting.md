# BUG-71 — Kill escalation, death verification, and orphan accounting

**Date:** 2026-07-22
**Status:** proposed (no code written; §8 spike gates the numbers)
**Problem owner:** Junielton
**Card:** `.capy/memory/roadmap/BUG-71-kill-without-escalation-or-verification-plus-immediate-forget.md`

## 0. Corrections to the diagnosis — read this first

The card is right about the three kill sites and right about the premature forget. Four
claims in and around it are wrong, imprecise, or incomplete, and the design below depends
on getting them right.

1. **"No verification the process died" — the evidence exists, Capy throws it away.**
   node-pty runs a dedicated thread that `waitpid()`s the child and fires an exit callback
   (`node_modules/node-pty/src/unix/pty.cc:150-193`, wired at `src/unixTerminal.ts:106`,
   surfaced as `emit('exit')` at `src/unixTerminal.ts:98,102`). Capy already subscribes:
   `pty.onExit(...)` at `src/main/pty.ts:788`. Authoritative death evidence for the direct
   child is therefore **free and already on the wire** — `hibernateSession` simply does not
   wait for it, and by the time it arrives (`src/main/pty.ts:797` → `ptys.get(id)`) the
   record is gone. The fix is not "add a probe", it is "stop discarding the answer".

2. **The card's acceptance criterion "no teardown path can remove a pty record while its
   process may still be alive" is wrong as literally worded, and implementing it would
   introduce two new bugs.** The `ptys` map is the app's _liveness_ source: the `pty:create`
   dedup guard reads it (`src/main/pty.ts:539-542` — `sessionIndex.getPtyId` corroborated by `ptys.has(existing)`) and
   `liveSessionKeys()` (`src/main/pty.ts:978-980`) gates the MCP task-state disclosure. Keeping
   a dying record in `ptys` would make a click on a parked session return the **dead ptyId**
   from the dedup guard, and would make `get_session` report a corpse as live. The record must
   still leave `ptys` synchronously. What must **not** happen is that it is _forgotten_. Those
   are two different things, and §5 separates them with a `stopping` registry that outlives the
   map entry — exactly the shape `hibernation.ts` already established for the same reason
   (T119 §5.1).

3. **"Kill the process group where the platform allows" understates Windows and overstates
   the risk of a signal argument.** On Windows, node-pty's `kill()` **throws** if you pass any
   signal at all (`src/windowsTerminal.ts:164-167`: `throw new Error('Signals not supported on
windows.')`), so a naive `pty.kill('SIGKILL')` escalation is a crash, not a no-op. Also on
   Windows the _group_ problem is already solved: `windowsPtyAgent.kill()` enumerates the
   console process list and `process.kill()`s every pid in it
   (`src/windowsPtyAgent.ts:141-182`), explicitly because "node servers in particular seem to
   become detached and remain running". Windows is the platform that gets this right today;
   Linux and macOS are the ones that leak.

4. **The card calls the surviving-children case hypothetical ("if … holding an MCP `node`
   child"). It is not hypothetical — it is the steady state on this machine, measured today.**
   See §3: every live session right now owns 3–9 descendants (MCP `npm exec` → `sh` → `node`,
   a `php`, a `bash` → `docker` → `docker-compose`), all in the session's process group, worth
   ~70–300 MB **on top of** the 400–500 MB `claude` root.

Unchanged from the card, and confirmed: this is **latent**. No orphan has been reproduced;
the operator's post-reboot `ps` was clean, and the confirmed leak on that machine is BUG-68.
The deliverable here is accounting, not a repro. Nothing below should be written up as "we
fixed the freeze".

## 1. The gap, exactly

| Site                                | Line                  | What it does                                                     |
| ----------------------------------- | --------------------- | ---------------------------------------------------------------- |
| `hibernateSession` (park)           | `src/main/pty.ts:511` | `rec.pty.kill()` in a `try {} catch {}` that swallows everything |
| `pty:destroy` (close / manual park) | `src/main/pty.ts:835` | same                                                             |
| `killAllPtys` (quit)                | `src/main/pty.ts:963` | same                                                             |

No signal argument, no timeout, no escalation, no probe. All three then drop every handle:

- `hibernateSession` — `ptys.delete(ptyId)` (`:515`), `sessionIndex.removeByPtyId(ptyId)`
  (`:516`), `pruneTaskState` (`:517`), `lastFocusedAt.delete` (`:518`), `markHibernated`
  (`:519`), all on the lines immediately after the kill.
- `pty:destroy` — `ptys.delete(id)` (`:839`), `removeByPtyId` (`:842`).
- `killAllPtys` — `ptys.clear()` (`src/main/pty.ts:970`).

After those lines the only reference to the `IPty` object is the closure captured by its own
`onData`/`onExit` handlers. **No code path can reach that process again**: it has no `ptys`
entry, so it is absent from `livePtyDescriptors()` (`:1026`) and therefore from every System
Monitor row, absent from `liveSessionKeys()` and therefore from every MCP disclosure, and
absent from `fleetSnapshot()` (`:474`) and therefore from the hibernation policy that would
otherwise notice it. A survivor is invisible **by construction** — that is the whole defect.

The park path is the worst of the three, because it is the _automatic_ one: the T119 sweep
fires every 60 s (`src/main/pty.ts:431`, `SWEEP_INTERVAL_MS = 60_000`) with no operator in the
loop, so a systematically-failing kill would accumulate silently.

## 2. What `kill()` actually does (node-pty 1.1.0, read from `node_modules`)

### 2.1 Linux and macOS

```ts
// node_modules/node-pty/src/unixTerminal.ts:249-253
public kill(signal?: string): void {
  try {
    process.kill(this.pid, signal || 'SIGHUP');
  } catch (e) { /* swallow */ }
}
```

- The default signal is **SIGHUP**, not SIGTERM.
- It is sent to `this.pid` — a **positive** pid, i.e. **the single direct child only**, never
  the process group. `this._pid` is the pid `forkpty(3)` returned (`src/unixTerminal.ts:147`).
- The `catch` swallows everything, including `ESRCH`. Even the one bit of information
  `process.kill` does give you (does this pid still exist?) is discarded before Capy can see it.

The child is a **session leader with its own process group**: node-pty forks via `forkpty(3)`
(`node_modules/node-pty/src/unix/pty.cc:399`), whose `login_tty()` calls `setsid()`. Hence
`pid == pgid == sid` for every session — verified live on this machine (§3). That is what makes
`process.kill(-pid, sig)` a well-defined, exact-scope group kill here: the negative form targets
that session's group and nothing else.

Death is observable without polling: `pty.cc:150-193` `waitpid()`s the child on a dedicated
thread and reports `WIFEXITED`/`WTERMSIG` through a thread-safe callback →
`emit('exit', code, signal)` (`src/unixTerminal.ts:98,102`) → Capy's `pty.onExit`
(`src/main/pty.ts:788`).

**Scope limit, stated plainly:** `onExit` proves the _root_ died. It says nothing about
descendants, which are reparented to `init`/`launchd` and are no longer anyone's child.

### 2.2 Windows

```ts
// node_modules/node-pty/src/windowsTerminal.ts:164-172
public kill(signal?: string): void {
  this._deferNoArgs(() => {
    if (signal) { throw new Error('Signals not supported on windows.'); }
    this._close();
    this._agent.kill();
  });
}
```

`_agent.kill()` (`src/windowsPtyAgent.ts:141-182`) closes the pty handle and additionally
`process.kill()`s **every pid in the console process list** (conpty branch: via the
`conpty_console_list_agent` fork; winpty branch: via `getProcessList`). On Windows,
`process.kill(pid)` from Node maps to `TerminateProcess` regardless of the signal name — there
is no graceful/forceful distinction to escalate through.

Consequences for the design: (a) never pass a signal to `pty.kill()` on Windows; (b) the
"group" step is already done for us; (c) escalation on Windows means _repeating_ the terminate
against the recorded root pid, and the ladder collapses to two rungs.

### 2.3 Cross-platform liveness probe

`process.kill(pid, 0)` performs permission + existence checking without sending a signal, on
every platform Node supports. Two caveats the implementation must respect:

- A **zombie** (exited, not yet reaped) still answers "alive". This is why `onExit` — a real
  `waitpid` — is the primary evidence and signal-0 is only the fallback for the window before
  the reap, and for **descendants**, which we never waited on.
- **pid reuse.** Once reaped, the pid may be recycled. Any probe of a pid we did _not_
  `waitpid` (i.e. any descendant, and any ledger entry read after a restart) must be
  corroborated — on Linux by `/proc/<pid>/stat` field 22 (`starttime`), which
  `src/main/monitor/proc-parse.ts` already parses the same file for. Off Linux, we do not
  re-probe across restarts at all (§6.3).

## 3. What a session actually owns — measured, 2026-07-22

Read-only `/proc` walk of the running AppImage (Capy main = pid 8666). Every column is
`pid, ppid, pgid, sid, comm, RSS(MB)`:

```
ROOT (225622, 8666, 225622, 225622, 'claude', 499)
     (225657, 225622, 225622, 225622, 'npm exec mcp-gi', 80)
     (225658, 225622, 225622, 225622, 'npm exec @playw', 79)
     (225664, 225622, 225622, 225622, 'php', 62)
     (225777, 225658, 225622, 225622, 'sh', 1)
     (225779, 225777, 225622, 225622, 'node', 107)
     (225780, 225778, 225622, 225622, 'node', 72)
ROOT (416826, 8666, 416826, 416826, 'claude', 408)
     (416881, 416826, 416826, 416826, 'npm exec mcp-gi', 80)
     (416883, 416826, 416826, 416826, 'bash', 3)
     (417127, 416883, 416826, 416826, 'docker', 28)
     (417161, 417127, 416826, 416826, 'docker-compose', 27)
     … (7 descendants total)
```

Three facts follow, and they are the load-bearing ones:

1. **`claude` is a direct child of Capy main**, spawned without an intermediate shell —
   `spawn(runCommand, runArgs, …)` at `src/main/pty.ts:741`, with `command = claudePath`
   resolved by `resolveClaudePath()` (`:561`) and argv built by `claude-args.ts`. Nothing in
   `shell-resolve.ts` is involved for `claude-*` kinds; `defaultShell()` is only the fallback
   for `kind === 'shell'` (`src/main/pty.ts:663`). So there is no shell wrapper that would
   otherwise absorb or forward the signal.
2. **`pid == pgid == sid` for every session root** (225622/225622/225622, 416826/416826/416826)
   — the `forkpty` + `setsid` invariant of §2.1, confirmed empirically rather than assumed.
3. **Every descendant, at every depth, carries the root's pgid and sid.** MCP servers launched
   as `npm exec … → sh → node`, a `php` language server, and a Bash-tool `docker` →
   `docker-compose` chain all sit in the session's group. A single-pid SIGHUP to the root
   leaves all of them running, reparented to pid 1, in **no** Capy data structure.

Per-session cost is therefore not "~450 MB" but **root + subtree**, up to ~800 MB in the
worst row above. The System Monitor already sums exactly this (`aggregateSubtree` over
`ppid` links, `src/main/monitor/aggregate.ts:35-40`) — for _live_ sessions only.

**The one mitigation that already exists, and why it is not enough.** When a session leader
exits, the kernel sends SIGHUP to the foreground process group of its controlling terminal, so
in the common case those same-pgid children _may_ get hung up for free. That mechanism is
real but is not a guarantee: it does not reach a process that installed `SIG_IGN` for SIGHUP,
one that called `setsid()`/`setpgid()` to leave the group, or one in a background group. It is
precisely the kind of "usually works" that produces a rare, invisible, 800 MB leak. An explicit
group kill removes the doubt for the cost of one syscall.

(Out of reach either way: containers `docker-compose` started live in dockerd's session, not
ours. Named as a known limit, not solved here.)

## 4. The escalation ladder

One pure decision function, one thin shell — the `fleet-policy.ts` precedent (ADR-0001
pure-core / thin-shell; the same shape `evaluateFleet` uses, with `now` injected).

```ts
// src/main/kill-escalation-core.ts — pure. No electron, no node-pty, no clock.
export type KillStage = 'hup' | 'term' | 'kill' | 'confirmed' | 'orphan'

export interface KillState {
  ptyId: string
  sessionKey: string | null
  pid: number
  /** Resolved process-group id; `null` when unresolvable → group form is not used. */
  pgid: number | null
  startedKillAt: number
  stage: KillStage
  /** Set by the `onExit` subscription — the authoritative reap. */
  rootExited: boolean
}

export type KillAction =
  | { do: 'signal'; scope: 'group' | 'pid'; signal: 'SIGHUP' | 'SIGTERM' | 'SIGKILL' }
  | { do: 'terminate-windows' } // no signal argument — see §2.2
  | { do: 'probe' }
  | { do: 'settle'; outcome: 'confirmed' | 'orphan' }
  | { do: 'wait' }

export function nextKillAction(
  s: KillState,
  now: number,
  budget: KillBudget,
  platform: 'linux' | 'darwin' | 'win32'
): KillAction
```

### 4.1 Rungs and grace periods (Linux/macOS)

| t (ms from first kill) | Action                                                  | Why this rung exists                                                                                                                                                                                                                                                             |
| ---------------------- | ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0                      | `pty.kill()` (root, SIGHUP) **+** `kill(-pgid, SIGHUP)` | Keep node-pty's own teardown bookkeeping intact (it closes the master fd), and hup the group in the same tick. SIGHUP first, not SIGTERM: it is today's behavior, sessions do die under it in the common case, and it is the signal a TUI expects for "your terminal went away". |
| **2 000** (`GRACE_1`)  | `kill(-pgid, SIGTERM)`                                  | The root did not reap. Escalate politeness, not force — a mid-tool-call `claude` still gets to flush its JSONL tail.                                                                                                                                                             |
| **5 000** (`GRACE_2`)  | `kill(-pgid, SIGKILL)`                                  | Unignorable. Anything that survived two catchable signals is not going to cooperate.                                                                                                                                                                                             |
| **6 000** (`FINAL`)    | probe root + subtree → `settle`                         | SIGKILL is asynchronous (the kernel may still be tearing down); one second is a generous reap window.                                                                                                                                                                            |

`pgid === null` (unresolvable) → every rung falls back to the positive-pid form. Never silently
skip a rung.

**On the numbers.** They are _placeholders with a derivation rule, not folklore_, and §8 gates
them. The only teardown latency this repo has ever measured is T119 §9b, where a parked
session's process was gone inside a single 1.5 s monitor tick — which bounds the common case
below 1.5 s and nothing more. Rule: `GRACE_1 = max(1000, 2 × p100(exit latency over 20 real
parks))`, `GRACE_2 = GRACE_1 + 3000`. If the spike measures a p100 above 1 s, these constants
move **before** the code lands. They live in one exported `KillBudget` object so the quit path
(§7) can substitute its own without a second ladder.

### 4.2 Platform matrix — nothing silently no-ops

| Step             | Linux                                 | macOS                                                                                                | Windows                                                                                                       |
| ---------------- | ------------------------------------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Resolve pgid     | `/proc/<pid>/stat` field 5 (`pgrp`)   | assume `pgid === pid` (forkpty/`setsid`, §2.1); no `/proc`                                           | n/a                                                                                                           |
| Rung 1           | `pty.kill()` + `kill(-pgid,'SIGHUP')` | same                                                                                                 | `pty.kill()` **with no argument** (a signal throws — §2.2); the agent already sweeps the console process list |
| Rung 2 / 3       | `SIGTERM` → `SIGKILL` to `-pgid`      | same                                                                                                 | single rung: re-`process.kill(rootPid)` (Node maps it to `TerminateProcess`)                                  |
| Root death proof | `onExit`                              | `onExit`                                                                                             | `onExit`                                                                                                      |
| Subtree proof    | `/proc` walk (`aggregate.ts`)         | **unavailable** — `createSampler()` returns the NullSampler (`src/main/monitor/proc-linux.ts:69-76`) | unavailable, but the agent's console-list kill makes it much less likely                                      |

macOS is the weak platform: group kill works, but there is **no way to verify the subtree
died**, because Capy has no process sampler there. The spec does not pretend otherwise — a
macOS orphan record can only ever be about the root (which `onExit` does cover). Writing a
`ps`-based macOS sampler is out of scope here and belongs to T127's platform seam.

## 5. Verification and the `stopping` registry

New module `src/main/kill-escalation.ts` (thin shell over §4's pure core), owning a
`Map<string /* ptyId */, KillState>`.

Teardown becomes, at all three sites:

1. `flushNow(ptyId)` + clear the flush timer — unchanged, still first.
2. Capture `{ ptyId, sessionKey, pid: rec.pty.pid, pgid, kind }` **before** anything is dropped.
3. `beginKill(rec)` — installs the record in `stopping`, subscribes to the record's existing
   `onExit` (a one-line addition inside the `pty.onExit` handler at `src/main/pty.ts:788`:
   `settleKill(id, evt)`), fires rung 1, arms the timer.
4. Everything the sites do today — `ptys.delete`, `sessionIndex.removeByPtyId`,
   `pruneTaskState`, `markHibernated` — runs **unchanged and synchronously**, for the reasons
   in §0.2.
5. The escalation runs on its own timer. On `onExit` **or** a clean probe → `settle('confirmed')`
   → drop the `stopping` entry. On `FINAL` with the root still alive, or (Linux) with any
   subtree pid still alive → `settle('orphan')` → §6.

Why a separate registry rather than a flag on `PtyRec`: `PtyRec` lives and dies with the `ptys`
map, and the whole point is to outlive it. `hibernation.ts` exists for exactly this reason
(T119 §5.1 — "the hibernated set must OUTLIVE the PTY"), and this is the same lesson applied to
a shorter-lived fact. The registry is also the natural home for the answer to "did the last
park actually work?", which nothing can answer today.

**The `stopping` window must not be observable as liveness.** `stopping` entries are
deliberately _not_ joined into `liveSessionKeys()`, `fleetSnapshot()`, or the `pty:create`
dedup guard. A session that is being killed is not live, and a click during those 2–6 s must
spawn a fresh `claude --resume`, which is correct: the transcript is on disk, and the dying
process is dying.

## 6. Where an orphan becomes visible

### 6.1 The record

```ts
// src/main/orphan-ledger.ts — JSONL under userData, the `reaper/journal.ts` pattern
export interface OrphanRecord {
  at: number
  pid: number
  /** Linux only: /proc/<pid>/stat field 22, to defeat pid reuse across a restart. */
  startTimeTicks: number | null
  pgid: number | null
  sessionKey: string | null
  kind: string
  /** 'park' | 'close' | 'quit' — which teardown site gave up. */
  origin: string
  /** Last known subtree RSS, when the sampler had ever seen it. */
  rssBytes: number | null
  /** Survived through this rung. */
  stage: KillStage
}
```

Append-only, parsed newest-first with a count cap, mirroring `parseJournal`
(`src/main/reaper/journal.ts:39-50`). Atomic writes are unnecessary for an append-only JSONL
(the Reaper journal makes the same call); the quit-path write in §7 uses
`mcp/atomic-write.ts` only if it ever becomes a rewrite rather than an append.

### 6.2 The surface: the Activity bell, with the System Monitor as evidence

**Required surface: the Activity bell** (`ActivityBell.vue` over
`stores/notifications.ts`), one record per orphan: `source: 'app'`, `kind: 'warning'`, title
naming the pid and the RSS, `target: { view: 'system-monitor' }`.

Justified against the alternatives:

- **Fleet rail (`InboxRail.vue`)** — wrong entity. The rail is about _sessions_ that need the
  operator. An orphan has no session left; it is a process. Putting it there would also make
  it compete with approvals, which are time-critical in a way this is not.
- **System Monitor row alone** — wrong reach. It is `/proc`-only (`proc-linux.ts:69-77`:
  macOS/Windows get the `NullSampler`), so on two of the three shipped platforms
  (`build:mac`, `build:win`) the orphan would have **no** surface at all. It also only pushes
  samples while the takeover is open (`fullSamplerRefcount`, `src/main/monitor/sampler.ts:30`),
  so nothing would ever announce itself.
- **Activity bell** — cross-platform, already persisted as a 200-entry / 7-day ring
  (`NOTIFICATIONS_MAX_COUNT`, `NOTIFICATIONS_MAX_AGE_MS`), already the app's attention channel,
  and already carries a navigable `target`. It survives the operator not looking, which is the
  entire failure mode here ("the operator isn't always watching Capy").

**Secondary, Linux only:** `SessionSample.state` (`src/main/monitor/types.ts:33`) gains
`'orphan'` alongside `'live' | 'parked'`, so the monitor renders the subtree with real pids
and real RSS — the evidence behind the bell's claim. `'stopping'` is _not_ added: the window is
2–6 s and a row that appears and vanishes inside three sampler ticks is noise, not information.

**No "force kill" button.** SIGKILL has already failed by the time a record exists; offering a
button that re-sends it would be theatre. The record is information: a pid, a size, and a
sentence telling the operator this process is Capy's fault and must be killed by hand. That is
the honest scope, and it is exactly what the card asked for ("an unkillable session is
information the operator needs").

### 6.3 Boot reconciliation

On startup, read the ledger and, **Linux only**, re-probe each entry (`process.kill(pid, 0)`
corroborated by `starttime`). Gone → drop the entry silently. Still alive → raise the bell
record now. Off Linux, do **not** re-probe (no reliable reuse guard, §2.3): announce a
quit-origin record exactly once, worded as historical (`"…did not confirm exit at last quit"`),
then drop it. Under-claiming beats a false accusation against a recycled pid.

## 7. The quit path — the sharp trade-off

**Question: can `killAllPtys` afford to wait, given the app is about to exit and any survivor
is then unreachable forever?**

**Answer: yes, and the waiting is nearly free — but it must be hard-capped and must never be
able to wedge the quit.**

Three facts make this cheap rather than expensive:

1. **`before-quit` is already async and already defers the quit.** `src/main/index.ts:865`
   is an `async` handler; it already `await`s `recordShutdownSnapshot(...)` (`:880`), and in the
   watcher branch it already calls `event.preventDefault()` (`:907`), `await`s the MCP server
   close and the chokidar close, and only then calls `app.quit()` (`:920`). There is no new
   mechanism to invent — the shape exists, for a lesser reason (releasing file descriptors).
2. **`killAllPtys()` runs first (`:870`), before all of that.** The polite rung is already
   several hundred milliseconds ahead of `app.quit()`. That latency is _dead time we already
   pay_, during which the children are dying anyway.
3. **The alternative is the worst variant in the whole card.** A park-time orphan is at least
   observable by a running app. A quit-time orphan is 500 MB with no process, no UI, and no
   record — the exact shape of "memory climbs until the machine freezes".

Design:

- `killAllPtys()` keeps its position at `:870` and fires **rung 1 for every PTY** (group SIGHUP)
  synchronously, exactly as today plus the group form.
- The existing async shutdown work proceeds untouched — free grace.
- Immediately before `app.quit()`, a new `await reapSurvivors({ budgetMs: 1500 })`: probe every
  `stopping` entry; anything still alive gets **SIGKILL to the group immediately** (no second
  grace — the app is dying, and a SIGKILL after ~a shutdown's worth of latency is strictly
  better than an unreachable survivor), then one final probe.
- The whole reap is `Promise.race`d against a 1 500 ms cap, and `app.quit()` is called in a
  `finally`. A hung probe must never be able to prevent the app from exiting; the failure mode
  of this feature cannot be "Capy won't close".
- Survivors of that final pass are appended to the orphan ledger (§6.1, `origin: 'quit'`) —
  the only surface that still exists at that point — and announced at the next boot (§6.3).
- `event.preventDefault()` must become **unconditional** when there is anything to reap. Today
  it only fires in the `watcherHandle` branch (`:906-907`); a quit with no watcher would
  otherwise skip the reap entirely.

**What we deliberately do not do:** no full 6 s ladder at quit. Two catchable signals plus a
1.5 s cap is the compromise between "let `claude` flush its transcript" and "the operator
clicked X and expects the window to close". A session that needed more than that at quit loses
at most its JSONL tail, which is exactly the loss T119 §4 already accepted for parking.

## 8. Gating spike — measure the grace period before shipping the constants

Same standing as T119 §9 ("gates everything below"). Without it, §4.1's numbers are guesses.

Procedure: park 20 real, long-running `claude` sessions (mixed idle and mid-tool-call) through
`hibernateSession`, timestamping `kill` → `onExit`. Record p50/p100. Then repeat with the group
form and, on Linux, diff `subtreePids()` before and after to count survivors under
(a) single-pid SIGHUP — today's behavior — and (b) group SIGHUP.

Outcomes to record in this file before implementation:

- p100 exit latency → sets `GRACE_1` per §4.1's rule.
- **Survivor count under (a).** If it is consistently zero, the kernel's session-leader SIGHUP
  (§3) is doing the work and the group kill is defense-in-depth rather than a fix — that is a
  materially different card, and it must be written down here rather than quietly assumed away.
- Whether `claude` catches SIGHUP at all (does it flush, or is the JSONL tail already durable?).

## 9. UI and copy

- **No new sidebar state.** `stopping` is transient (§6.2) and parking already has its `💤`
  row (T119 §7). `design.md` needs no edit for it.
- **`design.md` §6 → System Monitor** gains the `orphan` row variant (state pip colour, the
  "not killed" explain line, pids listed) — **edited before the Vue**, per the design contract.
- **i18n**: new keys for the bell title/description and the monitor row, in **both** `en.json`
  and `pt-BR.json` in the same change (schema parity — the build breaks otherwise).
- Copy tone (`design.md` §8): state the fact and the number, do not apologise and do not alarm.
  `"Session process 225622 did not exit (~499 MB). Capy can no longer reach it."`

## 10. Test plan

New files are marked **(new)**; everything else extends a file that exists today.

### 10.1 Pure core — `tests/kill-escalation-core.test.ts` **(new)**

`nextKillAction` with injected `now`, mirroring `tests/fleet-policy.test.ts`'s discipline (no
fake timers, no sleeps — time travel is a different integer).

| Test                                                        | Rule locked                                |
| ----------------------------------------------------------- | ------------------------------------------ |
| `rootExited` at t=10 → `settle('confirmed')`                | the fast, common path never escalates      |
| t=1999, no exit → `wait`                                    | grace is respected, not rounded away       |
| t=2000, no exit → `SIGTERM` to `group`                      | rung 2                                     |
| t=5000, no exit → `SIGKILL` to `group`                      | rung 3                                     |
| t=6000, still alive → `settle('orphan')`                    | the ledger is reached, not looped forever  |
| `pgid === null` → every rung uses `scope: 'pid'`            | fallback, never a skipped rung             |
| `platform: 'win32'` → `terminate-windows`, never a signal   | **the crash guard** (§2.2)                 |
| `platform: 'win32'` at t=2000 → terminate again, no SIGTERM | the two-rung Windows ladder                |
| already `confirmed` → `wait` (idempotent)                   | a late `onExit` can't resurrect the ladder |

### 10.2 Deterministic escalation against a real process — `tests/kill-escalation-shell.test.ts` **(new)**

Fixture **`tests/fixtures/stubborn-child.mjs` (new)**: installs no-op handlers for `SIGHUP`
_and_ `SIGTERM` (so both are caught and ignored — Node cannot ignore `SIGKILL`, which is what
makes the assertion deterministic), optionally `spawn`s a grandchild in the same process group,
then prints `ready` and idles.

- spawn it under node-pty, run the real shell with a compressed budget
  (`GRACE_1: 50, GRACE_2: 120, FINAL: 200`), assert the ladder observably reaches SIGKILL and
  that `onExit` reports `signal === 9`.
- assert the record leaves `stopping` **only after** that exit, and that
  `settle('confirmed')` — not `'orphan'` — was the outcome.
- group variant: assert the grandchild's pid is gone after the group rung, and (control) that a
  single-pid `SIGHUP` run leaves it alive. This is the §3 claim, as a regression test.
- a fixture that also survives SIGKILL cannot be written (by design), so the orphan branch is
  covered by injecting a stub `alive()` probe into the shell — same seam the pure core uses.

Precedent for exercising a real main-process shell with only `electron`/`pty.ts` doubled:
`tests/monitor-sampler-wiring.test.ts`.

### 10.3 Ledger — `tests/orphan-ledger.test.ts` **(new)**

Serialize → parse round-trip, malformed-line skipping, newest-first ordering, count cap,
`starttime` mismatch ⇒ treated as pid reuse ⇒ entry dropped. Mirrors
`tests/reaper-journal.test.ts` exactly.

### 10.4 Existing files to extend

| File                                   | Addition                                                                                                                                                                                |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tests/hibernation.test.ts`            | parking still `markHibernated`s immediately (an operator-facing park is not conditional on the reap), and a _failed_ kill still leaves the key parked **and** produces an orphan record |
| `tests/monitor-sampler-wiring.test.ts` | an `orphan` entry produces a `SessionSample` with `state: 'orphan'` and real subtree pids                                                                                               |
| `tests/pty-session-index.test.ts`      | a `stopping` record is **not** in `liveKeys()` (§5's non-observability rule)                                                                                                            |
| `tests/notifications.test.ts`          | the orphan bell record's shape (`source: 'app'`, `kind: 'warning'`, `target`)                                                                                                           |
| `tests/e2e/reload-survival.spec.ts`    | closest existing quit/reload harness; the quit-path reap gets a sibling spec if this one can't host it                                                                                  |

### 10.5 What the tests do **not** prove

They prove the ladder and the accounting. They do not prove that a real `claude` under a real
mid-tool-call ignores SIGHUP, and they do not prove RSS came back. Those are §8 (spike) and the
second-instance CDP recipe (`docs/dev/live-verify-second-instance.md`) — the same honest split
T119 §8.2 drew.

## 11. Out of scope (YAGNI)

- A macOS/Windows process sampler. Named as the reason those platforms can only verify the root
  (§4.2); it belongs to T127's platform seam, not here.
- A "force kill" action (§6.2 — SIGKILL already failed).
- Reaching into `dockerd`'s session for containers a Bash tool started (§3).
- A periodic orphan scanner sweeping all of `/proc` for stray `claude` processes. Tempting, and
  explicitly deferred: we have no reproduction (§0), and a scanner that guesses at ownership
  will eventually kill someone's hand-launched `claude`. Revisit only if the ledger ever fills.
- Persisting the ring buffer or scrollback across a failed kill.

## 12. Definition of done

- [ ] **§8 spike run and its outcome recorded in this file** — gates the constants below
- [ ] `tests/kill-escalation-core.test.ts` green, written first (§10.1)
- [ ] `nextKillAction` pure, `now` injected, platform injected
- [ ] All three sites (`pty.ts:511`, `:835`, `:963`) route through `beginKill`
- [ ] `stopping` registry outlives the `ptys` entry and is absent from every liveness read (§5)
- [ ] Windows path never passes a signal to `pty.kill()` (§2.2) — asserted by a test
- [ ] Quit path: unconditional `preventDefault`, `reapSurvivors` hard-capped at 1 500 ms,
      `app.quit()` in a `finally` (§7)
- [ ] Orphan ledger written, reconciled at boot (§6.3), announced in the Activity bell
- [ ] `design.md` §6 System Monitor `orphan` row edited **before** the Vue
- [ ] i18n keys in `en.json` **and** `pt-BR.json`
- [ ] `CHANGELOG.md` entry
- [ ] `docs/user/system-monitor.md` + `docs/user/troubleshooting.md` updated (new top-level
      `src/main/` files trigger the user-docs CI gate)
- [ ] Not agent-facing: no MCP verb, no ACK field, no grant/confirm change → `docs/capy-features.md`
      untouched and the awareness gate not triggered (`tool-catalog.ts` is not in the diff)
- [ ] `npm run typecheck` and `npm run build` pass
