/**
 * Recent sites (browser-tabs spec S-5): the start page's only kept history. A per-folder list in the app's user data
 * (`browser-recent.json`): origin + path (query and fragment dropped) + title, newest first, deduped by origin + path,
 * at most {@link RECENT_STORED} stored and {@link RECENT_SHOWN} shown. Pure (ADR-0001) apart from the small store,
 * which takes its file as injected `io`.
 *
 * To keep secrets out of it, a path segment that looks like a token (20 or more letters, digits, `-` or `_`) is
 * replaced by `…`, and a navigation whose path contains `reset`, `token`, `oauth`, `callback`, `verify` or `magic` (in
 * any case) is not recorded. Agent tabs, in-page (`pushState`) navigations and anything that is not http(s) (`about:`,
 * `harnu-page:`, error pages) are never recorded.
 */

export const RECENT_STORED = 50
export const RECENT_SHOWN = 8

/** A path segment this long, made only of these characters, reads as a token. */
const TOKEN_SEGMENT = /^[A-Za-z0-9_-]{20,}$/
/** Paths of an auth flow: not recorded at all. */
const AUTH_PATH = /reset|token|oauth|callback|verify|magic/i

export interface RecentEntry {
  /** Origin + path, query and fragment dropped, token-like segments masked. */
  url: string
  title: string
  /** `host` of the URL (port included), what a tile shows under the title. */
  host: string
  /** Epoch ms of the latest visit. */
  at: number
}

/** A main-frame navigation of a tab, as the view host reports it. */
export interface Visit {
  url: string
  title: string
  /** The main-frame HTTP status; only 2xx and 3xx are kept. */
  status: number
  openedBy: 'operator' | 'agent'
  /** An in-page (`pushState`, hash) navigation: never recorded. */
  inPage?: boolean
}

/** The address a visit is stored and deduped under, or null when it is not to be recorded. */
function keyOf(rawUrl: string): { url: string; host: string } | null {
  let u: URL
  try {
    u = new URL(rawUrl)
  } catch {
    return null
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
  if (AUTH_PATH.test(safeDecode(u.pathname))) return null
  const path = u.pathname
    .split('/')
    .map((seg) => (TOKEN_SEGMENT.test(seg) ? '…' : seg))
    .join('/')
  return { url: `${u.origin}${path}`, host: u.host }
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s)
  } catch {
    return s
  }
}

/** The list after `visit`: unchanged when it is not recorded, else the visit first, deduped and capped. */
export function recordVisit(
  entries: readonly RecentEntry[],
  visit: Visit,
  at: number
): RecentEntry[] {
  if (visit.openedBy !== 'operator' || visit.inPage === true) return [...entries]
  if (visit.status < 200 || visit.status > 399) return [...entries]
  const key = keyOf(visit.url)
  if (key === null) return [...entries]
  const entry: RecentEntry = {
    url: key.url,
    title: visit.title.trim() || key.host,
    host: key.host,
    at
  }
  return [entry, ...entries.filter((e) => e.url !== key.url)].slice(0, RECENT_STORED)
}

/** The list with the title of the entry for `url` replaced (a page's title often arrives after its commit). */
export function withTitle(
  entries: readonly RecentEntry[],
  url: string,
  title: string
): RecentEntry[] {
  const key = keyOf(url)
  const next = title.trim()
  if (key === null || next === '') return [...entries]
  return entries.map((e) => (e.url === key.url ? { ...e, title: next } : e))
}

/** What the start page shows: the newest {@link RECENT_SHOWN}. */
export function topRecent(entries: readonly RecentEntry[]): RecentEntry[] {
  return entries.slice(0, RECENT_SHOWN)
}

/** The file behind the store: its text, or null when there is none yet. */
export interface RecentIo {
  read(): Promise<string | null>
  write(text: string): Promise<void>
}

export interface RecentStore {
  record(folder: string, visit: Visit): Promise<void>
  setTitle(folder: string, url: string, title: string): Promise<void>
  /** The folder's stored entries, newest first (all {@link RECENT_STORED}; {@link topRecent} cuts what is shown). */
  list(folder: string): Promise<RecentEntry[]>
}

function isEntry(v: unknown): v is RecentEntry {
  if (typeof v !== 'object' || v === null) return false
  const e = v as Record<string, unknown>
  return (
    typeof e.url === 'string' &&
    typeof e.title === 'string' &&
    typeof e.host === 'string' &&
    typeof e.at === 'number'
  )
}

/** A store over `io`. Reads the file once, writes after each change; a corrupt file reads as empty. */
export function createRecentStore(deps: { io: RecentIo; now(): number }): RecentStore {
  let loaded: Map<string, RecentEntry[]> | null = null
  let chain: Promise<unknown> = Promise.resolve()

  const load = async (): Promise<Map<string, RecentEntry[]>> => {
    if (loaded) return loaded
    const map = new Map<string, RecentEntry[]>()
    try {
      const parsed = JSON.parse((await deps.io.read()) ?? 'null') as { byFolder?: unknown } | null
      const byFolder = parsed?.byFolder
      if (typeof byFolder === 'object' && byFolder !== null) {
        for (const [folder, list] of Object.entries(byFolder)) {
          if (Array.isArray(list)) map.set(folder, list.filter(isEntry).slice(0, RECENT_STORED))
        }
      }
    } catch {
      // Unreadable or corrupt: start empty; the next change replaces the file.
    }
    loaded = map
    return map
  }

  const save = async (map: Map<string, RecentEntry[]>): Promise<void> => {
    await deps.io.write(JSON.stringify({ byFolder: Object.fromEntries(map) }))
  }

  // Every change runs after the one before it, so two navigations never interleave their read-modify-write.
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = chain.then(fn, fn)
    chain = run.catch(() => undefined)
    return run
  }

  return {
    record: (folder, visit) =>
      serial(async () => {
        const map = await load()
        const before = map.get(folder) ?? []
        const after = recordVisit(before, visit, deps.now())
        if (after.length === before.length && after[0] === before[0]) return
        map.set(folder, after)
        await save(map)
      }),
    setTitle: (folder, url, title) =>
      serial(async () => {
        const map = await load()
        const before = map.get(folder) ?? []
        const after = withTitle(before, url, title)
        if (JSON.stringify(after) === JSON.stringify(before)) return
        map.set(folder, after)
        await save(map)
      }),
    list: (folder) => serial(async () => [...((await load()).get(folder) ?? [])])
  }
}
