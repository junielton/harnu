/**
 * A model id as the footer names it. Pure and framework-free: the renderer (transcript fallback)
 * and main (the telemetry composition, T577) must agree on the wording, so both import this file.
 */

const MODEL_ID_RE = /^claude-(opus|sonnet|haiku|fable)-(\d+)(?:-(\d+))?/i

/** `claude-opus-4-8[1m]` → `Opus 4.8`. An id this does not recognise is shown as it is. */
export function prettyModelName(modelId: string): string {
  const m = MODEL_ID_RE.exec(modelId)
  if (!m) return modelId
  const family = m[1]!.charAt(0).toUpperCase() + m[1]!.slice(1).toLowerCase()
  return `${family} ${m[3] ? `${m[2]}.${m[3]}` : m[2]}`
}

/** `claude-opus-4-8[1m]` → `claude-opus-4-8`: the id without the context-window suffix. */
export const baseModelId = (modelId: string): string => modelId.replace(/\[[^\]]*\]$/, '')
