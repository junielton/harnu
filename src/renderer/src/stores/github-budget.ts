/**
 * GitHub API budget store (T611 U2).
 *
 * Mirrors U1's main-side tracker: one `BudgetSnapshot` read at start and replaced by every
 * `github-budget:changed` push. The footer pill, its popover, the Settings pane and PR Stack's
 * "limit reached" copy all read this one snapshot, so they can never disagree. Also decides when the
 * budget speaks up (a toast entering `low`, an OS notification at `exhausted`; once per window each,
 * only with the `notify` pref on) — `lib/github-budget-notice.ts` holds that rule.
 */
import { defineStore } from 'pinia'
import { computed, ref, shallowRef } from 'vue'
import type { BudgetPrefs } from '../../../main/github-budget-core'
import { i18n } from '../i18n'
import {
  decideNotice,
  freshNoticeMemory,
  remember,
  type NoticeMemory
} from '../lib/github-budget-notice'
import {
  formatClock,
  formatCount,
  minutesUntil,
  readyBudget,
  resourceName,
  type BudgetSnapshot,
  type ThrottleState
} from '../lib/github-budget-view'
import { dispatchNotification } from './notify-dispatch'
import { useUiStore } from './ui'

export const useGithubBudgetStore = defineStore('githubBudget', () => {
  /** `null` until the first read lands. */
  const snapshot = shallowRef<BudgetSnapshot | null>(null)
  const prefs = ref<BudgetPrefs | null>(null)

  let started = false
  let off: (() => void) | null = null
  let lastState: ThrottleState | null = null
  let memory: NoticeMemory = freshNoticeMemory()

  /** The pill's data; `null` hides the pill (unavailable, or nothing polled yet). */
  const ready = computed(() => readyBudget(snapshot.value))
  const state = computed<ThrottleState>(() => snapshot.value?.throttle.state ?? 'normal')
  /** Epoch ms at which an `exhausted` budget is expected back, else `null`. */
  const resetAtMs = computed<number | null>(() => {
    const r = ready.value
    if (!r) return null
    return snapshot.value?.throttle.resetAt ?? r.tighterView.bucket.reset * 1000
  })

  /**
   * Epoch ms until which GitHub's secondary limit holds Harnu's throttled reads (AC-9 amended), or
   * `null`. It never changes the throttle state; the popover shows its own note while it lasts.
   */
  const secondaryPauseUntilMs = computed<number | null>(() => {
    const iso = snapshot.value?.secondaryPauseUntil
    const ms = iso ? Date.parse(iso) : NaN
    return Number.isFinite(ms) ? ms : null
  })

  function apply(next: BudgetSnapshot): void {
    const notice = decideNotice(lastState, next, memory)
    lastState = next.throttle.state
    snapshot.value = next
    prefs.value = next.prefs
    if (notice) {
      memory = remember(memory, notice)
      announce(notice.kind, next)
    }
  }

  /** The toast on entering `low` / the OS notification at `exhausted`. */
  function announce(kind: 'low' | 'exhausted', snap: BudgetSnapshot): void {
    const { t } = i18n.global
    const r = readyBudget(snap)
    if (!r) return
    // `locale` is a ref in composition mode, but the generic signature loses that (see `setLocale`).
    const loc = (i18n.global as unknown as { locale: { value: string } }).locale.value
    const reset = formatClock(r.tighterView.bucket.reset * 1000, loc)
    if (kind === 'low') {
      dispatchNotification({
        title: t('githubBudget.notice.low.title'),
        body: t('githubBudget.notice.low.body', {
          left: formatCount(r.tighterView.bucket.remaining, loc),
          resource: resourceName(r.tighter),
          time: reset
        }),
        channel: 'toast',
        sound: false,
        sessionId: '',
        toastKind: 'warning',
        unit: 'github-budget',
        notificationType: 'low',
        toastAction: {
          label: t('githubBudget.notice.details'),
          handler: () => useUiStore().openSettings('githubApi')
        }
      })
      return
    }
    const until = snap.throttle.resetAt ?? r.tighterView.bucket.reset * 1000
    dispatchNotification({
      title: t('githubBudget.notice.exhausted.title'),
      body: t('githubBudget.notice.exhausted.body', {
        time: formatClock(until, loc),
        minutes: minutesUntil(until, Date.now())
      }),
      channel: 'os',
      sound: false,
      sessionId: '',
      toastKind: 'danger',
      unit: 'github-budget',
      notificationType: 'exhausted'
    })
  }

  /**
   * Idempotent while a start is in flight or done. A failed start (bridge not ready, snapshot
   * rejected) drops its subscription and clears `started`, so the next call tries again.
   */
  async function init(): Promise<void> {
    if (started) return
    started = true
    try {
      off = window.api.onGithubBudgetChanged(apply)
      apply(await window.api.githubBudgetSnapshot())
    } catch {
      off?.()
      off = null
      started = false
    }
  }

  async function refresh(): Promise<void> {
    try {
      apply(await window.api.githubBudgetSnapshot())
    } catch {
      /* keep the last snapshot */
    }
  }

  /** Whole-object write (the Settings pane); main normalizes and echoes the stored value. */
  async function savePrefs(patch: Partial<BudgetPrefs>): Promise<void> {
    const base = prefs.value ?? snapshot.value?.prefs
    if (!base) return
    const next = { ...base, ...patch }
    prefs.value = next // optimistic
    try {
      prefs.value = await window.api.githubBudgetSetPrefs(next)
    } catch {
      prefs.value = base
    }
  }

  async function loadPrefs(): Promise<void> {
    try {
      prefs.value = await window.api.githubBudgetPrefs()
    } catch {
      /* the snapshot's copy stands */
    }
  }

  function dispose(): void {
    off?.()
    off = null
    started = false
  }

  return {
    snapshot,
    prefs,
    ready,
    state,
    resetAtMs,
    secondaryPauseUntilMs,
    init,
    refresh,
    savePrefs,
    loadPrefs,
    dispose
  }
})
