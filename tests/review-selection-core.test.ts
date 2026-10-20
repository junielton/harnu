import { describe, it, expect } from 'vitest'
import { parseUnifiedDiff } from '../src/main/review-core'
import {
  anchorOfRow,
  clampRange,
  fileSelection,
  gutterKeyAction,
  judgeSnapshot,
  lineSelection,
  rangeFields,
  rangeLabelOf,
  shortSha,
  stepRow,
  type SelectionBase
} from '../src/renderer/src/lib/review-selection'
import { BASE_SHA, HEAD_SHA, MOVED_SHA, SELECTION_DIFF } from './helpers/review-selection-fixture'

const files = parseUnifiedDiff(SELECTION_DIFF)
const speech = files.find((f) => f.path === 'src/main/speech.ts')!
const renamed = files.find((f) => f.path === 'src/new-name.ts')!
const deleted = files.find((f) => f.path === 'src/gone.ts')!
const binary = files.find((f) => f.path === 'brand/logo.png')!
const base: SelectionBase = { baseSha: BASE_SHA, headSha: HEAD_SHA, prNumber: 250 }

describe('U1-AC-1 — rows → §3 fields', () => {
  // hunk 0 of speech.ts: r0 ctx 10/10 · r1 del 11/– · r2 add –/11 · r3 add –/12 · r4 ctx 12/13
  it.each([
    ['context', 0, { line: 10, side: 'RIGHT' }],
    ['del', 1, { line: 11, side: 'LEFT' }],
    ['add', 2, { line: 11, side: 'RIGHT' }]
  ])('a %s row anchors per the table', (_kind, row, expected) => {
    expect(anchorOfRow(speech.hunks[0].rows[row])).toEqual(expected)
  })

  it('one row sets line/side only — the start pair is ABSENT, not null', () => {
    const f = rangeFields(speech.hunks[0].rows, 2, 2)!
    expect(f).toEqual({ line: 11, side: 'RIGHT' })
    expect('startLine' in f).toBe(false)
    expect('startSide' in f).toBe(false)
  })

  it.each([
    // same side
    [2, 3, { line: 12, side: 'RIGHT', startLine: 11, startSide: 'RIGHT' }],
    // all deletions on the left
    [1, 1, { line: 11, side: 'LEFT' }],
    // mixed: del (LEFT) → add (RIGHT), rendered order
    [1, 3, { line: 12, side: 'RIGHT', startLine: 11, startSide: 'LEFT' }],
    // context → del is impossible in order, but context(0) → del(1) is mixed too
    [0, 1, { line: 11, side: 'LEFT', startLine: 10, startSide: 'RIGHT' }]
  ])('rows %i..%i map to %j', (from, to, expected) => {
    expect(rangeFields(speech.hunks[0].rows, from, to)).toEqual(expected)
  })

  it('a LINE selection carries the commits, the paths and the row text', () => {
    const sel = lineSelection(renamed, 0, 2, 2, base, 'sel_1')!
    expect(sel).toMatchObject({
      id: 'sel_1',
      subjectType: 'LINE',
      path: 'src/new-name.ts',
      oldPath: 'src/old-name.ts',
      line: 2,
      side: 'RIGHT',
      baseSha: BASE_SHA,
      headSha: HEAD_SHA,
      prNumber: 250,
      hunkIndex: 0,
      rowFrom: 2,
      rowTo: 2
    })
    expect(sel.lineText).toEqual([renamed.hunks[0].rows[2].text])
  })

  it('labels each shape for the bar', () => {
    const one = lineSelection(speech, 0, 2, 2, base, 'a')!
    const same = lineSelection(speech, 0, 2, 3, base, 'b')!
    const old = lineSelection(deleted, 0, 0, 1, base, 'c')!
    const mixed = lineSelection(speech, 0, 1, 3, base, 'd')!
    expect(rangeLabelOf(one)).toEqual({ kind: 'line', side: 'RIGHT', line: 11 })
    expect(rangeLabelOf(same)).toEqual({ kind: 'range', side: 'RIGHT', start: 11, end: 12 })
    expect(rangeLabelOf(old)).toEqual({ kind: 'range', side: 'LEFT', start: 1, end: 2 })
    expect(rangeLabelOf(mixed)).toEqual({
      kind: 'mixed',
      startSide: 'LEFT',
      start: 11,
      endSide: 'RIGHT',
      end: 12
    })
    expect(rangeLabelOf(fileSelection(speech, base, 'e'))).toEqual({ kind: 'file' })
  })
})

describe('U1-AC-2 — a range never leaves its hunk', () => {
  it('stays unclamped inside the hunk, in either direction', () => {
    expect(clampRange({ hunk: 0, row: 3 }, { hunk: 0, row: 1 }, 6)).toEqual({
      from: 1,
      to: 3,
      clamped: false
    })
  })

  it('clamps a later hunk to the last row and an earlier one to the first', () => {
    expect(clampRange({ hunk: 0, row: 2 }, { hunk: 1, row: 0 }, 6)).toEqual({
      from: 2,
      to: 5,
      clamped: true
    })
    expect(clampRange({ hunk: 1, row: 2 }, { hunk: 0, row: 4 }, 5)).toEqual({
      from: 0,
      to: 2,
      clamped: true
    })
  })

  it('walks rows across hunks and stops at both ends of the file', () => {
    expect(stepRow(speech, { hunk: 0, row: 5 }, 1)).toEqual({ hunk: 1, row: 0 })
    expect(stepRow(speech, { hunk: 1, row: 0 }, -1)).toEqual({ hunk: 0, row: 5 })
    expect(stepRow(speech, { hunk: 0, row: 0 }, -1)).toBeNull()
    expect(stepRow(speech, { hunk: 1, row: 4 }, 1)).toBeNull()
  })
})

describe('U1-AC-3 — whole file, binary and deleted', () => {
  it('has no line fields at all', () => {
    const sel = fileSelection(speech, base, 'sel_f')
    expect(sel.subjectType).toBe('FILE')
    for (const k of ['line', 'side', 'startLine', 'startSide']) expect(k in sel).toBe(false)
    expect(sel).toMatchObject({ hunkIndex: null, rowFrom: null, rowTo: null, lineText: [] })
  })

  it('works for a binary file and for a deleted one', () => {
    expect(fileSelection(binary, base, 'b').path).toBe('brand/logo.png')
    expect(fileSelection(deleted, base, 'd')).toMatchObject({
      subjectType: 'FILE',
      path: 'src/gone.ts'
    })
  })

  it('refuses a line range on a binary file', () => {
    expect(binary.binary).toBe(true)
    expect(lineSelection(binary, 0, 0, 0, base, 'x')).toBeNull()
  })

  it('anchors every row of a deleted file to the LEFT', () => {
    expect(deleted.hunks[0].rows.map((r) => anchorOfRow(r)?.side)).toEqual(['LEFT', 'LEFT'])
  })
})

describe('U1-AC-5 (pure half) — judging a landed snapshot', () => {
  const sel = lineSelection(speech, 0, 1, 1, base, 's')!
  const paths = new Set(['src/main/speech.ts'])

  it('keeps on the same commits while the file is expanded', () => {
    expect(judgeSnapshot(sel, { baseSha: BASE_SHA, headSha: HEAD_SHA, paths }, true)).toEqual({
      keep: true
    })
  })

  it('clears with both short SHAs when the head moved', () => {
    expect(judgeSnapshot(sel, { baseSha: BASE_SHA, headSha: MOVED_SHA, paths }, true)).toEqual({
      keep: false,
      notice: { kind: 'head-moved', from: shortSha(HEAD_SHA), to: shortSha(MOVED_SHA) }
    })
    expect(shortSha(HEAD_SHA)).toBe('9f8e7d6')
  })

  it('clears with a base notice when only the base moved', () => {
    expect(judgeSnapshot(sel, { baseSha: MOVED_SHA, headSha: HEAD_SHA, paths }, true)).toEqual({
      keep: false,
      notice: { kind: 'base-moved', from: shortSha(BASE_SHA), to: shortSha(MOVED_SHA) }
    })
  })

  it('clears silently for a null snapshot, a collapsed file or a vanished file', () => {
    expect(judgeSnapshot(sel, null, true)).toEqual({ keep: false, notice: null })
    expect(judgeSnapshot(sel, { baseSha: BASE_SHA, headSha: HEAD_SHA, paths }, false)).toEqual({
      keep: false,
      notice: null
    })
    expect(
      judgeSnapshot(sel, { baseSha: BASE_SHA, headSha: HEAD_SHA, paths: new Set() }, true)
    ).toEqual({ keep: false, notice: null })
  })
})

describe('U1-AC-7 (pure half) — the key table', () => {
  it.each([
    ['ArrowDown', false, { kind: 'move', delta: 1, extend: false }],
    ['ArrowUp', true, { kind: 'move', delta: -1, extend: true }],
    ['Enter', false, { kind: 'toggle' }],
    [' ', false, { kind: 'toggle' }],
    ['Escape', false, { kind: 'clear' }],
    ['a', false, null],
    ['Tab', false, null]
  ])('%s (shift: %s)', (key, shift, expected) => {
    expect(gutterKeyAction(key, shift)).toEqual(expected)
  })
})
