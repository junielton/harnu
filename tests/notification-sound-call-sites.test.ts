// @vitest-environment jsdom
/**
 * T154 — every sound call site plays the family the card's table names, and none plays with the Sound
 * switch off. `playNotificationSound` is mocked at the module seam, so each assertion reads the family
 * the call site asked for.
 *
 * | Call site                                    | Family            |
 * | -------------------------------------------- | ----------------- |
 * | session needs-input (`maybeNotify`)          | ask               |
 * | session completed (working → idle)           | done              |
 * | session failed                               | fail              |
 * | approval parked in the Inbox                 | ask               |
 * | 5 h usage window reset                       | info              |
 * | daily budget 80% / 100%                      | info              |
 * | new Claude Code version                      | info              |
 * | Close mission dialog opens                   | nothing           |
 *
 * (The mission cue's call site is covered in `missions-store.test.ts`; its family mapping in
 * `notification-sound-families.test.ts`.)
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { mount } from '@vue/test-utils'
import { setActivePinia, createPinia } from 'pinia'
import { i18n } from '@renderer/i18n'
import { useSessionsStore } from '../src/renderer/src/stores/sessions'
import { useClaudeChangelogStore } from '../src/renderer/src/stores/claudeChangelog'
import { useMcpConfirmQueue } from '../src/renderer/src/stores/session-mcp-confirms'
import MissionCloseConfirmDialog from '../src/renderer/src/components/MissionCloseConfirmDialog.vue'
import { playNotificationSound } from '../src/renderer/src/lib/notification-sound'
import type { FolderEntry, McpConfirmPending, Session as SessionEntry } from '../src/preload'

vi.mock('../src/renderer/src/lib/notification-sound', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/renderer/src/lib/notification-sound')>()),
  playNotificationSound: vi.fn()
}))

const win = window as unknown as { api: Record<string, unknown> }

function session(over: Partial<SessionEntry> = {}): SessionEntry {
  return {
    sessionId: 's1',
    summary: 'My session',
    status: 'idle',
    modified: '2026-06-11T12:00:00.000Z',
    ...over
  } as SessionEntry
}

const folder = (sessions: SessionEntry[]): FolderEntry => ({
  path: '/repos/alpha',
  alias: 'alpha',
  sessions
})

const parked = (id = 'c1'): McpConfirmPending => ({
  id,
  prompt: 'Allow agent to boot with elevated flags?',
  permissionMode: 'default',
  nonDefaultFlags: [],
  commands: [],
  deadline: Date.now() + 30 * 60_000,
  mode: 'parked'
})

beforeEach(() => {
  setActivePinia(createPinia())
  i18n.global.locale.value = 'en'
  localStorage.clear()
  vi.mocked(playNotificationSound).mockClear()
})

afterEach(() => {
  delete (window as unknown as { api?: unknown }).api
})

describe('session notifications (maybeNotify)', () => {
  async function loaded() {
    const disk = [folder([session()])]
    win.api = {
      foldersLoad: vi.fn(async () =>
        disk.map((f) => ({ ...f, sessions: f.sessions.map((s) => ({ ...s })) }))
      ),
      userProjectsList: vi.fn(async () => ({ projects: [], hiddenPaths: [] })),
      orchestratorListArmed: vi.fn(async () => []),
      notify: vi.fn(),
      pushSend: vi.fn()
    }
    const store = useSessionsStore()
    await store.reloadModel()
    store.windowFocused = false
    return store
  }

  it('needs-input plays ask', async () => {
    const store = await loaded()
    store.applyTaskState('s1', 'needs-input')
    expect(playNotificationSound).toHaveBeenCalledTimes(1)
    expect(playNotificationSound).toHaveBeenCalledWith('ask')
  })

  it('a finished turn (working → idle) plays done', async () => {
    const store = await loaded()
    store.applyTaskState('s1', 'working')
    store.applyTaskState('s1', 'idle')
    expect(playNotificationSound).toHaveBeenCalledTimes(1)
    expect(playNotificationSound).toHaveBeenCalledWith('done')
  })

  it('a failed session plays fail', async () => {
    const store = await loaded()
    store.applyTaskState('s1', 'failed')
    expect(playNotificationSound).toHaveBeenCalledTimes(1)
    expect(playNotificationSound).toHaveBeenCalledWith('fail')
  })

  it('with the Sound switch off no session event plays anything', async () => {
    const store = await loaded()
    store.setNotifyPref('sound', false)
    store.applyTaskState('s1', 'needs-input')
    store.applyTaskState('s1', 'working')
    store.applyTaskState('s1', 'idle')
    store.applyTaskState('s1', 'failed')
    expect(playNotificationSound).not.toHaveBeenCalled()
  })

  it('a muted family stays silent while the others still play', async () => {
    const store = await loaded()
    store.setNotifyPref('soundDone', false)
    store.applyTaskState('s1', 'working')
    store.applyTaskState('s1', 'idle')
    expect(playNotificationSound).not.toHaveBeenCalled()
    store.applyTaskState('s1', 'failed')
    expect(playNotificationSound).toHaveBeenCalledWith('fail')
  })
})

describe('usage reset and daily budget', () => {
  const FIVE_HOURS_MS = 5 * 3600_000
  const budget = {
    state: 'near-limit' as const,
    spentPct: 80,
    budgetPct: 100,
    workingDaysLeft: 3,
    rebalancedPct: null,
    remainingDays: 2
  }

  beforeEach(() => {
    win.api = { notify: vi.fn() }
  })

  function resetOnce(store: ReturnType<typeof useSessionsStore>): void {
    store.windowFocused = false
    store.setNotifyPref('usageReset', true)
    store.checkUsageResetNotification(Date.now() - 1000)
    store.checkUsageResetNotification(Date.now() + FIVE_HOURS_MS)
  }

  it('a 5 h usage reset plays info', () => {
    resetOnce(useSessionsStore())
    expect(playNotificationSound).toHaveBeenCalledTimes(1)
    expect(playNotificationSound).toHaveBeenCalledWith('info')
  })

  it('a daily budget crossing plays info', () => {
    const store = useSessionsStore()
    store.windowFocused = false
    store.checkDailyBudgetNotification(budget, '2026-11-18')
    expect(playNotificationSound).toHaveBeenCalledTimes(1)
    expect(playNotificationSound).toHaveBeenCalledWith('info')
  })

  it('both are silent with the Sound switch off', () => {
    const store = useSessionsStore()
    store.setNotifyPref('sound', false)
    resetOnce(store)
    store.checkDailyBudgetNotification(budget, '2026-11-18')
    expect(playNotificationSound).not.toHaveBeenCalled()
  })

  it('both are silent with the info family muted', () => {
    const store = useSessionsStore()
    store.setNotifyPref('soundInfo', false)
    resetOnce(store)
    store.checkDailyBudgetNotification(budget, '2026-11-18')
    expect(playNotificationSound).not.toHaveBeenCalled()
  })
})

describe('new Claude Code version', () => {
  async function started(): Promise<() => void> {
    let fire: () => void = () => {}
    win.api = {
      onClaudeChangelogUpdated: vi.fn(() => () => {}),
      onClaudeChangelogNewVersion: vi.fn((cb: () => void) => {
        fire = cb
        return () => {}
      }),
      claudeChangelogGet: vi.fn(async () => ({
        releases: [],
        lastReadVersion: '',
        lastFetchedAt: 0
      }))
    }
    await useClaudeChangelogStore().init()
    return () => fire()
  }

  it('plays info', async () => {
    const fire = await started()
    fire()
    expect(playNotificationSound).toHaveBeenCalledTimes(1)
    expect(playNotificationSound).toHaveBeenCalledWith('info')
  })

  it('is silent with the Sound switch off', async () => {
    const fire = await started()
    useSessionsStore().setNotifyPref('sound', false)
    fire()
    expect(playNotificationSound).not.toHaveBeenCalled()
  })

  it('is silent with the info family muted', async () => {
    const fire = await started()
    useSessionsStore().setNotifyPref('soundInfo', false)
    fire()
    expect(playNotificationSound).not.toHaveBeenCalled()
  })
})

describe('approval parked in the Inbox', () => {
  beforeEach(() => {
    win.api = { notify: vi.fn(), pushSend: vi.fn(), requestAttention: vi.fn() }
  })

  it('plays ask', () => {
    const queue = useMcpConfirmQueue({ soundAllowed: () => true })
    queue.addParkedConfirm(parked())
    expect(playNotificationSound).toHaveBeenCalledTimes(1)
    expect(playNotificationSound).toHaveBeenCalledWith('ask')
  })

  it('stays silent when the sound is not allowed, but still raises attention and notifies', () => {
    const queue = useMcpConfirmQueue({ soundAllowed: () => false })
    queue.addParkedConfirm(parked())
    expect(playNotificationSound).not.toHaveBeenCalled()
    expect((win.api.requestAttention as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1)
    expect((win.api.notify as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1)
  })

  it('asks the gate about the ask family', () => {
    const soundAllowed = vi.fn(() => true)
    useMcpConfirmQueue({ soundAllowed }).addParkedConfirm(parked())
    expect(soundAllowed).toHaveBeenCalledWith('ask')
  })

  it('the sessions store wires the queue to the Sound switch and the family mutes', () => {
    const src = readFileSync(resolve(__dirname, '../src/renderer/src/stores/sessions.ts'), 'utf8')
    expect(src).toMatch(/useMcpConfirmQueue\(\{[^}]*soundAllowed:/)
  })
})

describe('Close mission dialog', () => {
  it('opening it plays nothing (the operator opened it) but still raises attention', () => {
    const requestAttention = vi.fn()
    win.api = { requestAttention }
    const w = mount(MissionCloseConfirmDialog, {
      props: { title: 'Mission one', busy: false },
      global: { plugins: [i18n] },
      attachTo: document.body
    })
    expect(playNotificationSound).not.toHaveBeenCalled()
    expect(requestAttention).toHaveBeenCalledTimes(1)
    w.unmount()
    document.body.innerHTML = ''
  })
})
