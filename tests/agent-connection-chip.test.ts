// @vitest-environment jsdom
/**
 * T476 (agent terminals U1) — the pane header's connection chip, mounted against the real
 * stores with `window.api` faked.
 *
 *   AC-U1-2  the states of design.md §6: session name, "(parked)", closed-session fallback, the
 *            rekeyed owner after a synthetic→real migration
 *   AC-U1-3  click selects the owner; Disconnect revokes at once, toasts, removes the chip, and
 *            asks no confirm
 *   AC-U1-4  the live word (and no pulse without it)
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { setActivePinia, createPinia } from 'pinia'
import { nextTick } from 'vue'
import AgentConnectionChip from '../src/renderer/src/components/AgentConnectionChip.vue'
import { i18n } from '@renderer/i18n'
import { useSessionsStore } from '../src/renderer/src/stores/sessions'
import { useHelpersStore, type HelperPaneAgentTerminal } from '../src/renderer/src/stores/helpers'
import { useAgentTerminalsStore, type ChipState } from '../src/renderer/src/stores/agent-terminals'
import { useUiStore } from '../src/renderer/src/stores/ui'
import { TerminalLeases } from '../src/main/terminal-lease'
import { TerminalRegistry, terminalChipState } from '../src/main/terminal-registry'
import { resolveTerminalGateState, gateTerminalOp } from '../src/main/terminal-gate-core'

const T = 'h-term'

let chip: ChipState | null
let activityCb: ((e: { terminalId: string; kind: 'read' | 'write'; at: number }) => void) | null
let disconnect: ReturnType<typeof vi.fn>

function installApi(): void {
  ;(window as unknown as { api: unknown }).api = {
    terminalChip: vi.fn(async () => chip),
    terminalDisconnect: disconnect,
    onTerminalActivity: vi.fn((cb: typeof activityCb) => {
      activityCb = cb
      return () => {
        activityCb = null
      }
    }),
    hooksStateFor: vi.fn(),
    foldersLoad: vi.fn(async () => [])
  }
}

function seedSessions(
  sessions: Array<{ sessionId: string; summary?: string; hibernated?: boolean }>
): void {
  const store = useSessionsStore()
  store.folders = [
    { path: '/repo', alias: 'repo', sessions } as unknown as (typeof store.folders)[number]
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

async function mountChip(props: Record<string, unknown> = {}) {
  const w = mount(AgentConnectionChip, {
    props: { terminalId: T, origin: 'agent', ownerSessionId: 'sess-1', ...props },
    global: { plugins: [i18n] }
  })
  await flushPromises()
  return w
}

const label = (w: Awaited<ReturnType<typeof mountChip>>): string =>
  w.find('[data-testid="agent-chip-label"]').text()

beforeEach(() => {
  setActivePinia(createPinia())
  chip = agentChip()
  activityCb = null
  disconnect = vi.fn(async () => true)
  installApi()
  seedSessions([{ sessionId: 'sess-1', summary: 'Fix login bug' }])
})
afterEach(() => {
  vi.restoreAllMocks()
  delete (window as unknown as { api?: unknown }).api
})

describe('AC-U1-2 — the states', () => {
  it('agent-spawned, owner known: "Connected to ‹session›"', async () => {
    const w = await mountChip()
    expect(label(w)).toBe('Connected to Fix login bug')
    expect(w.find('[data-testid="agent-chip-parked"]').exists()).toBe(false)
    expect(w.find('[data-testid="agent-disconnect"]').exists()).toBe(true)
  })

  it('a parked owner gets "(parked)"', async () => {
    seedSessions([{ sessionId: 'sess-1', summary: 'Fix login bug', hibernated: true }])
    const w = await mountChip()
    expect(w.find('[data-testid="agent-chip-parked"]').text()).toBe('(parked)')
  })

  it('an owner the sessions store does not know reads "a closed session", with no click target', async () => {
    const w = await mountChip({ ownerSessionId: 'sess-gone' })
    expect(label(w)).toBe('Connected to a closed session')
    expect(w.find('button[data-testid="agent-chip"]').exists()).toBe(false)
  })

  it('no owner at all reads "an agent"', async () => {
    const w = await mountChip({ ownerSessionId: null })
    expect(label(w)).toBe('Connected to an agent')
  })

  it('an operator-opened terminal with a live lease says an agent can type here', async () => {
    chip = agentChip({ origin: 'operator', ownerSessionId: null, leaseActive: true })
    const w = await mountChip({ origin: undefined, ownerSessionId: null })
    expect(label(w)).toBe('An agent can type here')
    expect(w.find('[data-testid="agent-disconnect"]').exists()).toBe(true)
  })

  it('an operator-opened terminal with a lease and a known owner names the session', async () => {
    chip = agentChip({ origin: 'operator', ownerSessionId: 'sess-1', leaseActive: true })
    const w = await mountChip({ origin: undefined, ownerSessionId: null })
    expect(label(w)).toBe('Fix login bug can type here')
  })

  it('an operator-opened terminal shows nothing until an agent reads it, then "reading" with NO Disconnect', async () => {
    chip = agentChip({ origin: 'operator', ownerSessionId: null })
    const w = await mountChip({ origin: undefined, ownerSessionId: null })
    expect(w.find('[data-testid="agent-connection-chip"]').exists()).toBe(false)

    activityCb?.({ terminalId: T, kind: 'read', at: 1 })
    await flushPromises()
    expect(label(w)).toBe('An agent is reading')
    expect(w.find('[data-testid="agent-disconnect"]').exists()).toBe(false)
  })

  it('a disconnected or exited terminal has no chip', async () => {
    chip = agentChip({ disconnected: true })
    expect((await mountChip()).find('[data-testid="agent-connection-chip"]').exists()).toBe(false)
    chip = agentChip({ exited: true })
    expect((await mountChip()).find('[data-testid="agent-connection-chip"]').exists()).toBe(false)
    chip = agentChip()
    expect(
      (await mountChip({ exited: true })).find('[data-testid="agent-connection-chip"]').exists()
    ).toBe(false)
  })

  it('follows the owner across a synthetic→real migration (rekey)', async () => {
    seedSessions([{ sessionId: 'synthetic-aaa', summary: 'Booting' }])
    const sessions = useSessionsStore()
    let migrate: ((from: string, to: string) => void) | null = null
    sessions.registerMigrateHandler = (fn) => {
      migrate = fn
      return () => {}
    }
    const helpers = useHelpersStore()
    const pane = {
      id: T,
      type: 'shell',
      cwd: '/repo',
      ratio: 1,
      origin: 'agent',
      terminalId: T,
      ptyId: 'pty-1',
      ownerSessionId: 'synthetic-aaa',
      spawnedAt: 0
    } as HelperPaneAgentTerminal
    helpers.byWorktree = new Map([
      ['/repo', { splitVisible: true, splitRatio: 0.5, panes: [pane] }]
    ])
    expect(migrate).not.toBeNull()

    // The transcript lands: the row is now keyed by the real id.
    seedSessions([{ sessionId: 'real-bbb', summary: 'Booting' }])
    migrate!('synthetic-aaa', 'real-bbb')

    const owner = helpers.byWorktree.get('/repo')!.panes[0] as HelperPaneAgentTerminal
    expect(owner.ownerSessionId).toBe('real-bbb')
    const w = await mountChip({ ownerSessionId: owner.ownerSessionId })
    expect(label(w)).toBe('Connected to Booting')
  })
})

describe('AC-U1-3 — click and Disconnect', () => {
  it('clicking the chip selects the owner session', async () => {
    const sessions = useSessionsStore()
    const select = vi.spyOn(sessions, 'select').mockImplementation(() => {})
    const w = await mountChip()
    await w.find('button[data-testid="agent-chip"]').trigger('click')
    expect(select).toHaveBeenCalledWith('sess-1')
  })

  it('Disconnect removes the chip at once, tells main, toasts, and asks no confirm', async () => {
    const confirm = vi.fn(() => true)
    ;(globalThis as unknown as { confirm: unknown }).confirm = confirm
    const ui = useUiStore()
    const toast = vi.spyOn(ui, 'pushToast')
    const w = await mountChip()

    await w.find('[data-testid="agent-disconnect"]').trigger('click')
    await nextTick()
    expect(w.find('[data-testid="agent-connection-chip"]').exists()).toBe(false)
    await flushPromises()

    expect(disconnect).toHaveBeenCalledWith(T)
    expect(confirm).not.toHaveBeenCalled()
    expect(toast).toHaveBeenCalledTimes(1)
    expect(toast.mock.calls[0]![0]).toMatchObject({
      title: 'Agent disconnected from this terminal'
    })
  })

  it('stays gone: a late chip answer cannot bring a disconnected chip back', async () => {
    const w = await mountChip()
    await w.find('[data-testid="agent-disconnect"]').trigger('click')
    await flushPromises()
    await useAgentTerminalsStore().refreshChip(T) // main still says connected (stale answer)
    await nextTick()
    expect(w.find('[data-testid="agent-connection-chip"]').exists()).toBe(false)
  })

  it('end to end with the real registry: after the click the gate refuses read AND write', async () => {
    const reg = new TerminalRegistry()
    const leases = new TerminalLeases()
    reg.register({
      terminalId: T,
      ptyId: 'p',
      folder: '/repo',
      origin: 'agent',
      ownerSessionId: 'sess-1',
      size: { cols: 80, rows: 24 }
    })
    const gate = (): ReturnType<typeof gateTerminalOp>[] => {
      const state = resolveTerminalGateState(reg.get(T), { readOptIn: false, writesEnabled: true })
      return [gateTerminalOp('read_terminal', state), gateTerminalOp('send_terminal', state)]
    }
    expect(gate()).toEqual([null, null])
    chip = terminalChipState(reg.get(T)!, leases.isActive(T))
    // The preload's `terminalDisconnect` lands on the registry (main's `disconnectTerminal`).
    disconnect = vi.fn(async (id: string) => reg.disconnect(id))
    installApi()

    const w = await mountChip()
    await w.find('[data-testid="agent-disconnect"]').trigger('click')
    await flushPromises()
    expect(gate()).toEqual(['TERMINAL_DISCONNECTED', 'TERMINAL_DISCONNECTED'])
  })
})

describe('AC-U1-4 — the live word', () => {
  it('shows nothing and does not pulse while idle', async () => {
    const w = await mountChip()
    expect(w.find('[data-testid="agent-chip-word"]').exists()).toBe(false)
    expect(w.find('[data-testid="agent-chip-dot"]').classes()).not.toContain('anim-pulse-dot')
    expect(w.find('[data-testid="agent-chip-live"]').text()).toBe('')
  })

  it('shows reading, then typing (write outranks read), with the accent pulse and an aria-live node', async () => {
    const w = await mountChip()
    activityCb?.({ terminalId: T, kind: 'read', at: 1 })
    await flushPromises()
    expect(w.find('[data-testid="agent-chip-word"]').text()).toBe('· reading')
    const dot = w.find('[data-testid="agent-chip-dot"]')
    expect(dot.classes()).toEqual(
      expect.arrayContaining(['anim-pulse-dot', 'anim-pulse-dot--accent'])
    )
    expect(w.find('[data-testid="agent-chip-live"]').attributes('aria-live')).toBe('polite')

    activityCb?.({ terminalId: T, kind: 'write', at: 2 })
    await flushPromises()
    expect(w.find('[data-testid="agent-chip-word"]').text()).toBe('· typing')
    expect(w.find('[data-testid="agent-chip-live"]').text()).toBe('typing')
  })

  it('ignores activity for another terminal', async () => {
    const w = await mountChip()
    activityCb?.({ terminalId: 'h-other', kind: 'write', at: 1 })
    await flushPromises()
    expect(w.find('[data-testid="agent-chip-word"]').exists()).toBe(false)
  })
})
