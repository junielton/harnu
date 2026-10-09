// "Check again": a demoted item (refused at the reprobe again and again) used to have no way out for
// up to a week after its cause was fixed outside Harnu — a registration repaired, a stack stopped.
// The operator now asks, and Harnu forgets that item's remembered refusal, gathers afresh and runs
// the real reprobe once: a fixed item is back to ready, a still-broken one stays demoted with its reason.

import { describe, expect, it, vi } from 'vitest'
import { REFUSAL_DEMOTE_AFTER, type CycleFailure } from '../src/main/gc/autopilot-core'
import { createCycleState, withFailures } from '../src/main/gc/gc-cycle'
import { recheckItem } from '../src/main/gc/gc-recheck'
import type { WorktreeBundle } from '../src/main/gc/bundle-core'
import { bundle, DAY, NOW, reapItem } from './gc-fixtures'

const stuck = (): WorktreeBundle =>
  bundle('/ws/wt/stuck', 'ready', {
    lastSignOfLifeAt: NOW - 9 * DAY,
    item: reapItem('/ws/wt/stuck', { diskBytes: 1_000 })
  })

function rig(opts: {
  raw: WorktreeBundle
  reprobe: (b: WorktreeBundle) => Promise<{ ok: true } | { ok: false; reason: string }>
  failure?: CycleFailure
  /** Other bundles in the same gather. */
  others?: WorktreeBundle[]
}) {
  const state = createCycleState()
  const id = opts.raw.item.id
  state.failures.set(
    id,
    opts.failure ?? {
      step: 'reprobe',
      error: 'cannot-unregister',
      at: NOW - 1000,
      count: REFUSAL_DEMOTE_AFTER,
      tip: opts.raw.localTip ?? null
    }
  )
  const reprobe = vi.fn(opts.reprobe)
  const deps = {
    // as the gatherer hands it out: the remembered refusals already laid over the raw scan
    gather: async () =>
      withFailures(
        { bundles: structuredClone([opts.raw, ...(opts.others ?? [])]), housekeeping: {} as never },
        state,
        NOW
      ),
    reprobe,
    state,
    now: () => NOW
  }
  return { deps, state, reprobe, id }
}

describe('recheckItem', () => {
  it('a fixed item: the memory is gone, the real reprobe passed, and the gather shows it ready again', async () => {
    const r = rig({ raw: stuck(), reprobe: async () => ({ ok: true }) })
    expect(r.state.failures.size).toBe(1)
    expect(await recheckItem(r.deps, r.id)).toEqual({ id: r.id, outcome: 'cleared' })
    expect(r.state.failures.size).toBe(0)
    expect(r.reprobe).toHaveBeenCalledTimes(1)
    const g = await r.deps.gather()
    expect(g.bundles[0].bucket).toBe('ready')
    expect(g.bundles[0].reprobeRefusal).toBeUndefined()
  })

  it('a still-broken item stays demoted with its reason', async () => {
    const r = rig({
      raw: stuck(),
      reprobe: async () => ({ ok: false, reason: 'cannot-unregister' })
    })
    expect(await recheckItem(r.deps, r.id)).toEqual({
      id: r.id,
      outcome: 'still-refused',
      code: 'cannot-unregister'
    })
    const g = await r.deps.gather()
    expect(g.bundles[0].bucket).toBe('review')
    expect(g.bundles[0].reprobeRefusal).toEqual({
      code: 'cannot-unregister',
      count: REFUSAL_DEMOTE_AFTER
    })
  })

  it('a different cause replaces the old one', async () => {
    const r = rig({ raw: stuck(), reprobe: async () => ({ ok: false, reason: 'tip-unknown' }) })
    const out = await recheckItem(r.deps, r.id)
    expect(out).toMatchObject({ outcome: 'still-refused', code: 'tip-unknown' })
    expect(r.state.failures.get(r.id)).toMatchObject({ error: 'tip-unknown' })
  })

  it('a refusal that is only the moment (Docker down) tells the operator it could not check, and forgets the old memory', async () => {
    const r = rig({
      raw: stuck(),
      reprobe: async () => ({ ok: false, reason: 'docker-unavailable' })
    })
    expect(await recheckItem(r.deps, r.id)).toEqual({
      id: r.id,
      outcome: 'unchecked',
      code: 'docker-unavailable'
    })
    expect(r.state.failures.size).toBe(0)
  })

  it('a probe that throws is "could not check", never "fixed"', async () => {
    const r = rig({
      raw: stuck(),
      reprobe: async () => {
        throw new Error('git exploded')
      }
    })
    expect(await recheckItem(r.deps, r.id)).toMatchObject({ outcome: 'unchecked' })
  })

  it('when the scan now calls it something else, the scan owns the verdict: no reprobe, memory gone', async () => {
    const raw = { ...stuck(), bucket: 'review' as const }
    const r = rig({ raw, reprobe: async () => ({ ok: true }) })
    r.state.failures.set(r.id, {
      step: 'reprobe',
      error: 'cannot-unregister',
      at: NOW,
      count: REFUSAL_DEMOTE_AFTER
    })
    expect(await recheckItem(r.deps, r.id)).toEqual({ id: r.id, outcome: 'cleared' })
    expect(r.reprobe).not.toHaveBeenCalled()
  })

  it('an id the gather does not know', async () => {
    const r = rig({ raw: stuck(), reprobe: async () => ({ ok: true }) })
    expect(await recheckItem(r.deps, 'ghost')).toEqual({ id: 'ghost', outcome: 'unknown-item' })
    expect(r.state.failures.size).toBe(1)
  })

  it("leaves another item's memory alone, and a halt after the reprobe too", async () => {
    const other = bundle('/ws/wt/other', 'ready', {
      lastSignOfLifeAt: NOW - 9 * DAY,
      item: reapItem('/ws/wt/other')
    })
    const r = rig({ raw: stuck(), others: [other], reprobe: async () => ({ ok: true }) })
    r.state.failures.set(other.item.id, {
      step: 'reprobe',
      error: 'tip-unknown',
      at: NOW,
      count: 1,
      tip: other.localTip ?? null
    })
    await recheckItem(r.deps, r.id)
    expect(r.state.failures.has(other.item.id)).toBe(true)
  })
})
