import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { Run, SchedulerState, Worker } from '../../../preload'

/**
 * Scheduler workers — renderer store (T294 / T291 U4). Thin write-through
 * cache over the `window.api.scheduler*` IPC surface, mirroring `push.ts`:
 * every mutation persists through main and re-adopts what came back, so a
 * field always shows what was actually written rather than an optimistic
 * guess (main mints a worker id, and a failed/timed-out tick can change
 * `failureStreak`/`enabled` out from under an in-flight edit).
 *
 * `save()` debounces 300ms **per worker id** — the same inline pattern
 * `EndpointsPane`/`PushChannelsPane`/`HibernationPolicyPane` use for a text
 * field, just centralized here instead of duplicated per component, since
 * the Settings tab edits many fields on the same worker. Keying the debounce
 * table by id (rather than one shared timer) means editing two different
 * workers back-to-back never cancels the first one's pending write.
 */
export const useSchedulerStore = defineStore('scheduler', () => {
  const workers = ref<Worker[]>([])
  const runsByWorker = ref<Record<string, Run[]>>({})
  const runningIds = ref<string[]>([])
  const selectedId = ref<string | null>(null)
  const loaded = ref(false)

  let unsubChanged: (() => void) | null = null
  const saveTimers = new Map<string, ReturnType<typeof setTimeout>>()
  const pendingDrafts = new Map<string, Partial<Worker>>()

  function applyState(state: SchedulerState): void {
    workers.value = state.workers
    runningIds.value = state.runningIds
  }

  async function init(): Promise<void> {
    workers.value = await window.api.schedulerList()
    loaded.value = true
    unsubChanged?.()
    unsubChanged = window.api.onSchedulerChanged(applyState)
  }

  function dispose(): void {
    unsubChanged?.()
    unsubChanged = null
    for (const timer of saveTimers.values()) clearTimeout(timer)
    saveTimers.clear()
    pendingDrafts.clear()
  }

  /**
   * IPC payloads must be structured-clone-safe; Vue's reactive proxies throw
   * `DataCloneError` at the contextBridge. A worker is tiny, so a JSON
   * round-trip is the simplest deep-unwrap.
   */
  function toPlain<T>(v: T): T {
    return JSON.parse(JSON.stringify(v)) as T
  }

  /** Flush `id`'s pending draft immediately, bypassing the debounce. */
  async function flush(id: string): Promise<void> {
    const timer = saveTimers.get(id)
    if (timer) clearTimeout(timer)
    saveTimers.delete(id)
    const draft = pendingDrafts.get(id)
    pendingDrafts.delete(id)
    if (!draft) return
    const result = await window.api.schedulerSave(toPlain(draft))
    workers.value = result
  }

  /**
   * Merge `patch` into worker `id`'s pending draft and (re)start its 300ms
   * debounce. Re-syncs `workers` from main's response once the write lands,
   * so a clamp/default main applies is reflected back into the field.
   */
  function save(id: string, patch: Partial<Worker>): void {
    const current = workers.value.find((w) => w.id === id)
    const draft = { ...(pendingDrafts.get(id) ?? current ?? {}), ...patch, id }
    pendingDrafts.set(id, draft)
    // Optimistic local echo so the field doesn't visibly revert while the
    // debounced write is still pending.
    workers.value = workers.value.map((w) => (w.id === id ? { ...w, ...patch } : w))

    const existing = saveTimers.get(id)
    if (existing) clearTimeout(existing)
    saveTimers.set(
      id,
      setTimeout(() => {
        void flush(id)
      }, 300)
    )
  }

  /** Create a worker with the given defaults, select it, and persist immediately. */
  async function create(draft: Partial<Worker>): Promise<Worker> {
    const result = await window.api.schedulerSave(toPlain(draft))
    workers.value = result
    const created = result.find((w) => !workers.value.some((existing) => existing.id === w.id))
    const worker = created ?? result[result.length - 1]
    selectedId.value = worker.id
    return worker
  }

  async function remove(id: string): Promise<void> {
    saveTimers.get(id) && clearTimeout(saveTimers.get(id))
    saveTimers.delete(id)
    pendingDrafts.delete(id)
    workers.value = await window.api.schedulerDelete(id)
    delete runsByWorker.value[id]
    if (selectedId.value === id) selectedId.value = null
  }

  async function runNow(id: string): Promise<void> {
    await flush(id)
    await window.api.schedulerRunNow(id)
  }

  async function stop(id: string): Promise<void> {
    await window.api.schedulerStop(id)
  }

  async function loadRuns(id: string): Promise<Run[]> {
    const runs = await window.api.schedulerRuns(id)
    runsByWorker.value = { ...runsByWorker.value, [id]: runs }
    return runs
  }

  return {
    workers,
    runsByWorker,
    runningIds,
    selectedId,
    loaded,
    init,
    dispose,
    save,
    flush,
    create,
    remove,
    runNow,
    stop,
    loadRuns
  }
})
