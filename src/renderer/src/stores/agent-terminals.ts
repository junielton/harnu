import { defineStore } from 'pinia'
import { ref } from 'vue'
import { i18n } from '../i18n'
import { LiveWordTracker, type ActivityKind, type LiveWord } from '../lib/agent-activity'
import { useUiStore } from './ui'

/** What main says about a terminal for its chip (the `terminal:chip` projection). */
export interface ChipState {
  terminalId: string
  origin: 'agent' | 'operator'
  ownerSessionId: string | null
  disconnected: boolean
  exited: boolean
  leaseActive: boolean
}

/**
 * How often a displayed lease is re-checked. Main pushes `terminal:chipChanged` whenever a lease is
 * granted or revoked, so this only covers the one ending nobody announces: a lease that idles
 * out after 10 minutes with no call to notice it. Cheap (one IPC), and only while one is shown.
 */
export const LEASE_RECHECK_MS = 5_000

/**
 * Renderer state behind the agent connection chip (T474 U1): the live word per terminal, the
 * chip projection main last reported, and the operator's Disconnect.
 *
 * Disconnect is permanent: there is no reconnect action here on purpose, and a terminal marked
 * disconnected stays marked (a late `terminal:chip` answer cannot bring the chip back).
 */
export const useAgentTerminalsStore = defineStore('agentTerminals', () => {
  /** Live word per terminal id (`reading` / `typing`); absent = idle. */
  const words = ref<Record<string, 'reading' | 'typing'>>({})
  /** Main's chip projection per terminal id. */
  const chips = ref<Record<string, ChipState>>({})
  /** Terminal ids the operator disconnected in this window. Permanent. */
  const disconnectedIds = ref<Record<string, true>>({})

  const tracker = new LiveWordTracker((id, word) => {
    if (word === null) {
      const next = { ...words.value }
      delete next[id]
      words.value = next
    } else {
      words.value = { ...words.value, [id]: word }
    }
  })

  const leaseTimers = new Map<string, ReturnType<typeof setTimeout>>()
  let offActivity: (() => void) | null = null
  let offChipChanged: (() => void) | null = null
  /** Disconnects awaiting main's answer — a second click meanwhile is ignored. */
  const disconnecting = new Set<string>()

  /** Ask main for a terminal's chip state; keeps the lease re-check going while one shows. */
  async function refreshChip(terminalId: string): Promise<ChipState | null> {
    let state: ChipState | null = null
    try {
      state = (await window.api.terminalChip(terminalId)) ?? null
    } catch {
      state = null
    }
    if (!state) return null
    if (disconnectedIds.value[terminalId]) state = { ...state, disconnected: true }
    chips.value = { ...chips.value, [terminalId]: state }
    scheduleLeaseRecheck(terminalId, state)
    return state
  }

  function scheduleLeaseRecheck(terminalId: string, state: ChipState): void {
    const armed = leaseTimers.get(terminalId)
    if (armed) clearTimeout(armed)
    leaseTimers.delete(terminalId)
    if (!state.leaseActive || state.disconnected) return
    leaseTimers.set(
      terminalId,
      setTimeout(() => {
        leaseTimers.delete(terminalId)
        void refreshChip(terminalId)
      }, LEASE_RECHECK_MS)
    )
  }

  function onActivity(e: { terminalId: string; kind: ActivityKind }): void {
    if (disconnectedIds.value[e.terminalId]) return
    tracker.note(e.terminalId, e.kind)
    // An operator-opened terminal has no chip until an agent shows up; learn about it now.
    // Cheap: one IPC per coalesced event (≤ 4/s per terminal).
    void refreshChip(e.terminalId)
  }

  /** Subscribe to `terminal:activity` once; the store is an app-lifetime singleton. */
  function start(): void {
    if (offActivity) return
    offActivity = window.api.onTerminalActivity(onActivity)
    // A lease was granted or ended: re-read the chip (only terminals this window already shows,
    // or has just learned about, matter — an unknown id answers null and changes nothing).
    offChipChanged = window.api.onTerminalChipChanged((e) => {
      void refreshChip(e.terminalId)
    })
  }

  function wordOf(terminalId: string): LiveWord {
    return words.value[terminalId] ?? null
  }

  /**
   * The operator's Disconnect. No confirm (revoking is the safe direction): the chip goes at once
   * and main is told. Main's answer is checked — a Disconnect that main did not apply (`false`, or
   * the call threw) leaves agents with access, so the chip comes back and an error toast says so
   * instead of the success one. Main then refuses every later read and write.
   */
  async function disconnect(terminalId: string): Promise<void> {
    if (disconnecting.has(terminalId)) return
    disconnecting.add(terminalId)
    const previousChip = chips.value[terminalId]
    disconnectedIds.value = { ...disconnectedIds.value, [terminalId]: true }
    tracker.forget(terminalId)
    const armed = leaseTimers.get(terminalId)
    if (armed) clearTimeout(armed)
    leaseTimers.delete(terminalId)
    if (previousChip) {
      chips.value = { ...chips.value, [terminalId]: { ...previousChip, disconnected: true } }
    }
    let applied = false
    try {
      applied = (await window.api.terminalDisconnect(terminalId)) === true
    } catch {
      applied = false
    }
    disconnecting.delete(terminalId)
    const t = i18n.global.t
    if (applied) {
      useUiStore().pushToast({ kind: 'success', title: t('agentTerminal.disconnected') })
      return
    }
    // Main did not set the flag: the agent still has access. Put the chip back.
    const next = { ...disconnectedIds.value }
    delete next[terminalId]
    disconnectedIds.value = next
    if (previousChip) chips.value = { ...chips.value, [terminalId]: previousChip }
    void refreshChip(terminalId)
    useUiStore().pushToast({
      kind: 'danger',
      title: t('agentTerminal.disconnectFailed'),
      description: t('agentTerminal.disconnectFailedHint')
    })
  }

  /** A pane is gone: drop everything held for it. */
  function forget(terminalId: string): void {
    tracker.forget(terminalId)
    const armed = leaseTimers.get(terminalId)
    if (armed) clearTimeout(armed)
    leaseTimers.delete(terminalId)
    const next = { ...chips.value }
    delete next[terminalId]
    chips.value = next
  }

  function dispose(): void {
    offActivity?.()
    offActivity = null
    offChipChanged?.()
    offChipChanged = null
    tracker.dispose()
    for (const t of leaseTimers.values()) clearTimeout(t)
    leaseTimers.clear()
  }

  return { words, chips, disconnectedIds, start, refreshChip, wordOf, disconnect, forget, dispose }
})
