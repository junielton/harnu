/**
 * Roadmap memory watcher (T80 S1 §3.2 — the glue).
 *
 * The existing `claude-watcher.ts` is a recursive chokidar rooted at
 * `~/.claude/projects/` that classifies session JSONL — it does NOT see
 * `.harnu/memory/`. This is the SECOND watcher, in the same shape (a `send()`
 * shell + a `classify`-style read), rooted at a repo's
 * `<main-checkout>/.harnu/memory/roadmap/`. A file changing on disk → a parsed
 * card pushed to the renderer store, which re-derives the columns (the board is
 * a VIEW; the `.md` files stay the single source of truth).
 *
 * Because the board is per-repo and opened on demand, this watcher is
 * **retargetable**: `retarget(dir, repoKey)` closes the previous chokidar and
 * points at a new repo's roadmap dir, returning the initial scan. Only ONE board
 * is open at a time, so one live watcher is enough; `repoKey` rides on every
 * event so a late event from a since-closed dir is ignored by the store.
 *
 * Env-bound (fs + chokidar) ⇒ e2e-only per ADR-0001; the parse/column/write math
 * is the pure `roadmap-core.ts` (unit-tested). This module only does the effect.
 *
 * Channels emitted (payloads match the preload's inline interfaces):
 *   - roadmap:card:added     { repoKey, card }
 *   - roadmap:card:changed   { repoKey, card }
 *   - roadmap:card:removed   { repoKey, slug }
 */

import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import chokidar, { type FSWatcher } from 'chokidar'
import { parseCard, type RoadmapCard } from './roadmap-core'

/** A retargetable roadmap watcher over one repo's `.harnu/memory/roadmap/`. */
export interface RoadmapWatcherHandle {
  /**
   * Point the watcher at `roadmapDir` (identified by `repoKey`), replacing any
   * previous target. Returns the initial card scan so the caller can seed the
   * store synchronously. Safe to call repeatedly (board re-open / repo switch).
   */
  retarget(roadmapDir: string, repoKey: string): Promise<RoadmapCard[]>
  /** The repoKey currently targeted (or null before the first retarget). */
  currentKey(): string | null
  /** Stop watching and free the chokidar instance. */
  close(): Promise<void>
}

/** Coalesce rapid rewrites (an editor save / our own temp+rename) per path. */
const CARD_DEBOUNCE_MS = 80

/** Read + parse one card file; `null` when it vanished or is unreadable. */
async function readCard(roadmapDir: string, filename: string): Promise<RoadmapCard | null> {
  try {
    const content = await fs.readFile(path.join(roadmapDir, filename), 'utf8')
    return parseCard(content, filename.replace(/\.md$/, ''))
  } catch {
    return null
  }
}

/** Scan a roadmap dir into parsed cards (sorted by filename for a stable seed). */
export async function scanRoadmapDir(roadmapDir: string): Promise<RoadmapCard[]> {
  let names: string[]
  try {
    names = await fs.readdir(roadmapDir)
  } catch {
    return [] // dir absent (repo with no cards yet) → empty board
  }
  const files = names.filter((n) => n.endsWith('.md') && !n.startsWith('.')).sort()
  const cards: RoadmapCard[] = []
  for (const name of files) {
    const card = await readCard(roadmapDir, name)
    if (card) cards.push(card)
  }
  return cards
}

/** Is this basename a card file we care about (a non-dotfile `.md`)? */
function isCardFile(p: string): boolean {
  const base = path.basename(p)
  return base.endsWith('.md') && !base.startsWith('.')
}

export function createRoadmapWatcher(
  send: (channel: string, payload: unknown) => void
): RoadmapWatcherHandle {
  let watcher: FSWatcher | null = null
  let dir: string | null = null
  let key: string | null = null
  const debounce = new Map<string, NodeJS.Timeout>()

  function clearDebounce(): void {
    for (const t of debounce.values()) clearTimeout(t)
    debounce.clear()
  }

  /** Schedule a coalesced read+emit for a card `add`/`change`. */
  function scheduleCardEmit(absPath: string): void {
    const prev = debounce.get(absPath)
    if (prev) clearTimeout(prev)
    debounce.set(
      absPath,
      setTimeout(() => {
        debounce.delete(absPath)
        const targetDir = dir
        const targetKey = key
        if (!targetDir || !targetKey) return
        void readCard(targetDir, path.basename(absPath)).then((card) => {
          // Ignore a result that landed after a retarget (guards the stale dir).
          if (!card || dir !== targetDir || key !== targetKey) return
          send('roadmap:card:changed', { repoKey: targetKey, card })
        })
      }, CARD_DEBOUNCE_MS)
    )
  }

  async function closeWatcher(): Promise<void> {
    clearDebounce()
    if (watcher) {
      const w = watcher
      watcher = null
      try {
        await w.close()
      } catch {
        /* best effort */
      }
    }
  }

  return {
    currentKey: () => key,

    async retarget(roadmapDir: string, repoKey: string): Promise<RoadmapCard[]> {
      await closeWatcher()
      dir = roadmapDir
      key = repoKey
      const cards = await scanRoadmapDir(roadmapDir)

      const w = chokidar.watch(roadmapDir, {
        ignoreInitial: true,
        persistent: true,
        depth: 0,
        followSymlinks: false,
        ignorePermissionErrors: true,
        // A card file is written atomically (temp+rename) by our IPC; the debounce
        // coalesces the resulting add/change so the renderer sees one update.
        awaitWriteFinish: { stabilityThreshold: 60, pollInterval: 20 },
        ignored: (p: string, stats?: { isDirectory(): boolean }) => {
          if (path.resolve(p) === path.resolve(roadmapDir)) return false // the root dir
          if (stats?.isDirectory()) return true // one level only — no nested dirs
          return !isCardFile(p)
        }
      })
      watcher = w

      w.on('add', (p) => {
        if (dir !== roadmapDir || key !== repoKey) return
        void readCard(roadmapDir, path.basename(p)).then((card) => {
          if (card && dir === roadmapDir && key === repoKey) {
            send('roadmap:card:added', { repoKey, card })
          }
        })
      })
      w.on('change', (p) => {
        if (dir !== roadmapDir || key !== repoKey) return
        scheduleCardEmit(p)
      })
      w.on('unlink', (p) => {
        if (dir !== roadmapDir || key !== repoKey) return
        send('roadmap:card:removed', { repoKey, slug: path.basename(p).replace(/\.md$/, '') })
      })
      w.on('error', () => {
        /* a watcher error must never crash main; the board still has its seed scan */
      })

      return cards
    },

    close: closeWatcher
  }
}
