# Workspace GC — one engine for worktree, container and Docker cleanup

- **Date:** 2026-10-07
- **Status:** design approved; amended 2026-10-08 with the operator's binding decisions D1–D5 (§14); UI direction approved (§11)
- **Supersedes / absorbs:** T321 (Reaper stop-stack), T250 (dehydrate — reused as a pipeline step), the Containers "sweep" path as a second cleanup door
- **Related:** `docs/specs/2026-07-15-reaper-cleanup-design.md`, `docs/specs/2026-08-28-reaper-detection-honesty.md`, `docs/specs/2026-08-28-reaper-dehydrate-worktrees.md`, `docs/specs/2026-08-28-reaper-guided-remediation-design.md`, `docs/prds/T320-containers-takeover.md`, `docs/adr/0014-containers-ship-as-core-with-a-wire-seam.md`
- **Gate before implementation:** 5 UI mockups (see §11) reviewed; direction approved 2026-10-08 (mockup 3 rev 1, the disk-first treemap).

## 1. Problem

Harnu's workflow creates worktrees and Docker stacks on purpose: one per card, per review, per experiment. Once the branch behind them dies — merged anywhere, or closed and deleted on the remote — everything hanging off it is ready to clean: the checkout, its `vendor/`/`node_modules/`, its compose stack, its local branch (its volumes are left behind as orphans, see §5). Today those items accumulate indefinitely because:

1. **Two islands, two clocks.** Reaper (`src/main/reaper/`) judges by branch fate but never touches Docker. Containers (`src/main/containers/`) judges by idle time (`zombieAfterDays`, default 2) and never reads branch fate. They share no code. Trashing a worktree strands its stack (the T321 orphan factory); a merged branch's stack still waits for the idle clock.
2. **Nothing executes on its own.** Both scan hourly; every removal is an operator click.
3. **Over-strict on the unambiguous, silent on the ambiguous.** A merged worktree with one modified tracked file (a lockfile) is `blocked` forever, with no way to say "keep" and stop seeing it.
4. **Blind spots.** Detached-HEAD worktrees never become harvestable. Docker build cache, dangling images and orphan volumes are out of scope entirely.
5. **Trash frees nothing.** `executor-core.ts` sends the worktree to the OS trash (`shell.trashItem`). On the same filesystem, the bytes are only freed when the operator empties the trash — so a sweep's "freed" figure is not real until then.

### Evidence (measured 2026-10-07)

`org/proj/www`, 64 linked worktrees, 29.2 GiB (`du -sk`), classified against `gh pr list --state all` (270 PRs) and `git ls-remote --heads origin`:

| Branch state              | Worktrees | Disk     |
| ------------------------- | --------- | -------- |
| PR merged                 | 20        | 10.4 GiB |
| PR closed unmerged        | 9         | 3.6 GiB  |
| No PR, remote branch gone | 9         | 3.4 GiB  |
| Detached HEAD             | 16        | 7.5 GiB  |
| PR open                   | 10        | 4.3 GiB  |

Of the 20 merged: 12 clean, 8 with modified tracked files (lockfiles, `.tfvars`, an `index.md`, two source files).

Docker on the same machine: 8 compose stacks / 32 containers (~5 GiB RAM), all attributed to worktrees whose PR is still open; build cache 4.6 GB, 100% reclaimable, untouched by Harnu.

Takeaway: most of the space is worktrees, not containers. ~17 GiB sits in dead or probably-dead worktrees today.

## 2. Goals and non-goals

**Goals**

- One engine decides, for every worktree, whether it is ready to clean, and cleans the whole bundle (stack → deps → checkout → branch) in one pass. Volumes are never part of that pass (§4, D1).
- A configurable autopilot cleans _proven_ ready items periodically, forever.
- Everything ambiguous is visible, explained in one sentence, and cleaned only on the operator's decision.
- Reclaimed bytes are real bytes (no trash-only accounting).
- Docker housekeeping (build cache, dangling images) is part of the same cycle; orphan volumes are surfaced in Needs review and removed only after per-id operator confirmation.

**Non-goals**

- An LLM never decides a deletion. The optional opinion helper (§8) only advises.
- Agents never get a removal verb.
- The autopilot never deletes remote branches, never kills a live process, never runs `docker system prune -a` or `docker image prune -a`.
- No rewrite of the Reaper classifier or archive machinery — they are reused.

## 3. Model

### 3.1 The worktree bundle

One record per worktree (linked, detached, and hidden folders included):

```
WorktreeBundle {
  path, repoMain, branch | null (detached)
  fate: BranchFate                       // §3.2
  sessions: { live: 'working' | 'needs-input' | 'open-idle' | 'none', lastActivityAt }
  tree: { dirtyTracked: string[], unpushed: number, untracked: number }
  stacks: StackRef[]                     // from containers attribution
  volumes: VolumeRef[]                   // informational: shown, never removed with the bundle (§4)
  deps: { dir, bytes }[]                 // manifest `ephemeral:` dirs
  bytes: { total, deps, volumes }
  lastSignOfLifeAt                       // §3.4
  keep: boolean                          // operator "Keep" mark
  bucket: 'ready' | 'review' | 'in-use'  // §3.3
  reason: string                         // one sentence, always present for 'review'
}
```

The bundle is computed by joining the existing Reaper scan (`scanner-shell.ts` `scanOneRepo`) with the existing Containers snapshot (`containers-core.ts` `buildSnapshot`) on the worktree path. No new docker or git probing is invented; both scans are reused.

### 3.2 Branch fate — single source of truth

A pure resolver extracted from `reaper-core.ts` (`mergedSignal` :276, `classify` :401) into a shared module consumed by both Reaper and Containers:

| Fate              | Signal                                                                                     |
| ----------------- | ------------------------------------------------------------------------------------------ |
| `merged`          | PR `MERGED` credited to the branch, or `ancestorOfDefault`, or `patchIdContained` (squash) |
| `closed-unmerged` | PR `CLOSED`, not merged                                                                    |
| `remote-gone`     | no PR, branch absent from `ls-remote`                                                      |
| `open`            | PR `OPEN`, or remote branch alive                                                          |
| `detached`        | no branch                                                                                  |
| `unknown`         | gh unavailable and no git-local proof                                                      |

Containers stops using the idle clock as its primary verdict for stacks attributed to a worktree: a stack inherits its worktree's bucket. The idle clock (`zombieAfterDays`) remains only for stacks attributed to plain folders or nothing.

### 3.3 Buckets

| Bucket                       | Rule                                                                                                                                                                                                        | Behavior                                                                                                      |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| **Ready to clean** (`ready`) | fate `merged` AND no dirty tracked files AND sessions.live ∈ {`none`} (history-only or hibernated) AND `now − lastSignOfLifeAt ≥ graceDays` AND not main checkout AND not protected AND not `keep`          | Autopilot cleans it. Also cleanable now by click.                                                             |
| **Needs review** (`review`)  | past grace AND not `keep` AND any of: fate `merged` with dirty tracked files or unpushed commits; fate `merged` with an `open-idle` session; fate `closed-unmerged`, `remote-gone`, `detached` or `unknown` | Visible with a one-sentence reason and size. Operator chooses Remove / Dehydrate / Keep / Ask for an opinion. |
| **In use** (`in-use`)        | fate `open`, or session `working`/`needs-input`, or within grace                                                                                                                                            | Never touched. Dehydrate offered if idle ≥ `dehydrateIdleDays`.                                               |

Precedence: `in-use` beats everything (a working session in a merged worktree is In use). `keep` removes an item from Needs review until its fate changes; a `keep` item is never auto-cleaned.

Orphan volumes (§5) are not worktree bundles; they are listed in **Needs review** as their own rows (size and compose project) and are never auto-removed.

### 3.4 Session rule and grace

"No session" means **no running process**, not "no transcript":

| Session state in the worktree                 | Effect                                                                                                |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| None, or history only                         | does not block                                                                                        |
| Hibernated (parked), no activity beyond grace | does not block                                                                                        |
| Process open but idle (forgotten tab)         | moves the item to **Needs review** ("session open, idle for 5 days"); autopilot never kills a process |
| `working` / `needs-input`                     | In use                                                                                                |

`lastSignOfLifeAt = max(merge time, last session activity in the folder, last container start/stop not made by Harnu)`. Grace counts from it.

## 4. Execution pipeline

Same pipeline for autopilot and click. Per item:

| #   | Step                                                                                                                                                                                          | On failure                                  |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| 0   | Re-probe at execution time: fate, dirty, live process, grace, and the stack set equals the scanned set (TOCTOU — same pattern as `executor-core.ts` guard and Containers `SWEEP_SET_CHANGED`) | skip with reason; item re-buckets next scan |
| 1   | `docker stop` the bundle's stacks (reuse `containers-shell.ts` `dockerActions`)                                                                                                               | halt item, nothing destructive ran          |
| 2   | `docker rm` the containers                                                                                                                                                                    | halt item                                   |
| 3   | **Volumes are left in place.** The pipeline never runs `docker volume rm`; once the worktree is gone its volumes are orphan volumes (§5)                                                      | —                                           |
| 4   | `fs.rm` the ephemeral dependency dirs, with the four dehydrate guards (`dehydrate-core.ts`)                                                                                                   | halt item                                   |
| 5   | Archive `refs/archive/<branch>/<stamp>/{tip,wip}` (existing `archive-core.ts`)                                                                                                                | halt item; no code removed                  |
| 6   | Trash the remaining checkout, `git worktree prune`, `git branch -d` (`-D` only for signals that override ancestry)                                                                            | halt item                                   |
| 7   | Sidebar detach, tombstone + journal entry with restore hint                                                                                                                                   | —                                           |

Ordering rationale: containers before the folder so no orphan container is ever manufactured; dependencies hard-deleted before the trash step so the reclaimed bytes are real (deps are regenerable; the small remaining checkout keeps the trash safety net).

**Volumes (D1).** Worktree cleanup, whether run by the autopilot or by the manual "Clean N ready" bulk action, never removes a Docker volume. Proving that a volume belongs to exactly one worktree turned out to be unreliable (a compose file in a subfolder, a `name:` in the compose file, or a project name shared with the main checkout all leaked through). The volumes of a cleaned worktree therefore become orphan volumes and are handled only through §5.

**Accepted deviation (D3): drop-deps runs before archive.** An earlier draft archived first. The implementation drops the ephemeral dependency dirs (step 4) before archiving (step 5). This is accepted because the archive excludes ignored directories, so it never captured them: the order has no effect on what can be recovered.

A halted item does not stop the batch. It reappears in **Needs review** with reason "cleanup stopped at step N: <error>".

Remote branches are never deleted by the autopilot. Manual opt-in stays as today (`neverDeleteRemote`).

## 5. Docker housekeeping

Runs at the end of each cycle. The two cleanup categories each sit behind their own toggle:

- `docker builder prune -f --filter until=<cacheMaxAgeDays*24>h`
- `docker image prune -f` — dangling only. Never `-a` (would delete base images live stacks use).

Bytes reclaimed are read from the commands' own output and reported.

**Orphan volumes (D1, D5)** are detected, never auto-removed: volumes with no container whose `com.docker.compose.project` working dir no longer exists. They are listed in **Needs review** with their size and compose project and removed only through `gc:clean` after the operator confirms each id (§9). There is no toggle that makes the autopilot or the bulk action remove them.

## 6. Autopilot

Reuses Reaper's existing timer (`reaper-ipc.ts`), extended from "scan" to "scan + clean ready items". Not a Scheduler worker — the job is deterministic and needs no LLM.

Prefs (merged Reaper + Containers prefs, one Settings tab):

| Pref                                    | Default                                                |
| --------------------------------------- | ------------------------------------------------------ |
| `autopilot`                             | off until the first report is acknowledged (see below) |
| `intervalMs`                            | 1 h (30 min – 24 h)                                    |
| `graceDays`                             | 2                                                      |
| `maxItemsPerCycle`                      | 20                                                     |
| `categories.worktrees` / `.dockerCache` | on / on                                                |
| `cacheMaxAgeDays`                       | 7                                                      |
| `neverClean`                            | list of repos/worktrees                                |

Safety:

- **First cycle is report-only.** On enabling, the first run produces "found 12 ready items, 6.0 GiB — enable?" and deletes nothing.
- Per-cycle cap bounds the blast radius of a bug.
- The autopilot never removes a Docker volume (D1, D5).
- Every cycle that cleaned something posts one notification ("cleaned 6 ready items, freed 3.1 GiB") linking to the journal.

## 7. Restore

| What              | Restorable? | How                                                                                                                                                    |
| ----------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Code, WIP, branch | yes         | `refs/archive/…` + OS trash; tombstone carries the command                                                                                             |
| Containers        | yes         | `docker compose -p P --project-directory D up -d`                                                                                                      |
| Dependencies      | yes         | manifest `setup` (rehydrate)                                                                                                                           |
| Volumes           | **no**      | never removed by worktree cleanup (nothing to restore). An orphan volume removed after per-id confirmation is irreversible; the confirm dialog says so |

## 8. "Ask for an opinion" (headless helper)

- On demand only, on a selection in **Needs review**.
- Spawns a read-only headless session (no write tools; Scheduler `observe`-style allowlist) with a per-item dossier: diff against the default branch, dirty files, PR state, last session summary in that folder.
- Returns per item `{ verdict: 'safe' | 'keep' | 'unsure', reason, evidence }` (e.g. "the 3 changed files are on main at abc123"), shown as a chip on the row, plus a "Remove the ones marked safe" action that the operator clicks.
- Model follows the operator's routing table.
- Never executes a removal.

## 9. UI

- **Cleanup takeover** becomes the single home: a summary line (`♻ 17.2 GiB reclaimable · autopilot on · next cycle in 42 min`), the three buckets (Ready to clean, Needs review, In use), and a Docker card (build cache and dangling images with sizes and toggles; orphan volumes appear in Needs review, not as a toggle).
- **Bulk dialog** ("Clean N ready") and **Settings** state plainly: "Volumes are kept. They show up in Needs review afterwards."
- **Containers takeover** stays as the inspector (per-stack start/stop, stacks with no worktree). Its sweep defers to Cleanup so there is one cleanup door.
- **Footer:** one pill (`♻ 17 GiB`) replaces the two.
- **Settings:** one Cleanup tab with the prefs in §6.
- `design.md` is updated before any component work, per the design contract.

### Confirmation binding — `gc:clean(ids, { confirmed, expected })` (D4)

Every manual removal goes through one renderer IPC, `gc:clean(ids, { confirmed, expected })`. The confirmation binds to what the operator saw:

- `ids` — the worktree bundles and orphan volumes to clean.
- `confirmed` — the operator confirmed this exact set in a dialog. A removal from Needs review (including every orphan volume, confirmed per id) is refused without it.
- `expected` — per id, a snapshot of what the dialog showed, including `bucket` (`'ready' | 'review' | 'in-use'`), fate and stack set.
- Step 0 of the pipeline (§4) re-probes each id and compares it with `expected`. An item that changed since the operator confirmed it is refused with `changed-since-confirm`; nothing destructive runs for it, it re-buckets on the next scan, and the rest of the batch continues.

The autopilot has no operator confirmation: it acts only on items whose live re-probe is still `ready`.

## 10. MCP (agent-facing)

- `list_cleanup({ folder? })` — read: buckets, reasons, bytes. On the Scheduler `observe` allowlist so `delivery-watchdog` can report accumulated ready items (orphan volumes are listed under Needs review).
- `release_worktree({ folder })` — the agent declares it is done with a worktree whose PR merged; the item skips the grace period and becomes ready to clean on the next cycle. Refused unless fate is `merged`.
- No removal verb for agents. `gc:clean(ids, { confirmed, expected })` (§9) is renderer IPC only and is not exposed over MCP.
- Ships with `docs/harnu-features.md` (version bump) and `docs/user/cleanup.md` / `docs/user/agent-control.md` updates.

## 11. Mockups — gate before implementation

Five mockups, each approaching the interface differently, judged on usability and UX:

1. **Three-bucket list** — the design in §9 as written: summary line, Ready to clean / Needs review / In use sections, Docker card.
2. **Inbox / triage** — Needs review items presented one at a time (card per item, keyboard Keep / Remove / Dehydrate / Ask), ready items summarized as a single "will be cleaned automatically" line.
3. **Disk-first treemap** — space as the primary visual (treemap or stacked bar by repo → worktree → deps/volumes), bucket shown by color; click a block to act.
4. **Timeline** — what the autopilot did and will do: past cycles with freed bytes, the next cycle's planned set, Needs review items as pending events.
5. **Repo-grouped dashboard** — one card per repo with its ready/review/in-use counts and bytes, drill-in per repo; fits the 64-worktree case without an endless list.

Each mockup must show: the summary line, a Needs review row with its one-sentence reason, the opinion chip, the autopilot state, the Docker housekeeping, the first-cycle report-only prompt, and the empty state ("all clean"). Use `dtk:create-mockup`; the operator approves one direction (or a blend) before slice 5 starts.

**Approved direction (2026-10-08): mockup 3, revision 1 — the disk-first treemap.** Slice 5 builds that direction.

## 12. Delivery slices (1 slice = 1 PR)

0. Mockups (§11) — gate for slice 5; cleared, mockup 3 rev 1 approved.
1. Shared branch-fate resolver; Containers consumes it.
2. Worktree bundle + pipeline (containers first, deps before trash) — absorbs T321.
3. Autopilot + merged prefs + report-only first cycle — absorbs T250's idle path.
4. Docker housekeeping.
5. Unified UI (after mockup approval).
6. Ask for an opinion.
7. MCP verbs + `docs/harnu-features.md` + user docs.

Each slice carries its CHANGELOG entry.

## 13. Open items

- Windows: `measureDiskBytes` returns null on `win32`; buckets must render without bytes there.
- pnpm hardlinked stores: removing `node_modules` frees nothing until the store is pruned; say so in the bytes figure.
- Bucket row for `unknown` fate when `gh` is unavailable: stays in Needs review with reason "could not reach GitHub".

## 14. Operator decisions (2026-10-08, binding for every slice)

| #   | Decision                                                                                                                                                                                                                                                                                                                                |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | Worktree cleanup (autopilot and manual bulk) never removes volumes. Leftover volumes become orphan volumes in Needs review, removed only after per-id confirmation. The `removeVolumes` pref and the `categories.volumes` toggle are gone; migration ignores both old keys; every call into the pipeline passes `removeVolumes: false`. |
| D2  | The three buckets are named `ready` ("Ready to clean"), `review` ("Needs review") and `in-use` ("In use") everywhere: UI, docs, code and tests. Reason and code types are `ReviewReason` / `ReviewCode`. Each branch does a mechanical rename commit of its own, with no behavior change.                                               |
| D3  | drop-deps runs before archive (§4); accepted because the archive excludes ignored directories.                                                                                                                                                                                                                                          |
| D4  | `gc:clean(ids, { confirmed, expected })` binds the confirmation to what the operator saw; a changed item is refused with `changed-since-confirm` (§9).                                                                                                                                                                                  |
| D5  | Orphan volumes are never auto-removed (§5).                                                                                                                                                                                                                                                                                             |
