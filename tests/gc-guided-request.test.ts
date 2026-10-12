// The `gc:clean` payload of a guided "…and remove": it names the facts the operator was shown, confirms
// exactly the ids the dialog listed, and carries each item's prep. It is built even though
// `removability()` refuses these items today — the prep is what lifts that refusal — but it still drops
// what no prep can lift (a Keep mark, a main checkout) and what the model no longer knows.

import { describe, expect, it } from 'vitest'
import { bundle, NOW, reapItem } from './gc-fixtures'
import {
  buildGcModel,
  expectedFor,
  guidedChanged,
  guidedRequestFor,
  type GcModel
} from '../src/renderer/src/lib/gc-model'
import { defaultGcPrefs } from '../src/main/gc/gc-prefs'
import type { GcSnapshot } from '../src/main/gc/gc-wire'
import type { BundleFacts } from '../src/main/gc/bundle-core'

function wt(name: string, over: Partial<BundleFacts> = {}, code = 'locked') {
  const b = bundle(`/ws/${name}`, 'review', {
    reason: { code: code as never, detail: 'x' },
    ...over
  })
  b.item = reapItem(`/ws/${name}`)
  b.item.id = `${b.item.repoPath}::worktree::/ws/${name}`
  return b
}

const model = (bundles: ReturnType<typeof wt>[]): GcModel =>
  buildGcModel({
    scannedAt: NOW,
    bundles,
    orphanVolumes: [],
    docker: { buildCacheReclaimableBytes: null, danglingImages: null },
    prefs: defaultGcPrefs(),
    lastCycle: null,
    nextCycleAt: null,
    nextClean: null,
    backgroundScan: true
  } as GcSnapshot)

describe('guidedRequestFor', () => {
  it('confirms the listed ids, binds each to what was shown and carries its prep', () => {
    const a = wt('a', { locked: true })
    const m = model([a])
    const r = guidedRequestFor(m, [a.item.id], () => ({ kind: 'unlock' }))
    expect(r.ids).toEqual([a.item.id])
    expect(r.options.confirmed).toEqual([a.item.id])
    expect(r.options.expected[a.item.id]).toEqual(expectedFor(m.byId.get(a.item.id)!))
    expect(r.options.prepare).toEqual({ [a.item.id]: { kind: 'unlock' } })
    // Crosses the preload as structured data.
    expect(structuredClone(r.options)).toEqual(r.options)
  })

  it('drops an item the prep cannot help: a Keep mark, an id the model lost, no prep for it', () => {
    const keep = wt('k', { keep: true }, 'dirty')
    const ok = wt('o', { locked: true })
    const m = model([keep, ok])
    const r = guidedRequestFor(m, [keep.item.id, ok.item.id, 'nope'], (id) =>
      id === ok.item.id ? { kind: 'unlock' } : null
    )
    expect(r.ids).toEqual([ok.item.id])
    expect(Object.keys(r.options.expected)).toEqual([ok.item.id])
  })
})

describe('guidedChanged', () => {
  it('is false while the model shows the same facts, true once an item moved or vanished', () => {
    const a = wt('a', { locked: true })
    const r = guidedRequestFor(model([a]), [a.item.id], () => ({ kind: 'unlock' }))
    const captured = { ids: r.ids, request: r }
    expect(guidedChanged(model([a]), captured)).toBe(false)

    const moved = structuredClone(a)
    moved.localTip = 'c'.repeat(40)
    expect(guidedChanged(model([moved]), captured)).toBe(true)
    expect(guidedChanged(model([]), captured)).toBe(true)
  })
})
