// The env-bound edge of the remote-delete facts (delta-1 items 5-7): the real `git` and `gh`
// runners, and the gather's one pass that probes every strongly merged branch so the remove confirm
// can offer "Also delete the branch on the remote" only when it can work. All decisions live in
// gc-remote-delete.ts and gc-remote-facts.ts; this file only runs commands, and fails closed.

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { spawnEnvOnce } from '../appimage-env'
import type { WorktreeBundle } from './bundle-core'
import type { RemoteFacts } from './gc-remote-delete'
import { probeRemoteFacts, type RemoteRunners } from './gc-remote-facts'

const run = promisify(execFile)
const OPTS = { windowsHide: true, timeout: 30_000, maxBuffer: 4 << 20 } as const

export const realRemoteRunners: RemoteRunners = {
  git: async (repo, args) =>
    (await run('git', ['-C', repo, ...args], { ...OPTS, env: await spawnEnvOnce() })).stdout,
  gh: async (repo, args) =>
    (await run('gh', args, { ...OPTS, cwd: repo, env: await spawnEnvOnce() })).stdout
}

/** The facts right now, never cached: the click-time check reads this. */
export const realRemoteFacts = (b: WorktreeBundle): Promise<RemoteFacts> =>
  probeRemoteFacts(b, realRemoteRunners)

/** At most this many branches are probed per gather; the rest simply are not offered the option. */
const MAX_PROBED = 30
const CONCURRENCY = 4

/** Whether a bundle's branch is a candidate for the remote delete at all (a merged PR's strong proof). */
export const isRemoteCandidate = (b: WorktreeBundle): boolean =>
  !!b.item.branch &&
  b.fate.fate === 'merged' &&
  b.fate.strong &&
  b.fate.signal === 'gh-merged' &&
  (b.bucket === 'ready' || b.bucket === 'review')

/** The bundles with `remoteFacts` attached to every candidate. A probe that throws attaches nothing. */
export async function attachRemoteFacts(
  bundles: WorktreeBundle[],
  probe: (b: WorktreeBundle) => Promise<RemoteFacts> = realRemoteFacts
): Promise<WorktreeBundle[]> {
  const todo = bundles.filter(isRemoteCandidate).slice(0, MAX_PROBED)
  const facts = new Map<string, RemoteFacts>()
  for (let i = 0; i < todo.length; i += CONCURRENCY) {
    await Promise.all(
      todo.slice(i, i + CONCURRENCY).map(async (b) => {
        try {
          facts.set(b.item.id, await probe(b))
        } catch {
          // not probed: not offered
        }
      })
    )
  }
  return bundles.map((b) =>
    facts.has(b.item.id) ? { ...b, remoteFacts: facts.get(b.item.id)! } : b
  )
}
