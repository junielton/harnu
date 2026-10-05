# PRD — T320 Containers takeover

**Status:** approved for delivery 2026-09-11 (operator: "depois das specs prontas e as tasks
organizadas por wave pode seguir").

**Related documents:**

- **Visual contract:** [`docs/specs/2026-09-10-containers-view/spec.html`](../specs/2026-09-10-containers-view/spec.html), framed by `review.html`.
- **Action audit:** [`smoke-test.md`](../specs/2026-09-10-containers-view/smoke-test.md).
- **Agent surface:** [`docs/specs/2026-09-11-containers-mcp-verbs.md`](../specs/2026-09-11-containers-mcp-verbs.md).
- **Architecture:** [ADR-0014](../adr/0014-containers-ship-as-core-with-a-wire-seam.md).

Anything marked **(provisional)** was decided while planning the delivery, not by the operator.
It stands until the operator corrects it.

## 1. Problem

Parallel orchestration leaves docker stacks running long after the work in their worktree has
shipped. The following was measured on 2026-08-31 on a Laravel Sail repo (`org/proj/www`, 53
worktrees):

- 40 containers used about 6.0 GB of RSS, 4.6 GB of it in 8 MySQL instances.
- They held 48 host ports.
- The host was left with 1.7 GiB free and no swap.
- One stack survived its deleted worktree, leaving 4 containers and a 657.9 MB volume.
- `docker system df` reported 88 B reclaimable, because exited containers still reference the
  volume.

Every fact is available from the docker CLI. The product is the aggregated **view**, and a sweep
the operator trusts.

## 2. Journeys

- **Operator.** The 19 journeys in `smoke-test.md` §2 are all in scope. After the 2026-09-11
  fixes, every one is covered except M7, which this PRD specifies in §6.
- **Agent.**
  - An orchestrator decides what to stop after a fan-out.
  - A session resumes a worktree whose stack was stopped, and starts it.
  - A Scheduler observe worker watches for zombies and notifies the operator.

## 3. Concepts

### 3.1 Stack

The unit a row represents: one compose project (the `com.docker.compose.project` label), or one
container that belongs to no project. Every action targets a stack.

### 3.2 Attribution ladder

The first rung that matches wins:

1. The compose `com.docker.compose.project.working_dir` label.
2. The source of a bind mount that lies inside a folder Capy knows.
3. Nothing: the stack is **unattributed**.

The attributed path is then resolved against Capy's folders. It is either a repo's **main
checkout**, a **worktree**, or a path that **no longer exists**.

### 3.3 Verdicts

Evaluate in this order; the first verdict that applies wins.

| #   | Verdict                     | Rule                                                                                                                                                | Section     | Chip                    |
| --- | --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- | ----------------------- |
| 1   | `unknown`                   | Unattributed (§3.2 rung 3).                                                                                                                         | Leave alone | neutral, "unknown"      |
| 2   | `orphan`                    | The attributed path no longer exists on disk.                                                                                                       | Needs you   | amber, "orphan"         |
| 3   | `active`                    | A Capy session in the attributed folder is `working` or `needs-input` with a live PTY. This is the same predicate as Reaper's `computeLiveFolders`. | Leave alone | accent, "active"        |
| 4   | `protected`                 | The attributed folder is a repo's main checkout.                                                                                                    | Leave alone | neutral, "protected"    |
| 5   | `pending` **(provisional)** | Attributed worktree, no live session, **unused for** less than `zombieAfterDays`.                                                                   | Leave alone | neutral, "zombie in Nd" |
| 6   | `zombie`                    | Attributed worktree, no live session, unused for at least `zombieAfterDays`.                                                                        | Needs you   | green, "zombie"         |

**Unused for (provisional):** the time elapsed since the later of these two:

- the last activity of any Capy session in the attributed folder;
- the most recent start or stop time (`State.StartedAt` / `State.FinishedAt`) of any container in
  the stack.

Stopping a stack does not reset the clock. The row stays a zombie until it is removed.

**Copy rule (operator decision, 2026-09-11):** "zombie" is the only user-facing term. The UI and
the docs never say "idle". The duration field is labelled "Unused for".

### 3.4 Actions and tiers

The actions live in **one main-process function**, which is called by the IPC handler and by the
MCP handlers. Tiers are enforced there and nowhere else.

| Action     | Allowed on                                                             | Refused on (code)                                                            | Reversible           | Confirm         |
| ---------- | ---------------------------------------------------------------------- | ---------------------------------------------------------------------------- | -------------------- | --------------- |
| **Stop**   | running `zombie`, `orphan`; manual on `active`, `protected`, `pending` | `unknown` (`STACK_NOT_ATTRIBUTABLE`)                                         | yes (`docker start`) | none in the UI  |
| **Start**  | stopped `zombie`, `pending`, `protected`, `active`                     | `orphan` (`WORKTREE_GONE`), `unknown`                                        | yes                  | none            |
| **Remove** | **stopped** `zombie`, `orphan`                                         | running stack (`STACK_RUNNING`), `active`, `protected`, `pending`, `unknown` | no                   | always (dialog) |
| **Sweep**  | `zombie`, `orphan`, **running or stopped**                             | `active`, `protected`, `pending`, `unknown`                                  | no                   | always (dialog) |

- **Bulk "Stop N running"** stops every running stack under "Needs you" (zombies and orphans). It
  never stops `active`, `protected`, `pending` or `unknown`. The UI asks for no confirmation,
  because stopping is reversible and the click is the consent.
- **Remove** always removes the containers first and the volumes second, and touches a volume
  only when the operator ticks it. Docker itself refuses to remove a volume that any container
  still references, and a running container without `--force`. The action never uses `--force`.
- **Sweep** (T340) is one operator gesture that clears the whole "Needs you" list: it
  stops-then-removes **every** zombie and orphan, running or stopped. Like the bulk stop, the main
  process picks the target set — the request carries no stack list, and no flag in it can widen the
  set. A running stack is stopped first and only then removed, so `docker rm` still never sees
  `--force`; a stack whose stop fails is reported as a failure and is **not** removed. Volume
  removal stays opt-in, and in a sweep it runs after **every** container removal: a volume two
  swept stacks share is removable once both are gone, while a volume any surviving stack still
  mounts is kept. `sweep` is operator-only — no MCP op exposes it, and an agent still stops and
  removes stacks one at a time.

### 3.5 Journal

Every action writes **one** tombstone to `<userData>/containers-log.jsonl`. It records:

- the time, the actor (`operator` | `agent`), the verb and the stacks it touched;
- per stack: the container ids and what was freed;
- a `restoreHint`.

What the `restoreHint` holds depends on the action:

- **after a stop:** `docker start <ids>`;
- **after a removal whose worktree still exists:** the compose recreate command
  (`docker compose -p <project> --project-directory <path> up -d`, so a stack named by `-p` or
  `COMPOSE_PROJECT_NAME` comes back under its own name and finds the volumes it kept);
- **after a removal whose worktree is gone:** nothing;
- **after a sweep:** the same recreate command when the sweep touched exactly one recreatable
  stack, and otherwise nothing — a batch no single command restores stores `null` rather than a
  hint that would read as if it brought the whole batch back (T340).

A bulk stop and a sweep each write one tombstone listing every stack they changed, and "Recent"
shows one entry per action.

## 4. Delivery units

All units branch from the integration branch `feat/containers`, and their PRs target it.
`feat/containers → main` is a single final PR.

| Unit | Card     | Wave | Scope                                                                                                                                 |
| ---- | -------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------- |
| U1   | core     | 1    | Main-process scan, attribution, verdicts, actions, journal, prefs, background scan, IPC + preload. No UI.                             |
| U2   | view     | 2    | The takeover, its detail panes, the remove dialogs, the footer pill, the registry wiring, i18n, `design.md` §6, the user doc.         |
| —    | T328     | 2    | The `list_containers` read verb.                                                                                                      |
| U3   | settings | 3    | The Settings tab (§6) and the new-zombie notification.                                                                                |
| —    | T329     | 3    | The `stop_containers` / `start_containers` / `remove_containers` verbs.                                                               |
| —    | T321     | —    | **Not in this delivery.** A stop-stack step in the Reaper; blocked until the planned Reaper refactor (operator decision, 2026-09-10). |

## 5. Snapshot (wire contract)

`src/main/containers/containers-wire.ts` holds plain types that survive JSON round-tripping:
`ContainersSnapshot`, `StackRow`, `ContainerRow`, `Verdict`, `Tombstone`, `ActRequest`,
`ActResult`. The file imports no Electron and no sibling main-process module.

The renderer and the MCP read verb both consume the snapshot exactly as it is. Neither ever
derives a verdict.

The snapshot carries these fields:

- `scannedAt`
- `dockerAvailable` and `dockerError?`
- `totals`:
  - `zombieRamBytes`, `zombiePorts`, `volumeBytesAtStake`;
  - RAM grouped by verdict, for the meter.
- `stacks[]`
- `recent[]` (the tombstones)

## 6. Settings (smoke test M7)

A **Containers** tab in Settings reuses `CleanupSettingsPane.vue`'s anatomy. It has no mockup of
its own; its visual contract is that anatomy. The labels and defaults below are **provisional**:

| Field                | Label                       | Default | Bounds                          |
| -------------------- | --------------------------- | ------- | ------------------------------- |
| `autoScan`           | Scan in the background      | on      | —                               |
| `intervalMs`         | Scan every                  | 60 min  | 30 min – 24 h (Reaper's bounds) |
| `zombieAfterDays`    | Zombie after                | 2 days  | ≥ 1                             |
| `notifyOnNewZombies` | Notify me about new zombies | on      | —                               |

Background scans feed the footer pill even while the view is closed. The new-zombie notification
fires **once per stack**, on the scan where the stack first becomes a zombie. Clicking it opens the
takeover.

## 7. Safety invariants

1. `unknown` is never touched by any action, from the UI or from an agent.
2. Nothing is removed while it is running. `--force` is never used.
3. A volume is removed only when the operator opts in. `remove` names exactly **one** stack and has
   no bulk form — that contract is unchanged. Clearing the whole "Needs you" list is the separate
   **`sweep`** verb (T340), whose targets are picked in the main process and never named by the
   caller; it stops a running stack before removing it, so `--force` is still never used, and it is
   available to the operator only.
4. Tiers are enforced in the main process. A renderer or agent request that violates them is
   refused.
5. **Verification never touches real stacks.** Executors verify against throwaway containers they
   create themselves, named `capy-verify-*`, plus a throwaway compose project in a temp directory.
   They remove all of it afterwards. The operator's machine runs real client stacks.

## 8. Non-goals

- Autonomous stopping.
- Port allocation (a future `allocate:` manifest key).
- Non-docker processes, such as dev servers.
- Integration with System Monitor or the Reaper (T321 covers the Reaper later).
- Pruning images.
- Docker contexts other than the default one.

## 9. Risks

- **Slow scans.** `docker stats --no-stream` and `docker system df -v` can take seconds with many
  containers. The UI shows a scanning state, and volume sizes may arrive after the rows.
- **Windows attribution.** Paths need normalisation before they are compared on Windows.
- **Clock skew.** Container timestamps are UTC; compare instants, never wall-clock strings.
