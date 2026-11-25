/**
 * What main knows about a session it spawned before the model of the fleet does (BUG-296).
 *
 * A dispatched row is born with a `synthetic-…` id, and its real id shows up later. Two things in main
 * see it first-hand, and both are written here:
 *
 * - **the spawn** (`pty:create`), when Harnu minted the id itself and passed it with `--session-id`
 *   (a session started for a step, whose credential carries it);
 * - **the re-key** (`pty:rekey`), which the renderer sends for EVERY synthetic row once its transcript
 *   landed, agent-controlled or not.
 *
 * The materialization report (`renderer:session-materialized`) is sent only for an agent-controlled
 * row, so a card the manifest drain or the board dispatched was never reported and the wait for it ran
 * out. {@link awaitSessionBoot} is the wait that works for every row. A minted id wins over the re-key's:
 * it is the id the CLI was told to use, while the renderer's pick among two rows of one folder is a guess.
 *
 * In memory only and bounded: an app restart drops it. Pure, no electron.
 */

export interface BootedSession {
  syntheticId: string
  sessionId: string
  folder: string
}

const CAP = 512
const SYNTHETIC_PREFIX = 'synthetic-'

const minted = new Map<string, string>()
const booted = new Map<string, BootedSession>()
const waiters = new Map<string, Set<(b: BootedSession) => void>>()

function remember<V>(map: Map<string, V>, key: string, value: V): void {
  map.delete(key)
  map.set(key, value)
  if (map.size > CAP) {
    const oldest = map.keys().next().value
    if (oldest !== undefined) map.delete(oldest)
  }
}

/** `pty:create` started `sessionKey` with `sessionId` as the CLI's own id. */
export function noteSpawnedSessionId(sessionKey: string, sessionId: string): void {
  if (sessionKey.startsWith(SYNTHETIC_PREFIX)) remember(minted, sessionKey, sessionId)
}

/** The id Harnu minted for the spawn of `sessionKey`, when it did. */
export function spawnedSessionId(sessionKey: string): string | undefined {
  return minted.get(sessionKey)
}

/** The PTY of `fromKey` is now `toKey`'s: the transcript exists. Anything but a synthetic row is ignored. */
export function noteSessionRekey(fromKey: string, toKey: string, folder: string): void {
  if (!fromKey.startsWith(SYNTHETIC_PREFIX) || toKey.startsWith(SYNTHETIC_PREFIX)) return
  const boot = { syntheticId: fromKey, sessionId: minted.get(fromKey) ?? toKey, folder }
  remember(booted, fromKey, boot)
  const waiting = waiters.get(fromKey)
  waiters.delete(fromKey)
  for (const resolve of waiting ?? []) resolve(boot)
}

/** The real session behind `syntheticId` once its transcript exists, or `null` after `timeoutMs`. */
export function awaitSessionBoot(
  syntheticId: string,
  timeoutMs: number
): Promise<BootedSession | null> {
  const done = booted.get(syntheticId)
  if (done) return Promise.resolve(done)
  return new Promise((resolve) => {
    const set = waiters.get(syntheticId) ?? new Set()
    waiters.set(syntheticId, set)
    const settle = (boot: BootedSession | null): void => {
      clearTimeout(timer)
      set.delete(onBoot)
      if (set.size === 0 && waiters.get(syntheticId) === set) waiters.delete(syntheticId)
      resolve(boot)
    }
    const onBoot = (boot: BootedSession): void => settle(boot)
    const timer = setTimeout(() => settle(null), timeoutMs)
    // A wait for a session that never boots must not hold the process open.
    timer.unref?.()
    set.add(onBoot)
  })
}
