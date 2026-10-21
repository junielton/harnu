/**
 * T257 U1 — the Review diff's live selection.
 *
 * A separate store from `stores/review.ts` on purpose (spec §4.1): that file's
 * `window.api` surface is pinned to five names and its no-model property is a
 * property of the file being short. This store READS the review store — the
 * snapshot's commits and the per-file collapse map — and the review store has no
 * reason to know the selection exists.
 *
 * There is exactly one live selection, never a list, so there is nothing to
 * total (PRD D7). Selecting anything replaces it. This unit delivers nothing:
 * no IPC, no companion — the selection is local state and a highlight.
 *
 * design.md §6 "Review selection (ReviewSelectionBar.vue, T257)".
 */

import { defineStore } from 'pinia'
import { ref, shallowRef, watch } from 'vue'
import type { DiffFile } from '../../../main/review-core'
import { useReviewStore } from './review'
import {
  clampRange,
  fileSelection,
  judgeSnapshot,
  lineSelection,
  type LocalSelectionState,
  type RowPos,
  type SelectionBase,
  type SelectionNotice
} from '../lib/review-selection'

/** What {@link capture} returns and {@link restore} takes back. */
export interface CapturedSelection {
  sel: LocalSelectionState | null
  anchor: RowPos | null
}

/** Why the selection went away — recorded so a test (and a reader) can tell. */
export type ClearReason = 'user' | 'toggle' | 'esc' | 'collapse' | 'snapshot' | 'context' | 'reset'

function mintId(): string {
  const uuid =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`
  return `sel_${uuid}`
}

export const useReviewSelectionStore = defineStore('reviewSelection', () => {
  const review = useReviewStore()

  /** `shallowRef`: replaced wholesale on every change, never mutated in place. */
  const live = shallowRef<LocalSelectionState | null>(null)
  /** A one-line disclosed clear or clamp, shown by the bar. */
  const notice = ref<SelectionNotice | null>(null)
  const lastCleared = ref<ClearReason | null>(null)

  /** Where the current range began — a shift-click and a drag extend from it. */
  let anchor: RowPos | null = null

  /** The commit pair the diff on screen was read on. `null` = nothing anchorable. */
  function baseOf(): SelectionBase | null {
    const snap = review.snapshot
    if (!snap || !snap.baseSha || !snap.head.sha) return null
    return {
      baseSha: snap.baseSha,
      headSha: snap.head.sha,
      prNumber: snap.head.prNumber ?? null
    }
  }

  function fileOf(path: string): DiffFile | null {
    return review.snapshot?.files.find((f) => f.path === path) ?? null
  }

  function commit(
    next: LocalSelectionState,
    from: RowPos | null,
    hint: SelectionNotice | null
  ): void {
    live.value = next
    anchor = from
    notice.value = hint
    lastCleared.value = null
  }

  /** Select one row, replacing whatever was selected. */
  function select(path: string, hunk: number, row: number): boolean {
    const file = fileOf(path)
    const base = baseOf()
    if (!file || !base) return false
    const next = lineSelection(file, hunk, row, row, base, mintId())
    if (!next) return false
    commit(next, { hunk, row }, null)
    return true
  }

  /**
   * Extend the current range to `row` — a shift-click, a drag step or
   * Shift+Arrow, all through this one door. Never leaves the anchor's hunk:
   * past an edge it clamps and says so.
   */
  function extend(path: string, hunk: number, row: number): boolean {
    const cur = live.value
    if (!cur || cur.subjectType !== 'LINE' || cur.hunkIndex === null || !anchor) {
      return select(path, hunk, row)
    }
    const file = fileOf(cur.path)
    const base = baseOf()
    if (!file || !base) return false
    let targetHunk = hunk
    if (path !== cur.path) {
      // Another file: before the anchor's file clamps to the hunk's first row,
      // after it to the last.
      const files = review.snapshot?.files ?? []
      const here = files.findIndex((f) => f.path === cur.path)
      const there = files.findIndex((f) => f.path === path)
      if (there < 0) return false
      targetHunk = there < here ? -1 : Number.POSITIVE_INFINITY
    }
    const range = clampRange(anchor, { hunk: targetHunk, row }, file.hunks[anchor.hunk].rows.length)
    const next = lineSelection(file, anchor.hunk, range.from, range.to, base, mintId())
    if (!next) return false
    commit(next, anchor, range.clamped ? { kind: 'clamp' } : null)
    return true
  }

  /** Click on a row: select it, or clear it when it already is the only selected row. */
  function toggleRow(path: string, hunk: number, row: number): void {
    if (isOnlyRow(path, hunk, row)) clear('toggle')
    else select(path, hunk, row)
  }

  function isOnlyRow(path: string, hunk: number, row: number): boolean {
    const cur = live.value
    return (
      !!cur &&
      cur.subjectType === 'LINE' &&
      cur.path === path &&
      cur.hunkIndex === hunk &&
      cur.rowFrom === row &&
      cur.rowTo === row
    )
  }

  /** Select the whole file, replacing a line range. */
  function selectFile(path: string): boolean {
    const file = fileOf(path)
    const base = baseOf()
    if (!file || !base) return false
    commit(fileSelection(file, base, mintId()), null, null)
    return true
  }

  function toggleFile(path: string): void {
    if (isFileSelected(path)) clear('toggle')
    else selectFile(path)
  }

  function isFileSelected(path: string): boolean {
    return live.value?.subjectType === 'FILE' && live.value.path === path
  }

  /**
   * The selection AND where its range began, for a drag that may be cancelled.
   * The anchor is not recoverable from the selection: a range made by shift-
   * clicking upward starts at its LAST row, so rebuilding it from `rowFrom`
   * would silently move the anchor.
   */
  function capture(): CapturedSelection {
    return { sel: live.value, anchor }
  }

  /** Put back what a cancelled drag started from, anchor included. */
  function restore(prev: CapturedSelection): void {
    live.value = prev.sel
    anchor = prev.sel ? prev.anchor : null
    notice.value = null
  }

  function clear(reason: ClearReason): void {
    live.value = null
    anchor = null
    notice.value = null
    lastCleared.value = reason
  }

  /** Drop the one-line notice without touching the selection. */
  function dismissNotice(): void {
    notice.value = null
  }

  /** The takeover closed: nothing may outlive it. */
  function reset(): void {
    clear('reset')
  }

  // ── The §4.2 triggers that come from the review store ─────────────────────
  // `sync`: the selection must never be sendable for a moment against a diff it
  // no longer belongs to, so these run inside the very mutation that caused them.

  watch(
    () => review.snapshot,
    (next) => {
      const cur = live.value
      if (!next) notice.value = null
      if (!cur) return
      const verdict = judgeSnapshot(
        cur,
        next
          ? {
              baseSha: next.baseSha,
              headSha: next.head.sha,
              paths: new Set(next.files.map((f) => f.path))
            }
          : null,
        review.isExpanded(cur.path)
      )
      if (verdict.keep) return
      clear('snapshot')
      notice.value = verdict.notice
    },
    { flush: 'sync' }
  )

  // A file the operator collapsed (header click, a viewed mark, a re-seed) takes
  // its selection with it — a hidden selection must not stay sendable.
  watch(
    () => review.expanded,
    (cur, prev) => {
      const sel = live.value
      if (sel && prev?.[sel.path] === true && cur[sel.path] !== true) clear('collapse')
    },
    { flush: 'sync' }
  )

  return {
    live,
    notice,
    lastCleared,
    select,
    extend,
    toggleRow,
    selectFile,
    toggleFile,
    isFileSelected,
    isOnlyRow,
    capture,
    restore,
    clear,
    dismissNotice,
    reset
  }
})
