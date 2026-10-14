/**
 * `<userData>/companion/lineage.json` (T455 spec §6.3 step 2): where a session came from, kept past
 * its PTY, a park and a restart. A `PtyRec` dies on every exit and a claim with its binding, so the
 * first time a bound conversation's lineage names ANOTHER session (a fork, or an in-session
 * `/resume` or `/clear` with the sid it left) the identity adapter records it here.
 *
 * Ids only: `{ sid, kind, from, at }`, every id checked against the session-id shape, no text and
 * no path. At most 10,000 entries, the oldest dropped. Written whole and atomically (a temp file,
 * then a rename), mode 0600, like `endpoint.json`. A torn or foreign file reads as empty and is
 * replaced by the next write.
 *
 * Reading it into the model's `forkedFrom` is W3 (`loadLineage`); nothing reads it in W2.
 */

import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { Lineage } from './identity-core'

export const LINEAGE_MAX_ENTRIES = 10_000

export interface LineageEntry {
  sid: string
  kind: Lineage['kind']
  from: string
  /** Epoch ms of the first bind with this lineage. */
  at: number
}

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/
const KINDS: ReadonlySet<string> = new Set(['new', 'resume', 'fork'])

function entryOf(raw: unknown): LineageEntry | null {
  if (typeof raw !== 'object' || raw === null) return null
  const e = raw as Record<string, unknown>
  if (typeof e.sid !== 'string' || !ID_RE.test(e.sid)) return null
  if (typeof e.from !== 'string' || !ID_RE.test(e.from) || e.from === e.sid) return null
  if (typeof e.kind !== 'string' || !KINDS.has(e.kind)) return null
  if (typeof e.at !== 'number' || !Number.isFinite(e.at)) return null
  return { sid: e.sid, kind: e.kind as LineageEntry['kind'], from: e.from, at: e.at }
}

/** The entries in file order (oldest first), one per sid (the later wins), trimmed to `max`. */
function parse(text: string, max: number): LineageEntry[] {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return []
  }
  const list = (raw as { v?: unknown; entries?: unknown } | null)?.entries
  if (!Array.isArray(list)) return []
  const bySid = new Map<string, LineageEntry>()
  for (const r of list) {
    const e = entryOf(r)
    if (!e) continue
    bySid.delete(e.sid) // re-insert, so the map keeps file order of the LAST write
    bySid.set(e.sid, e)
  }
  const all = [...bySid.values()]
  return all.length > max ? all.slice(all.length - max) : all
}

function read(path: string, max: number): LineageEntry[] {
  try {
    return parse(readFileSync(path, 'utf8'), max)
  } catch {
    return []
  }
}

/** Every recorded lineage by sid (W3 reads it into `forkedFrom`). A missing file is empty. */
export function loadLineage(
  path: string,
  max: number = LINEAGE_MAX_ENTRIES
): Map<string, LineageEntry> {
  return new Map(read(path, max).map((e) => [e.sid, e]))
}

export interface LineageStore {
  /** Records `sid`'s lineage when it names another session; false when nothing was written. */
  record(sid: string, lineage: Lineage): boolean
  lookup(sid: string): LineageEntry | null
  entries(): LineageEntry[]
}

export function createLineageStore(deps: {
  path: string
  now(): number
  /** Tests only; production keeps LINEAGE_MAX_ENTRIES. */
  maxEntries?: number
}): LineageStore {
  const max = deps.maxEntries ?? LINEAGE_MAX_ENTRIES
  let cache: LineageEntry[] | null = null
  const all = (): LineageEntry[] => (cache ??= read(deps.path, max))

  function write(list: LineageEntry[]): void {
    const tmp = `${deps.path}.${process.pid}.tmp`
    mkdirSync(dirname(deps.path), { recursive: true, mode: 0o700 })
    try {
      writeFileSync(tmp, JSON.stringify({ v: 1, entries: list }), { mode: 0o600 })
      chmodSync(tmp, 0o600) // the create mode is masked by the umask
      renameSync(tmp, deps.path)
    } catch (err) {
      rmSync(tmp, { force: true })
      throw err
    }
  }

  return {
    record(sid, lineage) {
      if (lineage.from === null) return false
      const e = entryOf({ sid, kind: lineage.kind, from: lineage.from, at: deps.now() })
      if (!e) return false
      const list = all()
      const prev = list.find((x) => x.sid === sid)
      if (prev && prev.kind === e.kind && prev.from === e.from) return false
      const next = list.filter((x) => x.sid !== sid)
      next.push(e)
      const trimmed = next.length > max ? next.slice(next.length - max) : next
      write(trimmed)
      cache = trimmed
      return true
    },
    lookup: (sid) => all().find((x) => x.sid === sid) ?? null,
    entries: () => [...all()]
  }
}
