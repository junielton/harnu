// Small pure formatters for the Cleanup summary line. They return a unit and a count; the component
// picks the translated, pluralised string, so no copy lives here.

export type DurationUnit = 'minute' | 'hour' | 'day'

export interface DurationParts {
  unit: DurationUnit
  n: number
}

const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR

/** "42 min", "3 h", "2 d": the coarsest unit that still reads as a whole number of at least 1. */
export function durationParts(ms: number): DurationParts {
  const v = Number.isFinite(ms) && ms > 0 ? ms : 0
  if (v >= DAY) return { unit: 'day', n: Math.round(v / DAY) }
  if (v >= HOUR) return { unit: 'hour', n: Math.round(v / HOUR) }
  return { unit: 'minute', n: Math.max(1, Math.round(v / MIN)) }
}

/** When the next cycle fires, or null when the background scan is off or the time already passed. */
export function nextCycleIn(nextCycleAt: number | null, now: number): DurationParts | null {
  if (nextCycleAt === null) return null
  return durationParts(Math.max(0, nextCycleAt - now))
}
