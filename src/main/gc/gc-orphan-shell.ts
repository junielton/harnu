// The env-bound edge of the orphan-transcript listing (unit D, AC-D1): which sessions are live or
// parked right now, which known folders still exist, and the real transcripts root. Every decision
// is made by `planOrphanTranscripts`; this file only gathers its inputs, and fails closed: any
// failure here lists nothing rather than guess. Imports are lazy so loading the gather for its
// pure parts never loads the PTY layer.

import { fsOrphanProbe, fsPathExistence, planOrphanTranscripts } from './gc-orphan-transcripts'
import type { OrphanTranscriptItem } from './gc-orphan-transcripts'

export interface OrphanSourceContext {
  /** Every folder Harnu knows (sidebar, pinned, hidden, repos, worktrees), existing or not. */
  known: readonly string[]
  /** Repo checkouts, to group a gone folder under its repo. */
  repoPaths: readonly string[]
}

export type OrphanSource = (ctx: OrphanSourceContext) => Promise<OrphanTranscriptItem[]>

/** Session ids that must keep their project folder: a running PTY, or a parked (hibernated) one. */
async function protectedSessionIds(): Promise<Set<string>> {
  const [{ liveSessionKeys }, { hibernatedKeys }] = await Promise.all([
    import('../pty'),
    import('../hibernation')
  ])
  return new Set([...liveSessionKeys(), ...hibernatedKeys()])
}

export const realOrphanSource: OrphanSource = async (ctx) => {
  try {
    const protectedIds = await protectedSessionIds()
    const states = await Promise.all(
      [...new Set([...ctx.known, ...ctx.repoPaths])].map(
        async (p) => [p, await fsPathExistence(p)] as const
      )
    )
    // Only a folder that still exists protects a slug; an unreadable one counts as existing.
    const alive = states.filter(([, s]) => s !== 'gone').map(([p]) => p)
    return await planOrphanTranscripts({
      probe: fsOrphanProbe(),
      exists: fsPathExistence,
      protectedSessionIds: protectedIds,
      protectedFolders: alive,
      repoPaths: ctx.repoPaths
    })
  } catch (err) {
    console.warn('[gc] orphan transcripts not listed', err instanceof Error ? err.message : err)
    return []
  }
}
