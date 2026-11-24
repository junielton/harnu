/**
 * Finds `~/.claude/projects/<slug>/<id>.jsonl` by session id: the renderer and the hooks never
 * name a path the main process can trust, and a companion event may carry none.
 *
 * The cost is bounded by the number of slug directories, never by the number of sessions asked
 * about. A path a hook payload carried is taken as it is. Otherwise one listing of every slug
 * builds an id → slug index that answers every lookup until it ages out; a found path is
 * remembered, and a session with no transcript is remembered as missing for a while, so the
 * sweep does not ask the disk about it again on every tick (BUG-261: probing each slug with
 * `fs.access` for each session pinned the main thread for seconds, once a minute).
 */

import * as path from 'node:path'

/** The one fs call the locator needs: a directory listing. */
export interface LocatorFs {
  readdir(dir: string): Promise<string[]>
}

/**
 * What a lookup knows. `missing` means the whole projects tree was listed and holds no
 * transcript for the id; `unknown` means a listing failed, so nothing is known: a caller that
 * would act on absence (close a card) must treat it as present.
 */
export type TranscriptLookup =
  { state: 'found'; path: string } | { state: 'missing' } | { state: 'unknown' }

export interface TranscriptLocator {
  /** The transcript of a session, or null when none is on disk (or none could be found). */
  locate(sessionId: string): Promise<string | null>
  /** Like `locate`, but tells a transcript that is not there from a listing that failed. */
  lookup(sessionId: string): Promise<TranscriptLookup>
  /** A path a hook payload carried: remembered, so no directory is touched for this session. */
  note(sessionId: string, transcriptPath: string | undefined): void
}

export interface LocatorDeps {
  /** `~/.claude/projects`. */
  root: string
  fs: LocatorFs
  now(): number
}

/** How long a session with no transcript is not looked for again. A hook path overrides it. */
export const MISSING_TTL_MS = 5 * 60_000
/** The slug index is rebuilt at most this often, however many lookups miss it. */
export const REINDEX_MIN_MS = 10_000
/** Remembered ids (found and missing, each): the oldest go first. */
const MAX_REMEMBERED = 10_000
/** Slug directories listed at once. */
const LIST_BATCH = 16
const TRANSCRIPT_EXT = '.jsonl'

function remember<V>(map: Map<string, V>, id: string, value: V): void {
  map.delete(id)
  map.set(id, value)
  if (map.size > MAX_REMEMBERED) map.delete(map.keys().next().value as string)
}

export function createTranscriptLocator(deps: LocatorDeps): TranscriptLocator {
  const found = new Map<string, string>()
  /** id → when the lookup that found nothing ran. */
  const missing = new Map<string, number>()
  /** id → the slug that holds its transcript, as of `indexedAt`. */
  let index = new Map<string, string>()
  let indexedAt = -Infinity
  /** Whether every listing of the last build succeeded: only then is an absent id really absent. */
  let indexComplete = false
  let building: Promise<void> | null = null

  async function build(): Promise<void> {
    const next = new Map<string, string>()
    let complete = true
    try {
      const slugs = await deps.fs.readdir(deps.root)
      for (let i = 0; i < slugs.length; i += LIST_BATCH) {
        await Promise.all(
          slugs.slice(i, i + LIST_BATCH).map(async (slug) => {
            try {
              for (const name of await deps.fs.readdir(path.join(deps.root, slug))) {
                if (name.endsWith(TRANSCRIPT_EXT)) {
                  next.set(name.slice(0, -TRANSCRIPT_EXT.length), slug)
                }
              }
            } catch (e) {
              // Not a directory, or gone since the listing, is fine: any other error means this
              // slug may hold transcripts the index does not know about.
              const code = (e as NodeJS.ErrnoException)?.code
              if (code !== 'ENOTDIR' && code !== 'ENOENT') complete = false
            }
          })
        )
      }
    } catch {
      /* no projects directory: an empty index, and nothing is known to be absent */
      complete = false
    }
    index = next
    indexComplete = complete
    indexedAt = deps.now()
    // A transcript that appeared since a miss is no longer missing.
    for (const id of [...missing.keys()]) if (next.has(id)) missing.delete(id)
  }

  /** Whether the index is no older than the minimum, rebuilding it when it is. */
  async function refresh(): Promise<void> {
    if (building) return building
    if (deps.now() - indexedAt < REINDEX_MIN_MS) return
    building = build().finally(() => {
      building = null
    })
    return building
  }

  async function lookup(sessionId: string): Promise<TranscriptLookup> {
    const known = found.get(sessionId)
    if (known !== undefined) return { state: 'found', path: known }
    const missedAt = missing.get(sessionId)
    if (missedAt !== undefined) {
      if (deps.now() - missedAt < MISSING_TTL_MS) return { state: 'missing' }
      missing.delete(sessionId)
    }
    await refresh()
    const slug = index.get(sessionId)
    if (slug === undefined) {
      // Remembered as missing only when the whole tree was read: an unknown is asked again.
      if (!indexComplete) return { state: 'unknown' }
      remember(missing, sessionId, deps.now())
      return { state: 'missing' }
    }
    const file = path.join(deps.root, slug, `${sessionId}${TRANSCRIPT_EXT}`)
    remember(found, sessionId, file)
    return { state: 'found', path: file }
  }

  return {
    async locate(sessionId) {
      const r = await lookup(sessionId)
      return r.state === 'found' ? r.path : null
    },
    lookup,
    note(sessionId, transcriptPath) {
      if (!transcriptPath || !path.isAbsolute(transcriptPath)) return
      if (!transcriptPath.endsWith(TRANSCRIPT_EXT)) return
      missing.delete(sessionId)
      remember(found, sessionId, transcriptPath)
    }
  }
}
