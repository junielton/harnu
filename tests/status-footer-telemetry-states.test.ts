// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils'
import { reactive } from 'vue'
import { setActivePinia, createPinia } from 'pinia'
import { i18n } from '@renderer/i18n'
import type { SessionTelemetry } from '../src/main/statusline-parse'

/**
 * BUG-196 — the footer's left cluster never goes silently blank (design.md §6 — Footer, "Last-known
 * state" and "Silent-session hint"). StatusFooter is mounted whole; the sessions store is replaced by a
 * small reactive fake (the real one is the app's biggest module and is not under test here), and the
 * usage store is the real one, seeded the way the telemetry pushes seed it.
 */

const SID = '11111111-1111-4111-8111-111111111111'
const HOUR = 3_600_000
const fakeSessions = reactive({
  selectedId: SID as string | null,
  selectedSession: {
    sessionId: SID,
    projectPath: '/ws/proj',
    fullPath: `/p/${SID}.jsonl`,
    gitBranch: 'main',
    synthetic: false
  } as Record<string, unknown> | null,
  allSessions: [] as unknown[],
  selectedPath: null,
  supervisionLoad: 0,
  live: true,
  reloaded: [] as string[]
})

vi.mock('../src/renderer/src/stores/sessions', () => ({
  useSessionsStore: () => ({
    get selectedId() {
      return fakeSessions.selectedId
    },
    get selectedSession() {
      return fakeSessions.selectedSession
    },
    get allSessions() {
      return fakeSessions.allSessions
    },
    get selectedPath() {
      return fakeSessions.selectedPath
    },
    get supervisionLoad() {
      return fakeSessions.supervisionLoad
    },
    isSessionLive: () => fakeSessions.live,
    reloadSession: (id: string) => void fakeSessions.reloaded.push(id)
  })
}))

import StatusFooter from '../src/renderer/src/components/StatusFooter.vue'
import { useUsageStore } from '../src/renderer/src/stores/usage'

function rec(over: Partial<SessionTelemetry> = {}): SessionTelemetry {
  return {
    sessionId: SID,
    cwd: '/ws/proj',
    modelId: 'claude-opus-4-8',
    modelName: 'Opus 4.8',
    costUsd: 5.84,
    linesAdded: 0,
    linesRemoved: 0,
    durationMs: null,
    contextPercent: 97,
    contextWindowSize: 200_000,
    exceeds200k: false,
    effortLevel: 'high',
    thinkingEnabled: false,
    outputStyle: null,
    pr: null,
    rateLimits: { fiveHour: null, sevenDay: null },
    updatedAtMs: Date.now() - 1_000,
    ...over
  }
}

let transcript: { modelId: string; contextPercent: number | null; atMs: number } | null
let push: Record<string, (p: unknown) => void>

function stubApi(): void {
  push = {}
  const none = (): (() => void) => () => {}
  const api = new Proxy(
    {
      usageGet: vi.fn(async () => null),
      telemetryGet: vi.fn(async () => ({
        perSession: [],
        lastKnown: [],
        fleet: {
          totalCostUsd: 0,
          sessionCount: 0,
          fiveHour: null,
          sevenDay: null,
          fiveHourAtMs: null,
          sevenDayAtMs: null
        }
      })),
      statuslineStatus: vi.fn(async () => ({ enabled: true, foreignPreserved: false })),
      telemetryTranscriptFallback: vi.fn(async () => transcript),
      onSessionUpdated: (cb: (p: unknown) => void) => {
        push.sessionUpdated = cb
        return () => {}
      },
      onStatuslineHealed: (cb: (p: unknown) => void) => {
        push.healed = cb
        return () => {}
      }
    } as Record<string, unknown>,
    {
      get: (target, key: string) => {
        if (key in target) return target[key]
        return key.startsWith('on') ? none : vi.fn(async () => null)
      }
    }
  )
  ;(window as unknown as { api: unknown }).api = api
}

async function mountFooter(): Promise<VueWrapper> {
  const wrapper = mount(StatusFooter, { global: { plugins: [i18n] } })
  await flushPromises()
  return wrapper
}

const reason = (w: VueWrapper) => w.find('[data-testid="footer-telemetry-reason"]')
const hint = (w: VueWrapper) => w.find('[data-testid="footer-silent-hint"]')

beforeEach(() => {
  setActivePinia(createPinia())
  transcript = null
  fakeSessions.selectedId = SID
  fakeSessions.live = true
  fakeSessions.reloaded = []
  fakeSessions.selectedSession = {
    sessionId: SID,
    projectPath: '/ws/proj',
    fullPath: `/p/${SID}.jsonl`,
    gitBranch: 'main',
    synthetic: false
  }
  stubApi()
})
afterEach(() => vi.useRealTimers())

describe('footer last-known state (AC-1)', () => {
  it('a fresh record renders at full strength with no reason', async () => {
    const usage = useUsageStore()
    usage.telemetryBySession = new Map([[SID, rec()]])
    const w = await mountFooter()
    const model = w.find('[aria-label="Model Opus 4.8"]')
    expect(model.exists()).toBe(true)
    expect(model.classes()).toContain('text-text-2')
    expect(model.classes()).not.toContain('text-text-4')
    expect(reason(w).exists()).toBe(false)
    // context 97% still raises the red signal and the near-/compact chip while live
    expect(w.find('[aria-label="97% context used"]').classes()).toContain('text-red')
    expect(w.text()).toContain('near /compact')
    w.unmount()
  })

  it('an expired record shows its values dimmed, with the age and a reason', async () => {
    const usage = useUsageStore()
    usage.lastKnownBySession = new Map([[SID, rec({ updatedAtMs: Date.now() - 72 * HOUR })]])
    const w = await mountFooter()
    const model = w.find('[aria-label^="Model Opus 4.8"]')
    expect(model.exists()).toBe(true)
    expect(model.classes()).toContain('text-text-4')
    expect(model.attributes('aria-label')).toContain('last seen 3d ago')
    expect(model.attributes('title')).toContain('last seen 3d ago')
    // a stale 97% must not raise an alarm
    const ctx = w.find('[aria-label^="97% context used"]')
    expect(ctx.classes()).toContain('text-text-4')
    expect(ctx.classes()).not.toContain('text-red')
    expect(w.text()).not.toContain('near /compact')
    expect(reason(w).text()).toBe('telemetry expired')
    expect(w.text()).toContain('$5.84')
    w.unmount()
  })

  it('a live-map record older than 24 h is not presented as live', async () => {
    const usage = useUsageStore()
    usage.telemetryBySession = new Map([[SID, rec({ updatedAtMs: Date.now() - 30 * HOUR })]])
    const w = await mountFooter()
    expect(w.find('[aria-label^="Model Opus 4.8"]').classes()).toContain('text-text-4')
    expect(reason(w).text()).toBe('telemetry expired')
    w.unmount()
  })

  it('with no record it falls back to the transcript: model and context only, dimmed', async () => {
    transcript = { modelId: 'claude-sonnet-5-5', contextPercent: 12, atMs: Date.now() - 2 * HOUR }
    const w = await mountFooter()
    await flushPromises()
    expect(w.find('[aria-label^="Model Sonnet 5.5"]').classes()).toContain('text-text-4')
    expect(w.find('[aria-label^="12% context used"]').exists()).toBe(true)
    expect(w.find('[aria-label^="Session cost"]').exists()).toBe(false)
    expect(reason(w).text()).toBe('no live telemetry')
    w.unmount()
  })

  it('with nothing at all it keeps the title and says why', async () => {
    const w = await mountFooter()
    await flushPromises()
    expect(w.find('[aria-label^="Model"]').exists()).toBe(false)
    expect(reason(w).text()).toBe('no live telemetry')
    expect(reason(w).attributes('title')).toContain('No telemetry has arrived')
    w.unmount()
  })

  it('shows no reason for a synthetic session that is about to get its first blob', async () => {
    fakeSessions.selectedSession = {
      sessionId: 'synthetic-abc',
      projectPath: '/ws/proj',
      fullPath: '',
      gitBranch: '',
      synthetic: true
    }
    fakeSessions.selectedId = 'synthetic-abc'
    const w = await mountFooter()
    expect(reason(w).exists()).toBe(false)
    w.unmount()
  })

  it('has no left content and no reason when no session is selected', async () => {
    fakeSessions.selectedId = null
    fakeSessions.selectedSession = null
    const w = await mountFooter()
    expect(w.text()).toContain('No session')
    expect(reason(w).exists()).toBe(false)
    w.unmount()
  })
})

describe('footer silent-session hint (AC-2)', () => {
  it('appears for a live session that answered with no telemetry, restarts it, and clears on a payload', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(1_790_000_000_000)
    const usage = useUsageStore()
    usage.telemetryBySession = new Map([[SID, rec({ updatedAtMs: Date.now() - 10 * 60_000 })]])
    await usage.init()
    push.sessionUpdated({ sessionId: SID, assistantTurn: true })

    // inside the 2-minute grace window: no hint
    vi.setSystemTime(Date.now() + 60_000)
    let w = await mountFooter()
    expect(hint(w).exists()).toBe(false)
    w.unmount()

    // past it, with no payload since the turn: the hint, and it restarts the session
    vi.setSystemTime(Date.now() + 2 * 60_000)
    w = await mountFooter()
    expect(hint(w).exists()).toBe(true)
    expect(hint(w).text()).toBe('Not reporting — restart session')
    await hint(w).trigger('click')
    expect(fakeSessions.reloaded).toEqual([SID])
    w.unmount()

    // the next payload for the session clears it
    usage.telemetryBySession = new Map([[SID, rec({ updatedAtMs: Date.now() })]])
    w = await mountFooter()
    expect(hint(w).exists()).toBe(false)
    w.unmount()
  })

  it('is hidden for a session that is not live', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(1_790_000_000_000)
    const usage = useUsageStore()
    await usage.init()
    push.sessionUpdated({ sessionId: SID, assistantTurn: true })
    vi.setSystemTime(Date.now() + 10 * 60_000)
    fakeSessions.live = false
    const w = await mountFooter()
    expect(hint(w).exists()).toBe(false)
    w.unmount()
  })
})
