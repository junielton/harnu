/**
 * The command palette, mounted and CLOSED, against one session event (BUG-265).
 *
 * The palette is always mounted (`App.vue`) and keeps a watcher on its item list so the cursor resets when
 * the list changes. If that watcher evaluates the list while the palette is closed, every transcript append
 * re-sorts and re-labels every session of the fleet for a window nobody is looking at: the `recents`
 * computed was 137 ms in the 2026-11-13 profile, `allSessionItems` another 57 ms.
 *
 * Needs jsdom (a mounted component), so it runs from `fleet-palette.perf.ts`, not `scale.perf.ts`.
 */

import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import CommandPalette from '../../src/renderer/src/components/CommandPalette.vue'
import { i18n } from '../../src/renderer/src/i18n'
import { READS_PER_EVENT } from './store-cases'
import { buildFleetWorld, type FleetWorld } from './support/fleet-world'
import type { JobContext, PerfCase } from './support/harness'

const mounted = new WeakMap<JobContext, Promise<FleetWorld>>()

function worldWithPalette(ctx: JobContext): Promise<FleetWorld> {
  let w = mounted.get(ctx)
  if (!w) {
    w = buildFleetWorld(ctx.fixture.spec, ctx.reads).then((world) => {
      mount(CommandPalette, { global: { plugins: [world.pinia, i18n] } })
      return world
    })
    mounted.set(ctx, w)
  }
  return w
}

export const paletteClosedCase: PerfCase = {
  id: 'renderer/palette-closed',
  thread: 'renderer',
  describes: 'CommandPalette (mounted, closed): its item lists after one session event',
  readsBudget: READS_PER_EVENT,
  async prepare(ctx) {
    const w = await worldWithPalette(ctx)
    await nextTick()
    let k = 0
    return async () => {
      k += 7
      w.fire(k)
      ctx.reads.n = 0
      w.arm()
      try {
        // The watchers of every mounted component run in this flush.
        await nextTick()
      } finally {
        w.disarm()
      }
    }
  }
}

export const PALETTE_CASES: PerfCase[] = [paletteClosedCase]
