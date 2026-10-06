import type { EventPayloads } from '../contract'

/**
 * `$`-free mapping of a `plugin.register` input to the `mod.admitted` payload (contract §8,
 * P4W1 part B). The input is the engine's own, but the mapping is written as if it were not: a
 * shape it does not recognise is not an admission (the hook then just passes the event on), and
 * every list and string is bounded so one admission always fits a batch (BATCH_MAX_BYTES).
 */

export type Admitted = EventPayloads['mod.admitted']

/** At most this many entries per list of `uses`; the rest is dropped, never an error. */
export const USES_LIST_MAX = 100
const STR_MAX = 256
const ROOT_MAX = 1024
const TIERS: ReadonlySet<string> = new Set(['prepend', 'user', 'append', 'builtin'])

const isRec = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

const str = (v: unknown, max: number): string | null =>
  typeof v === 'string' && v.length > 0 && v.length <= max ? v : null

/** A list of strings; entries that are not short strings are skipped, the list is cut. */
function strings(v: unknown): string[] | null {
  if (v === undefined) return []
  if (!Array.isArray(v)) return null
  const out: string[] = []
  for (const item of v) {
    const s = str(item, STR_MAX)
    if (s !== null) out.push(s)
    if (out.length === USES_LIST_MAX) break
  }
  return out
}

function stateRefs(v: unknown): { plugin: string; key: string }[] | null {
  if (v === undefined) return []
  if (!Array.isArray(v)) return null
  const out: { plugin: string; key: string }[] = []
  for (const item of v) {
    if (!isRec(item)) continue
    const plugin = str(item.plugin, STR_MAX)
    const key = str(item.key, STR_MAX)
    if (plugin !== null && key !== null) out.push({ plugin, key })
    if (out.length === USES_LIST_MAX) break
  }
  return out
}

/** `null` when the input is not the shape of contract §8's `mod.admitted`. Never throws. */
export function toAdmitted(input: unknown): Admitted | null {
  try {
    if (!isRec(input)) return null
    const name = str(input.name, STR_MAX)
    const root = str(input.root, ROOT_MAX)
    const provenance = str(input.provenance, STR_MAX)
    const tier = typeof input.tier === 'string' && TIERS.has(input.tier) ? input.tier : null
    if (name === null || root === null || provenance === null || tier === null) return null
    if (!isRec(input.uses)) return null
    const uses = input.uses
    const events = strings(uses.events)
    const calls = strings(uses.calls)
    if (events === null || calls === null) return null
    const env = isRec(uses.env) ? uses.env : {}
    const state = isRec(uses.state) ? uses.state : {}
    const envReads = strings(env.reads)
    const envWrites = strings(env.writes)
    const stateReads = stateRefs(state.reads)
    const stateWrites = stateRefs(state.writes)
    if (envReads === null || envWrites === null || stateReads === null || stateWrites === null) {
      return null
    }
    const version = str(input.version, STR_MAX)
    return {
      name,
      tier: tier as Admitted['tier'],
      root,
      ...(version !== null ? { version } : {}),
      provenance,
      uses: {
        events,
        calls,
        env: { reads: envReads, writes: envWrites },
        state: { reads: stateReads, writes: stateWrites }
      }
    }
  } catch {
    return null
  }
}
