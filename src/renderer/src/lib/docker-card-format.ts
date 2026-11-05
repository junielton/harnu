// Time spans on the Docker card (U3.7), pure: the card words them with `cleanup.gc.docker.age.*`.

const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR

/** The largest whole unit: days from 24 h, hours from an hour, minutes below (never less than 1). */
export function ageParts(ms: number): { n: number; unit: 'min' | 'h' | 'd' } {
  if (ms >= DAY) return { n: Math.floor(ms / DAY), unit: 'd' }
  if (ms >= HOUR) return { n: Math.floor(ms / HOUR), unit: 'h' }
  return { n: Math.max(1, Math.floor(ms / MIN)), unit: 'min' }
}
