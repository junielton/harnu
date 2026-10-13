import { defineStore } from 'pinia'
import { computed, ref, watch } from 'vue'
import type { GcPrefs } from '../../../main/gc/gc-prefs'
import type {
  GcCleanAck,
  GcRecheckResult,
  GcJobDone,
  GcJobProgress,
  GcOpinion,
  GcOpinionDone,
  GcOpinionResult,
  GcRecoveryAction,
  GcRecoveryItem,
  GcSnapshot
} from '../../../main/gc/gc-wire'
import type { RemoteFacts } from '../../../main/gc/gc-remote-delete'
import { i18n } from '../i18n'
import { toIpc } from '../lib/to-ipc'
import { formatBytes } from '../components/system-monitor-format'
import { freedText } from '../lib/gc-freed'
import { refusalKey } from '../components/cleanup-gc-copy'
import {
  buildGcModel,
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
  needsAction,
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
  dropUnconfirmed,
  fingerprintOf,
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

/** `gc:opinion` takes at most this many ids per request (`OPINION_MAX_IDS` in main). */
const OPINION_BATCH = 100

/** `--dur-slow`: how long a cleaned block stays on the map, faded, before the layout re-flows. */
export const FADE_MS = 220

/** The one place the clean payload crosses to the preload: ids, `expected` per id, `confirmed` for Needs review items. */
function sendClean(req: CleanRequest): Promise<GcCleanAck> {
  return window.api.gcClean(toIpc(req.ids), toIpc(req.options))
}

/** One sentence for the toast when items were refused up front: the code's own, or a count of several kinds. */
function refusalDescription(s: DoneSummary): string | undefined {
  const codes = Object.keys(s.refusals) as RefusalCode[]
  const { t } = i18n.global
  let out: string | undefined
  if (codes.length === 1) out = t(refusalKey(codes[0]))
  else if (codes.length > 1) out = t('cleanup.gc.refusal.several', { n: s.refused })
  if (s.prepLeft > 0) {
    const left = t('cleanup.gc.refusal.prepLeftStack')
    out = out ? `${out} ${left}` : left
  }
  // A guided prep that could not be put back is the one thing the operator must know about.
  if (s.rollbackFailed > 0) {
    const warn = [t('cleanup.gc.refusal.rollbackFailed'), ...s.rollbackDetails].join(' ')
    out = out ? `${out} ${warn}` : warn
  }
  return out
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

  /**
   * The jobs that carry items the operator confirmed by hand (Needs review). Their toast says
   * "removed", not "ready items cleaned": they were never ready. Keyed by job, so a ready job queued
   * behind (or ahead of) a review job keeps its own wording.
   */
  const reviewJobs = new Set<string>()
  let unsubs: Array<() => void> = []
  let initialised = false
  const fadeTimers = new Set<ReturnType<typeof setTimeout>>()
  const scheduled = new Set<string>()
  /** What each asked item looked like when the question went out; an answer is bound to it. */
  const askedFingerprints = new Map<string, string>()
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
    if (!m) return
    opinions.value = pruneOpinions(opinions.value, m)
    void peekOpinions()
  })

  /**
   * Restores the chips after a reload: main keeps the opinions it already got, so for every Needs
   * review item that has no chip yet the store asks main's cache (never the model). An item is
   * peeked once per state: a later snapshot shows the same item the same way and skips it, and a
   * changed head or reason makes it a new question. Best effort: a failed peek just shows no chip.
   */
  const peeked = new Map<string, string>()
  async function peekOpinions(): Promise<void> {
    const m = model.value
    if (!m) return
    const fresh: string[] = []
    for (const b of m.review) {
      const fp = fingerprintOf(b)
      if (opinions.value.has(b.id) || pendingOpinions.value.has(b.id) || peeked.get(b.id) === fp) {
        continue
      }
      peeked.set(b.id, fp)
      fresh.push(b.id)
    }
    // A chip that main cached is checked again on every snapshot: main's key also covers what the
    // snapshot does not carry (the dirty files, the pull request state), so it alone can say the
    // answer still describes the item.
    const recheck = [...opinions.value]
      .filter(([id, o]) => o.durable && !pendingOpinions.value.has(id))
      .map(([id]) => id)
    const ids = [...fresh, ...recheck]
    for (let i = 0; i < ids.length; i += 500) {
      const slice = ids.slice(i, i + 500)
      try {
        const found = await window.api.gcOpinionCached(toIpc(slice))
        const now = model.value
        if (!now) continue
        for (const opinion of Object.values(found)) {
          // A fresher answer, or a request still in flight, beats what the cache held.
          if (opinions.value.has(opinion.id) || pendingOpinions.value.has(opinion.id)) continue
          opinions.value = recordOpinion(opinions.value, opinion, now)
        }
        const checked = recheck.filter((id) => slice.includes(id))
        opinions.value = dropUnconfirmed(opinions.value, checked, new Set(Object.keys(found)))
      } catch {
        // Best effort: a chip stays as it is, and a missing one stays off until the operator asks.
      }
    }
  }

  const prefs = computed<GcPrefs | null>(() => snapshot.value?.prefs ?? null)
  const running = computed(() => runningJob(jobs.value))
  const states = computed(() => blockStates(jobs.value))

  /**
   * "Not now" on the first-cycle banner. A snooze, not an acknowledgement: it lasts until the app
   * restarts, and never tells the engine the operator has seen the report.
   */
  const firstReportSnoozed = ref(false)

  const hero = computed(() =>
    model.value
      ? heroState(
          model.value,
          running.value,
          (prefs.value?.firstReportAcknowledged ?? false) || firstReportSnoozed.value
        )
      : ({ kind: 'empty' } as const)
  )

  const attentionCount = computed(() => {
    const m = model.value
    if (!m) return 0
    let n = 0
    // Only what needs the operator: their own Keep / never-clean refusals are settings, not problems.
    for (const [id, f] of failures.value) if (m.byId.has(id) && needsAction(f.refusal)) n++
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
    // A remote branch that stayed is a warning on a clean that otherwise worked: no "partial" title.
    const partial = s.failed > 0 || !!d.error
    const fromReview = reviewJobs.has(d.jobId)
    const entry = {
      kind: warning ? ('warning' as const) : ('success' as const),
      title: partial
        ? t('cleanup.gc.toast.partial', { cleaned: s.cleaned, failed: s.failed }, s.failed)
        : t(fromReview ? 'cleanup.gc.toast.successReview' : 'cleanup.gc.toast.success', {
            freed: freedText(t, s.freedBytes, s.trashedBytes),
            count: s.cleaned
          }),
      description:
        refusalDescription(s) ??
        d.error ??
        (s.remoteLeft
          ? t('cleanup.gc.toast.remoteLeft', { error: s.remoteLeft.error }, s.remoteLeft.count)
          : undefined),
      timeoutMs: warning ? 8000 : 6000,
      target: { view: 'cleanup' as const },
      // Both open Cleanup, where the journal ("Recent cleanups") sits under the map.
      action: {
        label: warning ? t('cleanup.gc.toast.review') : t('cleanup.gc.toast.viewJournal'),
        handler: () => ui.openCleanup()
      }
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
    // Every id the request named gets exactly one result (a verdict, a refusal, or a stale
    // marker), so this is also what ends its pending state.
    pendingOpinions.value = clearPending(pendingOpinions.value, [r.id])
    const askedFingerprint = askedFingerprints.get(r.id)
    askedFingerprints.delete(r.id)
    if ('refused' in r || 'stale' in r || !model.value) return
    const { jobId: _jobId, durable, ...opinion } = r
    // Bound to the item as it was when asked: if it moved since, the answer is dropped.
    opinions.value = recordOpinion(opinions.value, opinion, model.value, {
      askedFingerprint,
      durable: durable !== false
    })
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

  // ---- the prep journal (see main's gc-prep-journal.ts) ---------------------------------------------
  const camel = (s: string): string => s.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())
  /** What still needs the operator: an interrupted stack stop, a lock that was not put back. */
  const recovery = ref<GcRecoveryItem[]>([])
  /** Announced in Activity during this session, so a listing that comes back before the ack lands is quiet. */
  const announcedHere = new Set<string>()

  /**
   * Lists what main's journal wants the operator to know. Notices stay in `recovery` until answered;
   * each new one (or put-back report) is announced in Activity ONCE, and main is told, so it is kept
   * until acknowledged: an acknowledgement that fails is simply tried again at the next listing.
   */
  async function loadRecovery(): Promise<void> {
    let answer: unknown
    try {
      answer = await window.api.gcRecoveryList()
    } catch {
      return
    }
    if (!Array.isArray(answer)) return
    const items = answer as GcRecoveryItem[]
    recovery.value = items.filter((i) => i.state === 'notice')
    const { t } = i18n.global
    const notes = useNotificationsStore()
    const fresh = items.filter((i) => !i.announced)
    for (const r of fresh) {
      if (announcedHere.has(r.id)) continue
      announcedHere.add(r.id)
      const resolved = r.state === 'resolved'
      notes.notify({
        ts: Date.now(),
        source: 'app',
        kind: resolved ? 'success' : 'warning',
        title: t(
          `cleanup.gc.recovered.${resolved ? 'relocked' : camel(r.notice ?? 'stack-stopped')}`,
          {
            path: r.path
          }
        ),
        description: r.detail || undefined,
        target: { view: 'cleanup' as const }
      })
    }
    if (fresh.length > 0) {
      try {
        await window.api.gcRecoveryAck(fresh.map((r) => r.id))
      } catch {
        // main still has them as unannounced: the next listing acknowledges again
      }
    }
  }

  /** "Start again" / "Lock again" / "Leave stopped (dismiss)": main does it, the list is read again. */
  async function answerRecovery(id: string, action: GcRecoveryAction): Promise<void> {
    try {
      const r = await window.api.gcRecoveryAct(id, action)
      // A lock that is not the same worktree is not an error: the notice itself now says so.
      if (!r.ok && !r.mismatch) {
        useUiStore().pushToast({
          kind: 'danger',
          title: i18n.global.t('cleanup.gc.recovered.failed'),
          description: r.error,
          timeoutMs: 8000
        })
      }
    } catch (e) {
      useUiStore().pushToast({
        kind: 'danger',
        title: i18n.global.t('cleanup.gc.recovered.failed'),
        description: e instanceof Error ? e.message : String(e),
        timeoutMs: 8000
      })
    } finally {
      await loadRecovery()
    }
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
        // The prep journal changed (boot recovery finished, a notice was answered).
        window.api.onGcRecoveryChanged(() => void loadRecovery()),
        window.api.onGcOpinionResult(onOpinionResult),
        window.api.onGcOpinionDone(onOpinionDone)
      ]
      const [snap, live] = await Promise.all([
        window.api.gcSnapshot(),
        window.api.gcJobs().catch(() => [])
      ])
      snapshot.value = snap
      jobs.value = attachJobs(jobs.value, live)
      void loadRecovery()
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

  /**
   * Send a clean request that was captured when its confirm dialog opened. The store never rebuilds the
   * facts from the current model: what the operator confirmed is what main compares (a request whose
   * facts have since moved is refused by the view before it gets here, and by main if it slips through).
   */
  function submit(req: CleanRequest): Promise<GcCleanAck | null> {
    if (req.ids.length === 0) return Promise.resolve(null)
    failures.value = new Map() // a new run replaces what the last one left behind
    const confirmed = (req.options.confirmed ?? []).length > 0
    return sendClean(req).then((ack) => {
      if (confirmed) reviewJobs.add(ack.jobId)
      return ack
    })
  }

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
    for (const id of wanted) askedFingerprints.set(id, fingerprintOf(m.byId.get(id)!))
    // Main takes at most 100 ids per request, so a longer list goes out in batches. They are one
    // logical ask: every item shows "Asking…" at once, each result clears its own item, and a
    // rejected batch gives up only its own ids and is reported once.
    let failure: unknown = null
    for (let i = 0; i < wanted.length; i += OPINION_BATCH) {
      const batch = wanted.slice(i, i + OPINION_BATCH)
      try {
        const ack = await window.api.gcOpinion(toIpc(batch))
        opinionJobs.set(ack.jobId, batch)
      } catch (e) {
        failure ??= e
        pendingOpinions.value = clearPending(pendingOpinions.value, batch)
        for (const id of batch) askedFingerprints.delete(id)
      }
    }
    if (failure !== null) {
      useUiStore().pushToast({
        kind: 'danger',
        title: i18n.global.t('cleanup.gc.opinion.failed'),
        description: failure instanceof Error ? failure.message : String(failure),
        timeoutMs: 8000
      })
    }
  }

  /**
   * Right before "Remove the ones marked safe" opens its dialog: asks main's cache again about the
   * marked ids and keeps only those it still holds as `safe` under the item's CURRENT key (the dirty
   * files and the pull request state included, which the snapshot does not carry). The rest lose
   * their chip. If main cannot be asked nothing is kept: an opinion that cannot be confirmed is not
   * a reason to pre-select a removal.
   */
  async function confirmSafe(): Promise<{ kept: string[]; dropped: string[]; failed: boolean }> {
    const marked = [...safeOpinionIds.value]
    if (marked.length === 0) return { kept: [], dropped: [], failed: false }
    const found: Record<string, GcOpinion> = {}
    try {
      for (let i = 0; i < marked.length; i += 500) {
        Object.assign(found, await window.api.gcOpinionCached(toIpc(marked.slice(i, i + 500))))
      }
    } catch {
      return { kept: [], dropped: marked, failed: true }
    }
    const now = model.value
    const kept = marked.filter((id) => found[id]?.verdict === 'safe')
    if (now) {
      let next = dropUnconfirmed(opinions.value, marked, new Set(Object.keys(found)))
      // What main holds now replaces what the chip said (a safe that turned into a keep, say).
      for (const id of Object.keys(found)) {
        if (marked.includes(id)) next = recordOpinion(next, found[id], now)
      }
      opinions.value = next
    }
    return { kept, dropped: marked.filter((id) => !kept.includes(id)), failed: false }
  }

  const opinionFor = (id: string): GcOpinion | null => opinionOf(opinions.value, id)
  const isAsking = (id: string): boolean => pendingOpinions.value.has(id)
  /** What "Remove the ones marked safe" pre-selects. */
  const safeOpinionIds = computed(() => (model.value ? safeIds(opinions.value, model.value) : []))

  async function keep(id: string): Promise<void> {
    await window.api.gcKeep(id)
    await refresh()
  }

  /**
   * Keep several at once (the selection bar): one refresh at the end, not one per id. Orphan volumes are
   * skipped (Keep applies to worktrees; the engine would reject a volume id), and the refresh runs even when
   * a keep is rejected so the screen never stays on a stale snapshot — the rejection is then passed on.
   */
  async function keepMany(ids: readonly string[]): Promise<void> {
    try {
      for (const id of ids) {
        if (!id.startsWith('volume:')) await window.api.gcKeep(id)
      }
    } finally {
      await refresh()
    }
  }

  /**
   * "Check again" on a demoted item: main forgets that item's remembered refusal and reprobes it once.
   * The screen refreshes either way, so a fixed item reappears as the scan sees it and a still-broken
   * one stays demoted with its reason.
   */
  async function recheck(id: string): Promise<GcRecheckResult> {
    try {
      return await window.api.gcRecheck(id)
    } finally {
      await refresh()
    }
  }

  /**
   * What GitHub and the remote say about these branches, asked once when the remove dialog opens
   * (the snapshot never carries it). A failure is "could not tell": the box is simply not offered.
   */
  async function probeRemote(ids: string[]): Promise<Record<string, RemoteFacts>> {
    try {
      return await window.api.gcRemoteFacts(toIpc(ids))
    } catch {
      return {}
    }
  }

  async function unkeep(id: string): Promise<void> {
    await window.api.gcUnkeep(id)
    await refresh()
  }

  /**
   * "Enable autopilot" / "Allow cleaning" on the first-cycle banner: turn the pref on AND
   * acknowledge the report. The banner states what the next cycle will clean before this runs,
   * which is what makes the acknowledgement informed. Turning the pref on resets the ack in main
   * (a fresh promise), so the ack always comes after it.
   */
  async function enableAutopilot(): Promise<void> {
    const current = prefs.value ?? (await window.api.gcPrefs())
    // Prefs first: if turning it on fails, the report stays unacknowledged and the banner stays up to retry.
    await window.api.gcSetPrefs(toIpc({ ...current, autopilot: true }))
    await window.api.gcAckFirstReport()
    await refresh()
  }

  /** "Not now": hide the banner for this session. Nothing is acknowledged and nothing is enabled. */
  function dismissFirstReport(): void {
    firstReportSnoozed.value = true
  }

  /** Settings: always the whole object — main fills a missing field with its default. */
  async function savePrefs(patch: Partial<GcPrefs>): Promise<GcPrefs> {
    const base = prefs.value ?? (await window.api.gcPrefs())
    const saved = await window.api.gcSetPrefs(toIpc({ ...base, ...patch }))
    if (snapshot.value) snapshot.value = { ...snapshot.value, prefs: saved }
    // The never-clean list is read on real paths in main (a symlinked entry), which the screen cannot
    // do: a changed list takes a fresh snapshot, whose bundles carry main's answer.
    if (patch.neverClean !== undefined) void refresh()
    return saved
  }

  // ---- Cleanup's own exhaust: archive refs and what Harnu put in the trash ---------------------

  /**
   * Deletes the archives the operator confirmed in one repo. Main re-lists and deletes only what
   * still has the shas the confirm showed; whatever changed is left alone and said so.
   */
  async function deleteArchives(
    repoPath: string,
    archives: Array<{
      namespace: string
      tipSha: string | null
      wipSha: string | null
      members?: Array<{ ref: string; sha: string }>
    }>
  ): Promise<void> {
    const { t } = i18n.global
    const ui = useUiStore()
    try {
      const ack = await window.api.gcDeleteArchives(toIpc({ repoPath, archives }))
      if (ack.archives > 0) {
        ui.pushToast({
          kind: 'success',
          title: t('cleanup.gc.archives.toast.deleted', ack.archives, {
            named: { n: ack.archives }
          }),
          description: t('cleanup.gc.archives.toast.deletedSub'),
          timeoutMs: 6000
        })
      }
      if (ack.neverClean) {
        ui.pushToast({
          kind: 'warning',
          title: t('cleanup.gc.archives.toast.neverClean'),
          timeoutMs: 8000
        })
      }
      // Name every cause that left something alone, once each, in one toast.
      const causes: string[] = []
      const changed = ack.changed.length
      if (changed > 0) {
        causes.push(t('cleanup.gc.archives.toast.changed', changed, { named: { n: changed } }))
      }
      if (ack.failed > 0) {
        causes.push(t('cleanup.gc.archives.toast.failed', ack.failed, { named: { n: ack.failed } }))
      }
      const guarded = ack.protectedArchives ?? 0
      if (guarded > 0) {
        causes.push(t('cleanup.gc.archives.toast.protected', guarded, { named: { n: guarded } }))
      }
      if (causes.length > 0) {
        ui.pushToast({ kind: 'warning', title: causes.join(' · '), timeoutMs: 8000 })
      }
    } catch (e) {
      ui.pushToast({
        kind: 'danger',
        title: t('cleanup.gc.archives.toast.failed', 1, { named: { n: 1 } }),
        description: e instanceof Error ? e.message : String(e),
        timeoutMs: 8000
      })
    } finally {
      await refresh()
    }
  }

  /** "Run git gc now": one repo, after its own confirm. */
  async function runArchiveGc(repoPath: string, repoName: string): Promise<void> {
    const { t } = i18n.global
    const ui = useUiStore()
    try {
      const ack = await window.api.gcRunArchiveGc(repoPath)
      ui.pushToast({
        kind: ack.ok ? 'success' : 'danger',
        title: t(
          ack.ok ? 'cleanup.gc.archives.toast.gcDone' : 'cleanup.gc.archives.toast.gcFailed',
          {
            repo: repoName
          }
        ),
        description: ack.ok ? undefined : ack.error,
        timeoutMs: ack.ok ? 6000 : 8000
      })
    } finally {
      await refresh()
    }
  }

  /**
   * "Empty what Harnu moved to the trash": the entries the confirm LISTED, by id. Main deletes only
   * those, each only while it is still exactly the entry Harnu recorded, so what was trashed after the
   * dialog opened, or restored and trashed again by the user, is left alone and said so.
   */
  async function emptyTrash(ids: readonly string[]): Promise<void> {
    const { t } = i18n.global
    const ui = useUiStore()
    try {
      const ack = await window.api.gcEmptyTrash([...ids])
      if (ack.unsupported) {
        ui.pushToast({
          kind: 'warning',
          title: t('cleanup.gc.trash.toast.unsupported', {
            location: ack.location ?? t('cleanup.gc.trash.recycleBin')
          }),
          timeoutMs: 8000
        })
      } else if (ack.failed > 0 || ack.skipped > 0) {
        // Name the real cause of what was left in the trash, once per cause.
        const causes: string[] = []
        if (ack.failed > 0) {
          causes.push(t('cleanup.gc.trash.toast.failed', ack.failed, { named: { n: ack.failed } }))
        }
        const left = (key: string, n: number): void => {
          if (n > 0) causes.push(t(`cleanup.gc.trash.toast.${key}`, n, { named: { n } }))
        }
        left('skippedUnreachable', ack.unreachable)
        left('skippedChanged', ack.changed)
        left('skippedNoRecord', ack.unverifiable)
        ui.pushToast({
          kind: 'warning',
          title: causes.join(' · '),
          description:
            ack.emptied > 0
              ? t('cleanup.gc.trash.toast.emptied', { size: formatBytes(ack.emptiedBytes) })
              : undefined,
          timeoutMs: 8000
        })
      } else if (ack.emptied === 0) {
        // Everything on the list was already gone: say so, never "Emptied 0 B".
        ui.pushToast({
          kind: 'info',
          title: t('cleanup.gc.trash.toast.nothing'),
          timeoutMs: 6000
        })
      } else {
        ui.pushToast({
          kind: 'success',
          title: t('cleanup.gc.trash.toast.emptied', { size: formatBytes(ack.emptiedBytes) }),
          timeoutMs: 6000
        })
      }
    } finally {
      await refresh()
    }
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
    submit,
    probeRemote,
    keep,
    keepMany,
    recheck,
    unkeep,
    enableAutopilot,
    dismissFirstReport,
    firstReportSnoozed,
    recovery,
    loadRecovery,
    answerRecovery,
    savePrefs,
    deleteArchives,
    runArchiveGc,
    emptyTrash,
    pruneSelection,
    opinions,
    pendingOpinions,
    safeOpinionIds,
    confirmSafe,
    askOpinion,
    opinionFor,
    isAsking
  }
})
