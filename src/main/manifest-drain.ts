import { sortManifestQueue, nextManifestDrainTarget } from './roadmap-core'

/**
 * T113 — background manifest drain: the main-process drain DRIVER.
 *
 * The T104 drain loop shipped inside `RoadmapBoard.vue`, so stamped cards only
 * dispatched while the board component was mounted — the operator's first real
 * manifest sat undrained for ~40 minutes (the live failure that escalated this
 * card). The decision layer was already main-side (`roadmap-core` sequencing,
 * `roadmap-ipc` gate/reserve); what moves here is the WALK. This module is the
 * pure core: every effect (load, plan/reserve, worktree cut, spawn, bind,
 * refund, progress events) is an injected dep (`DrainPassDeps`), so the whole
 * driver is unit-testable without Electron (ADR-0001). The env-bound shell that
 * wires real deps lives in `manifest-drain-shell.ts`; the board keeps only the
 * progress DISPLAY (fed by `emit`), never the driving.
 */

/** The card fields the drain walk reads — a narrowed `RoadmapCard` view. */
export interface DrainCardView {
  slug: string
  status: string
  kind?: string
  /** Manifest stamp (staggered ISO) — presence + order drive the queue. */
  approved?: string
  /** A bound session means the card already dispatched — never re-spawn. */
  session?: string
  /** `internal` never spawns (T102); `worktree` cuts one before spawning. */
  substrate?: string
}

/** Routing resolved kind → per-repo table → hardcoded default (T97). */
export interface DrainRouting {
  model: string
  effort: string
}

/** Mirror of the `roadmap:planDispatch` outcome the walk branches on. */
export type DrainPlanResult =
  | { ok: false }
  | {
      ok: true
      mode: 'auto'
      prompt: string
      grantId: string | null
      grantBudgetRemaining: number | null
    }
  | { ok: true; mode: 'confirm'; reason: string }

/** Progress event the renderer strip renders (`roadmap:drainEvent`). */
export interface DrainEvent {
  folder: string
  total: number
  dispatched: number
  confirmNeeded: number
  /** Which queued cards fell back to a per-card confirm this pass, and why. */
  confirmCards: Array<{ slug: string; reason: string }>
  /** How many stamped cards attempted to dispatch this pass and failed (BUG-62). */
  failed: number
  /**
   * BUG-62: which queued cards failed to dispatch this pass, and why — a
   * failure is never silent. A worktree cut for one of these is always rolled
   * back before it lands here (see `runDrainPass`), so the reason describes
   * the DISPATCH failure, not an orphan left on disk.
   */
  failedCards: Array<{ slug: string; reason: string }>
  /** Queued stamped cards never attempted because the WIP ceiling was reached. */
  wipBlocked: number
  /** False on the terminal event of a pass. */
  active: boolean
}

/**
 * BUG-63: the folder-adoption fields {@link DrainPassDeps.spawnSession} needs to
 * register a just-cut worktree into the renderer's live model BEFORE dispatching
 * into it — narrows `AdoptedFolderPayload` (`worktree-ipc.ts`) to the fields
 * `registerFolderImmediate` reads. Kept local (not imported) so this pure core
 * stays free of `worktree-ipc.ts`'s electron-bound module, mirroring how
 * {@link DrainCardView} narrows `RoadmapCard` instead of importing it.
 */
export interface DrainAdoptedFolder {
  path: string
  gitBranch?: string
  repoId?: string
  isMainWorktree?: boolean
}

/** A worktree {@link DrainPassDeps.createWorktree} cut, and what a rollback needs. */
export interface DrainCreatedWorktree {
  /** The worktree's absolute path — the spawn folder. */
  path: string
  /** The parent repo root, for the `git -C <repoRoot>` rollback commands. */
  repoRoot: string
  /** The branch a rollback may delete, or `null` when none was created by us. */
  createdBranch: string | null
  /**
   * BUG-63: the SAME adoption payload `createWorktree` broadcast via
   * `folders:adopted` — echoed here so {@link DrainPassDeps.spawnSession} can
   * register the folder synchronously before dispatching, instead of racing the
   * renderer's 250ms `RELOAD_DEBOUNCE_MS` reload.
   */
  adopted: DrainAdoptedFolder
}

/** Outcome of {@link DrainPassDeps.spawnSession} — the reason survives a failure (BUG-62). */
export type DrainSpawnResult = { ok: true; sessionId: string } | { ok: false; reason: string }

/** What a {@link DrainPassDeps.rollbackWorktree} attempt actually undid. */
export interface DrainRollbackResult {
  rolledBack: boolean
  branchDeleted: string | null
}

/** Injected effects — the shell provides the real ones. */
export interface DrainPassDeps {
  loadState(folder: string): Promise<{ cards: DrainCardView[]; wipLimit: number }>
  plan(folder: string, slug: string): Promise<DrainPlanResult>
  resolveRouting(folder: string, kind: string | undefined): Promise<DrainRouting>
  /** Cut the card's worktree; resolves what a rollback needs, or null on failure. */
  createWorktree(folder: string, slug: string): Promise<DrainCreatedWorktree | null>
  /**
   * Spawn the session in `folder`; the failure branch always carries a reason.
   * `adopted` (BUG-63) is the {@link DrainCreatedWorktree.adopted} payload of a
   * worktree this pass just cut for this dispatch — present ONLY for a
   * worktree-substrate card, so the real implementation can register the folder
   * into the renderer's live model before the dispatch's own folder lookup runs.
   */
  spawnSession(
    folder: string,
    prompt: string,
    routing: DrainRouting,
    adopted?: DrainAdoptedFolder
  ): Promise<DrainSpawnResult>
  /**
   * Roll back a worktree {@link createWorktree} cut when the spawn after it
   * fails — the SAME helper (`rollbackWorktree`) the board's own dispatch path
   * uses (BUG-40), never a third copy of this logic (BUG-62).
   */
  rollbackWorktree(
    repoRoot: string,
    path: string,
    createdBranch: string | null
  ): Promise<DrainRollbackResult>
  /** Best-effort card↔session bind — a false only misses the link, never aborts. */
  bindSession(
    folder: string,
    slug: string,
    sessionId: string,
    dispatchedWith: string,
    substrate: string,
    executedIn: string | undefined
  ): Promise<boolean>
  /**
   * T190: the short branch name of `spawnFolder` (the folder the session was
   * actually spawned into — the card's home `folder` for `session`/`teammate`,
   * a fresh worktree path for `worktree`), or `undefined` on detached HEAD/probe
   * failure. Resolved AFTER the spawn folder exists on disk so a freshly cut
   * worktree's branch is always readable.
   */
  resolveBranch(spawnFolder: string): Promise<string | undefined>
  /** Refund a grant unit `plan` reserved, when the dispatch didn't launch. */
  releaseGrant(grantId: string): void
  emit(event: DrainEvent): void
}

export interface DrainPassResult {
  total: number
  dispatched: number
  confirmNeeded: number
  wipBlocked: number
  /** How many stamped cards failed to dispatch this pass (BUG-62). */
  failed: number
  /** Which cards failed and why — the reason a `catch { return null }` used to destroy. */
  failedCards: Array<{ slug: string; reason: string }>
}

/** The `dispatched-with` audit line (mirror of `routing-policy#formatDispatchedWith`). */
function formatDispatchedWith(r: DrainRouting): string {
  return `dispatched-with: ${r.model}·${r.effort}`
}

/**
 * One drain pass over one folder's board: walk the stamped Ready queue in
 * declared order, dispatching every card the gate auto-allows, pausing at the
 * WIP ceiling, skipping (never stalling on) cards that fall back to a human
 * confirm or whose spawn fails — the exact contract of the renderer loop this
 * replaces (T104 §2.5 AC-3/AC-4).
 */
export async function runDrainPass(folder: string, deps: DrainPassDeps): Promise<DrainPassResult> {
  const { cards, wipLimit } = await deps.loadState(folder)
  let wip = cards.filter((c) => c.status === 'in-progress').length
  const queue = sortManifestQueue(
    cards.filter(
      (c) =>
        c.status === 'ready' &&
        !!c.approved &&
        !c.session &&
        (c.substrate ?? 'session') !== 'internal'
    )
  )
  const total = queue.length
  let dispatched = 0
  const confirmCards: Array<{ slug: string; reason: string }> = []
  const failedCards: Array<{ slug: string; reason: string }> = []
  const skipped = new Set<string>()
  const wipBlockedCount = (): number => queue.filter((c) => !skipped.has(c.slug)).length
  if (total === 0) {
    return { total, dispatched, confirmNeeded: 0, wipBlocked: 0, failed: 0, failedCards: [] }
  }

  const progress = (active: boolean): void =>
    deps.emit({
      folder,
      total,
      dispatched,
      confirmNeeded: confirmCards.length,
      confirmCards: [...confirmCards],
      failed: failedCards.length,
      failedCards: [...failedCards],
      wipBlocked: active ? 0 : wipBlockedCount(),
      active
    })

  progress(true)
  for (;;) {
    const slug = nextManifestDrainTarget(queue, skipped, wip < wipLimit)
    if (!slug) break
    skipped.add(slug) // one attempt per card per pass, whatever the outcome
    const target = queue.find((c) => c.slug === slug)
    if (!target) break

    const plan = await deps.plan(folder, slug)
    if (!plan.ok) continue
    if (plan.mode === 'confirm') {
      confirmCards.push({ slug, reason: plan.reason })
      continue
    }

    let spawnFolder = folder
    let createdWorktree: DrainCreatedWorktree | null = null
    if ((target.substrate ?? 'session') === 'worktree') {
      const wt = await deps.createWorktree(folder, slug)
      if (!wt) {
        if (plan.grantId !== null) deps.releaseGrant(plan.grantId)
        continue
      }
      createdWorktree = wt
      spawnFolder = wt.path
    }

    const routing = await deps.resolveRouting(folder, target.kind)
    const spawnResult = await deps.spawnSession(
      spawnFolder,
      plan.prompt,
      routing,
      createdWorktree?.adopted
    )
    if (!spawnResult.ok) {
      if (plan.grantId !== null) deps.releaseGrant(plan.grantId)
      // BUG-62: a worktree created for a spawn that then fails is an orphan
      // unless rolled back HERE — createWorktree already returned, so nothing
      // downstream will ever clean it up otherwise.
      let reason = spawnResult.reason
      if (createdWorktree) {
        const rollback = await deps.rollbackWorktree(
          createdWorktree.repoRoot,
          createdWorktree.path,
          createdWorktree.createdBranch
        )
        if (!rollback.rolledBack) {
          reason += ' (worktree rollback also failed — it may still be on disk)'
        }
      }
      failedCards.push({ slug, reason })
      continue
    }
    const sessionId = spawnResult.sessionId
    const executedIn = await deps.resolveBranch(spawnFolder)
    await deps.bindSession(
      folder,
      slug,
      sessionId,
      formatDispatchedWith(routing),
      target.substrate ?? 'session',
      executedIn
    )
    dispatched += 1
    wip += 1
    progress(true)
  }
  progress(false)
  return {
    total,
    dispatched,
    confirmNeeded: confirmCards.length,
    wipBlocked: wipBlockedCount(),
    failed: failedCards.length,
    failedCards: [...failedCards]
  }
}

// ---- Poke hook ---------------------------------------------------------------
// The write paths that can change a queue (stamp, status move, bind, close) call
// `pokeManifestDrain` — a module-level indirection so `roadmap-ipc`/`server.ts`
// can import it from this pure module without a cycle through the env-bound
// shell (which registers the real scheduler at boot). Before registration (or in
// unit tests) a poke is a silent no-op.

let pokeImpl: ((folder: string) => void) | null = null

/** Shell registration: point pokes at the live scheduler. */
export function setDrainPoke(fn: ((folder: string) => void) | null): void {
  pokeImpl = fn
}

/** Nudge the drain for `folder` — safe to call before the shell registered. */
export function pokeManifestDrain(folder: string): void {
  pokeImpl?.(folder)
}

/**
 * Debounced, per-folder, single-flight scheduler for drain passes. Every
 * write-path that can change the queue or free a WIP slot `poke`s it; pokes
 * landing mid-pass coalesce into exactly one follow-up pass, and a rejected
 * pass never kills the scheduler.
 */
export function createDrainScheduler(
  run: (folder: string) => Promise<void>,
  delayMs = 300
): { poke: (folder: string) => void } {
  const timers = new Map<string, ReturnType<typeof setTimeout>>()
  const running = new Set<string>()
  const dirty = new Set<string>()

  function poke(folder: string): void {
    const armed = timers.get(folder)
    if (armed) clearTimeout(armed)
    timers.set(
      folder,
      setTimeout(() => fire(folder), delayMs)
    )
  }

  function fire(folder: string): void {
    timers.delete(folder)
    if (running.has(folder)) {
      dirty.add(folder)
      return
    }
    running.add(folder)
    Promise.resolve()
      .then(() => run(folder))
      .catch(() => {})
      .then(() => {
        running.delete(folder)
        if (dirty.delete(folder)) poke(folder)
      })
  }

  return { poke }
}
