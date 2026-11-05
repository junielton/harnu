// A one-shot wait. Lives outside `src/main/gc` on purpose: the GC modules own no timer of their own
// (tests/gc-wiring.test.ts, "one timer": the Reaper's tick is the only clock), and a bounded pause
// between retries inside a user-triggered call is not a second clock.

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms))
