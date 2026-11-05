// The facts a shelve decision is bound to (autonomous cleanup U2.2, design §5): HEAD, a fingerprint
// of the uncommitted work, the newest edited file and the last commit time, read from the worktree
// itself. The cycle reads them when it decides and the executor reads them again right before it
// acts; any difference refuses with "changed since decided".
//
// env-bound (git + fs) ⇒ e2e-only per ADR-0001 beyond the real-git tests; the decision is in
// shelve-eligibility-core.ts. Nothing here throws: a probe that cannot answer yields a null, and a
// null HEAD makes the binding match nothing.

import { execFile } from 'node:child_process'
import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import { promisify } from 'node:util'
import type { ExecFn } from '../reaper/dehydrate-shell'
import type { WorktreeBundle } from './bundle-core'
import { workStampOf } from './gc-work-stamp'
import { readShelveManifest } from './shelve-manifest-shell'
import type { ShelveProbe } from './shelve-eligibility-core'

const run = promisify(execFile)

/** The three facts a decision is bound to. */
export type ShelveBinding = Pick<ShelveProbe, 'headSha' | 'workStamp' | 'newestMtime'>

/** Whether the worktree is still exactly what was decided on. Unreadable (no HEAD) never matches. */
export function sameBinding(a: ShelveBinding, b: ShelveBinding): boolean {
  return (
    a.headSha !== null &&
    b.headSha !== null &&
    a.headSha === b.headSha &&
    a.workStamp === b.workStamp &&
    a.newestMtime === b.newestMtime
  )
}

export interface ShelveProbeDeps {
  exec?: ExecFn
  /** The repo manifest's delegation, read once per probe. Default: the repo's own WORKTREE.md. */
  readManifest?: (repoPath: string) => Promise<{ delegates: boolean }>
}

const nodeExec: ExecFn = (file, args, opts) => run(file, args, { windowsHide: true, ...opts })

const BUDGET = { timeout: 30_000, maxBuffer: 32 << 20 } as const

async function gitOut(exec: ExecFn, cwd: string, args: string[]): Promise<string | null> {
  try {
    return (await exec('git', ['-C', cwd, ...args], BUDGET)).stdout
  } catch {
    return null
  }
}

/** The newest mtime among the paths `git status` lists (a deleted one has none). */
async function newestEditedAt(exec: ExecFn, wt: string): Promise<number | null> {
  const out = await gitOut(exec, wt, ['status', '--porcelain', '-z', '--untracked-files=all'])
  if (out === null) return null
  let newest: number | null = null
  const fields = out.split('\0').filter((f) => f.length > 0)
  for (const record of fields) {
    if (record.length <= 3 || record[2] !== ' ') continue
    try {
      const { mtimeMs } = await fs.lstat(path.join(wt, record.slice(3)))
      if (newest === null || mtimeMs > newest) newest = mtimeMs
    } catch {
      // deleted: contributes no mtime (the stamp already records it)
    }
  }
  return newest
}

export async function probeShelve(
  b: Pick<WorktreeBundle, 'item'>,
  deps: ShelveProbeDeps = {}
): Promise<ShelveProbe> {
  const exec = deps.exec ?? nodeExec
  const wt = b.item.path
  const delegates = async (): Promise<boolean> => {
    try {
      return (await (deps.readManifest ?? readShelveManifest)(b.item.repoPath)).delegates
    } catch {
      return true
    }
  }
  const unreadable = async (): Promise<ShelveProbe> => ({
    headSha: null,
    workStamp: null,
    newestMtime: null,
    lastCommitAt: null,
    manifestDelegates: await delegates()
  })
  if (!wt) return unreadable()

  const head = (await gitOut(exec, wt, ['rev-parse', '--verify', 'HEAD^{commit}']))?.trim()
  const committed = (await gitOut(exec, wt, ['log', '-1', '--format=%ct', 'HEAD']))?.trim()
  const commitSeconds = Number(committed)
  if (!head || !committed || !Number.isFinite(commitSeconds)) return unreadable()

  let workStamp: string | null
  try {
    workStamp = await workStampOf(exec, wt)
  } catch {
    return unreadable()
  }
  return {
    headSha: head,
    workStamp,
    newestMtime: workStamp === null ? null : await newestEditedAt(exec, wt),
    lastCommitAt: commitSeconds * 1000,
    manifestDelegates: await delegates()
  }
}
