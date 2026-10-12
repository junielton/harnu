// The env-bound edge of the remote-delete facts (delta-1 items 5-7, delta-2 item 2): the real
// `git` and `gh` runners, the click-time probe (never cached), and the dialog's probe service
// (shared, cached ten minutes, bounded). All decisions live in gc-remote-delete.ts,
// gc-remote-facts.ts and gc-remote-service.ts; this file only runs commands, and fails closed.
// Nothing here runs on a gather.

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { spawnEnvOnce } from '../appimage-env'
import type { WorktreeBundle } from './bundle-core'
import type { RemoteFacts } from './gc-remote-delete'
import {
  createOpenPrLister,
  openPrListArgs,
  probeRemoteFacts,
  type RemoteRunners
} from './gc-remote-facts'
import { createRemoteFactsService, type RemoteFactsService } from './gc-remote-service'

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

let service: RemoteFactsService | null = null

/** The dialog's probe: shared open-PR lists (the scanner's when it can answer), ten-minute cache. */
export function remoteFactsService(): RemoteFactsService {
  if (service) return service
  const openPr = createOpenPrLister({
    now: () => Date.now(),
    fromScanner: async (repo) => (await import('../reaper/scanner-shell')).readOpenPrRefs(repo),
    list: (repo, slug) => realRemoteRunners.gh(repo, openPrListArgs(slug))
  })
  service = createRemoteFactsService({
    now: () => Date.now(),
    probe: (b) => probeRemoteFacts(b, realRemoteRunners, { openPr })
  })
  return service
}
