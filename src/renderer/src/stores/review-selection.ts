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
 * total (PRD D7). Selecting anything replaces it.
 *
 * U2b keeps the open review companion's view of the selection up to date (spec §6.5, §9),
 * **reactively and silently**: every change of the live selection is delivered after a
 * {@link SEND_DEBOUNCE_MS} pause, latest wins, as a hidden context row through the mod channel —
 * COORDINATES only, never text (`main` reads the lines). It never starts a turn, never writes
 * to the composer and never sends a message; the operator starts the conversation in the
 * companion. While a turn is running in the companion the update is held and only the latest is
 * sent when it completes. {@link last} is the one record for the current selection, followed
 * through `review:selection:state`. This is the only file in the renderer that calls the
 * review-selection IPC (send, compose, state). It reads the companion's `sessionId` through one
 * helpers getter and nothing else of the pane: what the companion says never comes this way
 * (spec §11 G-5).
 *
 * design.md §6 "Review selection (ReviewSelectionBar.vue, T257)".
 */

import { defineStore } from 'pinia'
import { computed, ref, shallowRef, watch } from 'vue'
import type { DiffFile } from '../../../main/review-core'
import type { SelectionStateEvent } from '../../../main/companion/review-selection-core'
import { useHelpersStore } from './helpers'
import { useReviewStore } from './review'
import {
  clampRange,
  fileSelection,
  judgeSnapshot,
  lineSelection,
  type LocalSelectionState,
  type RowPos,
  type ReviewSelection,
  type SelectionBase,
  type SelectionNotice
} from '../lib/review-selection'
import {
  applyStateEvent,
  refuse,
  refuseUnknown,
  startDelivery,
  turnRunning,
  type DeliveryRecord
} from '../lib/review-selection-delivery'

/** What {@link capture} returns and {@link restore} takes back. */
export interface CapturedSelection {
  sel: LocalSelectionState | null
  anchor: RowPos | null
}

/** Why the selection went away — recorded so a test (and a reader) can tell. */
export type ClearReason = 'user' | 'toggle' | 'esc' | 'collapse' | 'snapshot' | 'context' | 'reset'

/** How long the selection must sit still before the companion is told (latest wins). */
export const SEND_DEBOUNCE_MS = 500

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

  /** The single most recent delivery (spec §9.1). One record, never a list. */
  const last = shallowRef<DeliveryRecord | null>(null)
  /** A send is crossing IPC; a second click waits. */
  const sending = ref(false)
  /**
   * The open review companion's minted session id, or `null`. Read lazily so this
   * store does not build the helper stack until the bar asks.
   */
  const companionSid = computed<string | null>(() => useHelpersStore().reviewCompanionSessionId)

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

  /** The takeover closed: nothing may outlive it — the live selection, its notice and `last`. */
  function reset(): void {
    clear('reset')
    cancelPending()
    last.value = null
    sentRec = null
  }

  /** Drop the hint and the delivery record: the bar's Dismiss when nothing is selected. */
  function dismiss(): void {
    notice.value = null
    last.value = null
  }

  // ── Delivery (U2b) ──────────────────────────────────────────────────────

  let unsubscribe: (() => void) | null = null
  /** The pause that makes "latest wins" true: at most one send is ever pending. */
  let timer: ReturnType<typeof setTimeout> | null = null
  /** The record of the selection actually SENT last — it keeps following events while `last` moves on. */
  let sentRec: DeliveryRecord | null = null
  /** A newer selection is waiting for the running turn to complete. */
  let held = false
  /** A selection changed while a send was crossing IPC: send the latest when it lands. */
  let again = false

  function cancelPending(): void {
    if (timer) clearTimeout(timer)
    timer = null
    held = false
    again = false
  }

  function onState(ev: SelectionStateEvent): void {
    if (sentRec && ev.selectionId === sentRec.selectionId) sentRec = applyStateEvent(sentRec, ev)
    const cur = last.value
    if (cur && ev.selectionId === cur.selectionId) {
      const next = applyStateEvent(cur, ev)
      if (next !== cur) last.value = next
    }
    // The running turn is over (or the companion went away): send what was held, latest only.
    if (held && !turnRunning(sentRec)) {
      held = false
      void send()
    }
  }

  /** Subscribe once, BEFORE the first send, so no event of it can arrive unheard. */
  function ensureSubscribed(): void {
    if (unsubscribe) return
    if (typeof window.api.onReviewSelectionState !== 'function') return
    unsubscribe = window.api.onReviewSelectionState(onState)
  }

  /** The wire coordinates of a selection: the renderer-only fields (rows, line text) stay home. */
  function coordinatesOf(sel: ReviewSelection): ReviewSelection {
    return {
      id: sel.id,
      subjectType: sel.subjectType,
      path: sel.path,
      oldPath: sel.oldPath,
      ...(sel.line !== undefined ? { line: sel.line } : {}),
      ...(sel.side !== undefined ? { side: sel.side } : {}),
      ...(sel.startLine !== undefined ? { startLine: sel.startLine } : {}),
      ...(sel.startSide !== undefined ? { startSide: sel.startSide } : {}),
      baseSha: sel.baseSha,
      headSha: sel.headSha,
      prNumber: sel.prNumber
    }
  }

  /**
   * Deliver the live selection to the open review companion. Never opens a companion: with none
   * open it sends nothing and leaves no record, and the bar says so (spec §7.2).
   */
  async function send(): Promise<void> {
    const sel = live.value
    const snap = review.snapshot
    if (!sel || !snap) return
    if (sending.value) {
      again = true
      return
    }
    const sid = companionSid.value
    if (sid === null) {
      last.value = null
      return
    }
    ensureSubscribed()
    const start = startDelivery(sel)
    sentRec = start
    last.value = start
    sending.value = true
    try {
      const res = await window.api.reviewSelectionSend({
        folder: snap.folder,
        headRef: snap.head.ref,
        base: snap.base,
        companionSid: sid,
        selection: coordinatesOf(sel)
      })
      // `ok` only means QUEUED. The tracker's events own every state after it, and one may
      // already have landed: never move a record back to `queued` here.
      if (!res.ok) {
        if (sentRec?.selectionId === sel.id) sentRec = refuse(sentRec, res)
        const cur = last.value
        if (cur && cur.selectionId === sel.id) last.value = refuse(cur, res)
      }
    } catch {
      if (sentRec?.selectionId === sel.id) sentRec = refuseUnknown(sentRec)
      const cur = last.value
      if (cur && cur.selectionId === sel.id) last.value = refuseUnknown(cur)
    } finally {
      sending.value = false
      if (again) {
        again = false
        flush()
      }
    }
  }

  /** The pause is over: send the latest selection — or hold it while a turn runs. */
  function flush(): void {
    timer = null
    if (!live.value) return
    if (turnRunning(sentRec)) {
      held = true // latest wins: a later change just replaces what is waiting
      return
    }
    void send()
  }

  /** Every change of the live selection lands here: say "updating", then send after the pause. */
  function onLiveChange(sel: LocalSelectionState | null): void {
    cancelPending()
    if (!sel) return
    if (companionSid.value === null) {
      last.value = null // nothing is sent; the bar says so quietly
      return
    }
    last.value = startDelivery(sel)
    timer = setTimeout(flush, SEND_DEBOUNCE_MS)
  }

  watch(live, onLiveChange)
  // A companion opening while something is selected gets the current selection; one closing
  // takes the record with it.
  watch(companionSid, (sid) => {
    if (sid === null) {
      cancelPending()
      last.value = null
      sentRec = null
    } else if (live.value) onLiveChange(live.value)
  })

  /** "Try again": send the live selection now, without waiting out the pause. */
  function retry(): Promise<void> {
    cancelPending()
    return send()
  }

  /**
   * "Copy as text": put exactly what `review:selection:compose` returns on the clipboard.
   * It needs git and nothing else — no companion, no mod — so it is the way out of every
   * failure state but a moved head or base, where `main` refuses and the chip says so.
   */
  async function copy(): Promise<'copied' | 'refused' | 'failed'> {
    const sel = live.value
    const snap = review.snapshot
    if (!sel || !snap) return 'failed'
    try {
      const res = await window.api.reviewSelectionCompose({
        folder: snap.folder,
        headRef: snap.head.ref,
        base: snap.base,
        selection: coordinatesOf(sel)
      })
      if (!res.ok) {
        last.value = refuse(startDelivery(sel), res)
        return 'refused'
      }
      await navigator.clipboard.writeText(res.text)
      return 'copied'
    } catch {
      return 'failed'
    }
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
    last,
    sending,
    companionSid,
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
    dismiss,
    reset,
    send,
    retry,
    copy
  }
})
