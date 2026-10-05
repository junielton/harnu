import { app } from 'electron'
import { join, dirname } from 'node:path'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { DEFAULT_POLICY, type Policy } from '../fleet-policy'

/**
 * Persisted hibernation policy (T127) — backs `monitor:policyGet`/`monitor:policySet`.
 * Mirrors `settings.ts`'s read-modify-write-json shape, scoped to just the three
 * `Policy` fields.
 *
 * `pty.ts`'s `runPolicy()` calls `getPolicy()` on every cap/sweep check (T127 S4),
 * so an edit made in the Settings tab takes effect on the very next check — no
 * restart, no rebuild.
 */

const MIN_MAX_LIVE = 1
const MAX_MAX_LIVE = 50
const MIN_IDLE_MS = 0

function policyPath(): string {
  return join(app.getPath('userData'), 'monitor-policy.json')
}

let cached: Policy | null = null

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

function load(): Policy {
  if (cached) return cached
  try {
    const raw = JSON.parse(readFileSync(policyPath(), 'utf8')) as Partial<Policy>
    cached = applyPatch(raw, DEFAULT_POLICY)
  } catch {
    // Missing or invalid file — fall back to defaults. Never throws: a corrupt
    // policy file must not block the app from starting.
    cached = { ...DEFAULT_POLICY }
  }
  return cached
}

function persist(policy: Policy): void {
  try {
    mkdirSync(dirname(policyPath()), { recursive: true })
    writeFileSync(policyPath(), JSON.stringify(policy, null, 2) + '\n', 'utf8')
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
