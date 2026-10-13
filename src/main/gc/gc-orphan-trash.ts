// Moving an orphaned transcripts folder to the OS trash, recorded like a worktree removal (unit E,
// AC-E1). The move names the exact trash entry it created and writes a journal line carrying it, so
// the "in the trash" strip counts those bytes and "Empty what Harnu moved" can empty exactly them.
// Without the line the folder sat in the trash for good and Cleanup could not clean what it had put
// there itself. The disk work is trash-shell.ts; the slug checks are `trashTranscriptSlug`'s.

import * as path from 'node:path'
import type { Tombstone } from '../reaper/journal'
import { trashTranscriptSlug } from './gc-orphan-transcripts'
import { recordTrash, type TrashEnv } from './trash-shell'

/** The journal line's `kind` for these folders, so a reader can tell them from a removed worktree. */
export const TRANSCRIPTS_TOMBSTONE_KIND = 'orphan-transcripts'

export interface TrashTranscriptsDeps {
  /** `~/.claude/projects`. */
  root: string
  slug: string
  /** What the operator was shown: the size it will report, and the folder it belonged to. */
  facts: { bytes: number; folder: string }
  env: TrashEnv
  /** The OS trash move (`shell.trashItem`). Throws when it cannot. */
  trash: (p: string) => Promise<void>
  appendTombstone: (t: Tombstone) => Promise<void>
  now: () => number
}

/**
 * Trashes one project folder and records the move. The move's failure propagates (nothing was
 * trashed); a failure to NAME the entry or to write the journal never does, because the folder is
 * already in the trash by then and the clean is done. Such an entry is simply never emptied by Harnu.
 */
export async function trashTranscriptsRecorded(deps: TrashTranscriptsDeps): Promise<void> {
  let moved: { path: string; entry: Tombstone['trashEntry'] } | null = null
  await trashTranscriptSlug(deps.root, deps.slug, async (p) => {
    const entry = await recordTrash(deps.env, p, () => deps.trash(p))
    moved = { path: p, entry }
  })
  if (!moved) return
  const { path: trashedPath, entry } = moved as { path: string; entry: Tombstone['trashEntry'] }
  const at = deps.now()
  try {
    await deps.appendTombstone({
      at,
      // The project's own folder, so the ledger line names where it came from.
      repoPath: deps.facts.folder || path.dirname(trashedPath),
      kind: TRANSCRIPTS_TOMBSTONE_KIND,
      branch: null,
      sha: null,
      deleted: ['trash-transcripts'],
      justifiedBy: null,
      restoreHint: null,
      archiveTipRef: null,
      archiveWipRef: null,
      actor: 'operator',
      trashedPath,
      trashedBytes: deps.facts.bytes,
      trashedAt: at,
      trashEntry: entry ?? null
    })
  } catch (err) {
    console.warn('[gc] recording the transcripts trash failed', err)
  }
}
