import { app } from 'electron'
import { join, dirname } from 'node:path'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { DEFAULT_POLICY, type Policy } from '../fleet-policy'
import { DEFAULT_NEGOTIATION } from '../park-negotiation-core'

/**
 * Persisted hibernation policy (T127) — backs `monitor:policyGet`/`monitor:policySet`.
 * Mirrors `settings.ts`'s read-modify-write-json shape, scoped to just the three
 * `Policy` fields.
 *
 * `pty.ts`'s `runPolicy()` calls `getPolicy()` on every cap/sweep check (T127 S4),
 * so an edit made in the Settings tab takes effect on the very next check — no
 * restart, no rebuild.
 *
 * T456 (spec §9.1): the three negotiation bounds live in the same file beside the policy fields,
 * clamped the same way, and are read by the park coordinator on every decision. No UI edits them
 * yet (W3); a policy edit keeps whatever the file holds.
 */

/** The operator's bounds on a negotiated park (spec §6.2). */
export interface NegotiationBounds {
  /** Questions per cold episode before the park goes ahead anyway. */
  maxDeclines: number
  /** Longest hold past the first decline, in ms. */
  maxDeferMs: number
  /** Below this MemAvailable (MB), a session is parked without being asked. */
  pressureFloorMb: number
}

const DEFAULT_BOUNDS: NegotiationBounds = {
  maxDeclines: DEFAULT_NEGOTIATION.maxDeclines,
  maxDeferMs: DEFAULT_NEGOTIATION.maxDeferMs,
  pressureFloorMb: DEFAULT_NEGOTIATION.pressureFloorMb
}
const MIN_MAX_DECLINES = 1
const MAX_MAX_DECLINES = 100
const MAX_DEFER_MS = 24 * 60 * 60_000

const MIN_MAX_LIVE = 1
const MAX_MAX_LIVE = 50
const MIN_IDLE_MS = 0

function policyPath(): string {
  return join(app.getPath('userData'), 'monitor-policy.json')
}

let cached: Policy | null = null
let cachedBounds: NegotiationBounds | null = null

/** Clamp/round a patch's known keys onto `base`; unknown/invalid keys are dropped. */
function applyPatch(patch: Partial<Policy>, base: Policy): Policy {
  const out = { ...base }
  if (typeof patch.maxLive === 'number' && Number.isFinite(patch.maxLive)) {
    out.maxLive = Math.min(MAX_MAX_LIVE, Math.max(MIN_MAX_LIVE, Math.round(patch.maxLive)))
  }
  if (typeof patch.lruIdleMs === 'number' && Number.isFinite(patch.lruIdleMs)) {
    out.lruIdleMs = Math.max(MIN_IDLE_MS, Math.round(patch.lruIdleMs))
  }
  if (typeof patch.hardIdleMs === 'number' && Number.isFinite(patch.hardIdleMs)) {
    out.hardIdleMs = Math.max(MIN_IDLE_MS, Math.round(patch.hardIdleMs))
  }
  return out
}

/** Clamp/round the bounds' known keys onto `base`, like {@link applyPatch}. */
function applyBoundsPatch(
  patch: Partial<NegotiationBounds>,
  base: NegotiationBounds
): NegotiationBounds {
  const out = { ...base }
  const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
  if (num(patch.maxDeclines)) {
    out.maxDeclines = Math.min(
      MAX_MAX_DECLINES,
      Math.max(MIN_MAX_DECLINES, Math.round(patch.maxDeclines))
    )
  }
  if (num(patch.maxDeferMs)) {
    out.maxDeferMs = Math.min(MAX_DEFER_MS, Math.max(0, Math.round(patch.maxDeferMs)))
  }
  if (num(patch.pressureFloorMb)) {
    out.pressureFloorMb = Math.max(0, Math.round(patch.pressureFloorMb))
  }
  return out
}

function load(): Policy {
  if (cached) return cached
  try {
    const raw = JSON.parse(readFileSync(policyPath(), 'utf8')) as Partial<Policy> &
      Partial<NegotiationBounds>
    cached = applyPatch(raw, DEFAULT_POLICY)
    cachedBounds = applyBoundsPatch(raw, DEFAULT_BOUNDS)
  } catch {
    // Missing or invalid file — fall back to defaults. Never throws: a corrupt
    // policy file must not block the app from starting.
    cached = { ...DEFAULT_POLICY }
    cachedBounds = { ...DEFAULT_BOUNDS }
  }
  return cached
}

function persist(policy: Policy): void {
  try {
    mkdirSync(dirname(policyPath()), { recursive: true })
    const file = { ...policy, ...(cachedBounds ?? DEFAULT_BOUNDS) }
    writeFileSync(policyPath(), JSON.stringify(file, null, 2) + '\n', 'utf8')
  } catch {
    // Best-effort — the in-memory value still applies for the rest of this run.
  }
}

export function getPolicy(): Policy {
  return load()
}

export function setPolicy(patch: Partial<Policy>): Policy {
  const next = applyPatch(patch, load())
  cached = next
  persist(next)
  return next
}

/** T456: the negotiation bounds, read on every park decision (cached with the policy, so a hand edit of the file applies after a restart). */
export function getNegotiationBounds(): NegotiationBounds {
  load()
  return { ...(cachedBounds ?? DEFAULT_BOUNDS) }
}
