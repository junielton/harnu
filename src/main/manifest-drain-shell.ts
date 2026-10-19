import { promises as fs } from 'node:fs'
import { ipcMain, type BrowserWindow } from 'electron'
import type { CommandBridge } from './command-bridge'
import {
  computeWipVerdict,
  resolveWipSessionFacts,
  type BootPromptLabels,
  type WipCardInput,
  type WipLivenessEnv,
  type WipSessionFacts,
  type WipVerdict
} from './roadmap-core'
import {
  runDrainPass,
  createDrainScheduler,
  setDrainPoke,
  type DrainCardView,
  type DrainPassDeps,
  type DrainPlanResult
} from './manifest-drain'
import { planDispatchCore, bindSessionCore, listCardSlugs, readCard } from './roadmap-ipc'
import { resolveFolderRouting } from './routing-policy'
import { release } from './mcp/grant-registry'
import { createWorktree, rollbackWorktree } from './worktree-ipc'
import { probeGitMeta } from './git-probe'
import { getFleetFolders } from './fleet-model'
import { isHibernated } from './hibernation'
import { liveSessionKeys, resolveSessionAlias } from './pty'
import { getUserProjectWipLimit } from './user-projects'

/**
 * T113 — the env-bound shell wiring the pure drain driver (`manifest-drain.ts`)
 * to the real world: card reads via the serialized roadmap primitives, the
 * gate/reserve via `planDispatchCore` (the SAME code the board IPC runs), the
 * worktree cut via `createWorktree`, the session spawn via the renderer
 * CommandBridge (`dispatch_card_session` — background boot, never steals
 * selection), and progress via `roadmap:drainEvent` to whichever window is up.
 *
 * The renderer is still REQUIRED for a spawn (sessions/PTYs are renderer-owned)
 * — what T113 removes is the ROADMAP BOARD requirement: with the app open on any
 * view, stamped cards drain. Boot-labels come from the renderer's i18n over the
 * bridge for the same reason; no window ⇒ the pass aborts and a later poke
 * retries. env-bound (electron webContents + fs + git) ⇒ e2e-only per ADR-0001.
 */

/** The labels ack shape the renderer's `boot_labels` command returns. */
function isLabels(v: unknown): v is BootPromptLabels {
  if (!v || typeof v !== 'object') return false
  const o = v as Record<string, unknown>
  return (['heading', 'framing', 'specLabel', 'specFileHint', 'closure'] as const).every(
    (k) => typeof o[k] === 'string' && (o[k] as string).length > 0
  )
}

/**
 * BUG-197 (ADR-0021): the transcript-activity map the live-work rule reads —
 * `sessionId → newest activity (ms)`. `null` when the fleet model cannot be read
 * (the caller then fails toward counting every card, as before this change).
 */
async function transcriptActivity(): Promise<Map<string, number | null> | null> {
  try {
    const out = new Map<string, number | null>()
    for (const folder of await getFleetFolders()) {
      for (const s of folder.sessions) {
        const t = Math.max(s.fileMtime || 0, Date.parse(s.modified) || 0)
        out.set(s.sessionId, t > 0 ? t : null)
      }
    }
    return out
  } catch {
    return null
  }
}

/** Everything a drain pass or the board needs about one folder's WIP ceiling. */
export interface FolderWipState {
  cards: Array<DrainCardView & WipCardInput>
  verdict: WipVerdict
}

/**
 * Read a folder's board, judge each In Progress card against the live-work rule and
 * measure the live count against the repo's configured limit. The ONE entry point
 * both the manifest drain (`loadState`) and the board (`roadmap:wipState`) go
 * through, so the two can never disagree about what counts.
 */
export async function loadFolderWip(folder: string, now = Date.now()): Promise<FolderWipState> {
  const slugs = await listCardSlugs(folder)
  const cards: Array<DrainCardView & WipCardInput> = []
  for (const slug of slugs) {
    const res = await readCard(folder, slug)
    if (!res.ok) continue
    const c = res.card
    let touchedAtMs: number | null = null
    if (c.status === 'in-progress') {
      try {
        touchedAtMs = (await fs.stat(res.file)).mtimeMs
      } catch {
        touchedAtMs = null
      }
    }
    cards.push({
      slug: c.slug,
      id: c.id,
      status: c.status,
      touchedAtMs,
      ...(c.kind ? { kind: c.kind } : {}),
      ...(c.approved ? { approved: c.approved } : {}),
      ...(c.session ? { session: c.session } : {}),
      ...(c.substrate ? { substrate: c.substrate } : {})
    })
  }
  const limit = await getUserProjectWipLimit(folder)
  const activity = await transcriptActivity()
  const live = liveSessionKeys()
  const env: WipLivenessEnv = {
    resolveAlias: resolveSessionAlias,
    isLive: (k) => live.has(k),
    isParked: isHibernated,
    transcriptActivityMs: (id) => activity?.get(id)
  }
  const factsFor = (session: string): WipSessionFacts | null =>
    activity ? resolveWipSessionFacts(session, env) : null
  const verdict = computeWipVerdict(cards, limit, factsFor, now)
  const stale = new Set(verdict.staleSlugs)
  for (const c of cards) if (stale.has(c.slug)) c.stale = true
  return { cards, verdict }
}

export function registerManifestDrain(
  bridge: CommandBridge,
  getWindow: () => BrowserWindow | null
): void {
  // BUG-197: the board draws the SAME verdict the drain acts on — it asks main
  // instead of keeping a second copy of the live/stale rule in the renderer.
  ipcMain.handle('roadmap:wipState', async (_e, args: { folder?: string }): Promise<WipVerdict> => {
    return (await loadFolderWip(args?.folder ?? '')).verdict
  })

  const deps: DrainPassDeps = {
    loadState: async (folder) => {
      const { cards, verdict } = await loadFolderWip(folder)
      return { cards, wipLimit: verdict.limit }
    },

    plan: async (folder, slug): Promise<DrainPlanResult> => {
      let ack: { labels?: unknown } | null = null
      try {
        ack = await bridge.dispatch<{ labels?: unknown }>('roadmap.bootLabels', {})
      } catch {
        return { ok: false } // no renderer ⇒ no spawn either; a later poke retries
      }
      const labels = ack?.labels
      if (!isLabels(labels)) return { ok: false }
      const res = await planDispatchCore(folder, slug, labels)
      if (!res.ok) return { ok: false }
      if (res.mode === 'auto') {
        return {
          ok: true,
          mode: 'auto',
          prompt: res.prompt,
          grantId: res.grantId,
          grantBudgetRemaining: res.grantBudgetRemaining
        }
      }
      return { ok: true, mode: 'confirm', reason: res.reason }
    },

    resolveRouting: (folder, kind) => resolveFolderRouting(folder, kind),

    createWorktree: async (folder, slug) => {
      try {
        // Same shape as the board's manual path (`window.api.worktreeCreate`):
        // branch `card/<slug>`, disclosed-human-surface inheritance (the manifest
        // go IS the disclosure), defaults for base/ref. T191: `folder` doubles as
        // the lineage origin — the drain pass already knows it exactly, no
        // guessing needed.
        const created = await createWorktree(
          folder,
          `card/${slug}`,
          undefined,
          undefined,
          undefined,
          {
            inherit: { optedOut: false },
            origin: folder
          }
        )
        if (!created.path) return null
        return {
          path: created.path,
          repoRoot: created.repoRoot,
          createdBranch: created.createdBranch,
          // BUG-63: echo the SAME adoption payload `folders:adopted` carries, so
          // `spawnSession` can have the renderer register it synchronously
          // BEFORE dispatching — closing the race against the 250ms
          // `RELOAD_DEBOUNCE_MS` reload that used to guarantee a
          // `FOLDER_NOT_FOUND` on the first attempt.
          adopted: created.adopted
        }
      } catch {
        return null
      }
    },

    spawnSession: async (folder, prompt, routing, adopted) => {
      try {
        const ack = await bridge.dispatch<{ sessionId?: string; error?: string }>(
          'session.dispatchCard',
          {
            folderPath: folder,
            prompt,
            bootOverride: { model: routing.model, effort: routing.effort },
            // BUG-63: present ONLY for a worktree-substrate dispatch — the
            // renderer handler registers this folder (`registerFolderImmediate`,
            // BUG-40) BEFORE its own `dispatchCardSession` folder lookup runs.
            ...(adopted ? { adopted } : {})
          }
        )
        if (ack && typeof ack.sessionId === 'string' && ack.sessionId) {
          return { ok: true, sessionId: ack.sessionId }
        }
        // BUG-62: an ack without a sessionId is a NAMED failure (e.g.
        // `FOLDER_NOT_FOUND`), never a bare null — the reason must survive so
        // the drain result and the operator-facing event can show it.
        const reason =
          ack && typeof ack.error === 'string' && ack.error
            ? ack.error
            : 'session.dispatchCard returned no sessionId'
        return { ok: false, reason }
      } catch (err) {
        // A `CommandBridgeError` (`NO_WINDOW`/`TIMEOUT`) or any other throw —
        // its message IS the reason, never discarded (BUG-62).
        return { ok: false, reason: err instanceof Error ? err.message : String(err) }
      }
    },

    rollbackWorktree: async (repoRoot, path, createdBranch) =>
      rollbackWorktree(repoRoot, path, createdBranch),

    bindSession: async (folder, slug, sessionId, dispatchedWith, substrate, executedIn) =>
      (await bindSessionCore(folder, slug, sessionId, dispatchedWith, substrate, executedIn)).ok,

    // T190: probe the SPAWN folder (not the card's home `folder`) for its short
    // branch name — works for both same-folder dispatch and a freshly cut
    // worktree, since this runs after the worktree exists on disk.
    resolveBranch: async (spawnFolder) => (await probeGitMeta(spawnFolder)).gitBranch,

    releaseGrant: (grantId) => release(grantId),

    emit: (event) => {
      const win = getWindow()
      if (!win || win.isDestroyed()) return
      win.webContents.send('roadmap:drainEvent', event)
    }
  }

  const scheduler = createDrainScheduler(async (folder) => {
    await runDrainPass(folder, deps)
  })
  setDrainPoke(scheduler.poke)
}
