// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useReviewStore } from '../src/renderer/src/stores/review'
import { useReviewSelectionStore } from '../src/renderer/src/stores/review-selection'
import {
  BASE_SHA,
  HEAD_SHA,
  MOVED_SHA,
  selectionSnapshot,
  stubReviewApi
} from './helpers/review-selection-fixture'
import { readFileSync } from 'node:fs'

const SPEECH = 'src/main/speech.ts'

function setup() {
  const review = useReviewStore()
  const selection = useReviewSelectionStore()
  review.snapshot = selectionSnapshot()
  review.expanded = Object.fromEntries(review.snapshot!.files.map((f) => [f.path, true]))
  return { review, selection }
}

function headMovedSnapshot() {
  const snap = selectionSnapshot() as unknown as { head: Record<string, unknown> }
  return selectionSnapshot({ head: { ...snap.head, sha: MOVED_SHA } })
}

beforeEach(() => {
  setActivePinia(createPinia())
  stubReviewApi()
})

describe('U1-AC-2 — one door for extending', () => {
  it('a range is the same whether it came from a drag step or a shift-click', () => {
    const { selection } = setup()
    selection.select(SPEECH, 0, 1)
    selection.extend(SPEECH, 0, 3)
    const viaExtend = { ...selection.live!, id: '' }

    selection.clear('user')
    selection.select(SPEECH, 0, 1)
    selection.extend(SPEECH, 0, 2) // the drag passes through row 2…
    selection.extend(SPEECH, 0, 3) // …and ends on row 3
    expect({ ...selection.live!, id: '' }).toEqual(viaExtend)
    expect(selection.live).toMatchObject({
      startLine: 11,
      startSide: 'LEFT',
      line: 12,
      side: 'RIGHT'
    })
  })

  it('clamps at the hunk edge and says so; the next in-hunk step drops the hint', () => {
    const { selection } = setup()
    selection.select(SPEECH, 0, 2)
    selection.extend(SPEECH, 1, 1)
    expect(selection.live).toMatchObject({ hunkIndex: 0, rowFrom: 2, rowTo: 5 })
    expect(selection.notice).toEqual({ kind: 'clamp' })
    selection.extend(SPEECH, 0, 4)
    expect(selection.notice).toBeNull()
  })

  it('clamps toward the start for a target in an earlier hunk', () => {
    const { selection } = setup()
    selection.select(SPEECH, 1, 2)
    selection.extend(SPEECH, 0, 5)
    expect(selection.live).toMatchObject({ hunkIndex: 1, rowFrom: 0, rowTo: 2 })
  })

  it('clamps a target in another file by that file’s position', () => {
    const { selection } = setup()
    selection.select(SPEECH, 0, 2)
    selection.extend('src/new-name.ts', 0, 1) // a later file
    expect(selection.live).toMatchObject({ path: SPEECH, rowFrom: 2, rowTo: 5 })
    expect(selection.notice).toEqual({ kind: 'clamp' })
  })

  it('shift-extending with nothing selected just selects', () => {
    const { selection } = setup()
    selection.extend(SPEECH, 0, 2)
    expect(selection.live).toMatchObject({ rowFrom: 2, rowTo: 2 })
  })
})

describe('U1-AC-3 — whole file and binary', () => {
  it('selects a binary and a deleted file, refuses a line range on a binary', () => {
    const { selection } = setup()
    expect(selection.selectFile('brand/logo.png')).toBe(true)
    expect(selection.live).toMatchObject({ subjectType: 'FILE', path: 'brand/logo.png' })
    expect(selection.select('brand/logo.png', 0, 0)).toBe(false)
    expect(selection.live?.subjectType).toBe('FILE') // the refusal changed nothing
    expect(selection.selectFile('src/gone.ts')).toBe(true)
  })

  it('a file selection replaces a line range and the reverse; pressing it again clears', () => {
    const { selection } = setup()
    selection.select(SPEECH, 0, 1)
    selection.toggleFile(SPEECH)
    expect(selection.live?.subjectType).toBe('FILE')
    selection.select(SPEECH, 0, 1)
    expect(selection.live?.subjectType).toBe('LINE')
    selection.toggleFile(SPEECH)
    selection.toggleFile(SPEECH)
    expect(selection.live).toBeNull()
  })

  it('refuses to anchor anything while the base or head commit is unknown', () => {
    const { review, selection } = setup()
    review.snapshot = selectionSnapshot({ baseSha: null })
    expect(selection.select(SPEECH, 0, 1)).toBe(false)
    expect(selection.selectFile(SPEECH)).toBe(false)
    expect(selection.live).toBeNull()
  })
})

describe('U1-AC-4 — its own store', () => {
  it('stores/review.ts knows nothing about the selection', () => {
    const src = readFileSync('src/renderer/src/stores/review.ts', 'utf8')
    expect(src).not.toMatch(/selection/i)
  })

  it('the selection store calls no window.api at all in this unit', () => {
    const src = readFileSync('src/renderer/src/stores/review-selection.ts', 'utf8')
    expect(src).not.toMatch(/window\.api\.\w/)
  })
})

describe('U1-AC-5 — §4.2, one test per row', () => {
  it('row 1 — the selected file collapses: header click, a viewed mark, a re-seed', async () => {
    const { review, selection } = setup()

    selection.select(SPEECH, 0, 1)
    review.toggleFile(SPEECH)
    expect(selection.live).toBeNull()
    expect(selection.notice).toBeNull()
    expect(selection.lastCleared).toBe('collapse')

    review.toggleFile(SPEECH)
    selection.select(SPEECH, 0, 1)
    await review.markViewed(SPEECH, true)
    expect(selection.live).toBeNull()

    // a re-seed that collapses it
    ;(window as unknown as { api: Record<string, unknown> }).api.reviewLoad = async () =>
      selectionSnapshot({
        viewed: { prNodeId: null, remoteKnown: false, files: { [SPEECH]: 'viewed' } }
      })
    review.expanded = { ...review.expanded, [SPEECH]: true }
    selection.select(SPEECH, 0, 1)
    await review.load('/repos/harnu', { silent: true })
    expect(review.isExpanded(SPEECH)).toBe(false)
    expect(selection.live).toBeNull()
    expect(selection.notice).toBeNull()
  })

  it('row 1b — collapsing a DIFFERENT file leaves the selection alone', () => {
    const { review, selection } = setup()
    selection.select(SPEECH, 0, 1)
    review.toggleFile('src/new-name.ts')
    expect(selection.live).not.toBeNull()
  })

  it('row 2 — a different head clears with a notice naming both short SHAs', () => {
    const { review, selection } = setup()
    selection.select(SPEECH, 0, 1)
    review.snapshot = headMovedSnapshot()
    expect(selection.live).toBeNull()
    expect(selection.notice).toEqual({
      kind: 'head-moved',
      from: HEAD_SHA.slice(0, 7),
      to: MOVED_SHA.slice(0, 7)
    })
  })

  it('row 2b — a different base clears with a base notice', () => {
    const { review, selection } = setup()
    selection.select(SPEECH, 0, 1)
    review.snapshot = selectionSnapshot({ baseSha: MOVED_SHA })
    expect(selection.live).toBeNull()
    expect(selection.notice).toEqual({
      kind: 'base-moved',
      from: BASE_SHA.slice(0, 7),
      to: MOVED_SHA.slice(0, 7)
    })
  })

  it('row 3 — the same SHAs keep the selection while the file is expanded, with no notice', () => {
    const { review, selection } = setup()
    selection.select(SPEECH, 0, 1)
    const before = selection.live
    review.snapshot = selectionSnapshot()
    expect(selection.live).toBe(before)
    expect(selection.notice).toBeNull()
  })

  it('row 4 — a non-silent load, a load error and snapshot → null clear with no notice', async () => {
    const { review, selection } = setup()

    selection.select(SPEECH, 0, 1)
    const pending = review.load('/repos/harnu') // sets snapshot → null first
    expect(selection.live).toBeNull()
    await pending

    ;(window as unknown as { api: Record<string, unknown> }).api.reviewLoad = async () => {
      throw new Error('boom')
    }
    review.snapshot = selectionSnapshot()
    review.expanded = { ...review.expanded, [SPEECH]: true }
    selection.select(SPEECH, 0, 1)
    await review.load('/repos/harnu', { silent: true })
    expect(review.error).toBe('boom')
    expect(selection.live).toBeNull()

    review.snapshot = selectionSnapshot()
    selection.select(SPEECH, 0, 1)
    review.snapshot = null
    expect(selection.live).toBeNull()
    expect(selection.notice).toBeNull()
  })

  it('row 4b — a stale notice does not survive the snapshot going away', () => {
    const { review, selection } = setup()
    selection.select(SPEECH, 0, 1)
    review.snapshot = headMovedSnapshot()
    expect(selection.notice).not.toBeNull()
    review.snapshot = null
    expect(selection.notice).toBeNull()
  })

  it('row 6 — reset() drops the selection and the notice', () => {
    const { review, selection } = setup()
    selection.select(SPEECH, 0, 1)
    review.snapshot = headMovedSnapshot()
    selection.select(SPEECH, 0, 1) // against the moved head, notice gone
    selection.extend(SPEECH, 1, 1)
    expect(selection.notice).toEqual({ kind: 'clamp' })
    selection.reset()
    expect(selection.live).toBeNull()
    expect(selection.notice).toBeNull()
  })

  it('row 7 — Clear selection / Esc clear it', () => {
    const { selection } = setup()
    selection.select(SPEECH, 0, 1)
    selection.clear('esc')
    expect(selection.live).toBeNull()
    expect(selection.lastCleared).toBe('esc')
  })

  it('row 8 — selecting something else replaces it', () => {
    const { selection } = setup()
    selection.select(SPEECH, 0, 1)
    const first = selection.live!.id
    selection.select(SPEECH, 1, 2)
    expect(selection.live).toMatchObject({ hunkIndex: 1, rowFrom: 2 })
    expect(selection.live!.id).not.toBe(first)
  })

  it('restore() puts a cancelled drag back, and a later shift-click extends from it', () => {
    const { selection } = setup()
    selection.select(SPEECH, 0, 1)
    const prev = selection.capture()
    selection.select(SPEECH, 1, 0)
    selection.restore(prev)
    expect(selection.live).toBe(prev.sel)
    selection.extend(SPEECH, 0, 3)
    expect(selection.live).toMatchObject({ rowFrom: 1, rowTo: 3 })
  })

  it('restore() keeps the anchor of a REVERSED range, not its first row', () => {
    const { selection } = setup()
    selection.select(SPEECH, 0, 3)
    selection.extend(SPEECH, 0, 1) // shift-click upward: rows 1..3, anchored at 3
    expect(selection.live).toMatchObject({ rowFrom: 1, rowTo: 3 })
    const prev = selection.capture()

    selection.select(SPEECH, 0, 0) // a drag starts…
    selection.restore(prev) // …and Esc cancels it
    expect(selection.live).toBe(prev.sel)

    selection.extend(SPEECH, 0, 5) // the next shift-click still pivots on row 3
    expect(selection.live).toMatchObject({ rowFrom: 3, rowTo: 5 })
  })

  it('restoring "nothing" leaves no anchor to extend from', () => {
    const { selection } = setup()
    const none = selection.capture()
    selection.select(SPEECH, 0, 2)
    selection.restore(none)
    expect(selection.live).toBeNull()
    selection.extend(SPEECH, 0, 4) // no anchor → a plain select
    expect(selection.live).toMatchObject({ rowFrom: 4, rowTo: 4 })
  })
})
