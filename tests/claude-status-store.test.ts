import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { nextTick } from 'vue'
import { setActivePinia, createPinia } from 'pinia'
import { useClaudeStatusStore } from '../src/renderer/src/stores/claude-status'
import type { ClaudeStatusSnapshot } from '../src/main/claude-status-parse'

const snap = (over: Partial<ClaudeStatusSnapshot> = {}): ClaudeStatusSnapshot => ({
  severity: 'operational',
  indicator: 'none',
  description: 'All Systems Operational',
  components: [{ id: 'c1', name: 'API', severity: 'operational', statusText: 'operational' }],
  incidents: [],
  maintenances: [],
  fetchedAtMs: 1,
  stale: false,
  ...over
})

let updatedCb: ((s: ClaudeStatusSnapshot) => void) | null = null

function installApi(over: Record<string, unknown> = {}): {
  setNotify: ReturnType<typeof vi.fn>
} {
  const setNotify = vi.fn().mockResolvedValue(undefined)
  ;(globalThis as unknown as { window: unknown }).window = {
    api: {
      claudeStatusGet: vi.fn().mockResolvedValue(snap()),
      claudeStatusRefresh: vi.fn().mockResolvedValue(snap()),
      claudeStatusHistoryUrl: vi.fn().mockResolvedValue('https://status.claude.com'),
      claudeStatusSetNotify: setNotify,
      onClaudeStatusUpdated: (cb: (s: ClaudeStatusSnapshot) => void) => {
        updatedCb = cb
        return () => {}
      },
      onClaudeStatusActivate: () => () => {},
      ...over
    }
  }
  return { setNotify }
}

beforeEach(() => {
  setActivePinia(createPinia())
  updatedCb = null
})

afterEach(() => {
  delete (globalThis as unknown as { window?: unknown; localStorage?: unknown }).window
  delete (globalThis as unknown as { localStorage?: unknown }).localStorage
})

describe('claudeStatus store', () => {
  it('hydrates from claudeStatusGet on init', async () => {
    installApi()
    const s = useClaudeStatusStore()
    await s.init()
    expect(s.severity).toBe('operational')
    expect(s.components).toHaveLength(1)
    expect(s.hasIncidents).toBe(false)
  })

  it('applies live pushes from onClaudeStatusUpdated', async () => {
    installApi()
    const s = useClaudeStatusStore()
    await s.init()
    updatedCb?.(snap({ severity: 'outage', description: 'Major Outage', incidents: [] }))
    expect(s.severity).toBe('outage')
    expect(s.description).toBe('Major Outage')
  })

  it('pushes the mute pref to main on init and round-trips setNotifyEnabled', async () => {
    const store: Record<string, string> = {}
    ;(globalThis as unknown as { localStorage: unknown }).localStorage = {
      getItem: (k: string) => store[k] ?? null,
      setItem: (k: string, v: string) => {
        store[k] = v
      },
      removeItem: (k: string) => {
        delete store[k]
      }
    }
    const { setNotify } = installApi()
    const s = useClaudeStatusStore()
    await s.init()
    // Default ON → pushed to main on init.
    expect(setNotify).toHaveBeenCalledWith(true)

    s.setNotifyEnabled(false)
    expect(s.notifyEnabled).toBe(false)
    expect(setNotify).toHaveBeenLastCalledWith(false)
    // persistedRef mirrors to localStorage via a watch (async — flush it).
    await nextTick()
    expect(store['om2tab.claudeStatusNotify']).toBe('false')
  })
})
