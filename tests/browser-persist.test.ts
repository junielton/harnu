/**
 * T574 (browser pane U7, AC-6) — what a browser pane keeps in `helpers.json`, pure: a pushed state or a persist
 * event becomes a minimal patch of the pane's payload, or nothing, so an unchanged push never schedules a write.
 */
import { describe, expect, it } from 'vitest'
import {
  payloadPatchFromPersist,
  payloadPatchFromState,
  type PersistableState
} from '../src/renderer/src/lib/browser-persist'
import { paneRegistry } from '../src/renderer/src/lib/pane-registry'

const state = (over: Partial<PersistableState> = {}): PersistableState => ({
  url: 'http://localhost:3000/cart',
  pagePath: null,
  zoom: 1,
  emulation: {},
  allowNetwork: false,
  ...over
})

describe('the browser pane type', () => {
  it('is persistable: helpers.json keeps it', () => {
    expect(paneRegistry.browser.persistable).toBe(true)
  })
})

describe('a pushed state', () => {
  it('changes nothing when nothing persisted changed', () => {
    expect(
      payloadPatchFromState(
        { url: 'http://localhost:3000/cart', zoom: 1, emulation: {}, allowNetwork: false },
        state()
      )
    ).toBeNull()
    // a payload that never saved these fields reads as the defaults
    expect(payloadPatchFromState({ url: 'http://localhost:3000/cart' }, state())).toBeNull()
  })

  it('keeps the new address, zoom, page file, network switch and emulation', () => {
    const device = {
      preset: 'phone-m',
      width: 390,
      height: 844,
      dpr: 3,
      mobile: true,
      rotated: false
    }
    expect(
      payloadPatchFromState(
        {},
        state({
          url: 'http://localhost:3000/pay',
          zoom: 1.25,
          pagePath: 'docs/board.html',
          allowNetwork: true,
          emulation: { device: device as never, colorScheme: 'dark' }
        })
      )
    ).toEqual({
      url: 'http://localhost:3000/pay',
      zoom: 1.25,
      pagePath: 'docs/board.html',
      allowNetwork: true,
      emulation: { device, colorScheme: 'dark' }
    })
  })

  it('an empty address (nothing committed yet) never replaces the saved one', () => {
    expect(
      payloadPatchFromState({ url: 'http://localhost:3000/cart' }, state({ url: '' }))
    ).toBeNull()
  })

  it('resetting the device saves the empty record, and key order never counts as a change', () => {
    const saved = { emulation: { colorScheme: 'dark' as const, reducedMotion: true } }
    expect(
      payloadPatchFromState(
        { url: 'http://localhost:3000/cart', ...saved },
        state({ emulation: { reducedMotion: true, colorScheme: 'dark' } })
      )
    ).toBeNull()
    expect(
      payloadPatchFromState(
        { url: 'http://localhost:3000/cart', ...saved },
        state({ emulation: {} })
      )
    ).toEqual({ emulation: {} })
  })
})

describe('a persist event', () => {
  const pin = { id: 'p1', n: 1, state: 'draft', comment: 'x' }

  it('keeps the whole list of pins and the scroll position', () => {
    expect(payloadPatchFromPersist({}, { pins: [pin], scroll: { x: 0, y: 40 } })).toEqual({
      pins: [pin],
      scroll: { x: 0, y: 40 }
    })
  })

  it('changes nothing for the same pins or the same scroll', () => {
    expect(
      payloadPatchFromPersist(
        { pins: [pin], scroll: { x: 0, y: 40 } },
        { pins: [{ ...pin }], scroll: { x: 0, y: 40 } }
      )
    ).toBeNull()
    expect(payloadPatchFromPersist({}, { pins: [] })).toBeNull()
    expect(payloadPatchFromPersist({}, {})).toBeNull()
  })

  it('an emptied list of pins is saved (a discarded draft stays discarded after a restart)', () => {
    expect(payloadPatchFromPersist({ pins: [pin] }, { pins: [] })).toEqual({ pins: [] })
  })

  it('a null scroll clears the saved one', () => {
    expect(payloadPatchFromPersist({ scroll: { x: 0, y: 5 } }, { scroll: null })).toEqual({
      scroll: null
    })
  })
})
