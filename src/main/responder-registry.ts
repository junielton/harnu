import { app } from 'electron'
import { join, resolve, sep } from 'node:path'
import { homedir } from 'node:os'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import {
  gateAction,
  type GateAction,
  type RampScope,
  type Resolver,
  type ResponderMode
} from './responder-dispatch'

/**
 * Hook responder registry + mode prefs + shadow ring (spec §4.2). The thin shell
 * around the pure core: it holds the mutable resolver list, the persisted mode
 * (`<userData>/responder-prefs.json`, mirroring the hook-bridge opt-out), and the
 * in-memory shadow-decision ring the future Approval Inbox consumes.
 *
 * Importing ONLY types from `responder-dispatch` keeps the value-import edge
 * one-directional (`hook-bridge` → registry → dispatch types) — no cycle.
 */

/** A mutable registry of resolvers, sorted by priority on read. */
export class ResolverRegistry {
  private readonly resolvers = new Map<string, Resolver>()

  /** Register a resolver; returns an unregister for exactly this one. */
  register(r: Resolver): () => void {
    this.resolvers.set(r.id, r)
    return () => this.unregister(r.id)
  }

  unregister(id: string): void {
    this.resolvers.delete(id)
  }

  /** Sorted by priority asc, stable by id on ties. */
  list(): readonly Resolver[] {
    return [...this.resolvers.values()].sort(
      (a, b) => a.priority - b.priority || a.id.localeCompare(b.id)
    )
  }
}

export const responderRegistry = new ResolverRegistry()

/** Zero-risk demonstration resolver (always abstains). Registered in v1. */
export const echoNoopResolver: Resolver = { id: 'noop', priority: 1000, resolve: () => null }

function prefsPath(): string {
  return join(app.getPath('userData'), 'responder-prefs.json')
}

const MODES: readonly ResponderMode[] = ['off', 'shadow', 'active']

/**
 * Persisted mode. Default `shadow` (the confidence ramp): no file, invalid JSON,
 * or an out-of-enum value all degrade to `shadow` — never throws, mirroring
 * `readEnabled` in hook-bridge.
 */
// In-memory mirror of the persisted mode. Synchronous source of truth for
// resolvers (e.g. the Approval Inbox parks only in `active`) and the dispatch
// branch — set by readMode() on boot and writeMode() on change.
let inMemoryMode: ResponderMode = 'shadow'

/**
 * T30 trust-ramp scope — the synchronous source of truth the Approval Inbox
 * resolver reads (alongside {@link getMode}). `inMemoryTrustAll` (persisted in
 * `responder-prefs.json`) is the fleet-active escape hatch; `interceptFolders`
 * (hydrated from `projects.json` `interceptActive` via {@link setInterceptFolders})
 * is the per-folder ramp, keyed by a normalized absolute path. Both default
 * fail-safe: trustAll `false`, empty ramp → nothing parked until explicitly
 * widened.
 */
let inMemoryTrustAll = false
let interceptFolders = new Set<string>()

/** Normalize a folder path for the ramp set + cwd matching (sync — expand `~`,
 *  absolutize + collapse `.`/`..`, strip a trailing separator). No `realpath`
 *  (the resolver's abstain path stays synchronous); a symlink divergence falls
 *  to the fail-safe off-ramp preview. */
function normalizeFolder(input: string): string {
  const expanded = input.startsWith('~') ? join(homedir(), input.slice(1)) : input
  const abs = resolve(expanded)
  return abs.length > 1 && abs.endsWith(sep) ? abs.slice(0, -1) : abs
}

/** Synchronous current mode (mirrors the persisted file). */
export function getMode(): ResponderMode {
  return inMemoryMode
}

/** Whether the fleet-active "Trust all folders" escape hatch is on (T30). */
export function getTrustAll(): boolean {
  return inMemoryTrustAll
}

/** The synchronous trust-ramp scope the Approval Inbox gate decides against (T30). */
export function getScope(): RampScope {
  return { mode: inMemoryMode, trustAll: inMemoryTrustAll, interceptFolders }
}

/** Replace the per-folder ramp set (from `projects.json` `interceptActive`),
 *  normalizing each path so it matches a normalized hook cwd. */
export function setInterceptFolders(paths: readonly string[]): void {
  interceptFolders = new Set(paths.map(normalizeFolder))
}

/**
 * Decide the Approval Inbox action for a hook event (T30). Normalizes the raw
 * hook `cwd` with the SAME `normalizeFolder` the ramp set uses (so they match),
 * then defers to the pure {@link gateAction}. A missing/blank cwd → `null` folder
 * → fail-safe off-ramp (`preview`, never `park`).
 */
export function rampActionFor(rawCwd: unknown, isGatedEvent: boolean): GateAction {
  const folder = typeof rawCwd === 'string' && rawCwd.length > 0 ? normalizeFolder(rawCwd) : null
  return gateAction(getScope(), isGatedEvent, folder)
}

export async function readMode(): Promise<ResponderMode> {
  try {
    const p = JSON.parse(await readFile(prefsPath(), 'utf8'))
    const mode = p?.mode
    inMemoryMode = MODES.includes(mode) ? (mode as ResponderMode) : 'shadow'
    inMemoryTrustAll = p?.trustAll === true
  } catch {
    inMemoryMode = 'shadow'
    inMemoryTrustAll = false
  }
  return inMemoryMode
}

/** Persist the responder prefs ({ mode, trustAll }) from the in-memory mirror. */
async function writePrefs(): Promise<void> {
  await mkdir(app.getPath('userData'), { recursive: true })
  await writeFile(
    prefsPath(),
    JSON.stringify({ mode: inMemoryMode, trustAll: inMemoryTrustAll }, null, 2) + '\n',
    'utf8'
  )
}

export async function writeMode(mode: ResponderMode): Promise<void> {
  inMemoryMode = mode
  await writePrefs()
}

/** Persist the "Trust all folders" escape hatch (T30), preserving `mode`. */
export async function writeTrustAll(trustAll: boolean): Promise<void> {
  inMemoryTrustAll = trustAll
  await writePrefs()
}

/** A decision the shadow mode COMPUTED but did not apply (in-memory ring). */
export interface ShadowEntry {
  sessionId: string
  event: string
  by: string
  summary: string
  ts: number
}

export const SHADOW_LOG_MAX = 200

let ring: ShadowEntry[] = []

/** Append a shadow entry; drops the oldest once over SHADOW_LOG_MAX. */
export function pushShadowEntry(e: ShadowEntry): void {
  ring.push(e)
  if (ring.length > SHADOW_LOG_MAX) ring.shift()
}

/** A copy of the ring, most recent last. */
export function getShadowLog(): readonly ShadowEntry[] {
  return ring.slice()
}

export function clearShadowLog(): void {
  ring = []
}

/** Test-only: reset the ring + the shared registry (mirrors _resetHaikuState). */
export function _resetResponderState(): void {
  ring = []
  inMemoryMode = 'shadow'
  inMemoryTrustAll = false
  interceptFolders = new Set()
  for (const r of responderRegistry.list()) responderRegistry.unregister(r.id)
}
