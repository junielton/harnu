import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

/**
 * QA-1 — a `position: sticky` child pins to the scrollport INSET BY THE SCROLL
 * CONTAINER'S PADDING, not to the container's visible top edge.
 *
 * So `pt-4` on a scroller silently turns every `sticky top-0` inside it into
 * "pin 16px down", and that 16px strip is unpainted: content scrolls through
 * it in plain sight. Verified in Chromium (the runtime that matters here):
 * with `padding-top: 16px` on the scroller the header pins at +16px; with the
 * padding moved to a margin on the first child it pins at 0 and the 16px of
 * breathing room above the first box is unchanged.
 *
 * The repo's other scrollers already dodge this by accident of shape — the
 * takeovers (UsageDashboard, SystemMonitor) pad an inner wrapper and leave the
 * scroll container itself padding-free. ReviewPane was the first component to
 * put a sticky child inside a padded scroller, so nothing was holding the line.
 * This file holds it, for every component, from the classes themselves.
 */

const REPO = join(import.meta.dirname, '..')
const COMPONENTS = join(REPO, 'src/renderer/src/components')

// ── Tailwind class → px ─────────────────────────────────────────────────────

/** Tailwind's spacing unit is 0.25rem; the root font-size here is the 16px default. */
function scaleToPx(raw: string): number | null {
  const arbitrary = /^\[(-?[\d.]+)px\]$/.exec(raw)
  if (arbitrary) return Number(arbitrary[1])
  if (raw === 'px') return 1
  if (!/^\d+(\.\d+)?$/.test(raw)) return null
  return Number(raw) * 4
}

/** Top padding a scroll container imposes on its sticky children (`p-`/`py-`/`pt-`). */
function topPaddingPx(classes: string[]): number {
  let px = 0
  for (const prefix of ['p', 'py', 'pt']) {
    for (const cls of classes) {
      const m = new RegExp(`^${prefix}-(\\[[^\\]]+\\]|px|[\\d.]+)$`).exec(cls)
      const value = m && scaleToPx(m[1])
      if (value !== null && value !== undefined) px = value
    }
  }
  return px
}

/** The `top` a sticky element declares, negative form included (`-top-4`). */
function stickyTopPx(classes: string[]): number | null {
  for (const cls of classes) {
    const m = /^(-?)top-(\[[^\]]+\]|px|[\d.]+)$/.exec(cls)
    if (!m) continue
    const value = scaleToPx(m[2])
    if (value === null) continue
    return m[1] === '-' ? -value : value
  }
  return null
}

/** `[&>*:first-child]:mt-4` — spacing put on the content instead of the scroller. */
function firstChildMarginTopPx(classes: string[]): number {
  for (const cls of classes) {
    const m = /^\[&>\*:first-child\]:mt-(\[[^\]]+\]|px|[\d.]+)$/.exec(cls)
    const value = m && scaleToPx(m[1])
    if (value !== null && value !== undefined) return value
  }
  return 0
}

const SCROLLS = ['overflow-y-auto', 'overflow-auto', 'overflow-y-scroll', 'overflow-scroll']
const isScrollContainer = (classes: string[]): boolean => classes.some((c) => SCROLLS.includes(c))

// ── A very small SFC template walker ────────────────────────────────────────

interface El {
  tag: string
  /** Every class the element can ever carry — the right lens for an ancestor. */
  classes: string[]
  /**
   * One entry per mutually exclusive outcome of a bound `:class` (the intent
   * rail picks between an `absolute top-0` overlay and a `sticky top-3` rail).
   * Merging those into one bag would read `top-0` off a branch that also says
   * `absolute`, so each branch is scored on its own.
   */
  variants: string[][]
  line: number
}

const VOID = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'param',
  'source',
  'track',
  'wbr'
])

/** Blank a region out while preserving newlines, so line numbers stay honest. */
const blank = (s: string): string => s.replace(/[^\n]/g, ' ')

/**
 * Every element in the SFC template, each paired with the stack of elements
 * enclosing it. Static `class` and every string literal inside a bound
 * `:class` count — the intent rail declares its `sticky top-3` in a ternary.
 */
function elementsWithAncestors(source: string): Array<{ el: El; ancestors: El[] }> {
  const open = source.search(/^<template>$/m)
  if (open === -1) return []
  const close = source.lastIndexOf('\n</template>')
  const head = blank(source.slice(0, open))
  const body = source
    .slice(open, close === -1 ? source.length : close)
    .replace(/<!--[\s\S]*?-->/g, blank)
    .replace(/\{\{[\s\S]*?\}\}/g, blank)
  const text = head + body

  const TAG = /<(\/?)([A-Za-z][\w.-]*)((?:'[^']*'|"[^"]*"|[^>'"])*)(\/?)>/g
  const out: Array<{ el: El; ancestors: El[] }> = []
  const stack: El[] = []
  let m: RegExpExecArray | null
  while ((m = TAG.exec(text))) {
    const [, closing, tag, attrs, selfClosing] = m
    if (closing) {
      const at = stack.map((e) => e.tag).lastIndexOf(tag)
      if (at !== -1) stack.length = at
      continue
    }
    const statics: string[] = []
    const branches: string[][] = []
    for (const a of attrs.matchAll(/(?::|v-bind:)?class="([\s\S]*?)"/g)) {
      const split = (s: string): string[] => s.split(/\s+/).filter(Boolean)
      if (a[0].startsWith('class=')) statics.push(...split(a[1]))
      // A bound class is an expression: only its string literals are classes.
      else for (const q of a[1].matchAll(/'([^']*)'/g)) branches.push(split(q[1]))
    }
    const variants = branches.length ? branches.map((b) => [...statics, ...b]) : [statics]
    const el: El = {
      tag,
      classes: [...statics, ...branches.flat()],
      variants,
      line: text.slice(0, m.index).split('\n').length
    }
    out.push({ el, ancestors: [...stack] })
    if (!selfClosing && !VOID.has(tag)) stack.push(el)
  }
  return out
}

function vueFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) vueFiles(full, out)
    else if (full.endsWith('.vue')) out.push(full)
  }
  return out
}

// ── The guard ───────────────────────────────────────────────────────────────

describe('sticky children inside a scroll container', () => {
  it('no scroll container hosting a sticky child carries top padding', () => {
    const offenders: string[] = []
    for (const file of vueFiles(COMPONENTS)) {
      const source = readFileSync(file, 'utf8')
      for (const { el, ancestors } of elementsWithAncestors(source)) {
        const stuck = el.variants.find((v) => v.includes('sticky') && stickyTopPx(v) !== null)
        if (!stuck) continue
        const scroller = [...ancestors].reverse().find((a) => isScrollContainer(a.classes))
        if (!scroller) continue
        const pad = topPaddingPx(scroller.classes)
        if (pad === 0) continue
        offenders.push(
          `${relative(REPO, file)}:${el.line} <${el.tag}> pins ${pad}px low — its scroller ` +
            `(<${scroller.tag}> line ${scroller.line}) has ${pad}px of top padding. ` +
            `Move that spacing onto the content (a margin on the first child, or an ` +
            `inner wrapper) so the scroll container itself stays padding-free.`
        )
      }
    }
    expect(offenders, offenders.join('\n')).toEqual([])
  })
})

describe('QA-1 — the review pane file header pins flush', () => {
  const source = readFileSync(join(COMPONENTS, 'ReviewPane.vue'), 'utf8')
  const els = elementsWithAncestors(source)

  const fileHeader = els.find(
    ({ el }) => el.tag === 'header' && el.classes.includes('sticky') && el.classes.includes('z-[2]')
  )
  const headerVariant = fileHeader?.el.variants.find((v) => v.includes('sticky'))
  const scroller =
    fileHeader && [...fileHeader.ancestors].reverse().find((a) => isScrollContainer(a.classes))

  it('the diff scroller and its sticky file header were both found', () => {
    expect(fileHeader, 'the sticky file-box header').toBeTruthy()
    expect(scroller, 'the scrolling diff body').toBeTruthy()
  })

  /**
   * The whole finding, as one number: where the header actually comes to rest,
   * measured from the top edge the reader sees. Anything above 0 is a strip of
   * unpainted scroller with a half-clipped hunk header showing through it.
   */
  it('rests at 0px from the visible top edge — nothing can show above it', () => {
    const pin = topPaddingPx(scroller!.classes) + stickyTopPx(headerVariant!)!
    expect(pin, `file header pins ${pin}px below the top of the scroll viewport`).toBe(0)
  })

  /** The mockup's breathing room is a requirement, not a side effect of the bug. */
  it('still leaves 16px above the first box', () => {
    const gap = topPaddingPx(scroller!.classes) + firstChildMarginTopPx(scroller!.classes)
    expect(gap).toBe(16)
  })

  /**
   * The rail is the second sticky in the same scroller. It has no say in where
   * it lands while the scroller is padded, so it belongs to the same finding.
   */
  it('the intent rail lands at exactly the offset it declares', () => {
    const rail = els.find(
      ({ el }) =>
        el.tag === 'aside' && el.variants.some((v) => v.includes('sticky') && v.includes('top-3'))
    )
    expect(rail, 'the sticky intent rail').toBeTruthy()
    const branch = rail!.el.variants.find((v) => v.includes('sticky'))!
    const railScroller = [...rail!.ancestors].reverse().find((a) => isScrollContainer(a.classes))
    expect(topPaddingPx(railScroller!.classes) + stickyTopPx(branch)!).toBe(12)
  })
})
