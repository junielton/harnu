// The env-bound edge of the orphan-transcript listing (unit D, AC-D1): which sessions are live or
// parked right now, which known folders still exist, and the real transcripts root. Every decision
// is made by `planOrphanTranscripts`; this file only gathers its inputs, and fails closed: any
// failure here lists nothing rather than guess. Imports are lazy so loading the gather for its
// pure parts never loads the PTY layer.

import { execFile } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { homedir } from 'node:os'
import * as path from 'node:path'
import { promisify } from 'node:util'
import { fsOrphanProbe, fsPathExistence, planOrphanTranscripts } from './gc-orphan-transcripts'
import { evidenceFromGit, proveGone } from './gc-orphan-proof'
import { readRemovedFolders } from './gc-removed-folders'
import { digestOrphans, fsOrphanSessions, inspectOrphanTranscript } from './gc-orphan-digest'
import type { OrphanTranscriptItem } from './gc-orphan-transcripts'

export interface OrphanSourceContext {
  /** Every folder Harnu knows (sidebar, pinned, hidden, repos, worktrees), existing or not. */
  known: readonly string[]
  /** Repo checkouts, to group a gone folder under its repo. */
  repoPaths: readonly string[]
  /** Worktrees Harnu shelved: missing on purpose, so their transcripts are never orphans. */
  shelvedFolders?: readonly string[]
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

const runGit = promisify(execFile)

/**
 * Digests the sessions of the listed orphans into their owning repo's memory, at gather time
 * (memory U1 S-5, D-4), and stamps each item with what was digested. The memory layer is loaded
 * lazily; when it (or the engine) is unavailable the items are only counted. Any failure here
 * leaves every item undigested, so the trash needs the explicit choice: it fails closed.
 */
async function withDigests(
  items: OrphanTranscriptItem[],
  ctx: OrphanSourceContext
): Promise<OrphanTranscriptItem[]> {
  if (items.length === 0) return items
  try {
    const [{ digestOrphanTranscript, orphanHasDigest }] = await Promise.all([
      import('../memory-digest')
    ])
    return await digestOrphans(items, {
      repoPaths: ctx.repoPaths,
      probe: {
        exists: async (p) => (await fsPathExistence(p)) === 'exists',
        isCheckout: async (p) =>
          runGit('git', ['-C', p, 'rev-parse', '--git-common-dir'], {
            windowsHide: true,
            timeout: 15_000
          }).then(
            () => true,
            () => false
          )
      },
      sessionsOf: fsOrphanSessions(path.join(homedir(), '.claude', 'projects')),
      inspect: inspectOrphanTranscript,
      hasDigest: orphanHasDigest,
      digest: digestOrphanTranscript
    })
  } catch (err) {
    console.warn('[gc] orphan transcripts not digested', err instanceof Error ? err.message : err)
    return items.map((i) => ({
      ...i,
      digest: { done: 0, total: i.sessionCount, home: null }
    }))
  }
}

export const realOrphanSource: OrphanSource = async (ctx) => {
  try {
    const protectedIds = await protectedSessionIds()
    // What positively proves a missing folder gone: Harnu's own removals, git's prunable worktrees
    // of repos that still exist, and a readable known worktrees parent. Nothing else does.
    const evidence = await evidenceFromGit({
      repoPaths: ctx.repoPaths,
      repoExists: async (p) => (await fsPathExistence(p)) === 'exists',
      worktreeList: async (repo) =>
        (
          await runGit('git', ['-C', repo, 'worktree', 'list', '--porcelain'], {
            windowsHide: true,
            timeout: 15_000,
            maxBuffer: 4 << 20
          })
        ).stdout,
      readable: async (p) =>
        fs.readdir(p).then(
          () => true,
          () => false
        ),
      removed: await readRemovedFolders()
    })
    const states = await Promise.all(
      [...new Set([...ctx.known, ...ctx.repoPaths])].map(
        async (p) => [p, await fsPathExistence(p)] as const
      )
    )
    // Only a folder that still exists protects a slug; an unreadable one counts as existing.
    const alive = states.filter(([, s]) => s !== 'missing').map(([p]) => p)
    const items = await planOrphanTranscripts({
      probe: fsOrphanProbe(),
      exists: fsPathExistence,
      protectedSessionIds: protectedIds,
      protectedFolders: alive,
      repoPaths: ctx.repoPaths,
      shelvedFolders: ctx.shelvedFolders,
      proof: (folder) => proveGone(folder, evidence, fsPathExistence)
    })
    return await withDigests(items, ctx)
  } catch (err) {
    console.warn('[gc] orphan transcripts not listed', err instanceof Error ? err.message : err)
    return []
  }
}
