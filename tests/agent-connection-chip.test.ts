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
import {
  LEASE_RECHECK_MS,
  useAgentTerminalsStore,
  type ChipState
} from '../src/renderer/src/stores/agent-terminals'
import { useUiStore } from '../src/renderer/src/stores/ui'
import { TerminalLeases } from '../src/main/terminal-lease'
import { TerminalRegistry, terminalChipState } from '../src/main/terminal-registry'
import { resolveTerminalGateState, gateTerminalOp } from '../src/main/terminal-gate-core'

const T = 'h-term'

let chip: ChipState | null
let activityCb: ((e: { terminalId: string; kind: 'read' | 'write'; at: number }) => void) | null
let chipChangedCb: ((e: { terminalId: string }) => void) | null
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
    onTerminalChipChanged: vi.fn((cb: typeof chipChangedCb) => {
      chipChangedCb = cb
      return () => {
        chipChangedCb = null
      }
    }),
    terminalClose: vi.fn(async () => true),
    helpersGet: vi.fn(async () => ({ splitVisible: false, splitRatio: 0.5, panes: [] })),
    helpersSet: vi.fn(async () => undefined),
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
  chipChangedCb = null
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

  it('a lease never names a session: even a projection that carries an owner reads "An agent"', async () => {
    chip = agentChip({ origin: 'operator', ownerSessionId: 'sess-1', leaseActive: true })
    const w = await mountChip({ origin: undefined, ownerSessionId: null })
    expect(label(w)).toBe('An agent can type here')
    expect(w.find('button[data-testid="agent-chip"]').exists()).toBe(false)
  })

  it('an operator-opened terminal shows nothing until an agent reads it, then "reading" with NO Disconnect', async () => {
    chip = agentChip({ origin: 'operator', ownerSessionId: null })
    const w = await mountChip({ origin: undefined, ownerSessionId: null })
    expect(w.find('[data-testid="agent-connection-chip"]').exists()).toBe(false)

    activityCb?.({ terminalId: T, kind: 'read', at: 1 })
    await flushPromises()
    expect(label(w)).toBe('An agent is reading')
    // The label says it already: no second "· reading" beside it.
    expect(w.find('[data-testid="agent-chip-word"]').exists()).toBe(false)
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
    chip = terminalChipState(reg.get(T)!, leases.isActive(T, 'p'))
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

describe('Disconnect that main did not apply (L2: a safety control must not fail open)', () => {
  async function failing(
    how: 'false' | 'throw'
  ): Promise<{ w: Awaited<ReturnType<typeof mountChip>>; toast: ReturnType<typeof vi.spyOn> }> {
    disconnect = vi.fn(async () => {
      if (how === 'throw') throw new Error('ipc gone')
      return false
    })
    installApi()
    const toast = vi.spyOn(useUiStore(), 'pushToast')
    const w = await mountChip()
    await w.find('[data-testid="agent-disconnect"]').trigger('click')
    await flushPromises()
    return { w, toast }
  }

  for (const how of ['false', 'throw'] as const) {
    it(`main answers ${how === 'false' ? 'false' : 'with a throw'}: the chip comes back and the toast is the error one`, async () => {
      const { w, toast } = await failing(how)
      expect(disconnect).toHaveBeenCalledWith(T)
      expect(w.find('[data-testid="agent-connection-chip"]').exists()).toBe(true)
      expect(w.find('[data-testid="agent-disconnect"]').exists()).toBe(true)
      expect(useAgentTerminalsStore().disconnectedIds[T]).toBeUndefined()
      expect(toast).toHaveBeenCalledTimes(1)
      expect(toast.mock.calls[0]![0]).toMatchObject({
        kind: 'danger',
        title: 'Could not disconnect the agent from this terminal',
        description: 'The agent still has access. Try again.'
      })
      expect(JSON.stringify(toast.mock.calls)).not.toContain(
        'Agent disconnected from this terminal'
      )
    })
  }

  it('after a failure the operator can try again, and a success then sticks', async () => {
    const { w } = await failing('false')
    disconnect = vi.fn(async () => true)
    installApi()
    await w.find('[data-testid="agent-disconnect"]').trigger('click')
    await flushPromises()
    expect(w.find('[data-testid="agent-connection-chip"]').exists()).toBe(false)
  })

  it('a second click while main is still answering is ignored', async () => {
    let release: (v: boolean) => void = () => {}
    disconnect = vi.fn(() => new Promise<boolean>((r) => (release = r)))
    installApi()
    const w = await mountChip()
    const store = useAgentTerminalsStore()
    void store.disconnect(T)
    void store.disconnect(T)
    release(true)
    await flushPromises()
    expect(disconnect).toHaveBeenCalledTimes(1)
    expect(w.find('[data-testid="agent-connection-chip"]').exists()).toBe(false)
  })
})

describe('accessibility and truncation recovery (L4, L5)', () => {
  it('the title is the full label plus where a click goes, "(parked)" included', async () => {
    seedSessions([{ sessionId: 'sess-1', summary: 'Fix login bug', hibernated: true }])
    const w = await mountChip()
    expect(w.find('[data-testid="agent-chip"]').attributes('title')).toBe(
      'Connected to Fix login bug (parked) — Go to session'
    )
  })

  it('a chip with no click target has the label alone as its title', async () => {
    const w = await mountChip({ ownerSessionId: null })
    expect(w.find('[data-testid="agent-chip"]').attributes('title')).toBe('Connected to an agent')
  })

  it('the aria-live node is OUTSIDE the button, so its name does not repeat the word', async () => {
    const w = await mountChip()
    activityCb?.({ terminalId: T, kind: 'write', at: 1 })
    await flushPromises()
    const live = w.find('[data-testid="agent-chip-live"]')
    expect(live.text()).toBe('typing')
    const chipEl = w.find('button[data-testid="agent-chip"]').element
    expect(chipEl.contains(live.element)).toBe(false)
  })

  it('narrow: the label, "(parked)" and the word hide with the header container; the chip clips instead of overflowing', async () => {
    seedSessions([{ sessionId: 'sess-1', summary: 'Fix login bug', hibernated: true }])
    const w = await mountChip()
    activityCb?.({ terminalId: T, kind: 'read', at: 1 })
    await flushPromises()
    for (const id of ['agent-chip-label', 'agent-chip-parked', 'agent-chip-word']) {
      expect(w.find(`[data-testid="${id}"]`).classes()).toContain('@max-[180px]:hidden')
    }
    expect(w.find('[data-testid="agent-chip"]').classes()).toEqual(
      expect.arrayContaining(['min-w-0', 'shrink', 'overflow-hidden'])
    )
  })
})

describe('lease changes reach the chip (L3)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('terminal:chipChanged re-reads the chip: a lease that ended removes "An agent can type here" at once', async () => {
    chip = agentChip({ origin: 'operator', ownerSessionId: null, leaseActive: true })
    const w = await mountChip({ origin: undefined, ownerSessionId: null })
    expect(label(w)).toBe('An agent can type here')

    chip = agentChip({ origin: 'operator', ownerSessionId: null, leaseActive: false })
    chipChangedCb?.({ terminalId: T })
    await flushPromises()
    expect(w.find('[data-testid="agent-connection-chip"]').exists()).toBe(false)
  })

  it('a lease granted later shows up on the event, before any agent call', async () => {
    chip = agentChip({ origin: 'operator', ownerSessionId: null })
    const w = await mountChip({ origin: undefined, ownerSessionId: null })
    expect(w.find('[data-testid="agent-connection-chip"]').exists()).toBe(false)
    chip = agentChip({ origin: 'operator', ownerSessionId: null, leaseActive: true })
    chipChangedCb?.({ terminalId: T })
    await flushPromises()
    expect(label(w)).toBe('An agent can type here')
  })

  it('an idle-out announces nothing, so a shown lease is re-checked every LEASE_RECHECK_MS', async () => {
    chip = agentChip({ origin: 'operator', ownerSessionId: null, leaseActive: true })
    const w = await mountChip({ origin: undefined, ownerSessionId: null })
    expect(LEASE_RECHECK_MS).toBe(5_000)
    chip = agentChip({ origin: 'operator', ownerSessionId: null, leaseActive: false })
    await vi.advanceTimersByTimeAsync(LEASE_RECHECK_MS - 1)
    expect(label(w)).toBe('An agent can type here')
    await vi.advanceTimersByTimeAsync(1)
    await flushPromises()
    expect(w.find('[data-testid="agent-connection-chip"]').exists()).toBe(false)
  })
})

describe('forget on pane removal (L6)', () => {
  it('removing the pane drops the chip state, the live word and the lease re-check', async () => {
    vi.useFakeTimers()
    try {
      chip = agentChip({ origin: 'operator', ownerSessionId: null, leaseActive: true })
      await mountChip({ origin: undefined, ownerSessionId: null })
      const store = useAgentTerminalsStore()
      activityCb?.({ terminalId: T, kind: 'read', at: 1 })
      await flushPromises()
      expect(store.chips[T]).toBeDefined()
      expect(store.words[T]).toBe('reading')

      const helpers = useHelpersStore()
      helpers.byWorktree = new Map([
        [
          '/repo',
          {
            splitVisible: true,
            splitRatio: 0.5,
            panes: [{ id: T, type: 'shell', cwd: '/repo', ratio: 1 }]
          }
        ]
      ])
      helpers.removeHelper('/repo', T)

      expect(store.chips[T]).toBeUndefined()
      expect(store.words[T]).toBeUndefined()
      const calls = (window.api.terminalChip as ReturnType<typeof vi.fn>).mock.calls.length
      await vi.advanceTimersByTimeAsync(LEASE_RECHECK_MS * 3)
      expect((window.api.terminalChip as ReturnType<typeof vi.fn>).mock.calls.length).toBe(calls)
    } finally {
      vi.useRealTimers()
    }
  })
})
