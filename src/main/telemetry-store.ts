import { readFile, writeFile } from 'node:fs/promises'
import { writeFileSync } from 'node:fs'
import {
  foldFleetTelemetry,
  TELEMETRY_TTL_MS,
  type FleetTelemetry,
  type SessionTelemetry
} from './statusline-parse'
import { captureFleet as captureFleetToHistory } from './usage-history'
import { compose, mergePart, type CompanionPart } from './telemetry-compose-core'

/**
 * The neutral per-session telemetry store (T389 P1W6 §7.3). Two writers feed it: the statusLine
 * blob (`ingestStatusline`) and the companion mod's readings (`ingestCompanion`). The pure
 * composition (`telemetry-compose-core.ts`) decides which writer owns which field; this shell
 * keeps the maps, the cache, the debounced renderer push, and runs one **commit** per accepted
 * write: compose, set, persist, feed usage history, emit.
 *
 * `captureFleet` is in the commit and not in a writer, so usage history is fed whichever source
 * wrote (R14). This module imports nothing from `src/main/companion` and nothing that edits
 * `~/.claude/settings.json`: the statusLine's install, self-heal and exit cleanup cannot depend
 * on companion state (lesson framework/005). The companion adapter calls in, never the reverse.
 */

export interface TelemetryPayload {
  perSession: SessionTelemetry[]
  fleet: FleetTelemetry
}

export interface TelemetryStoreDeps {
  now(): number
  /** Usage history's capture (issue #19); fire-and-forget, it swallows its own errors. */
  captureFleet(fleet: FleetTelemetry, now: number): void | Promise<void>
  /** Where the composed map is persisted; `null` for none. */
  cachePath(): string | null
  /** The debounced push to the renderer. */
  send(payload: TelemetryPayload): void
}

export interface TelemetryStore {
  ingestStatusline(t: SessionTelemetry): void
  /**
   * One companion reading (`part` holds only the groups it carried). `owned` is the arbiter's
   * answer for the `telemetry` family now: not owned drops whatever the companion held for the
   * session, so the statusLine record passes through untouched.
   */
  ingestCompanion(sid: string, part: CompanionPart, owned: boolean): void
  /** Lease loss, session end, kill switch: every group returns to the statusLine at once. */
  dropCompanion(sid: string): void
  getTelemetryPayload(): TelemetryPayload
  /** The last `context.tokens` a session reported, or null. */
  lastContextTokens(sid: string): number | null
  /** Sessions the companion currently writes for. */
  companionSids(): string[]
  /** Raw statusLine blobs, for the parity ledger. Returns the unsubscribe. */
  onStatusline(fn: (t: SessionTelemetry) => void): () => void
  hydrate(): Promise<void>
  flushSync(): void
  close(): void
}

const DEBOUNCE_MS = 150
/** Debounce for persisting the telemetry map to disk (survives app restarts). */
const CACHE_WRITE_MS = 1_000

export function createTelemetryStore(deps: TelemetryStoreDeps): TelemetryStore {
  /** What `getTelemetryPayload` serves: the composed record per session. */
  const telemetry = new Map<string, SessionTelemetry>()
  /** The statusLine's own record per session (or the last restored one after a restart). */
  const statusline = new Map<string, SessionTelemetry>()
  /** What the companion holds for sessions it owns; presence means "owned". */
  const parts = new Map<string, CompanionPart>()
  const tokens = new Map<string, number>()
  const statuslineListeners = new Set<(t: SessionTelemetry) => void>()
  let debounceTimer: ReturnType<typeof setTimeout> | null = null
  let cacheTimer: ReturnType<typeof setTimeout> | null = null

  const payload = (): TelemetryPayload => ({
    perSession: [...telemetry.values()],
    fleet: foldFleetTelemetry(telemetry, deps.now())
  })

  const serialize = (): string => JSON.stringify([...telemetry.values()])

  function scheduleCacheWrite(): void {
    if (cacheTimer) clearTimeout(cacheTimer)
    cacheTimer = setTimeout(() => {
      cacheTimer = null
      const path = deps.cachePath()
      if (path) void writeFile(path, serialize(), 'utf8').catch(() => {})
    }, CACHE_WRITE_MS)
  }

  function scheduleEmit(): void {
    if (debounceTimer) clearTimeout(debounceTimer)
    debounceTimer = setTimeout(() => {
      debounceTimer = null
      try {
        deps.send(payload())
      } catch {
        // the renderer may be gone: it pulls the payload again at store init
      }
    }, DEBOUNCE_MS)
  }

  /** compose → set → persist → feed usage history → emit. */
  function commit(sid: string): void {
    const composed = compose(
      statusline.get(sid) ?? null,
      parts.get(sid) ?? null,
      parts.has(sid),
      sid
    )
    if (composed) telemetry.set(sid, composed)
    else telemetry.delete(sid)
    scheduleCacheWrite()
    // Fire-and-forget and fail-safe: the capture layer swallows its own errors, so it can never
    // block or break either writer.
    const now = deps.now()
    try {
      void Promise.resolve(deps.captureFleet(foldFleetTelemetry(telemetry, now), now)).catch(
        () => {}
      )
    } catch {
      // history is evidence, never a dependency of the footer
    }
    scheduleEmit()
  }

  return {
    ingestStatusline(t) {
      statusline.set(t.sessionId, t)
      for (const fn of [...statuslineListeners]) {
        try {
          fn(t)
        } catch {
          // a listener's failure never stops the ingest
        }
      }
      commit(t.sessionId)
    },

    ingestCompanion(sid, part, owned) {
      if (part.context?.tokens !== undefined) tokens.set(sid, part.context.tokens)
      if (!owned) {
        // Shadow, no lease, unproven: the statusLine record passes through untouched.
        if (parts.delete(sid)) commit(sid)
        return
      }
      parts.set(sid, mergePart(parts.get(sid) ?? null, part))
      commit(sid)
    },

    dropCompanion(sid) {
      tokens.delete(sid)
      if (parts.delete(sid)) commit(sid)
    },

    getTelemetryPayload: payload,
    lastContextTokens: (sid) => tokens.get(sid) ?? null,
    companionSids: () => [...parts.keys()],

    onStatusline(fn) {
      statuslineListeners.add(fn)
      return () => void statuslineListeners.delete(fn)
    },

    /**
     * Seed the maps from the persisted cache (TTL-filtered). Without this every restart blanked
     * the per-session HUD until each session's NEXT turn. A restored record stands in for the
     * statusLine's, so a lease loss falls back to the last known values; the companion groups
     * re-prove after the re-hello.
     */
    async hydrate() {
      const path = deps.cachePath()
      if (!path) return
      try {
        const arr: unknown = JSON.parse(await readFile(path, 'utf8'))
        if (!Array.isArray(arr)) return
        const now = deps.now()
        for (const entry of arr) {
          if (!entry || typeof entry !== 'object') continue
          const t = entry as SessionTelemetry
          if (typeof t.sessionId !== 'string' || typeof t.updatedAtMs !== 'number') continue
          if (now - t.updatedAtMs > TELEMETRY_TTL_MS) continue
          telemetry.set(t.sessionId, t)
          statusline.set(t.sessionId, t)
        }
      } catch {
        /* no/unreadable cache — cold start */
      }
    },

    flushSync() {
      if (cacheTimer) {
        clearTimeout(cacheTimer)
        cacheTimer = null
      }
      const path = deps.cachePath()
      if (!path) return
      try {
        writeFileSync(path, serialize(), 'utf8')
      } catch {
        /* best-effort cache */
      }
    },

    close() {
      if (debounceTimer) clearTimeout(debounceTimer)
      debounceTimer = null
      if (cacheTimer) clearTimeout(cacheTimer)
      cacheTimer = null
    }
  }
}

// ---- The app's one store -------------------------------------------------------------------

const config: Pick<TelemetryStoreDeps, 'cachePath' | 'send'> = {
  cachePath: () => null,
  send: () => {}
}

const store = createTelemetryStore({
  now: () => Date.now(),
  captureFleet: (fleet, now) => captureFleetToHistory(fleet, now),
  cachePath: () => config.cachePath(),
  send: (p) => config.send(p)
})

/** Called once by `statusline.ts`, which owns the Electron side (the userData path, the window). */
export function configureTelemetryStore(c: Pick<TelemetryStoreDeps, 'cachePath' | 'send'>): void {
  config.cachePath = c.cachePath
  config.send = c.send
}

export const telemetryStore = (): TelemetryStore => store
export const ingestStatusline: TelemetryStore['ingestStatusline'] = (t) => store.ingestStatusline(t)
export const ingestCompanion: TelemetryStore['ingestCompanion'] = (sid, part, owned) =>
  store.ingestCompanion(sid, part, owned)
export const dropCompanion: TelemetryStore['dropCompanion'] = (sid) => store.dropCompanion(sid)
export const getTelemetryPayload: TelemetryStore['getTelemetryPayload'] = () =>
  store.getTelemetryPayload()
export const lastContextTokens: TelemetryStore['lastContextTokens'] = (sid) =>
  store.lastContextTokens(sid)
