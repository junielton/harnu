/**
 * The pure half of the live mod observation (T389 P4W1 part B, spec §7.6): the host-side check
 * of a `mod.admitted` payload and the in-memory store of what each binding reported. The payload
 * is the mod's word, so it is validated here with the mod's own mapper (one definition of the
 * shape and its bounds), and what it carries is kept per (binding, root), never persisted.
 */

import type { EventPayloads } from './contract'
import { toAdmitted } from '../../../resources/companion/hooks/lib/admitted'

export type ObservedAdmission = EventPayloads['mod.admitted']

/** One admitted module as the host keeps it: the report, its arrival rank and its time. */
export interface ObservedMod extends ObservedAdmission {
  /** 1-based rank in the order the modules were reported, the load order of master Q3. */
  order: number
  /** Epoch ms of the report. */
  at: number
}

/** A session loads a handful of mods; this only stops a runaway mod from growing the map. */
export const MAX_MODS_PER_BINDING = 256

/** `null` when the payload is not an admission. Unknown fields are dropped, lists are cut. */
export const parseAdmission = (d: unknown): ObservedAdmission | null => toAdmitted(d)

interface Held {
  seq: number
  at: number
  admission: ObservedAdmission
}

export interface ObservationStore {
  /** Keeps the report for (binding, root); `false` when it is not an admission or the cap is hit. */
  record(binding: number, d: unknown, at: number): boolean
  /** The reports of one binding in arrival order, ranked from 1. */
  mods(binding: number): ObservedMod[]
  /** The bindings that hold at least one report. */
  bindings(): number[]
  drop(binding: number): void
  dropAll(): void
}

export function createObservationStore(): ObservationStore {
  const held = new Map<number, Map<string, Held>>()
  let seq = 0
  return {
    record(binding, d, at) {
      const admission = parseAdmission(d)
      if (admission === null) return false
      let roots = held.get(binding)
      if (!roots) held.set(binding, (roots = new Map()))
      if (!roots.has(admission.root) && roots.size >= MAX_MODS_PER_BINDING) return false
      roots.set(admission.root, { seq: ++seq, at, admission })
      return true
    },
    mods(binding) {
      return [...(held.get(binding)?.values() ?? [])]
        .sort((a, b) => a.seq - b.seq)
        .map((h, i) => ({ ...h.admission, order: i + 1, at: h.at }))
    },
    bindings: () => [...held.keys()],
    drop: (binding) => void held.delete(binding),
    dropAll: () => held.clear()
  }
}
