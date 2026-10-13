// The remote facts the remove dialog asks for when it opens (delta-2 item 2). Probing what GitHub
// and the remote say about a branch costs network round trips, so it happens lazily, for the
// branches in the dialog only, never on a gather; answers are shared and kept for ten minutes,
// bounded in concurrency and in time, and a probe that fails or hangs is "could not tell", which
// is never cached. Pure over an injected probe.

import type { WorktreeBundle } from './bundle-core'
import type { RemoteFacts } from './gc-remote-delete'
import { isRemoteCandidate } from './gc-remote-facts'

export const REMOTE_FACTS_TTL_MS = 10 * 60_000
const DEFAULT_CONCURRENCY = 4
const DEFAULT_TIMEOUT_MS = 30_000

export interface RemoteFactsDeps {
  probe(b: WorktreeBundle): Promise<RemoteFacts>
  now(): number
  concurrency?: number
  timeoutMs?: number
}

/**
 * Only a fully answered probe is worth keeping: any unknown (a failed `gh`, an unreachable remote, tips
 * that could not be compared) may be an error, and an error must not be served for ten minutes.
 */
const isComplete = (f: RemoteFacts): boolean =>
  f.remote !== null &&
  f.remoteSha !== null &&
  f.remoteMatchesLocal !== null &&
  f.openPr !== null &&
  f.ghProtected !== null

const UNKNOWN: RemoteFacts = {
  remote: null,
  remoteSha: null,
  remoteMatchesLocal: null,
  openPr: null,
  ghProtected: null
}

export interface RemoteFactsService {
  /** The facts of every candidate among these bundles, by bundle id; non-candidates are absent. */
  facts(bundles: readonly WorktreeBundle[]): Promise<Record<string, RemoteFacts>>
}

export function createRemoteFactsService(deps: RemoteFactsDeps): RemoteFactsService {
  const limit = deps.concurrency ?? DEFAULT_CONCURRENCY
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const cache = new Map<string, { at: number; facts: RemoteFacts }>()
  const inFlight = new Map<string, Promise<RemoteFacts>>()
  let running = 0
  const waiting: Array<() => void> = []

  const acquire = async (): Promise<void> => {
    if (running < limit) {
      running++
      return
    }
    await new Promise<void>((res) => waiting.push(res))
  }
  const release = (): void => {
    const next = waiting.shift()
    if (next) next()
    else running--
  }

  /** One probe, bounded in time. Returns null when it threw or ran out of time. */
  const run = async (b: WorktreeBundle): Promise<RemoteFacts | null> => {
    await acquire()
    try {
      // `AbortSignal.timeout` rather than a timer of our own: no GC module owns a timer.
      const signal = AbortSignal.timeout(timeoutMs)
      return await Promise.race([
        deps.probe(b),
        new Promise<null>((res) =>
          signal.addEventListener('abort', () => res(null), { once: true })
        )
      ])
    } catch {
      return null
    } finally {
      release()
    }
  }

  const keyOf = (b: WorktreeBundle): string =>
    `${b.item.repoPath}\0${b.item.branch}\0${b.localTip ?? ''}`

  const one = (b: WorktreeBundle): Promise<RemoteFacts> => {
    const key = keyOf(b)
    const hit = cache.get(key)
    if (hit && deps.now() - hit.at < REMOTE_FACTS_TTL_MS) return Promise.resolve(hit.facts)
    const pending = inFlight.get(key)
    if (pending) return pending
    const p = run(b)
      .then((facts) => {
        if (facts && isComplete(facts)) cache.set(key, { at: deps.now(), facts })
        return facts ?? { ...UNKNOWN }
      })
      .finally(() => inFlight.delete(key))
    inFlight.set(key, p)
    return p
  }

  return {
    async facts(bundles) {
      const out: Record<string, RemoteFacts> = {}
      await Promise.all(
        bundles.filter(isRemoteCandidate).map(async (b) => {
          out[b.item.id] = await one(b)
        })
      )
      return out
    }
  }
}
