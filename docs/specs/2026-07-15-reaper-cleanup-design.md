# Reaper — branch & worktree cleanup (design)

**Date:** 2026-07-15 · **Status:** approved in brainstorming, pending implementation plan
**Mockup:** `docs/specs/2026-07-14-reaper-cleanup-mockup.html` (Capy Ink tokens, all four surfaces)

## Problem

Capy's session-per-task workflow mass-produces branches and worktrees. Once a PR merges,
the worktree, its local branch, its remote branch, and its sidebar entry all outlive their
purpose. Today's "archive" is just `hiddenPaths` — the folder is hidden, never deleted.
Zombies accumulate: gigabytes of `node_modules`, sidebar noise, orphan branches.

Reaper is a deterministic engine + a dedicated view that shows, per candidate, **how far it
got through its lifecycle** (a checkpoint timeline) and offers deletion **only when every
checkpoint is green**.

## Scope

- **Slice 1** — engine (scanner → classifier → executor) + the Cleanup takeover view,
  per-item trash and batch sweep, manual "Scan now".
- **Slice 2** — periodic background scan (default hourly, configurable), footer badge +
  one aggregated notification-center entry when items _become_ harvestable, and a small
  Settings tab for preferences.

Decisions fixed during brainstorming:

| Decision                    | Choice                                                                                                       |
| --------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Blast radius of one cleanup | Full: worktree + local branch + remote branch + sidebar unpin/unhide                                         |
| PR/CI signal source         | `gh` CLI (user's auth), graceful degradation to pure-git signals                                             |
| Where it lives              | Takeover view (Usage Dashboard pattern); Settings gets a small prefs tab                                     |
| Post-deletion net           | OS trash (`shell.trashItem`) + reflog + tombstone journal                                                    |
| Inventory                   | Worktrees, orphan local branches, hidden folders, remote orphan branches (the last with an explicit warning) |
| Batch action                | "Sweep all green" with a single confirm                                                                      |
| Slice-2 alert               | Footer badge + notification-center entry; no toast, no sound, no OS notification                             |

## Engine — `src/main/reaper/`

Three units, single responsibility each. Registered from `src/main/index.ts` like any other
IPC capability (`reaper:scan`, `reaper:snapshot`, `reaper:clean`, `reaper:sweep`,
`reaper:event` stream to the renderer).

### `scanner.ts` — inventory (I/O, cached)

Per known repo (from the existing folder/git-probe model):

- **Worktrees:** `git worktree list --porcelain` — parser already exists
  (`worktree-core.ts` `parseWorktreeList`). Capy-created or manual alike.
- **Orphan local branches:** `git for-each-ref refs/heads` + upstream tracking state,
  cross-referenced against worktrees (a branch checked out in a worktree is reported as
  that worktree, not twice).
- **Hidden folders:** `hiddenPaths` from `user-projects.ts` that point inside a known repo's
  worktree layout.
- **Remote side:** one `gh pr list --state all --json headRefName,state,mergedAt,statusCheckRollup,reviewDecision`
  per repo (never per branch) + `git ls-remote --heads origin`. Disk cache with a 30-min TTL,
  short timeout; on any `gh` failure (absent, unauthenticated, rate-limited, non-GitHub
  remote) the scanner emits `unknown` for PR-backed signals and continues.
- **Disk size:** `du`-equivalent measured only for candidate folders, cached by mtime.

Scanning never runs on the UI path: bounded concurrency (one repo at a time, git commands
serialized within a repo), same single-flight/debounce scheduler pattern as the manifest
drain (T113).

### `classifier.ts` — pure, no I/O, unit-tested

Input: raw inventory. Output per item: checkpoints + verdict.

Checkpoints (fixed order, each `green | red | unknown | na`):

`PR opened → Review approved → CI green → PR merged → In main → Remote branch gone → Local clean`

**Signal hierarchy for "merged":** squash merges break ancestor detection, so:

1. `gh` says the PR merged — authoritative (covers squash/rebase merges).
2. `git merge-base --is-ancestor <branch> origin/<default>` — covers true merge commits.
3. Remote branch deleted after its PR closed — strong corroborating signal.

The classifier records which signal justified each green checkpoint; the UI shows it in the
checkpoint tooltip and the tombstone stores it.

Verdicts:

- **`harvestable`** — every applicable checkpoint green → trash enabled.
- **`blocked`** — something red (dirty, unpushed, CI failing…) → lock icon + reason.
- **`unknown`** — insufficient signal → never deletable; on doubt, do nothing.
- **`active`** — a live Capy session runs in that folder (fleet model) → not a candidate
  at all (filtered out before the list; the mockup shows one row only to illustrate).

### `executor.ts` — the deletion pipeline for one item

Reuses existing, tested primitives, in order, stopping at the first error without hiding
partial state:

1. `removeWorktree` (`worktree-ipc.ts`) — keeps its dirty/unpushed guards; runs the
   `WORKTREE.md` `remove:` recipe.
2. `git branch -d` (never `-D`) — git itself re-checks merged-ness; redundant guard by design.
3. `git push origin --delete <branch>` — only when the remote toggle was explicitly checked.
4. Sidebar detach — `removeProject` / `hiddenPaths` cleanup (`user-projects.ts`).
5. Folder → OS trash via `shell.trashItem` (restorable).
6. Tombstone appended to `reaper-log.jsonl` in `userData`: timestamp, repo, branch, final
   SHA, what was deleted, justifying signal.

Each step is idempotent; re-running a partially cleaned item resumes where it stopped.
Batch sweep = a serial loop of this executor with per-item progress and an aggregate report;
one failure does not abort the rest.

**Not an MCP verb.** Deletion stays UI-only (human gesture), matching the existing
deliberate choice for `worktree:remove`. Agents may get a read-only report verb in a future
slice. Consequently `docs/capy-features.md` is untouched by slices 1–2.

## Safety model

**Never listed (invisible to Reaper):**

- the main worktree (`isMainWorktree`) and the default branch (`origin/HEAD`);
- per-repo protected branches (default `main`, `master`, `develop`);
- any folder with a live Capy session.

**Listed but locked (`blocked`):**

- dirty (`git status --porcelain` non-empty);
- unpushed commits (`rev-list @{upstream}..HEAD` > 0, **fail-closed**: probe failure counts
  as unpushed — existing `removeWorktree` behavior);
- verdict `unknown` never enables deletion.

**Remote deletions:** always behind an explicit warning block in the confirm with its own
opt-in toggle (unchecked by default), plus a global kill-switch in Settings
("never delete remote branches") that removes the toggle entirely.

**Post-deletion net:** OS trash for folders; reflog (~30 days) for branch SHAs; tombstone
journal rendered at the bottom of the view as "Recent cleanups", each row offering the exact
restore command (`git branch <name> <sha>`) ready to copy.

## UI

**Cleanup takeover view** (`CleanupView.vue`) — mounted from `App.vue` via the existing
mutually-exclusive `v-else-if` chain, toggled by a boolean in `stores/ui.ts`
(Usage Dashboard pattern). Header: title, KPIs (`14 items · 5 harvestable · 3.2 GB
reclaimable`), "Scan now", and the sweep button carrying count + reclaimable size.

**Item row** — no tables: kind icon (worktree `⌂` / local branch `⎇` / hidden folder `▤` /
remote `☁`), mono branch name, age + disk size, the 7-checkpoint timeline (green ✓ / red ✕ /
dashed `?` unknown / dimmed n/a, connector line colored green as far as the cycle
progressed), a verdict chip, and the action slot: trash (harvestable only, red on hover) or
lock with the blocking reason in the tooltip. Rows grouped by repo.

**Sweep confirm** (`SweepConfirmDialog.vue`) — full list of what dies (per-item "what"),
totals (worktrees, branches, GB), amber warning block for remote deletions with the opt-in
toggle. Progress per item during execution; final report keeps successes visible when one
item fails.

**Entry points** — footer pill `🧹 Cleanup [N]` in `StatusFooter.vue` (plus reclaimable-GB
pill); a "Cleanup…" item in the repo-group context menu opening the view filtered to that
repo.

**Contracts:** `design.md` §6 gains the new entities (checkpoint timeline, verdict chips,
sweep dialog, footer pill) in the same change; all strings via `$t()` added to both
`en.json` and `pt-BR.json`; `docs/user/` page for the feature; `CHANGELOG.md` entry.
`docs/capy-features.md` untouched (no agent-facing surface).

## Slice 2 — periodic scan, alert, Settings

**Scheduler:** main-process, T113 drain-scheduler pattern (single-flight, debounced,
`poke()`), default every 1 h, configurable. Runs the same scanner; results pushed to the
renderer over the `reaper:event` stream; the view opens instantly from the last snapshot.

**Alert:** the scheduler diffs verdicts against the previous snapshot. Only items that
_became_ harvestable trigger: footer badge increment + **one** aggregated
notification-center entry ("3 branches closed the cycle · 2.1 GB reclaimable"). No toast, no
sound, no OS notification. No re-alerting on unchanged items.

**Settings → "Cleanup" tab** (`SettingsDialog.vue` tabs list + a small pane; preferences
only — the tool itself lives in the takeover):

- auto-scan on/off + interval (30 min / 1 h / 6 h / daily);
- global "never delete remote branches" kill-switch;
- per-repo protected branches (default `main`, `master`, `develop`);
- minimum candidate age (default 0 = list everything);
- "notify when items become harvestable" on/off.

## Testing

- `classifier.ts` is pure — exhaustive unit tests: every checkpoint state combination,
  squash-merge vs merge-commit vs deleted-remote signal hierarchy, degraded (no-`gh`) mode,
  verdict edges (`unknown` never harvestable; fail-closed unpushed).
- `scanner.ts` — unit tests over fixture command outputs (porcelain formats, `gh` JSON);
  cache TTL behavior.
- `executor.ts` — integration-style tests against throwaway git repos (temp dirs): full
  pipeline, partial-failure resume, `-d` refusal on unmerged, tombstone contents.
- UI — component tests for row states; live verification via the second-instance CDP recipe
  (`docs/dev/live-verify-second-instance.md`).

## Future slices (recorded, not scoped)

- **Auto-sweep policy** — "green for N days → sweep automatically, notify after".
- **Session hygiene** — stale session JSONLs under `~/.claude/projects/` in the same view.
- **Board integration** — a `done` roadmap card marks its worktree as a candidate early
  (pairs with T125 completion sensor).
- **Read-only MCP verb** — agents consume the scanner report (never the executor).
- **Disk analytics** — per-repo reclaimable trend in the Usage Dashboard.

## Addendum — 2026-07-17 (planning-time refinements, both slices landed)

Both slices of the implementation plan (`docs/plans/2026-07-15-reaper-cleanup.md`) have
shipped across five stacked PRs. Three refinements were locked at planning time, ahead of
any implementation, and are recorded here as the source of truth now that the code matches
them:

1. **Trash-first, then prune.** `git worktree remove` deletes the directory permanently,
   which would contradict the OS-trash safety net this spec promises. The executor instead
   re-probes the dirty/unpushed guards immediately before acting (a TOCTOU re-check), calls
   `shell.trashItem(folder)`, then runs `git worktree prune` to drop the now-stale admin
   entry. `worktree-ipc.ts`'s `removeWorktree` is not reused wholesale — only its probe
   helpers (`isWorktreeDirty`/`hasUnpushedCommits`) are exported and shared.
2. **`WORKTREE.md`'s `remove:` recipe stays out of scope for v1.** It only runs today on
   create-rollback; wiring it into the cleanup executor is recorded as a future slice, not
   attempted here.
3. **`remote-gone` red never blocks a harvest.** It flags that the remote-delete step still
   has work to do (surfaced as the mockup's `harvestable · remote ⚠` chip) — the cleanup
   action itself is what closes that checkpoint. A branch that's fully merged locally but
   still has a remote counterpart is harvestable today, with remote deletion opt-in per the
   sweep dialog's warning + toggle.
