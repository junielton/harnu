import { PARK_MODES, parkModeNow } from '../park-coordinator'
import { setPrefsKey } from '../companion/companion-prefs'
import { getNegotiationBounds, setNegotiationBounds } from './policy-store'
import type { ParkSettings } from './types'

/**
 * T456 W3 (spec §9.1): the operator-facing half of "Ask before parking" — the `park` prefs key
 * (`off | facts | ask`) and the three bounds that live beside the policy fields in
 * `monitor-policy.json`. Backs `monitor:negotiationGet` / `monitor:negotiationSet`.
 *
 * The clamps are `policy-store.ts`'s (maxDeclines [1, 100], maxDeferMs [0, 24 h], floor >= 0); the
 * coordinator reads both on every decision, so an edit applies on the very next check.
 */

export function getNegotiationSettings(): ParkSettings {
  // `parkModeNow` is the EFFECTIVE mode: capped at `facts` above the tested CLI ceiling (ARB-7b).
  return { park: parkModeNow(), ...getNegotiationBounds() }
}

/** Unknown keys, non-finite numbers and a `park` outside the three modes are dropped. */
export function setNegotiationSettings(patch: Partial<ParkSettings>): ParkSettings {
  // The payload crosses IPC unvalidated: anything that is not a plain object is ignored.
  if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) {
    return getNegotiationSettings()
  }
  if (patch.park !== undefined && PARK_MODES.includes(patch.park)) {
    setPrefsKey('park', patch.park)
  }
  setNegotiationBounds(patch)
  return getNegotiationSettings()
}
