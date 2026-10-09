// A fingerprint of a worktree's uncommitted work. The operator's force path removes a
// worktree that has work git would not keep, after showing a dialog; a file edited between the
// scan the dialog was built from and the removal must stop the removal, not ride into the
// trash. `git status` alone cannot say that for a file that was already modified, so each
// listed path contributes its size and mtime too.
//
// Free of electron: the subprocess goes through the injected `ExecFn` and the stat is `node:fs`.

import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import type { ExecFn } from '../reaper/dehydrate-shell'
import type { ReapItem } from '../reaper/reaper-core'

/** A worktree with more dirty paths than this is stamped from `git status` alone beyond it. */
const STAT_CAP = 2000

const BUDGET = { timeout: 30_000, maxBuffer: 32 << 20 } as const

/**
 * Null when the worktree has no uncommitted work, otherwise a hex digest of every status record
 * with its path's size and mtime. Rejects when git cannot answer: a caller that compares stamps
 * must treat that as "cannot tell", never as "unchanged".
 */
export async function workStampOf(exec: ExecFn, worktreePath: string): Promise<string | null> {
  const { stdout } = await exec(
    'git',
    ['-C', worktreePath, 'status', '--porcelain', '-z', '--untracked-files=all'],
    BUDGET
  )
  const fields = stdout.split('\0').filter((f) => f.length > 0)
  if (fields.length === 0) return null
  const hash = createHash('sha256')
  let statted = 0
  for (const record of fields) {
    // A rename's source arrives as its own field without an `XY ` prefix; hashing it verbatim
    // is harmless, and only the records that look like `XY path` are statted.
    hash.update(record)
    if (record.length > 3 && record[2] === ' ' && statted < STAT_CAP) {
      statted++
      try {
        const st = await fs.lstat(path.join(worktreePath, record.slice(3)))
        hash.update(`|${st.size}:${st.mtimeMs}`)
      } catch {
        hash.update('|gone') // a deleted file is its own state
      }
    }
    hash.update('\0')
  }
  return hash.digest('hex')
}

/**
 * What the scan records when the probe could not answer (an overflow, a git error). It is neither
 * a stamp nor "no work": the force path refuses such an item (`work-unreadable`) with a message
 * that says to scan again, instead of comparing a live value against nothing and refusing forever.
 */
export const WORK_STAMP_UNKNOWN = 'unknown'

/** The scan's stamp: {@link workStampOf} with the very same git call, or "unknown" if it cannot answer. */
export async function scanWorkStamp(exec: ExecFn, worktreePath: string): Promise<string | null> {
  try {
    return await workStampOf(exec, worktreePath)
  } catch {
    return WORK_STAMP_UNKNOWN
  }
}

/**
 * Which scanned worktrees get a stamp: any with uncommitted or untracked work, and any whose status
 * could not be read (`local-clean` unknown), since the live check may well read work there. A clean
 * one has none, and a row with no folder has nothing to probe.
 */
export function needsWorkStamp(item: ReapItem): boolean {
  if (!item.path) return false
  if (item.blockers.includes('dirty') || item.untracked.length > 0) return true
  return item.checkpoints.find((c) => c.id === 'local-clean')?.state === 'unknown'
}
