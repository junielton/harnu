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
