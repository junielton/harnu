/**
 * Every bound the bake-off loop applies: the Limits table of
 * `docs/specs/2026-11-07-bakeoff-harness/spec.md`. No other module holds one of
 * these numbers.
 *
 * `HARNU_BAKEOFF_TIMEOUT_SCALE` (test-only, a positive float, default 1) multiplies
 * the time limits and no count. It is read at each access, so a test can set it
 * after this module is loaded.
 */
const MINUTE = 60_000

function scale() {
  const parsed = Number.parseFloat(process.env.HARNU_BAKEOFF_TIMEOUT_SCALE ?? '')
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1
}

/** Scaled to a whole number of milliseconds, never 0: a 0 timeout would mean no time at all. */
const scaled = (minutes) => Math.max(1, Math.round(minutes * MINUTE * scale()))

export const limits = {
  operatorExchanges: 12,
  strayReplies: 3,
  retries: { noResult: 1, invalidJudgeReply: 1 },
  maxTurns: { contestant: 200, operator: 2, judge: 2, builder: 300 },
  invocationMs: {
    get contestant() {
      return scaled(45)
    },
    get operator() {
      return scaled(5)
    },
    get judge() {
      return scaled(15)
    },
    get builder() {
      return scaled(90)
    }
  },
  get runMs() {
    return scaled(150)
  },
  get commandMs() {
    return scaled(15)
  },
  get validationMs() {
    return scaled(5)
  }
}
