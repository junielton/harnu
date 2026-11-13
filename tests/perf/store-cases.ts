/**
 * The renderer computeds that read the whole fleet, measured against ONE session event (BUG-265).
 *
 * `cases.ts` asks "is this function fast at reference scale". These ask the other question the 2026-11-13
 * profile raised: after a hook event or a transcript append for ONE session, how much of the fleet does
 * each computed read again? The answer must not depend on the fleet size, so every case carries a
 * `readsBudget` (a small constant) instead of leaning on the growth check, which only catches worse than
 * linear. The world is the real sessions store (`support/fleet-world.ts`).
 */

import type { JobContext, PerfCase } from './support/harness'
import { buildFleetWorld, type FleetWorld } from './support/fleet-world'

/** Reads of session fields one event may cost a computed: the changed session's own record, nothing else. */
export const READS_PER_EVENT = 64

const worlds = new WeakMap<JobContext, Promise<FleetWorld>>()

/** One store per fixture size, shared by the repeats of a case. */
function worldFor(ctx: JobContext): Promise<FleetWorld> {
  let w = worlds.get(ctx)
  if (!w) {
    w = buildFleetWorld(ctx.fixture.spec, ctx.reads)
    worlds.set(ctx, w)
  }
  return w
}

/**
 * A case: fire one event, then evaluate `evaluate(world)` (the computed under test) with the counter on.
 * The computed is evaluated once beforehand so the run measures the re-evaluation, not the first build.
 */
function eventCase(id: string, describes: string, evaluate: (w: FleetWorld) => unknown): PerfCase {
  return {
    id,
    thread: 'renderer',
    describes,
    readsBudget: READS_PER_EVENT,
    async prepare(ctx) {
      const w = await worldFor(ctx)
      evaluate(w) // prime: the run below re-evaluates a computed that was clean
      let k = 0
      return () => {
        // A step that is coprime with the fleet size, so every run changes a different session.
        k += 7
        w.fire(k)
        ctx.reads.n = 0
        w.arm()
        try {
          evaluate(w)
        } finally {
          w.disarm()
        }
      }
    }
  }
}

export const supervisionLoadCase = eventCase(
  'renderer/store-supervision-load',
  'sessions.supervisionLoad (footer count) after one session event',
  (w) => w.store.supervisionLoad
)

export const boardBucketsCase = eventCase(
  'renderer/store-board-buckets',
  'sessions.boardBuckets (fleet rail) after one session event',
  (w) => w.store.boardBuckets
)

export const STORE_CASES: PerfCase[] = [supervisionLoadCase, boardBucketsCase]
