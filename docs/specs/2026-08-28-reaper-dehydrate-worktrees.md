# Reaper — dehydrate idle worktrees

**Date:** 2026-08-28 · rewritten the same day after two independent reviews
**Status:** design
**Card:** T250
**Depends on:** BUG-95 (detached worktrees) for its coverage claim. Independent of every
classifier fix.

## Why this exists

Measured on `proj/www`, 2026-08-28, `du -sk` reported in GiB (one mode throughout — see
the detection spec for why mixing `du` modes produced four wrong figures in an earlier
draft):

```
.git (141 branches, full history)          78 MiB   (69 MiB of objects)
worktree checkouts                      19.71 GiB
  └─ vendor/ + node_modules/            17.48 GiB   (93%)
```

**Deleting branches reclaims essentially nothing.** The disk is installed dependencies.
Every existing Cleanup action — trash the folder, delete the branch, delete the remote —
is gated on merge status, dirtiness and pushed-ness, and almost every worktree fails
those gates. So today nearly all of it is unreachable.

Dehydration is reachable on every worktree, because a gitignored dependency directory is
not work: removing it cannot lose a commit, cannot lose an uncommitted edit, and is
undone by a command the repo already declares.

For contrast, the three detection fixes reclaim ~2.7 GiB (14%). Dehydration reaches
17.48 GiB (93%) and does not care whether a worktree is dirty, unpushed, abandoned or
merged.

**Coverage caveat, and it is significant.** 15 of the 48 worktree entries are
detached-HEAD and have no Cleanup row at all (BUG-95) — 7.02 GiB, 36% of the checkout
disk. If dehydration is scoped to Cleanup rows, it cannot touch them. Either BUG-95
lands first, or this spec must state plainly that a third of the disk is out of reach in
v1. It must not claim coverage it does not have.

The corpus is live: two `git worktree list` runs minutes apart returned 47 and 48
entries. Treat every count here as "measured on 2026-08-28", not as a constant.

## What it does

For a worktree with **no live session**, remove the regenerable dependency directories
and mark it _dehydrated_. The checkout, the branch, the uncommitted edits and the
untracked files all stay exactly as they were. Rehydration re-runs the manifest's
`setup`.

This reframes the Reaper from "delete things" to "reclaim space", and it is the only
action in the view available to a blocked row.

## Safety — four guards, fail-closed

A path is removable only when **all** hold. Any uncertainty means skip-and-report, never
proceed.

1. It is listed as ephemeral (see below).
2. `git check-ignore` confirms the repo ignores it. Some PHP projects commit `vendor/`;
   removing a _tracked_ dependency directory must be impossible, not discouraged.
3. `git ls-files -- <dir>` is empty — a second, independent check that does not trust
   ignore rules alone.
4. The worktree has no live session.

**Guard 4 must be re-probed at execution time, not only at scan time.** A session can
start between the scan that produced the row and the click that acts on it. This is
exactly the time-of-check-to-time-of-use case the deletion path already covers in
`executor-core.ts:66-80`. The re-probe belongs in the per-item path, so the repo-level
"dehydrate all idle" inherits it.

Note that guard 4 is currently satisfied _vacuously_ in the UI: `stores/reaper.ts:75`
filters `verdict === 'active'` out of the rendered list, so a worktree with a live
session has no row and therefore no button. That is correct-by-accident and no UI test
can demonstrate it. Express the guard in the pure core instead — given a candidate whose
path is in the live-folders set, the removable-or-skip decision returns skipped with
reason `session-live` — so it is a real unit test.

## How it removes — and why this departs from the engine's safety model

Every destructive step in this engine goes through `shell.trashItem`; the 2026-07-15
design names OS trash as the post-deletion net. **Trashing dependency directories frees
nothing**: the trash is on the same filesystem, so the headline reclaim figure would be
false until the user empties it.

Use `fs.rm({ recursive: true, force: true })`. This is a deliberate exemption from the
trash net, defensible precisely _because_ of the four guards — the content is ignored,
untracked and regenerable — and it must be written down rather than left to whoever
implements it. Per-path failures are skipped and reported using the same guard
vocabulary.

**Windows.** `fs.rm` over a deep `node_modules` routinely hits `EPERM` and long-path
failures, and `measureDiskBytes` already returns `null` on `win32`
(`scanner-shell.ts:271`) — so the feature is size-blind there and the row cannot show
the number that justifies clicking it. State what the row shows when bytes are unknown,
and handle per-path removal failure as a first-class outcome rather than an exception.

## Where the ephemeral list comes from

A new optional `ephemeral:` key in `WORKTREE.md`, beside the existing `setup:` and
`seed:` in `ResolvedManifest`. Additive; existing manifests keep working.

Default when absent — **package-manager install targets only**:
`node_modules`, `vendor`, `.venv`, `venv`.

An earlier draft also defaulted `target`, `.next`, `.nuxt`, `dist`, `build`, `.turbo`,
`.gradle`. Those are wrong as a default: `setup` is an install recipe, not a build, so it
does not regenerate them — a Rust `target/` can be an hour of compilation. The
reversibility argument that makes this feature safe simply does not hold for them. Build
outputs and caches opt in per-project via `ephemeral:`, where the author knows what
regenerates them and what it costs.

## Rehydration

Re-run the manifest's `setup` in the worktree — the same path `create_worktree` uses,
which already reports structured failures (`WORKTREE_PROVISION_FAILED` with `stage`,
`command`, `kind`, `binary`, `path`). Reuse that vocabulary rather than inventing a
second one.

A worktree whose manifest has no `setup` can still be dehydrated, but the row must say
plainly that Capy cannot rehydrate it and the operator will have to run their own
install. Silence there is the difference between a reversible action and a destructive
one.

**Rehydration can dirty tracked files, and that must be disclosed.** Install commands
routinely rewrite lockfiles — `package-lock.json`, `composer.lock` — which are tracked.
So rehydrating a clean worktree can leave it modified, which is exactly the condition
that makes the classifier mark it blocked: Capy causing the wall of blocked rows this
program exists to reduce. Prefer the lockfile-respecting form of the install command
where the manifest offers a choice, and have rehydrate diff the tracked set afterwards
and report what it changed. It already has to diff to satisfy the byte-identical
criterion below, so the information is in hand.

## Disk measurement

`scanner-shell.ts:322-326` measures only harvestable items, serialized, under a 10 s
`DU_OPTS` timeout. Extending it to every folder row — which this feature needs — will
time out and return `null` for most rows on a cold tree, blanking the number exactly
where it matters. The 2026-07-15 design specified a `du`-equivalent "cached by mtime";
that cache was never implemented. Reinstate it, move `du` off the synchronous scan path
or raise its budget and cap concurrency.

**pnpm caveat:** pnpm hardlinks from a global store, and `du` counts those bytes in full,
but removing `node_modules` frees none of them until the store is pruned. The figure is
honest for npm and Composer and materially wrong for pnpm. Say so in
`docs/user/cleanup.md` — the operator will check it against `df`.

## UI

The Cleanup row gains a dehydrate action and a `hydrated | dehydrated` state, with
reclaimable bytes per row. A repo-level "dehydrate all idle" mirrors the existing sweep
affordance and confirm pattern. Dehydrated worktrees keep their row: still worktrees,
still classified, still sweepable once their real blockers clear.

**This shares one row action slot with three other cards** (T251's Diagnose, T252's
Remediate, BUG-93's abandoned chip). `design.md` today defines one verdict chip and one
action slot. A single `design.md` pass defining the slot across every state —
harvestable, blocked, unknown, remediating, dehydrated — must land **before** any of
them, and this view's own precedent is an approved mockup contract
(`design.md:6239` cites `docs/specs/2026-07-17-reaper-cleanup/spec.html`). New actions
need accessible labels, following the filter bar's existing pattern.

`cleanup.dehydrate.*` keys land in `en.json` **and** `pt-BR.json` in the same change.

**Preferences have nowhere to land today.** The prefs module has no key for dehydrate
defaults or an idle threshold, so the open question below has no home even as a deferred
decision. Add one with this card.

## Testing

- Pure core, table-driven: candidate list + per-path guard results → removable or
  skipped-with-reason. Includes the tracked-`vendor/` case (must skip) and the
  `session-live` case.
- A worktree with uncommitted tracked changes is dehydrated and those changes are
  byte-identical afterwards.
- **The symmetric criterion, which an earlier draft omitted:** after a _rehydrate_,
  either the tracked set is unchanged, or the row states plainly that the install command
  modified it and names the files. The mutation happens on rehydrate, and nothing tested
  it.
- Env-bound removal and rehydration are e2e per ADR-0001.

## Open questions

- Should dehydration become automatic past an idle threshold (30 days, say)? It is
  reversible and the space is large, which argues yes; but an unattended recursive
  removal is a different risk class from one the operator clicks. Leaning manual for v1,
  with idle age shown on the row so it can be sorted on.
- Concurrency: a scan racing a sweep is covered by the stale-item lookup plus the
  executor re-probe. Nothing prevents a disk measurement and a recursive removal running
  over the same tree; the failure mode is a wrong number rather than a crash, which is
  worse. Decide before shipping the repo-level action.
- Snapshot migration is a non-issue — the snapshot is in-memory only, so a new row state
  needs none. Stated so a reviewer does not go looking.
