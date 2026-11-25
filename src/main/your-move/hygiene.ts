/**
 * Queue hygiene (BUG-308): the queue holds only cards the operator can still act on.
 *
 * Four rules, each applied where cards are filed and once more at start to what is on disk:
 *   A. a judged turn supersedes the session's older judge cards (`inspector.ts`);
 *   B. a live card with no activity for 7 days expires;
 *   C. a mission has at most one card, and a mission nobody touched in 7 days has none
 *      (`source-mission.ts`);
 *   D. a card whose session transcript or folder is gone closes. A death card closes only with
 *      its folder: a session that really died must not vanish because its transcript did. A
 *      worktree Cleanup shelved is not gone: resuming one of its sessions brings it back.
 *
 * Recall over noise: only a sure "gone" closes anything. A lookup that failed, threw or answered
 * `unknown` keeps the card. Every write goes through the store's own `transact`.
 */

import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import { isShelvedFolder, type ShelvedFile } from '../gc/shelve-store'
import {
  closeCards,
  expireStale,
  supersedeOlderTurns,
  type YourMoveCard,
  type YourMoveState
} from './core'
import type { TranscriptLookup } from './locate'
import { reconcileMissions, type RecordViews } from './source-mission'
import type { YourMoveStore } from './store'

export type Presence = 'present' | 'missing' | 'unknown'

/** Is there a directory at `folder`? Only a path that is surely not one is `missing`. */
export async function folderPresence(folder: string): Promise<Presence> {
  if (!path.isAbsolute(folder)) return 'unknown'
  try {
    return (await fs.stat(folder)).isDirectory() ? 'present' : 'missing'
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code
    return code === 'ENOENT' || code === 'ENOTDIR' ? 'missing' : 'unknown'
  }
}

/**
 * `base`, except that a missing folder on the shelved list is `present`. `readShelved` must throw
 * on a list it cannot read: a missing folder is then `unknown`, and its cards stay.
 */
export function shelvedAware(
  base: (folder: string) => Promise<Presence>,
  readShelved: () => Promise<ShelvedFile>
): (folder: string) => Promise<Presence> {
  return async (folder) => {
    const found = await base(folder)
    if (found !== 'missing') return found
    try {
      return isShelvedFolder(await readShelved(), folder) ? 'present' : 'missing'
    } catch {
      return 'unknown'
    }
  }
}

export interface SweepDeps {
  store: YourMoveStore
  lookup(sessionId: string): Promise<TranscriptLookup>
  folder(folder: string): Promise<Presence>
  now(): number
}

interface Gone {
  folders: Set<string>
  transcripts: Set<string>
}

/** The open cards whose folder or transcript is surely gone. Each is asked about once. */
async function findGone(cards: readonly YourMoveCard[], deps: SweepDeps): Promise<Gone> {
  const out: Gone = { folders: new Set(), transcripts: new Set() }
  const folders = new Map<string, Presence>()
  const sessions = new Map<string, boolean>()
  for (const c of cards) {
    if (c.closedAt !== undefined) continue
    let folder = folders.get(c.folder)
    if (folder === undefined) {
      folder = await deps.folder(c.folder).catch((): Presence => 'unknown')
      folders.set(c.folder, folder)
    }
    if (folder === 'missing') {
      out.folders.add(c.id)
      continue
    }
    if (c.source === 'death') continue
    let missing = sessions.get(c.sessionId)
    if (missing === undefined) {
      missing = await deps.lookup(c.sessionId).then(
        (r) => r.state === 'missing',
        () => false
      )
      sessions.set(c.sessionId, missing)
    }
    if (missing) out.transcripts.add(c.id)
  }
  return out
}

const closedCount = (before: YourMoveState, after: YourMoveState): number =>
  after.cards.filter((c, i) => c.closedAt !== undefined && before.cards[i]?.closedAt === undefined)
    .length

const closeGone = (s: YourMoveState, gone: Gone, now: number): YourMoveState =>
  closeCards(
    closeCards(s, gone.folders, 'folder-removed', now),
    gone.transcripts,
    'source-resolved',
    now
  )

/** Rules D and B on the open cards: what the running app repeats every hour. One write. */
export async function sweepStaleCards(deps: SweepDeps): Promise<{ gone: number; expired: number }> {
  const gone = await findGone(deps.store.state().cards, deps)
  return deps.store.transact((s) => {
    const now = deps.now()
    const present = closeGone(s, gone, now)
    const next = expireStale(present, now)
    return {
      next,
      result: { gone: closedCount(s, present), expired: closedCount(present, next) }
    }
  })
}

export interface CleanupQueueDeps extends SweepDeps {
  /** What each repo's open missions owe now (`readRecordViews`). */
  readViews(roots: readonly string[]): Promise<RecordViews>
  /** A folder switched off for Your move: its mission cards are left as they are. */
  folderOff(root: string): boolean
}

export interface CleanupCounts {
  gone: number
  superseded: number
  expired: number
  mission: number
}

/**
 * The startup cleanup: D, A, B, then C over the cards already on disk. It only closes (and puts a
 * mission's next item on the card that stays): filing is the sources' job. Safe to run again.
 */
export async function cleanupQueue(deps: CleanupQueueDeps): Promise<CleanupCounts> {
  const gone = await findGone(deps.store.state().cards, deps)
  const first = await deps.store.transact((s) => {
    const now = deps.now()
    const a = closeGone(s, gone, now)
    const b = supersedeOlderTurns(a, now)
    const c = expireStale(b, now)
    return {
      next: c,
      result: { gone: closedCount(s, a), superseded: closedCount(a, b), expired: closedCount(b, c) }
    }
  })
  const roots = new Set<string>()
  for (const c of deps.store.state().cards) {
    if (c.closedAt === undefined && c.mission && !deps.folderOff(c.mission.root)) {
      roots.add(c.mission.root)
    }
  }
  if (roots.size === 0) return { ...first, mission: 0 }
  let views: RecordViews
  try {
    views = await deps.readViews([...roots])
  } catch (e) {
    // The list poll applies the same rule later; nothing is closed on a read that failed.
    console.error(`[your-move] mission cleanup skipped: ${(e as Error).message}`)
    return { ...first, mission: 0 }
  }
  const mission = await deps.store.transact((s) => {
    const next = reconcileMissions(
      s,
      { unreadable: [] },
      [...roots],
      'live',
      // `onlyExisting` files nothing, so no id is ever minted.
      () => '',
      deps.now(),
      views,
      { onlyExisting: true }
    )
    return { next, result: closedCount(s, next) }
  })
  return { ...first, mission }
}
