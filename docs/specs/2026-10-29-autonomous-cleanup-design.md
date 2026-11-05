# Autonomous Cleanup — unattended workflows never run out of machine

- **Date:** 2026-10-29
- **Status:** draft for operator review (builder check done, operator decisions in §8)
- **Supersedes:** the unattended Docker capacity draft of 2026-10-27 (folded in as U3 and U4; the draft was not committed)
- **Extends:** `docs/specs/2026-10-07-workspace-gc-design.md` (Workspace GC), `docs/prds/T320-containers-takeover.md`
- **Evidence:** `docs/studies/2026-10-27-autonomous-cleanup-risks.md` (three read-only risk reviews, measured on the operator's machine)

## 1. Intent

The operator runs agent workflows across ~5 projects a week, often unattended overnight. Every unit
of work leaves the same bundle behind: a worktree, its dependencies, a compose stack, a network, a
local branch. Cleanup already finds most of it, but it acts under rules written for an operator who is
watching, so the garbage piles up and eventually stops work:

- A delivery sat at 2/10 overnight because Docker had no free bridge network (32 in use, ~31 allowed;
  4 of them empty leftovers, 6 stacks running for worktrees that no longer exist).
- Cleanup showed **26.58 GB reclaimable** next to **"Nothing to clean"**: everything sat in
  "Needs review" or "In use". In Harnu alone, 13 of 28 "Needs review" worktrees (~10.4 GB) were
  provably merged under rules the code did not yet know.

**The goal: the operator never has to stop and clean, and never fears the machine running out —
without ever losing work.** Safety comes from _everything Cleanup removes being restorable_, not from
the operator approving each item.

## 2. The model in one table

What a worktree's bundle is made of, and what Cleanup may do with each part on its own:

| Part                    | Unproven branch (commits may exist only here)                                                     | Strongly merged branch |
| ----------------------- | ------------------------------------------------------------------------------------------------- | ---------------------- |
| Branch (commits)        | **never deleted**                                                                                 | deleted, as today      |
| Worktree folder         | **shelved**: removed after its uncommitted, untracked and ignored files are preserved; restorable | removed, as today      |
| Dependencies            | removed with the folder                                                                           | removed                |
| Compose stack + network | **parked** (`down`, volumes kept)                                                                 | removed, volumes kept  |
| Named volumes           | never removed without operator confirmation                                                       | same                   |

"Shelve" and "park" need no merge proof, because both are fully restorable. Only deleting a branch
needs proof, and that rule does not change.

## 3. Goals, non-goals, anti-goals

**Goals**

1. Idle worktrees are shelved and their stacks parked without a click, freeing disk and Docker
   capacity.
2. Garbage that can only be regenerated (empty compose networks, orphan stacks) is removed
   automatically, whatever deleted the worktree.
3. More merged branches are recognized as merged (squash, rebase-after-merge, stacked bases).
4. A shelved worktree comes back by itself when its session resumes, or by one click.
5. When work still cannot proceed (no Docker capacity left), the operator is told at that moment.
6. The operator reads one digest of what happened, each line with how to undo it.

**Non-goals**

- An LLM never decides a deletion (Workspace GC non-goal stands). An agent may write the
  one-sentence _reason_ in the digest or flag stranded work; it never triggers an action.
- Harnu never re-installs dependencies or restarts a stack. The session that needs them does
  (`WORKTREE.md` setup, `compose up`).
- No outward actions: Cleanup never pushes, opens a PR, or deletes a remote branch on its own.
- Stacks not attributed to a known worktree (`unknown`, `protected`: personal containers, main
  checkouts) stay untouched.

**Anti-goals — failure even if it "works"**

- Any file the operator had in a worktree is missing after a restore — including `.env*`, dumps and
  `.harnu/out` (113 of 197 linked worktrees hold such ignored files today).
- A branch with commits on no remote is deleted.
- A volume is removed, the OS trash is emptied, `git gc` runs, or an archive expires — autonomously.
- A stack is parked while its session is working, or a parked session resumes into a missing folder.
- Parking thrashes: stacks of live, open-PR work evicting each other.

## 4. Units (one PR each, in this order)

### U1 — Merge proofs Cleanup does not know yet

`src/main/gc/fate-core.ts`. Add three strong proofs:

- **Squash containment:** the PR is MERGED and its head commit _contains_ the local tip
  (`merge-base --is-ancestor localTip prHead`), not only equals it. (4 Harnu worktrees today.)
- **Rebase after merge:** every local commit not in the PR head has a counterpart in the merged PR
  with the same author, author date and subject — what a rebase preserves. (9 Harnu worktrees: the
  land flow rebased the stack; the worktrees kept the pre-rebase copies.)
- **Stacked base:** a PR merged into a non-default `baseRefName` counts as merged when that base PR
  is itself merged into the default branch.

**AC-U1** The 13 named Harnu worktrees (`T537`, `fix/gc-archives-trash`, `fix/gc-guided-actions`,
`fix/gc-orphans`, `refactor/t474-b0`, `feat/t474-b1…b8`, `feat/t474-u1`) resolve to strongly merged
and leave "Needs review", unless the content-safe checks in C2 leave some unproven. A branch with any
commit lacking a content-identical counterpart stays unproven.

### U2 — Shelve and restore

Shelve = preserve, then remove the folder; the branch stays.

- **Preserve, before anything is removed:**
  - uncommitted and untracked files → the existing wip archive (`refs/archive/**`);
  - **ignored files outside dependency dirs** (new) → a size-capped snapshot (location is the
    builder's call; it must stay local, never be pushed, and never expire while the branch exists);
  - stash entries naming the branch → copied under the branch's archive refs;
  - a detached HEAD → an archive ref to that commit (it becomes branch-like).
    Shelving is refused if preservation fails or cannot be verified.
- **Eligible to shelve:** no session working on it; idle for at least the **shelve threshold**
  (newest of: transcript write, commit, session transition); no `keep` mark, not `neverClean`, no git
  operation in progress (rebase/bisect/am), not locked, not the main checkout. A `keep` made stale by
  a fate change downgrades to review, never to eligible.
- **Remove:** the folder is deleted for real (the point is freeing disk; the trash frees nothing on
  the same filesystem). _Builder's-call flag: only after preservation is verified._
- **Restore** — one function, two callers:
  - automatically, before Harnu resumes a session whose cwd is a shelved worktree (the resume must
    never start in a missing or wrong folder — BUG-144);
  - a "Restore" action in Cleanup and on the digest line.
    Restore = `git worktree add <same path> <branch|archived HEAD>` + unpack the snapshot + re-apply
    the wip state. Dependencies and stacks are left to the session.

**AC-U2a** After shelve → restore, the worktree is byte-identical to before for every tracked,
untracked and ignored file outside dependency dirs.
**AC-U2b** Resuming a session of a shelved worktree restores it first; the session opens in its own
folder with its history.
**AC-U2c** A worktree with a working session, a keep mark, or an operation in progress is never
shelved; a failed preservation leaves it untouched.
**AC-U2d** No branch is deleted by shelving; branches with commits on no remote survive indefinitely.

### U3 — Docker: park, garbage, capacity

- **Park:** `docker compose -p P --project-directory WD down` (no `-v`) for the stack of a shelved
  worktree, or of a worktree idle past the **park threshold** (idle = newest of session activity,
  container CPU/IO, a Harnu browser pane or host listener on its ports). Record its ports and the
  restore command. Stacks with an anonymous volume, or a database image with no volume on its data
  path, are confirm-only (0 today). Hysteresis: a minimum age since the stack's last `up`, and a cap
  on parks per hour.
- **Garbage, removed automatically:**
  - **empty compose networks** (have the compose project label, zero containers attached, counted
    from containers' `NetworkSettings`, not `network inspect`) — `compose up` recreates them, so this
    is regenerable for any project;
  - **orphan stacks** (verdict `orphan`): containers removed, **volumes kept** and journaled as
    belonging to a removed worktree.
- **Capacity watcher:** knows free bridge-network slots (daemon address pools, default pools when
  `daemon.json` sets none). Below a **low-water mark** it acts at once, not on the hourly tick:
  garbage first, then parks longest-idle eligible stacks.
- **Out of capacity:** at the low-water mark with nothing left to free, and again at zero free slots
  → an immediate Activity notification (and push, if configured). The Mission blocker is raised by the
  session whose `compose up` fails, not by Harnu (C6).
- **Correct restore hint:** a parked stack's journal hint is the `compose up -d` command (with
  `--build` when the compose file builds), never `docker start <ids>` (fails after `down`).
- **Address pool advice:** with default pools and a squeeze observed, Cleanup offers once a guided
  `daemon.json` `default-address-pools` snippet and the restart note. Harnu never edits it.
- **Stale-volume warning:** when a live project mounts a volume journaled as belonging to a removed
  worktree (allocators reuse numbers), warn in Activity.

**AC-U3a** The 4 empty networks of numbered compose projects (13 to 16) and the 6 running orphans are cleared without a click;
no volume is removed.
**AC-U3b** Below the low-water mark, eligible stacks are parked within one watcher interval; a stack
with a working session is never parked; a stack is not parked twice within the minimum age.
**AC-U3c** Zero free slots fires one immediate notification; `docs/harnu-features.md` tells a
session whose `compose up` fails on pools or ports to raise an operator-owned blocker on its step.
**AC-U3d** Every park records its ports and a `compose up -d` command that, run by hand, brings the
stack back.

### U4 — Digest and stranded-work alert

- Every automatic action (shelve, park, remove, network prune) writes a journal entry and joins a
  **digest** in Activity: "Shelved `feat-x` (idle 9 d) · restore", "Parked compose project 12 (branch merged) ·
  restore". Each worktree line restores in one click; a stack line shows its `compose up` command (C5).
- **Stranded work:** a branch with commits on no remote and no PR, untouched for N days, gets one
  alert ("unpublished work: `BUG-217` has a fix that never reached main") — the operator decides;
  Cleanup never pushes. An agent may write the one-line summary, read-only.
- `docs/harnu-features.md`: a worktree may be shelved and its stack parked; resume restores the
  folder; bring the stack back with `compose up -d`; run the `WORKTREE.md` setup if deps are missing.
  Marker bump.

**AC-U4** Each automatic action appears once in the digest with its reason and a working restore;
`BUG-217`-shaped branches raise exactly one stranded-work alert.

## 5. Guardrails (all units)

- Never autonomous: delete a volume, empty the OS trash, `git gc`, expire an archive, push, open or
  close a PR, delete a remote branch, delete an unproven branch.
- Every action is bound to the facts it was decided on (HEAD, dirty hash, mtimes) and re-probed right
  before it runs; any change refuses with "changed since decided".
- A per-repo lock for every cycle (two Harnu instances can run via `--user-data-dir`).
- Per-cycle caps, a failure-streak kill switch, and a global "pause autonomous cleanup".
- Rollout: the new actions have their own switch and their own report-only first cycle (C1).

## 6. Left to the builder

- Defaults for the shelve threshold, park threshold, low-water mark, parks-per-hour cap and the
  stranded-work age (suggested: shelve after 3 d idle, park after 2 h, low-water 3 slots, 6 parks/h,
  stranded after 7 d), and which of them are operator-configurable.
- Where the ignored-files snapshot lives and its size cap (and what happens above it — suggested:
  refuse to shelve and list it in the digest).
- Whether "parked" and "shelved" are new verdict/bucket values or flags; `list_cleanup`,
  `list_containers`, renderer and wire must stay coherent.
- The watcher's trigger (Docker events vs short interval).
- CHANGELOG, `docs/user/`, design.md updates per the repo contracts.

## 7. Decisions settled after the builder check (designer's calls — operator may overturn)

- **C1 Rollout.** Shelve, park and the automatic Docker removals get their **own switch** (default
  on) with their **own report-only first cycle** and acknowledgement. They do not ride on the existing
  `autopilot` / `firstReportAcknowledged`, which are already `true` on the operator's machine.
- **C2 Proof beats the AC count.** U1's proofs must be content-safe: the rebase match additionally
  requires each local commit's patch-id (or resulting tree for its paths) to equal its counterpart's,
  so an amend after merge does not match; the stacked-base proof requires the branch's PR head to be
  contained in the base's merged PR head. If that leaves some of the 13 unproven, AC-U1 shrinks —
  they are shelved by U2 anyway (disk freed, branch kept).
- **C3 What restores a shelved worktree.** Resuming one of its sessions, opening a new session or
  terminal on it (UI or MCP `create_session` / `spawn_terminal`), or the Restore action. Scheduler
  ticks never restore. A shelved worktree is excluded from orphan-transcript, ghost and
  `detachFromSidebar` logic: its transcripts are not orphans.
- **C4 BUG-144 stays its own card.** A worktree any session drifted into (session attributed to a
  different folder than its transcript's cwd) is ineligible to shelve. U2 does not fix BUG-144.
- **C5 "Restore" for Docker means the command, not a restart.** A parked stack's digest line shows
  and copies its `compose up -d` command; the session or operator runs it. Pruned empty networks and
  removed orphans need no restore (regenerable / worktree gone). AC-U3d and AC-U4 read accordingly.
- **C6 Exhaustion is reported, not scraped.** Harnu does not read session output for Docker errors.
  At zero free slots it notifies at once. The blocker comes from the session that hits the error:
  `docs/harnu-features.md` tells sessions that when `compose up` fails on address pools or ports they
  raise `mission_set_blocker { owner: 'operator' }` on their step and stop. No `Blocker` schema change.
- **C7 What protects a stack from parking.** `keep` and `neverClean` always protect (explicit operator
  decisions), under pressure too. An open PR does not (it is the normal state of waiting work); the
  idle threshold, hysteresis and parks-per-hour cap prevent thrash.
- **C8 Which empty networks go.** Any network carrying a compose project label with zero containers
  attached (running or stopped) and not declared `external` by any stack on the machine. Main-checkout
  and personal compose projects are included because `compose up` recreates the network; no container
  of theirs is touched.
- **C9 Stranded-work alert scope.** Only repos with a remote; one digest line per branch, raised once
  and again only when the branch gets new commits.
- **C10 Delegated manifests.** Worktrees of repos whose `WORKTREE.md` delegates `create:`/`remove:`
  are not shelved in this version (their allocator would reuse the number while the folder is gone);
  their stacks may still be parked and their deps dehydrated.
- **C11 Platforms.** The capacity watcher ships for Linux engines first. On Docker Desktop, rootless or
  remote contexts it reports capacity as unknown and still does the garbage removal and idle parking.

## 8. Operator decisions (2026-10-29)

- **D-A Merged worktrees leave no trace.** A strongly merged worktree is removed as today: folder,
  branch and its sessions leave the sidebar, and its transcripts go to the existing orphan-transcript
  cleanup (`gc-orphan-transcripts.ts`) — transcripts are themselves garbage here (6.5 GB in 865
  transcript folders on this machine, median ~3.8 MB). Nothing is shelved for a merged branch.
- **D-B Shelved worktrees live in an "Archived" section.** Only unproven worktrees are shelved. In the
  sidebar they move out of the folder's main list into a collapsed **Archived** section at the end of
  the folder; their sessions stay resumable from there (resume restores the folder, C3). This is a new
  sidebar affordance: `design.md` §6 gets the section before it is built.
- **D-C Archived is not forever.** An archived worktree untouched for **60 days** appears once in the
  digest for the operator to decide. It is never deleted automatically.
- **D-D Blockers come from the session (confirms C6).** Harnu notifies at once; the session whose
  `compose up` fails raises the operator-owned Mission blocker.

## 9. Measured while planning U1 (2026-10-29) — U1 narrows

Tested the U1 proofs against the 13 worktrees before writing the plan:

- **Squash containment holds** for the 4 PRs merged into `main` (`T537`, `fix/gc-archives-trash`,
  `fix/gc-guided-actions`, `fix/gc-orphans`): the local tip is an ancestor of the merged PR head.
- **Rebase-after-merge is not provable content-safely.** For the 9 `t474` branches, 0 local commits
  have a counterpart with the same patch-id (the rebase changed every diff), the local copies also
  carry `docs(spec)` commits the PRs never had, and only 3–79% of their file versions exist anywhere
  in `main`'s history. Per C2 the proof is dropped; these 9 stay unproven and are shelved by U2
  (disk freed, branch kept).
- **Stacked landing is provable** and kept: each `t474` PR's merge commit is an ancestor of the base
  PR's (#97) head, and #97 is merged into `main`. It applies when the local tip is contained in the PR
  head, which is not the case for these 9 — so it clears none of them today, but it is the correct
  rule for clean stacks.

AC-U1 therefore reads: the 4 named main-based worktrees become strongly merged; the 9 `t474`
worktrees stay unproven.
