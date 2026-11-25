// @vitest-environment jsdom
/**
 * The app tooltip (design.md §6 "Tooltip"): anchor resolution, the warm-up delay and placement.
 */
import { afterEach, describe, expect, it } from 'vitest'
import {
  EDGE_PX,
  GAP_PX,
  OPEN_DELAY_MS,
  STASH_ATTR,
  WARM_WINDOW_MS,
  openDelay,
  placeTooltip,
  resolveAnchor
} from '../src/renderer/src/lib/tooltip'

function html(markup: string): HTMLElement {
  document.body.innerHTML = markup
  return document.body
}

afterEach(() => {
  document.body.innerHTML = ''
})

describe('resolveAnchor', () => {
  it('uses the nearest title, from a child of the anchor', () => {
    html('<button title="Close panel"><svg><path id="p"/></svg></button>')
    const hit = resolveAnchor(document.getElementById('p'))
    expect(hit?.text).toBe('Close panel')
    expect(hit?.el.tagName).toBe('BUTTON')
  })

  it('reads a title already moved aside while hovered', () => {
    html(`<button id="b" ${STASH_ATTR}="Rescan"></button>`)
    expect(resolveAnchor(document.getElementById('b'))?.text).toBe('Rescan')
  })

  it('falls back to aria-label on an icon-only control', () => {
    html('<button id="b" aria-label="Next image"><svg></svg></button>')
    expect(resolveAnchor(document.getElementById('b'))?.text).toBe('Next image')
  })

  it('treats role=button, tab and menuitem as controls', () => {
    html(
      '<div id="a" role="button" aria-label="A"></div><div id="b" role="tab" aria-label="B"></div><div id="c" role="menuitem" aria-label="C"></div>'
    )
    expect(resolveAnchor(document.getElementById('a'))?.text).toBe('A')
    expect(resolveAnchor(document.getElementById('b'))?.text).toBe('B')
    expect(resolveAnchor(document.getElementById('c'))?.text).toBe('C')
  })

  it('does not duplicate a visible label from aria-label', () => {
    html('<button id="b" aria-label="Save changes">Save</button>')
    expect(resolveAnchor(document.getElementById('b'))).toBeNull()
  })

  it('ignores aria-label on a non-control', () => {
    html('<section id="s" aria-label="Sessions"></section>')
    expect(resolveAnchor(document.getElementById('s'))).toBeNull()
  })

  it('prefers title over aria-label so the chord suffix shows', () => {
    html('<button id="b" aria-label="Hide sidebar" title="Hide sidebar (⌘B)"></button>')
    expect(resolveAnchor(document.getElementById('b'))?.text).toBe('Hide sidebar (⌘B)')
  })

  it('honors data-tooltip="off" on the element or an ancestor', () => {
    html('<div data-tooltip="off"><button id="b" title="X"></button></div>')
    expect(resolveAnchor(document.getElementById('b'))).toBeNull()
  })

  it('skips an empty title', () => {
    html('<div title="Outer"><button id="b" title="  "></button></div>')
    expect(resolveAnchor(document.getElementById('b'))?.text).toBe('Outer')
  })
})

describe('openDelay', () => {
  it('waits the open delay when cold', () => {
    expect(openDelay(1000, null)).toBe(OPEN_DELAY_MS)
    expect(openDelay(5000, 1000)).toBe(OPEN_DELAY_MS)
  })

  it('opens at once inside the warm window', () => {
    expect(openDelay(1000 + WARM_WINDOW_MS, 1000)).toBe(0)
  })

  it('is faster than the native tooltip', () => {
    expect(OPEN_DELAY_MS).toBeLessThanOrEqual(300)
  })
})

describe('placeTooltip', () => {
  const viewport = { width: 1000, height: 800 }
  const tip = { width: 100, height: 24 }

  it('centers below the anchor', () => {
    const p = placeTooltip({ left: 200, top: 100, width: 20, height: 20 }, tip, viewport)
    expect(p).toEqual({ x: 160, y: 120 + GAP_PX, side: 'bottom' })
  })

  it('flips above near the bottom edge', () => {
    const p = placeTooltip({ left: 200, top: 780, width: 20, height: 16 }, tip, viewport)
    expect(p.side).toBe('top')
    expect(p.y).toBe(780 - GAP_PX - tip.height)
  })

  it('clamps to the left and right edges', () => {
    expect(placeTooltip({ left: 0, top: 10, width: 10, height: 10 }, tip, viewport).x).toBe(EDGE_PX)
    expect(placeTooltip({ left: 995, top: 10, width: 5, height: 10 }, tip, viewport).x).toBe(
      viewport.width - EDGE_PX - tip.width
    )
  })
})
