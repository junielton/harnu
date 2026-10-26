/**
 * T257 U1 — the Review selection model, as pure functions.
 *
 * Spec: `docs/specs/2026-10-20-t257-review-selection.md` §3–§4. Everything that
 * decides what a selection IS lives here and is table-tested; the store only
 * holds it and the components only paint it.
 *
 * The wire fields match GitHub's `addPullRequestReviewThread` input so that a
 * later unit that posts a thread is a mapping, not a translation (PRD D3).
 */

import type { DiffFile, DiffRow } from '../../../main/review-core'

/** `LEFT` = the old file, `RIGHT` = the new file. */
export type SelectionSide = 'LEFT' | 'RIGHT'

/** The wire shape (spec §3.1). Optional fields are ABSENT, never `null`. */
export interface ReviewSelection {
  /** `sel_<uuid>`, minted in the renderer. Local identity only. */
  id: string
  /** `LINE` is a range of rows; `FILE` is the whole file. */
  subjectType: 'LINE' | 'FILE'
  path: string
  oldPath: string | null
  /** The LAST line of the range, on `side`. */
  line?: number
  side?: SelectionSide
  /** The FIRST line; present only when the range spans more than one row. */
  startLine?: number
  startSide?: SelectionSide
  /** The commits this anchor was read on. */
  baseSha: string
  headSha: string
  prNumber: number | null
}

/** What stays in the renderer: the highlight's address and the row text. */
export interface LocalSelectionState extends ReviewSelection {
  hunkIndex: number | null
  rowFrom: number | null
  rowTo: number | null
  /** The selected rows' text, kept for a later re-anchor. Never sent anywhere. */
  lineText: string[]
}

/** The commit pair a selection is read against. */
export interface SelectionBase {
  baseSha: string
  headSha: string
  prNumber: number | null
}

/** A row's address inside one file. */
export interface RowPos {
  hunk: number
  row: number
}

/** The anchor a single row maps to (spec §3.2). `null` only for a malformed row. */
export function anchorOfRow(row: DiffRow): { line: number; side: SelectionSide } | null {
  if (row.kind === 'del') {
    return row.oldLine === null ? null : { line: row.oldLine, side: 'LEFT' }
  }
  // `add` exists only in the new file; `context` is accepted on either side and
  // RIGHT is the one the head commit can read directly.
  return row.newLine === null ? null : { line: row.newLine, side: 'RIGHT' }
}

/**
 * Rows `from..to` (inclusive, rendered order) → `line`/`side`/`startLine`/
 * `startSide`. One row sets only `line`/`side`; the start pair is added only
 * when the range spans more than one row.
 */
export function rangeFields(
  rows: readonly DiffRow[],
  from: number,
  to: number
): Pick<ReviewSelection, 'line' | 'side' | 'startLine' | 'startSide'> | null {
  const first = rows[from] ? anchorOfRow(rows[from]) : null
  const last = rows[to] ? anchorOfRow(rows[to]) : null
  if (!first || !last) return null
  if (from === to) return { line: last.line, side: last.side }
  return { line: last.line, side: last.side, startLine: first.line, startSide: first.side }
}

export interface ClampedRange {
  from: number
  to: number
  /** The target was outside the anchor's hunk and was pulled back to its edge. */
  clamped: boolean
}

/**
 * The range between `anchor` and `target`, never leaving the anchor's hunk
 * (GitHub requires `startLine` in the same hunk as `line`). A target in an
 * earlier hunk clamps to the first row, in a later one to the last. A drag and
 * a shift-click both go through here, which is what makes them identical.
 */
export function clampRange(anchor: RowPos, target: RowPos, hunkRowCount: number): ClampedRange {
  if (target.hunk === anchor.hunk) {
    return {
      from: Math.min(anchor.row, target.row),
      to: Math.max(anchor.row, target.row),
      clamped: false
    }
  }
  const edge = target.hunk < anchor.hunk ? 0 : Math.max(0, hunkRowCount - 1)
  return { from: Math.min(anchor.row, edge), to: Math.max(anchor.row, edge), clamped: true }
}

/** Every row of a file, in rendered order — the keyboard's walk. */
export function flatRows(file: DiffFile): RowPos[] {
  const out: RowPos[] = []
  file.hunks.forEach((h, hunk) => h.rows.forEach((_, row) => out.push({ hunk, row })))
  return out
}

/** The row `delta` steps from `pos`, or `null` at either end of the file. */
export function stepRow(file: DiffFile, pos: RowPos, delta: -1 | 1): RowPos | null {
  const flat = flatRows(file)
  const at = flat.findIndex((p) => p.hunk === pos.hunk && p.row === pos.row)
  if (at < 0) return null
  return flat[at + delta] ?? null
}

/** The 7-character form every SHA is shown in. */
export function shortSha(sha: string): string {
  return sha.slice(0, 7)
}

/** A `LINE` selection for rows `from..to` of one hunk, or `null` when it cannot exist. */
export function lineSelection(
  file: DiffFile,
  hunk: number,
  from: number,
  to: number,
  base: SelectionBase,
  id: string
): LocalSelectionState | null {
  // A binary file has no rows, so a line range on it is refused outright.
  if (file.binary) return null
  const rows = file.hunks[hunk]?.rows
  if (!rows) return null
  const fields = rangeFields(rows, from, to)
  if (!fields) return null
  return {
    id,
    subjectType: 'LINE',
    path: file.path,
    oldPath: file.oldPath,
    ...fields,
    ...base,
    hunkIndex: hunk,
    rowFrom: from,
    rowTo: to,
    lineText: rows.slice(from, to + 1).map((r) => r.text)
  }
}

/** A `FILE` selection: no line fields at all. Works for binary and deleted files. */
export function fileSelection(
  file: DiffFile,
  base: SelectionBase,
  id: string
): LocalSelectionState {
  return {
    id,
    subjectType: 'FILE',
    path: file.path,
    oldPath: file.oldPath,
    ...base,
    hunkIndex: null,
    rowFrom: null,
    rowTo: null,
    lineText: []
  }
}

/** What the bar says about the range, before i18n gives it words. */
export type RangeLabel =
  | { kind: 'file' }
  | { kind: 'line'; side: SelectionSide; line: number }
  | { kind: 'range'; side: SelectionSide; start: number; end: number }
  | { kind: 'mixed'; startSide: SelectionSide; start: number; endSide: SelectionSide; end: number }

export function rangeLabelOf(sel: ReviewSelection): RangeLabel {
  if (sel.subjectType === 'FILE' || sel.line === undefined || sel.side === undefined) {
    return { kind: 'file' }
  }
  if (sel.startLine === undefined || sel.startSide === undefined) {
    return { kind: 'line', side: sel.side, line: sel.line }
  }
  if (sel.startSide === sel.side) {
    return { kind: 'range', side: sel.side, start: sel.startLine, end: sel.line }
  }
  return {
    kind: 'mixed',
    startSide: sel.startSide,
    start: sel.startLine,
    endSide: sel.side,
    end: sel.line
  }
}

// ── The keyboard (spec §5.1) ────────────────────────────────────────────────

/** What a key does on a focused gutter. `null` = not ours; let it through. */
export type GutterKeyAction =
  { kind: 'move'; delta: -1 | 1; extend: boolean } | { kind: 'toggle' } | { kind: 'clear' }

/**
 * Arrow Up/Down move focus; Shift+Arrow extends; Enter / Space select (again:
 * clear); Esc clears. Kept as a pure table so the pane holds no key names — and
 * so it can be tested without a DOM.
 */
export function gutterKeyAction(key: string, shift: boolean): GutterKeyAction | null {
  if (key === 'ArrowDown') return { kind: 'move', delta: 1, extend: shift }
  if (key === 'ArrowUp') return { kind: 'move', delta: -1, extend: shift }
  if (key === 'Enter' || key === ' ') return { kind: 'toggle' }
  if (key === 'Escape') return { kind: 'clear' }
  return null
}

// ── When a live selection survives a new snapshot (spec §4.2) ───────────────

/** The one-line disclosed clear. SHAs are short; ref names never appear. */
export type SelectionNotice =
  | { kind: 'clamp' }
  | { kind: 'head-moved'; from: string; to: string }
  | { kind: 'base-moved'; from: string; to: string }

export interface SnapshotFacts {
  baseSha: string | null
  headSha: string | null
  paths: ReadonlySet<string>
}

export type SnapshotVerdict = { keep: true } | { keep: false; notice: SelectionNotice | null }

/**
 * What a freshly landed snapshot does to the live selection.
 *
 * `null` (a non-silent load, a load error, a reset) clears with no notice. A
 * different head or base commit clears WITH one — the selection is anchored to
 * the commit it was read on, and keeping it would let a stale range be re-used
 * against a head the operator has not read. The same commits keep it, but only
 * while the file is still expanded.
 */
export function judgeSnapshot(
  sel: ReviewSelection,
  next: SnapshotFacts | null,
  fileExpanded: boolean
): SnapshotVerdict {
  if (!next) return { keep: false, notice: null }
  if (next.headSha !== sel.headSha) {
    return {
      keep: false,
      notice: next.headSha
        ? { kind: 'head-moved', from: shortSha(sel.headSha), to: shortSha(next.headSha) }
        : null
    }
  }
  if (next.baseSha !== sel.baseSha) {
    return {
      keep: false,
      notice: next.baseSha
        ? { kind: 'base-moved', from: shortSha(sel.baseSha), to: shortSha(next.baseSha) }
        : null
    }
  }
  if (!next.paths.has(sel.path) || !fileExpanded) return { keep: false, notice: null }
  return { keep: true }
}
