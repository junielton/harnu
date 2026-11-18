import { defineStore } from 'pinia'
import { reactive } from 'vue'
import type { WalkIpcError, WalkLoad } from '../../../preload'
import { explainAction, freshUi, tickExtra, type WalkData, type WalkUi } from '../lib/walk-view'

/**
 * Guided walks S-3: what each open walk pane holds, and the operator's outcomes sent to main.
 *
 * Main owns the walk and its runs (`src/main/walk/`): this store never decides a rule, it asks the main side to
 * apply one operator step (`walk:operate`, which runs the SAME machine the pane draws with) and shows what comes
 * back. What lives here is only ephemeral pane state (`WalkUi`: which card is open, whether the failure form is
 * up) and the last read of the run. The dev-only `HARNU_WALK_CHECK_WAIT_MS` is read in main (`walk-ipc.ts`) and
 * arrives as `waitMs` in every load.
 *
 * Nothing here settles a criterion, runs a command or sends a turn by itself: the service writes the turn an
 * outcome owes in the same file write as the step (the outbox) and delivers it.
 */

export interface PaneWalk {
  paneId: string
  folder: string
  walkId: string
  runId: string
  data: WalkData | null
  /** Why there is no data: the walk was deleted, or main refused. */
  missing: boolean
  ui: WalkUi
  /** The last operator step main refused, for one quiet line. */
  refusal: string | null
  /** When the cursor last moved to a new check (the Done debounce of AC-14). */
  servedAt: number | null
  /** The check the pane last showed, to know when the cursor moved. */
  cursor: string | null
  /** An operator step is in flight to main: a second press meanwhile is dropped, never queued behind it. */
  busy: boolean
  /** When each question to the session was sent, so its answer (a later deepening / card) ends the "asking". */
  askedAt: Record<string, number>
}

const isRefusal = (x: unknown): x is WalkIpcError =>
  typeof x === 'object' && x !== null && (x as { ok?: unknown }).ok === false

const cursorOf = (d: WalkData): string | null => d.run.cursor

export const useWalkStore = defineStore('walk', () => {
  const panes = reactive(new Map<string, PaneWalk>())

  function get(paneId: string): PaneWalk | undefined {
    return panes.get(paneId)
  }

  function apply(p: PaneWalk, load: WalkLoad): void {
    const prevCursor = p.cursor
    p.data = load as unknown as WalkData
    p.missing = false
    const cur = cursorOf(p.data)
    if (cur !== prevCursor) {
      p.cursor = cur
      p.servedAt = Date.now()
      // a new check: its own card is closed, the failure form is down
      p.ui.explainOpen = false
      p.ui.formOpen = false
    }
    if (p.data.run.state !== 'live') {
      p.ui.roadmapOpen = false
      p.ui.formOpen = false
    }
    // a question the session answered: a deepening (or a simpler card) written after it was asked
    for (const id of [...p.ui.asking.explain]) {
      const at = p.askedAt[`explain:${id}`] ?? 0
      if (p.data.deepenings.some((d) => d.checkId === id && d.at >= at)) {
        p.ui.asking.explain = p.ui.asking.explain.filter((x) => x !== id)
        if (cur === id) p.ui.explainOpen = true
      }
    }
    for (const id of [...p.ui.asking.simpler]) {
      const at = p.askedAt[`simpler:${id}`] ?? 0
      if (p.data.simpler.some((d) => d.checkId === id && d.at >= at))
        p.ui.asking.simpler = p.ui.asking.simpler.filter((x) => x !== id)
    }
  }

  async function reload(paneId: string): Promise<void> {
    const p = panes.get(paneId)
    if (!p) return
    const res = await window.api.walkLoad({ folder: p.folder, walkId: p.walkId, runId: p.runId })
    if (isRefusal(res)) {
      // a walk that was deleted (or a run that was discarded): the pane shows its empty state
      p.missing = true
      p.data = null
      return
    }
    apply(p, res)
  }

  let listening = false
  /** What a verb writes (`walk_report`, `walk_extend`) reaches the pane without the operator doing anything. */
  function listen(): void {
    if (listening || typeof window === 'undefined' || !window.api?.onWalkChanged) return
    listening = true
    window.api.onWalkChanged(({ folder, walkId }) => walkChanged(folder, walkId))
  }

  /** A pane mounted: read the run, watch the walk for what a session writes, and offer waiting turns again. */
  async function attach(a: {
    paneId: string
    folder: string
    walkId: string
    runId: string
    /** Opened on a past run (from the library): an ended run is shown read-only. */
    past?: boolean
  }): Promise<void> {
    listen()
    const have = panes.get(a.paneId)
    if (have && have.walkId === a.walkId && have.runId === a.runId) {
      have.ui.past = a.past === true
      await reload(a.paneId)
      return
    }
    const { past, ...ids } = a
    panes.set(a.paneId, {
      ...ids,
      data: null,
      missing: false,
      ui: { ...freshUi(), past: past === true },
      refusal: null,
      servedAt: null,
      cursor: null,
      busy: false,
      askedAt: {}
    })
    void window.api.walkWatch({ folder: a.folder, walkId: a.walkId, on: true })
    await reload(a.paneId)
    // turn replay has no timer of its own: the pane asks for it when it comes up
    void window.api.walkReplay({ folder: a.folder })
  }

  function detach(paneId: string): void {
    const p = panes.get(paneId)
    if (!p) return
    void window.api.walkWatch({ folder: p.folder, walkId: p.walkId, on: false })
    panes.delete(paneId)
  }

  /** Re-read every pane that shows `walkId` (a verb wrote the walk, or a turn was delivered). */
  function walkChanged(folder: string, walkId: string): void {
    for (const p of panes.values())
      if (p.walkId === walkId && p.folder === folder) void reload(p.paneId)
  }

  /** Point a pane at another run (a re-run, the run selector) or another walk (the re-run offer). */
  async function follow(
    paneId: string,
    runId: string,
    walkId?: string,
    opts: { past?: boolean } = {}
  ): Promise<void> {
    const p = panes.get(paneId)
    if (!p) return
    if (walkId && walkId !== p.walkId) {
      void window.api.walkWatch({ folder: p.folder, walkId: p.walkId, on: false })
      p.walkId = walkId
      void window.api.walkWatch({ folder: p.folder, walkId, on: true })
    }
    p.runId = runId
    p.cursor = null
    p.ui = { ...freshUi(), past: opts.past === true }
    await reload(paneId)
  }

  // ---- the operator's outcomes -------------------------------------------------------------------

  /** Apply one operator step in main and show the run it leaves. Returns the refusal code, or `null`. */
  async function operate(
    paneId: string,
    op: string,
    extra: { line?: string; shot?: string; checkId?: string; waitMs?: number } = {}
  ): Promise<string | null> {
    const p = panes.get(paneId)
    if (!p) return 'NO_PANE'
    p.refusal = null
    p.busy = true
    let res: Awaited<ReturnType<typeof window.api.walkOperate>>
    try {
      res = await window.api.walkOperate({
        folder: p.folder,
        walkId: p.walkId,
        runId: p.runId,
        op,
        ...extra
      })
    } finally {
      p.busy = false
    }
    if (isRefusal(res)) {
      p.refusal = res.error.code
      await reload(paneId) // the run may have moved under us (a late report); draw what is true
      return res.error.code
    }
    if (isRefusal(res.load)) {
      p.refusal = res.load.error.code
      return res.load.error.code
    }
    apply(p, res.load)
    return null
  }

  /** Explain more: reveal what the script prepared, fold it back, or ask the session (a toggle, never a move). */
  async function toggleExplain(paneId: string): Promise<void> {
    const p = panes.get(paneId)
    if (!p?.data || p.data.run.cursor === null) return
    const id = p.data.run.cursor
    const act = explainAction(p.data, p.ui, id)
    if (act === 'fold') {
      p.ui.explainOpen = false
      return
    }
    if (act === 'reveal') {
      p.ui.explainOpen = true
      if (!p.data.tick.revealed.includes(id)) {
        const res = await window.api.walkTick({
          folder: p.folder,
          walkId: p.walkId,
          runId: p.runId,
          checkId: id
        })
        if (!isRefusal(res)) p.data.tick = res.tick
      }
      return
    }
    // nothing prepared: ask the session, and show a quiet "Asking…" while it answers
    if (p.ui.asking.explain.includes(id)) return
    p.ui.asking.explain = [...p.ui.asking.explain, id]
    p.askedAt[`explain:${id}`] = Date.now()
    const err = await operate(paneId, 'explain')
    if (err) p.ui.asking.explain = p.ui.asking.explain.filter((x) => x !== id)
  }

  /** I didn't get this step: ask for the same check said more simply. A later press replaces the card. */
  async function askSimpler(paneId: string): Promise<void> {
    const p = panes.get(paneId)
    if (!p?.data || p.data.run.cursor === null) return
    const id = p.data.run.cursor
    if (p.ui.asking.simpler.includes(id)) return
    p.ui.asking.simpler = [...p.ui.asking.simpler, id]
    p.askedAt[`simpler:${id}`] = Date.now()
    const err = await operate(paneId, 'simpler')
    if (err) p.ui.asking.simpler = p.ui.asking.simpler.filter((x) => x !== id)
  }

  /** Tick or untick one extra check. Saved per run; it never blocks Done. */
  async function tick(paneId: string, checkId: string, extraId: string): Promise<void> {
    const p = panes.get(paneId)
    if (!p?.data) return
    const next = tickExtra(p.data.tick, checkId, extraId)
    p.data.tick = next // optimistic: the box answers at once
    await window.api.walkTick({
      folder: p.folder,
      walkId: p.walkId,
      runId: p.runId,
      checkId,
      ticked: next.ticked[checkId] ?? []
    })
  }

  // ---- screenshots, links, the re-run offer ------------------------------------------------------

  /** Save a pasted image inside the run's folder; the absolute path or a refusal code. */
  async function saveShot(
    paneId: string,
    bytes: Uint8Array
  ): Promise<{ ok: true; path: string; name: string } | { ok: false; code: string }> {
    const p = panes.get(paneId)
    if (!p) return { ok: false, code: 'NO_PANE' }
    const res = await window.api.walkSaveShot({
      folder: p.folder,
      walkId: p.walkId,
      runId: p.runId,
      data: bytes
    })
    return isRefusal(res) ? { ok: false, code: res.error.code } : res
  }

  /** Accept "Re-run the saved walk?": the saved walk starts run n + 1 and the new walk (never started) is gone. */
  async function rerunSaved(paneId: string): Promise<string | null> {
    const p = panes.get(paneId)
    if (!p?.data?.saved) return 'NO_OFFER'
    const res = await window.api.walkRerunSaved({
      folder: p.folder,
      newWalkId: p.walkId,
      newRunId: p.runId,
      savedWalkId: p.data.saved.walkId
    })
    if (isRefusal(res)) return res.error.code
    return `${res.walkId}:${res.runId}`
  }

  /** The pane of a run that never started was closed: that run goes, the walk stays. */
  async function discardIfReady(paneId: string): Promise<void> {
    const p = panes.get(paneId)
    if (p?.data?.run.state !== 'ready') return
    await window.api.walkDiscardReady({ folder: p.folder, walkId: p.walkId, runId: p.runId })
  }

  // ---- the library, re-run and export (S-4) -------------------------------------------------------

  /**
   * Re-run a walk: a fresh run n + 1 with every check to do, or, while a run of the walk is live, that live run
   * (`kind: 'live'`). Earlier runs are never touched.
   */
  async function rerun(
    folder: string,
    walkId: string
  ): Promise<
    | { ok: true; walkId: string; runId: string; kind: 'rerun' | 'reused' | 'live' }
    | { ok: false; code: string }
  > {
    const res = await window.api.walkRerun({ folder, walkId })
    return isRefusal(res) ? { ok: false, code: res.error.code } : res
  }

  /** Export a run as Markdown into the walk's own folder: the path of the file, or a refusal code. */
  async function exportRun(
    folder: string,
    walkId: string,
    runId?: string
  ): Promise<{ ok: true; path: string } | { ok: false; code: string }> {
    const res = await window.api.walkExport({ folder, walkId, ...(runId ? { runId } : {}) })
    return res.ok ? { ok: true, path: res.path } : { ok: false, code: res.error.code }
  }

  async function replay(paneId: string): Promise<void> {
    const p = panes.get(paneId)
    if (!p) return
    await window.api.walkReplay({ folder: p.folder })
    await reload(paneId)
  }

  return {
    panes,
    get,
    attach,
    detach,
    reload,
    walkChanged,
    follow,
    operate,
    toggleExplain,
    askSimpler,
    tick,
    saveShot,
    rerunSaved,
    rerun,
    exportRun,
    discardIfReady,
    replay
  }
})
