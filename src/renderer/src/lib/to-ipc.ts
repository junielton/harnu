import { toRaw } from 'vue'

/**
 * A deep, plain copy of `value`, safe to hand to `window.api`.
 *
 * Every `window.api.*` call is an `ipcRenderer.invoke`, so its arguments are structured-cloned on
 * the way to main. Anything a Pinia `ref` holds comes back as a deep reactive Proxy, and a Proxy is
 * not cloneable: the call dies in the renderer with "An object could not be cloned" and never
 * reaches main. A shallow spread (`{ ...prefs.value }`) does not help — the nested objects and
 * arrays stay reactive — so run any object or array argument built from store or component state
 * through this first (BUG-141 for containers; the same bug hit Cleanup's Clean and Enable autopilot).
 *
 * Payloads are plain data by construction (ids, flags, names, numbers), so rebuilding them is
 * lossless. Maps, Sets and class instances are not supported: send them as arrays or objects.
 */
export function toIpc<T>(value: T): T {
  const raw = toRaw(value)
  if (Array.isArray(raw)) return raw.map(toIpc) as T
  if (raw === null || typeof raw !== 'object') return raw
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) out[k] = toIpc(v)
  return out as T
}
