// @vitest-environment jsdom
/**
 * browser-tabs S-7 / AC-32 (decision D-4) — the compact agent icon that replaces the connection pill in the
 * terminal and browser pane headers. One shared view (`AgentConnectionChip.vue`) draws it in both; its hover tip
 * names the session and says "Typing" or "Reading" from the chip's existing words; Paused and Disconnected keep
 * their pills.
 *
 * Mounted against the real stores with `window.api` faked, like `agent-connection-chip.test.ts`.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { setActivePinia, createPinia } from 'pinia'
import { readFileSync } from 'node:fs'
import AgentConnectionChip from '../src/renderer/src/components/AgentConnectionChip.vue'
import { i18n } from '@renderer/i18n'
import { useSessionsStore } from '../src/renderer/src/stores/sessions'
import type { ChipState } from '../src/renderer/src/stores/agent-terminals'
import { chipPresentation } from '../src/renderer/src/lib/agent-chip'

const T = 'h-term'

let chip: ChipState | null
let activityCb: ((e: { terminalId: string; kind: 'read' | 'write'; at: number }) => void) | null

function installApi(): void {
  ;(window as unknown as { api: unknown }).api = {
    terminalChip: vi.fn(async () => chip),
    terminalDisconnect: vi.fn(async () => true),
    onTerminalActivity: vi.fn((cb: typeof activityCb) => {
      activityCb = cb
      return () => {
        activityCb = null
      }
    }),
    onTerminalChipChanged: vi.fn(() => () => {}),
    terminalClose: vi.fn(async () => true),
    helpersGet: vi.fn(async () => ({ splitVisible: false, splitRatio: 0.5, panes: [] })),
    helpersSet: vi.fn(async () => undefined),
    hooksStateFor: vi.fn(),
    foldersLoad: vi.fn(async () => [])
  }
}

function seedSession(summary: string, hibernated = false): void {
  const store = useSessionsStore()
  store.folders = [
    {
      path: '/repo',
      alias: 'repo',
      sessions: [{ sessionId: 'sess-1', summary, hibernated }]
    } as unknown as (typeof store.folders)[number]
  ]
}

function agentChip(over: Partial<ChipState> = {}): ChipState {
  return {
    terminalId: T,
    origin: 'agent',
    ownerSessionId: 'sess-1',
    disconnected: false,
    exited: false,
    leaseActive: false,
    ...over
  }
}

async function mountTerminalChip(props: Record<string, unknown> = {}) {
  const w = mount(AgentConnectionChip, {
    props: { terminalId: T, origin: 'agent', ownerSessionId: 'sess-1', ...props },
    global: { plugins: [i18n] }
  })
  await flushPromises()
  return w
}

beforeEach(() => {
  setActivePinia(createPinia())
  chip = agentChip()
  activityCb = null
  installApi()
  seedSession('Fix login bug')
})
afterEach(() => {
  vi.restoreAllMocks()
  delete (window as unknown as { api?: unknown }).api
})

describe('terminal compact icon', () => {
  it('the terminal header draws one 18px round accent icon, not the text pill', async () => {
    const w = await mountTerminalChip()
    const icon = w.find('[data-testid="agent-icon"]')
    expect(icon.exists()).toBe(true)
    expect(icon.classes()).toEqual(
      expect.arrayContaining([
        'h-[18px]',
        'w-[18px]',
        'rounded-full',
        'bg-accent-soft',
        'text-accent',
        'anim-pulse-dot',
        'anim-pulse-dot--accent'
      ])
    )
    // The halo starts at 18 ÷ 26 of its size (design.md §7).
    expect(icon.attributes('style')).toContain('--pulse-from: 0.69')
    // No pill: no inline label, no dot, no inline word.
    expect(w.find('[data-testid="agent-chip-dot"]').exists()).toBe(false)
    expect(w.find('[data-testid="agent-chip-word"]').exists()).toBe(false)
  })

  it('the tip names the session (and "parked"), and is a hover and focus tip', async () => {
    seedSession('Fix login bug', true)
    const w = await mountTerminalChip()
    const icon = w.find('[data-testid="agent-icon"]')
    expect(w.find('[data-testid="agent-icon-tip"]').exists()).toBe(false)
    await icon.trigger('mouseenter')
    expect(w.find('[data-testid="agent-icon-tip-head"]').text()).toBe(
      'Connected to Fix login bug (parked)'
    )
    await icon.trigger('mouseleave')
    expect(w.find('[data-testid="agent-icon-tip"]').exists()).toBe(false)
    await icon.trigger('focus')
    expect(w.find('[data-testid="agent-icon-tip"]').exists()).toBe(true)
    await icon.trigger('blur')
    expect(w.find('[data-testid="agent-icon-tip"]').exists()).toBe(false)
  })

  it('the tip says "Typing" or "Reading" from the existing chip words, and says nothing while idle', async () => {
    const w = await mountTerminalChip()
    const icon = w.find('[data-testid="agent-icon"]')
    await icon.trigger('mouseenter')
    expect(w.find('[data-testid="agent-icon-tip-detail"]').exists()).toBe(false)

    activityCb?.({ terminalId: T, kind: 'read', at: 1 })
    await flushPromises()
    expect(w.find('[data-testid="agent-icon-tip-detail"]').text()).toBe('Reading')

    activityCb?.({ terminalId: T, kind: 'write', at: 2 })
    await flushPromises()
    expect(w.find('[data-testid="agent-icon-tip-detail"]').text()).toBe('Typing')
    // The screen-reader announcement keeps the lower-case word of the chip, outside the icon.
    expect(w.find('[data-testid="agent-chip-live"]').text()).toBe('typing')
  })

  it('the icon is named for assistive tech even while its tip is closed', async () => {
    const w = await mountTerminalChip()
    expect(w.find('[data-testid="agent-icon"]').attributes('aria-label')).toBe(
      'Connected to Fix login bug'
    )
  })

  it('Disconnect stays an unplug button beside the icon', async () => {
    const w = await mountTerminalChip()
    expect(w.find('[data-testid="agent-disconnect"]').exists()).toBe(true)
    expect(
      w
        .find('[data-testid="agent-icon"]')
        .element.contains(w.find('[data-testid="agent-disconnect"]').element)
    ).toBe(false)
  })

  it('a terminal with no chip (disconnected or exited) draws neither the icon nor a pill', async () => {
    chip = agentChip({ disconnected: true })
    const w = await mountTerminalChip()
    expect(w.find('[data-testid="agent-icon"]').exists()).toBe(false)
    expect(w.find('[data-testid="agent-connection-chip"]').exists()).toBe(false)
  })
})

describe('the shared icon view in the browser header', () => {
  it('the browser header hands its connected states to the same component', () => {
    const src = readFileSync('src/renderer/src/components/BrowserPane.vue', 'utf8')
    expect(src).toMatch(/import AgentConnectionChip from '\.\/AgentConnectionChip\.vue'/)
    expect(src).toMatch(/<AgentConnectionChip[^>]*:model=/s)
    // The browser no longer paints its own accent pill for a connected agent.
    expect(src).not.toContain("chip.kind === 'connected'")
    expect(src).not.toContain('browserPane.chip.connectedPrefix')
  })

  it('mounted with the browser words, the view says "Driving this tab · ‹host›" and "Reading"', async () => {
    const w = mount(AgentConnectionChip, {
      props: {
        model: {
          head: 'Connected to Fix login bug',
          detail: 'Driving this tab · localhost:8080',
          live: 'driving',
          clickSessionId: null,
          disconnectable: true
        }
      },
      global: { plugins: [i18n] }
    })
    await w.find('[data-testid="agent-icon"]').trigger('mouseenter')
    expect(w.find('[data-testid="agent-icon-tip-head"]').text()).toBe('Connected to Fix login bug')
    expect(w.find('[data-testid="agent-icon-tip-detail"]').text()).toBe(
      'Driving this tab · localhost:8080'
    )
    await w.setProps({
      model: {
        head: 'Connected to Fix login bug',
        detail: 'Reading',
        live: 'reading',
        clickSessionId: null,
        disconnectable: true
      }
    })
    expect(w.find('[data-testid="agent-icon-tip-detail"]').text()).toBe('Reading')
  })
})

describe('Paused and Disconnected keep their pills', () => {
  it('only the connected states take the icon; paused and disconnected stay text pills', () => {
    expect(chipPresentation('connected')).toBe('icon')
    expect(chipPresentation('connectedAgent')).toBe('icon')
    expect(chipPresentation('operatorLease')).toBe('icon')
    expect(chipPresentation('operatorRead')).toBe('icon')
    expect(chipPresentation('paused')).toBe('pill')
    expect(chipPresentation('disconnected')).toBe('pill')
  })

  it('the browser header still renders both pills, and the narrow-pane paused strip', () => {
    const src = readFileSync('src/renderer/src/components/BrowserPane.vue', 'utf8')
    expect(src).toContain("chip.kind === 'disconnected'")
    expect(src).toContain('border-red/40 bg-red-soft text-red')
    expect(src).toContain('border-warning/30 bg-warning/10 text-warning')
    expect(src).toContain('data-testid="browser-paused-strip"')
    expect(src).toContain('data-testid="browser-resume"')
  })

  it('the terminal has no Paused or Disconnected pill: a disconnected terminal shows nothing, as in T474', async () => {
    chip = agentChip({ disconnected: true })
    const w = await mountTerminalChip()
    expect(w.html()).not.toMatch(/bg-red-soft|bg-warning/)
  })
})
