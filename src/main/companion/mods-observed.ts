/**
 * The live mod observation (T389 P4W1 part B, spec §7.6, contract §8 `mod.admitted`, §11.1
 * `sense.mods`, §11.5 key `modsLive`). Electron-free: the host facade is injected, so every rule
 * here is tested against the real host core.
 *
 * What it keeps: the last `mod.admitted` per (binding, root) and the order they arrived in, for a
 * binding whose lease is live and whose `enable` still holds `sense.mods`. Memory only, no
 * ledger, no audit row: a `root` is host-side data (contract §8). What it never does: refuse,
 * gate or change anything about another mod.
 *
 * Observations die with the binding's eligibility: a lost lease, an end, a re-key (`/clear`), a
 * revoked conn (the kill switch empties `enabled`) all drop them at once, with no TTL wait.
 */

import { normalizeFolder } from './arbitration-core'
import { prefsKey, registerPrefsKey } from './companion-prefs'
import type { Sid } from './contract'
import { registerFeaturePolicy } from './feature-policy'
import type { CompanionHostFacade } from './host-core'
import { getCompanionMode } from './mode'
import {
  createObservationStore,
  type ObservedMod,
  type ObservationStore
} from './mods-observed-core'
import type { BindingView } from './session-table'

export interface ObservedSession {
  sid: Sid
  /** Harnu's row key for the session, when the PTY owner resolves to one. */
  sessionKey: string | null
  cwd: string
  /** Epoch ms of the newest report of the session. */
  lastAt: number
  mods: ObservedMod[]
}

export interface ModsObserved {
  /** Sessions with a live lease that reported admissions; `null` folder: all of them. */
  sessions(folder: string | null): ObservedSession[]
  /** The arrival order of one session's admissions, for the load-order evidence (master Q3). */
  loadOrder(sid: Sid): ObservedMod[]
  /** How many bindings hold reports in memory (diagnostics, and the tests of "dropped at once"). */
  held(): number
  dispose(): void
}

export interface ModsObservedDeps {
  host: Pick<CompanionHostFacade, 'bus' | 'onBindingChange' | 'markProven' | 'registerEventTypes'>
  /** Epoch ms for a report's time. Default `Date.now()`. */
  epochNow?(): number
}

const FEATURE = 'sense.mods'

/** The three things `sense.mods` needs besides a live lease (contract §11.5). */
function registerKeyAndPolicy(): void {
  registerPrefsKey<boolean>('modsLive', {
    default: false,
    parse: (raw) => raw === true,
    // A CLI above the tested ceiling caps the key at off: no hook step runs (§11.5).
    observeCap: false
  })
  registerFeaturePolicy(
    FEATURE,
    () => prefsKey<boolean>('modsLive') && getCompanionMode() !== 'off'
  )
}

/** A binding whose reports may be shown: bound, lease live, and still enabled for the feature. */
const eligible = (b: BindingView): boolean =>
  b.state === 'bound' && b.lease === 'live' && b.enabled.includes(FEATURE)

export function registerModsObserved(deps: ModsObservedDeps): ModsObserved {
  const epochNow = deps.epochNow ?? ((): number => Date.now())
  const store: ObservationStore = createObservationStore()
  const views = new Map<number, BindingView>()

  registerKeyAndPolicy()
  // The server delivers only event types a wave registered (contract §8).
  deps.host.registerEventTypes(['mod.admitted'])

  /** Remembers the newest view of a binding and drops what it no longer qualifies to show. */
  function reconcile(b: BindingView): void {
    views.set(b.key, b)
    if (!eligible(b)) store.drop(b.key)
    if (b.state !== 'bound') views.delete(b.key)
  }

  const offs = [
    deps.host.bus.on('hello', reconcile),
    deps.host.bus.on('lease', reconcile),
    deps.host.bus.on('end', reconcile),
    deps.host.bus.on('event', (b, ev) => {
      views.set(b.key, b)
      if (ev.t === 'session.rebound') {
        store.drop(b.key) // a /clear or a resume: the mod announced them to the old session
        return
      }
      if (ev.t !== 'mod.admitted' || !eligible(b)) return
      if (store.record(b.key, ev.d, epochNow()) && !b.proven.includes(FEATURE)) {
        deps.host.markProven(b, FEATURE) // contract §11.2: the first event of the feature
      }
    }),
    deps.host.onBindingChange(reconcile)
  ]

  function sessions(folder: string | null): ObservedSession[] {
    const want = folder === null || folder === '' ? null : normalizeFolder(folder)
    const out: ObservedSession[] = []
    for (const key of store.bindings()) {
      const b = views.get(key)
      if (!b || !eligible(b)) continue
      if (want !== null && normalizeFolder(b.cwd) !== want) continue
      const mods = store.mods(key)
      if (mods.length === 0) continue
      out.push({
        sid: b.sid,
        sessionKey: b.sessionKey,
        cwd: b.cwd,
        lastAt: Math.max(...mods.map((m) => m.at)),
        mods
      })
    }
    return out
  }

  return {
    sessions,
    loadOrder: (sid) => sessions(null).find((s) => s.sid === sid)?.mods ?? [],
    held: () => store.bindings().length,
    dispose() {
      for (const off of offs) off()
      store.dropAll()
      views.clear()
    }
  }
}
