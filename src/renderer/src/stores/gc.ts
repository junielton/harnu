import { defineStore } from 'pinia'
import { computed, ref, watch } from 'vue'
import type { GcPrefs } from '../../../main/gc/gc-prefs'
import type {
  GcCleanAck,
  GcJobDone,
  GcJobProgress,
  GcOpinion,
  GcOpinionDone,
  GcOpinionResult,
  GcSnapshot
} from '../../../main/gc/gc-wire'
import { i18n } from '../i18n'
import { formatBytes } from '../components/system-monitor-format'
import { refusalKey } from '../components/cleanup-gc-copy'
import {
  buildGcModel,
  cleanRequestFor,
  heroState,
  prunedSelection,
  type CleanRequest,
  type GcModel
} from '../lib/gc-model'
import {
  applyDone,
  applyProgress,
  attachJobs,
  blockStates,
  doneSummary,
  dropFinished,
  emptyJobs,
  failureFor,
  pillState,
  runningJob,
  type BlockJobState,
  type DoneSummary,
  type RefusalCode,
  type ItemFailure,
  type JobsState
} from '../lib/gc-jobs'
import {
  clearPending,
  markPending,
  opinionOf,
  pruneOpinions,
  recordOpinion,
  safeIds,
  type OpinionMap
} from '../lib/gc-opinion'
import { useNotificationsStore } from './notifications'
import { useUiStore } from './ui'

/**
 * Workspace GC — renderer store (T443, design.md "Workspace GC — unified Cleanup"). A thin cache over
 * the `window.api.gc*` IPC (S3): the last snapshot, the live job state, and the transient failures the
 * panel shows. It never decides what may be cleaned — main re-probes every item and refuses what it
 * must; this store only builds the request from what the operator was shown and reflects progress.
 *
 * The view never awaits `gc:clean`: it returns an ack at once and the work streams on `gc:progress`
 * and ends on `gc:done`.
 */

/** `--dur-slow`: how long a cleaned block stays on the map, faded, before the layout re-flows. */
export const FADE_MS = 220

/** The one place the clean payload crosses to the preload: ids, `expected` per id, `confirmed` for Needs review items. */
function sendClean(req: CleanRequest): Promise<GcCleanAck> {
  return window.api.gcClean(req.ids, req.options)
}

/** One sentence for the toast when items were refused up front: the code's own, or a count of several kinds. */
function refusalDescription(s: DoneSummary): string | undefined {
  const codes = Object.keys(s.refusals) as RefusalCode[]
  const { t } = i18n.global
  if (codes.length === 1) return t(refusalKey(codes[0]))
  if (codes.length > 1) return t('cleanup.gc.refusal.several', { n: s.refused })
  return undefined
}

export const useGcStore = defineStore('gc', () => {
  const snapshot = ref<GcSnapshot | null>(null)
  const jobs = ref<JobsState>(emptyJobs())
  const loading = ref(false)
  const loadError = ref<string | null>(null)
  /** Blocks that finished cleaning and have faded out: removed from the drawn model before the refresh. */
  const gone = ref<Set<string>>(new Set())
  /** Items the last run could not clean (or refused), kept for the panel's "what ran" and the pill. */
  const failures = ref<Map<string, ItemFailure>>(new Map())
  /** "Ask for an opinion": the verdicts received, and the ids whose answer is still on its way. */
  const opinions = ref<OpinionMap>(new Map())
  const pendingOpinions = ref<ReadonlySet<string>>(new Set())

  let unsubs: Array<() => void> = []
  let initialised = false
  const fadeTimers = new Set<ReturnType<typeof setTimeout>>()
  const scheduled = new Set<string>()
  /** Ids each opinion request named, to end their pending state if a result is lost. */
  const opinionJobs = new Map<string, string[]>()

  const model = computed<GcModel | null>(() => {
    const s = snapshot.value
    if (!s) return null
    if (gone.value.size === 0) return buildGcModel(s)
    return buildGcModel({ ...s, bundles: s.bundles.filter((b) => !gone.value.has(b.item.id)) })
  })

  // An opinion is about one state of one item: it goes when the snapshot shows a different head,
  // reason or bucket. The chip then disappears and asking again is a fresh question.
  watch(model, (m) => {
    if (m) opinions.value = pruneOpinions(opinions.value, m)
  })

  const prefs = computed<GcPrefs | null>(() => snapshot.value?.prefs ?? null)
  const running = computed(() => runningJob(jobs.value))
  const states = computed(() => blockStates(jobs.value))

  const hero = computed(() =>
    model.value
      ? heroState(model.value, running.value, prefs.value?.firstReportAcknowledged ?? false)
      : ({ kind: 'empty' } as const)
  )

  const attentionCount = computed(() => {
    const m = model.value
    if (!m) return 0
    let n = 0
    for (const id of failures.value.keys()) if (m.byId.has(id)) n++
    return n
  })
  const pill = computed(() => pillState(jobs.value, attentionCount.value))
  const reclaimableBytes = computed(() => model.value?.reclaimableBytes ?? 0)

  /** Faded-out or failed state of one block; null when it is just sitting there. */
  function blockState(id: string): BlockJobState | null {
    const live = states.value.get(id)
    if (live) return live
    return failures.value.has(id) ? 'failed' : null
  }

  function failureOf(id: string): ItemFailure | null {
    return failures.value.get(id) ?? failureFor(jobs.value, id)
  }

  async function refresh(): Promise<void> {
    try {
      snapshot.value = await window.api.gcSnapshot({ refresh: true })
      loadError.value = null
    } catch (e) {
      loadError.value = e instanceof Error ? e.message : String(e)
    }
  }

  function scheduleFade(ids: readonly string[]): void {
    for (const id of ids) {
      if (scheduled.has(id)) continue
      scheduled.add(id)
      const t = setTimeout(() => {
        fadeTimers.delete(t)
        gone.value = new Set(gone.value).add(id)
      }, FADE_MS)
      fadeTimers.add(t)
    }
  }

  function onProgress(p: GcJobProgress): void {
    jobs.value = applyProgress(jobs.value, p)
    scheduleFade(p.results.filter((r) => r.ok).map((r) => r.id))
  }

  function toast(d: GcJobDone): void {
    if (d.kind !== 'manual') return // an autopilot cycle is announced natively by main
    const s = doneSummary(d)
    if (s.tone === 'none') return
    const { t } = i18n.global
    const ui = useUiStore()
    const warning = s.tone === 'warning'
    const entry = {
      kind: warning ? ('warning' as const) : ('success' as const),
      title: warning
        ? t('cleanup.gc.toast.partial', { cleaned: s.cleaned, failed: s.failed })
        : t('cleanup.gc.toast.success', { size: formatBytes(s.freedBytes), count: s.cleaned }),
      description: refusalDescription(s) ?? d.error ?? undefined,
      timeoutMs: warning ? 8000 : 6000,
      target: { view: 'cleanup' as const },
      action: { label: t('cleanup.gc.toast.review'), handler: () => ui.openCleanup() }
    }
    // A toast shows only while the window is focused; otherwise the Activity entry stands in
    // (main raises the native notification).
    if (typeof document !== 'undefined' && document.hasFocus()) {
      ui.pushToast(entry)
    } else {
      useNotificationsStore().notify({
        ts: Date.now(),
        source: 'app',
        kind: warning ? 'warning' : 'success',
        title: entry.title,
        description: entry.description,
        target: entry.target
      })
    }
  }

  function onOpinionResult(r: GcOpinionResult): void {
    // Every id the request named gets exactly one result (a verdict, or a refusal), so this is
    // also what ends its pending state.
    pendingOpinions.value = clearPending(pendingOpinions.value, [r.id])
    if ('refused' in r || !model.value) return
    const { jobId: _jobId, ...opinion } = r
    opinions.value = recordOpinion(opinions.value, opinion, model.value)
  }

  /** The job is over: anything still marked pending for it was lost, so stop showing "Asking…". */
  function onOpinionDone(d: GcOpinionDone): void {
    const ids = opinionJobs.get(d.jobId)
    opinionJobs.delete(d.jobId)
    if (ids) pendingOpinions.value = clearPending(pendingOpinions.value, ids)
  }

  async function onDone(d: GcJobDone): Promise<void> {
    jobs.value = applyDone(jobs.value, d)
    const next = new Map(failures.value)
    for (const r of d.results) {
      if (r.ok) next.delete(r.id)
      else {
        const f = failureFor(jobs.value, r.id)
        if (f) next.set(r.id, f)
      }
    }
    failures.value = next
    toast(d)
    await refresh()
    // The snapshot is authoritative again: forget the transient fade bookkeeping.
    jobs.value = dropFinished(jobs.value)
    gone.value = new Set()
    scheduled.clear()
    for (const t of fadeTimers) clearTimeout(t)
    fadeTimers.clear()
  }

  async function init(): Promise<void> {
    if (initialised) return
    initialised = true
    loading.value = true
    try {
      for (const u of unsubs) u()
      unsubs = [
        window.api.onGcProgress(onProgress),
        window.api.onGcDone((d) => void onDone(d)),
        // A cycle finished (autopilot tick or manual): the world changed.
        window.api.onGcCycle(() => void refresh()),
        window.api.onGcOpinionResult(onOpinionResult),
        window.api.onGcOpinionDone(onOpinionDone)
      ]
      const [snap, live] = await Promise.all([
        window.api.gcSnapshot(),
        window.api.gcJobs().catch(() => [])
      ])
      snapshot.value = snap
      jobs.value = attachJobs(jobs.value, live)
    } catch (e) {
      loadError.value = e instanceof Error ? e.message : String(e)
      initialised = false
    } finally {
      loading.value = false
    }
  }

  function dispose(): void {
    for (const u of unsubs) u()
    unsubs = []
    initialised = false
  }

  // ---- actions ---------------------------------------------------------------------------------

  function startClean(
    ids: readonly string[],
    mode: 'ready' | 'review'
  ): Promise<GcCleanAck | null> {
    const m = model.value
    if (!m) return Promise.resolve(null)
    const req = cleanRequestFor(m, ids, mode)
    if (req.ids.length === 0) return Promise.resolve(null)
    failures.value = new Map() // a new run replaces what the last one left behind
    return sendClean(req)
  }

  /** The hero: every proven-ready item, behind the one confirm dialog. */
  const cleanReady = (ids?: readonly string[]): Promise<GcCleanAck | null> =>
    startClean(ids ?? model.value?.ready.map((b) => b.id) ?? [], 'ready')

  /** Remove selected: the operator confirmed each of these Needs review items. */
  const cleanSelected = (ids: readonly string[]): Promise<GcCleanAck | null> =>
    startClean(ids, 'review')

  /**
   * "Ask for an opinion" on Needs review items (orphan volumes included). Advisory and read-only:
   * it only fills `opinions`. Items already being asked about are not asked twice, and an item that
   * is not Needs review is not sent at all.
   */
  async function askOpinion(ids: readonly string[]): Promise<void> {
    const m = model.value
    if (!m) return
    const wanted = [...new Set(ids)].filter(
      (id) => m.byId.get(id)?.bucket === 'review' && !pendingOpinions.value.has(id)
    )
    if (wanted.length === 0) return
    pendingOpinions.value = markPending(pendingOpinions.value, wanted)
    try {
      const ack = await window.api.gcOpinion(wanted)
      opinionJobs.set(ack.jobId, wanted)
    } catch (e) {
      pendingOpinions.value = clearPending(pendingOpinions.value, wanted)
      useUiStore().pushToast({
        kind: 'danger',
        title: i18n.global.t('cleanup.gc.opinion.failed'),
        description: e instanceof Error ? e.message : String(e),
        timeoutMs: 8000
      })
    }
  }

  const opinionFor = (id: string): GcOpinion | null => opinionOf(opinions.value, id)
  const isAsking = (id: string): boolean => pendingOpinions.value.has(id)
  /** What "Remove the ones marked safe" pre-selects. */
  const safeOpinionIds = computed(() => (model.value ? safeIds(opinions.value, model.value) : []))

  async function keep(id: string): Promise<void> {
    await window.api.gcKeep(id)
    await refresh()
  }

  /** Keep several at once (the selection bar): one refresh at the end, not one per id. */
  async function keepMany(ids: readonly string[]): Promise<void> {
    for (const id of ids) await window.api.gcKeep(id)
    await refresh()
  }

  async function unkeep(id: string): Promise<void> {
    await window.api.gcUnkeep(id)
    await refresh()
  }

  /** "Enable autopilot" on the first-cycle banner: acknowledge the report AND turn the pref on. */
  async function enableAutopilot(): Promise<void> {
    const current = prefs.value ?? (await window.api.gcPrefs())
    await window.api.gcAckFirstReport()
    await window.api.gcSetPrefs({ ...current, autopilot: true })
    await refresh()
  }

  /** "Not now": acknowledge the report without turning the autopilot on. */
  async function dismissFirstReport(): Promise<void> {
    await window.api.gcAckFirstReport()
    await refresh()
  }

  /** Settings: always the whole object — main fills a missing field with its default. */
  async function savePrefs(patch: Partial<GcPrefs>): Promise<GcPrefs> {
    const base = prefs.value ?? (await window.api.gcPrefs())
    const saved = await window.api.gcSetPrefs({ ...base, ...patch })
    if (snapshot.value) snapshot.value = { ...snapshot.value, prefs: saved }
    return saved
  }

  /** Selection that survives a refresh only for the items that are still Needs review. */
  function pruneSelection(selection: ReadonlySet<string>): Set<string> {
    return model.value ? prunedSelection(model.value, selection) : new Set()
  }

  return {
    snapshot,
    jobs,
    loading,
    loadError,
    failures,
    model,
    prefs,
    running,
    hero,
    pill,
    attentionCount,
    reclaimableBytes,
    blockState,
    failureOf,
    init,
    dispose,
    refresh,
    cleanReady,
    cleanSelected,
    keep,
    keepMany,
    unkeep,
    enableAutopilot,
    dismissFirstReport,
    savePrefs,
    pruneSelection,
    opinions,
    pendingOpinions,
    safeOpinionIds,
    askOpinion,
    opinionFor,
    isAsking
  }
})
