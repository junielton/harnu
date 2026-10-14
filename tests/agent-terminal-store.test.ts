// @vitest-environment jsdom
/**
 * T479 (agent terminals B2) — the renderer half of an agent terminal's lifecycle, against the
 * real helpers store with `window.api` faked:
 *
 *   AC-B2-3  the exit watch is armed when `pane.split` lands, not when the pane mounts
 *   AC-B2-4  an exit between spawn and landing is caught by `terminal:status`
 *   AC-B2-5  `removeHelper` kills the PTY through main even if the pane never mounted
 *   AC-B2-6  a re-dispatched pane the store already has is not duplicated
 *   AC-B2-7  agent panes (and every transient field) never reach `helpers.json`
 *
 * No component is mounted anywhere in this file: that is the point of AC-B2-3 and AC-B2-5.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useHelpersStore, type HelperPaneAgentTerminal } from '../src/renderer/src/stores/helpers'
import { useUiStore } from '../src/renderer/src/stores/ui'
import { buildDispatchActions } from '../src/renderer/src/stores/command-dispatch'
import { makeCommandRouter } from '../src/renderer/src/stores/command-router'

const WT = '/repo/a'
const NOW = 1_700_000_000_000

interface Status {
  known: boolean
  state?: 'running' | 'exited'
  spawnedAt?: number
  exit?: { code: number | null; at: number; reason: 'natural' | 'closed' }
  snapshot?: string
}

let exitCbs: Map<string, (evt: { exitCode: number }) => void>
let status: Status
let api: {
  onPtyExit: ReturnType<typeof vi.fn>
  terminalStatus: ReturnType<typeof vi.fn>
  terminalClose: ReturnType<typeof vi.fn>
  helpersSet: ReturnType<typeof vi.fn>
  helpersGet: ReturnType<typeof vi.fn>
}

/** Let the store's promise chains (status → handler) settle. */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await Promise.resolve()
}

function split(
  over: Record<string, unknown> = {}
): ReturnType<ReturnType<typeof makeCommandRouter>> {
  const router = makeCommandRouter(buildDispatchActions())
  return router('pane.split', {
    target: 'split',
    worktreePath: WT,
    cwd: WT,
    kind: 'shell',
    paneId: 'h-a',
    ptyId: 'pty-a',
    ownerSessionId: 'sess-1',
    spawnedAt: NOW - 5_000,
    ...over
  })
}

const panes = (): ReturnType<typeof useHelpersStore>['byWorktree'] extends infer _
  ? unknown[]
  : never => useHelpersStore().byWorktree.get(WT)?.panes ?? []

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
  setActivePinia(createPinia())
  exitCbs = new Map()
  status = { known: true, state: 'running', spawnedAt: NOW - 5_000 }
  api = {
    onPtyExit: vi.fn((id: string, cb: (evt: { exitCode: number }) => void) => {
      exitCbs.set(id, cb)
      return () => exitCbs.delete(id)
    }),
    terminalStatus: vi.fn(async () => status),
    terminalClose: vi.fn(async () => true),
    helpersSet: vi.fn(async () => {}),
    // nothing saved on disk, unless a test says otherwise
    helpersGet: vi.fn(async () => null)
  }
  ;(window as unknown as { api: unknown }).api = api
})

afterEach(() => {
  vi.useRealTimers()
})

describe('pane.split for an agent terminal', () => {
  it('uses the terminalId as the pane id and keeps main-spawned PTY on the pane — it mints nothing', () => {
    expect(split()).toEqual({ paneId: 'h-a' })
    expect(panes()).toHaveLength(1)
    expect(panes()[0]).toMatchObject({
      id: 'h-a',
      type: 'shell',
      origin: 'agent',
      terminalId: 'h-a',
      ptyId: 'pty-a',
      ownerSessionId: 'sess-1',
      spawnedAt: NOW - 5_000
    })
  })

  it('AC-B2-6: a second pane.split for the same id returns it and does not duplicate the pane', () => {
    split()
    expect(split()).toEqual({ paneId: 'h-a' })
    expect(panes()).toHaveLength(1)
    // ...and arms no second exit watch
    expect(api.onPtyExit).toHaveBeenCalledTimes(1)
  })

  it('rejects a paneId without a ptyId', () => {
    expect(split({ ptyId: undefined })).toEqual({ error: 'BAD_ARGS' })
  })

  it('a plain shell pane.split (no paneId) still mints its own pane and arms no watch', () => {
    const r = split({ paneId: undefined, ptyId: undefined, spawnedAt: undefined })
    expect(r).toMatchObject({ paneId: expect.stringMatching(/^h-/) })
    expect(api.onPtyExit).not.toHaveBeenCalled()
  })

  it('a reload re-announcement does not count as unseen news; a fresh spawn does', () => {
    const helpers = useHelpersStore()
    split()
    expect(helpers.unseenAgentPaneCount(WT)).toBe(1)
    split({ paneId: 'h-b', ptyId: 'pty-b', redispatch: true })
    expect(helpers.unseenAgentPaneCount(WT)).toBe(1)
  })
})

describe('the exit watch is armed when the pane lands (AC-B2-3)', () => {
  it('an exit ≥ 2 s after spawn removes a pane that never mounted, and asks main to close it', async () => {
    split() // spawnedAt = now − 5 s
    expect(api.onPtyExit).toHaveBeenCalledWith('pty-a', expect.any(Function))
    await settle()

    status = {
      known: true,
      state: 'exited',
      spawnedAt: NOW - 5_000,
      exit: { code: 0, at: NOW, reason: 'natural' }
    }
    exitCbs.get('pty-a')!({ exitCode: 0 })
    await settle()

    expect(panes()).toHaveLength(0)
    expect(api.terminalClose).toHaveBeenCalledWith('h-a')
  })

  it('an exit < 2 s after spawn keeps the pane, flags it exited with the snapshot, and raises the stale toast', async () => {
    split({ spawnedAt: NOW - 500 })
    await settle()

    status = {
      known: true,
      state: 'exited',
      spawnedAt: NOW - 500,
      exit: { code: 127, at: NOW, reason: 'natural' },
      snapshot: 'zsh: command not found\r\n'
    }
    exitCbs.get('pty-a')!({ exitCode: 127 })
    await settle()

    const pane = panes()[0] as HelperPaneAgentTerminal
    expect(pane.exited).toEqual({ code: 127, snapshot: 'zsh: command not found\r\n' })
    expect(api.terminalClose).not.toHaveBeenCalled()
    expect(useUiStore().toasts.some((t) => t.kind === 'danger')).toBe(true)
  })

  it('the watch fires once even if the exit event and the status answer both report it', async () => {
    split({ spawnedAt: NOW - 500 })
    status = {
      known: true,
      state: 'exited',
      spawnedAt: NOW - 500,
      exit: { code: 1, at: NOW, reason: 'natural' }
    }
    await settle()
    exitCbs.get('pty-a')?.({ exitCode: 1 })
    await settle()
    expect(useUiStore().toasts.filter((t) => t.kind === 'danger')).toHaveLength(1)
  })
})

describe('an exit that beat the dispatch (AC-B2-4)', () => {
  it('terminal:status catches it with no exit event ever delivered — a late one removes the pane', async () => {
    status = {
      known: true,
      state: 'exited',
      spawnedAt: NOW - 5_000,
      exit: { code: 0, at: NOW - 100, reason: 'natural' }
    }
    split()
    await settle()
    expect(api.terminalStatus).toHaveBeenCalledWith('h-a')
    expect(panes()).toHaveLength(0)
  })

  it('an early one keeps the pane flagged exited', async () => {
    status = {
      known: true,
      state: 'exited',
      spawnedAt: NOW - 5_000,
      exit: { code: 1, at: NOW - 4_800, reason: 'natural' },
      snapshot: 'boom\r\n'
    }
    split()
    await settle()
    expect((panes()[0] as HelperPaneAgentTerminal).exited).toEqual({
      code: 1,
      snapshot: 'boom\r\n'
    })
  })

  it('subscribes to the exit BEFORE asking for the status', () => {
    const order: string[] = []
    api.onPtyExit.mockImplementation((id: string, cb: (e: { exitCode: number }) => void) => {
      order.push('subscribe')
      exitCbs.set(id, cb)
      return () => {}
    })
    api.terminalStatus.mockImplementation(async () => {
      order.push('status')
      return status
    })
    split()
    expect(order).toEqual(['subscribe', 'status'])
  })

  it('a terminal main no longer knows leaves a ghost pane: it is removed', async () => {
    status = { known: false }
    split()
    await settle()
    expect(panes()).toHaveLength(0)
  })
})

describe('main-owned teardown (AC-B2-5)', () => {
  it('removeHelper on a pane that was never mounted asks main to close the terminal', () => {
    const helpers = useHelpersStore()
    split()
    helpers.removeHelper(WT, 'h-a')
    expect(api.terminalClose).toHaveBeenCalledTimes(1)
    expect(api.terminalClose).toHaveBeenCalledWith('h-a')
    expect(panes()).toHaveLength(0)
  })

  it('also stops the exit watch, so a later exit cannot resurrect or re-remove anything', async () => {
    const helpers = useHelpersStore()
    split()
    helpers.removeHelper(WT, 'h-a')
    expect(exitCbs.has('pty-a')).toBe(false)
    api.terminalClose.mockClear()
    await settle()
    expect(api.terminalClose).not.toHaveBeenCalled()
  })

  it('closeHelperById (the agent close_pane path) goes through the same teardown', () => {
    const helpers = useHelpersStore()
    split()
    expect(helpers.closeHelperById(WT, 'h-a')).toBe(true)
    expect(api.terminalClose).toHaveBeenCalledWith('h-a')
  })

  it('dropping the worktree closes its terminals too', () => {
    const helpers = useHelpersStore()
    split()
    helpers.dropWorktreeFromMemory(WT)
    expect(api.terminalClose).toHaveBeenCalledWith('h-a')
  })

  it('removing an operator-opened shell never calls terminal:close', () => {
    const helpers = useHelpersStore()
    const id = helpers.addShellHelper(WT, WT)
    helpers.removeHelper(WT, id)
    expect(api.terminalClose).not.toHaveBeenCalled()
  })
})

describe('persistence (AC-B2-7)', () => {
  it('an agent pane is absent from helpers.json; an operator shell next to it is unchanged', async () => {
    const helpers = useHelpersStore()
    const operatorId = helpers.addShellHelper(WT, WT)
    split()
    await helpers.flushNow()

    expect(api.helpersSet).toHaveBeenCalled()
    const persisted = api.helpersSet.mock.calls.at(-1)![0].state.panes as Array<
      Record<string, unknown>
    >
    expect(persisted.map((p) => p.id)).toEqual([operatorId])
    expect(Object.keys(persisted[0]).sort()).toEqual(['cwd', 'id', 'ratio', 'type'])
  })

  it('no transient field leaks even from a flagged-exited agent pane', async () => {
    const helpers = useHelpersStore()
    status = {
      known: true,
      state: 'exited',
      spawnedAt: NOW - 500,
      exit: { code: 1, at: NOW, reason: 'natural' },
      snapshot: 'x'
    }
    split({ spawnedAt: NOW - 500 })
    await settle()
    await helpers.flushNow()
    const json = JSON.stringify(api.helpersSet.mock.calls.at(-1)![0].state)
    for (const key of ['origin', 'terminalId', 'ptyId', 'ownerSessionId', 'spawnedAt', 'exited']) {
      expect(json).not.toContain(`"${key}"`)
    }
  })
})

describe("a reload re-dispatch must not wipe the operator's saved panes (D1)", () => {
  const saved = {
    splitVisible: true,
    splitRatio: 0.55,
    panes: [{ id: 'h-op', type: 'shell', cwd: WT, ratio: 1 }]
  }

  it('ensureLoaded after a re-dispatched agent pane merges the saved panes under the live one', async () => {
    api.helpersGet.mockResolvedValue(saved)
    const helpers = useHelpersStore()
    split() // main re-announces the terminal BEFORE the worktree was ever loaded
    await helpers.ensureLoaded(WT)
    expect(panes().map((p) => (p as { id: string }).id)).toEqual(['h-op', 'h-a'])
    expect(helpers.byWorktree.get(WT)?.splitRatio).toBe(0.55)
  })

  it('the flush that follows writes the saved pane back, never panes: []', async () => {
    api.helpersGet.mockResolvedValue(saved)
    const helpers = useHelpersStore()
    split()
    await helpers.flushNow()
    const written = api.helpersSet.mock.calls.at(-1)![0].state.panes as Array<{ id: string }>
    expect(written.map((p) => p.id)).toEqual(['h-op'])
  })

  it('a worktree whose saved state cannot be read is not overwritten', async () => {
    api.helpersGet.mockRejectedValue(new Error('disk'))
    const helpers = useHelpersStore()
    split()
    await helpers.flushNow()
    expect(api.helpersSet).not.toHaveBeenCalled()
  })

  it('a pane the live state already holds is not doubled by the merge', async () => {
    const helpers = useHelpersStore()
    const opId = helpers.addShellHelper(WT, WT)
    api.helpersGet.mockResolvedValue({
      ...saved,
      panes: [{ id: opId, type: 'shell', cwd: WT, ratio: 1 }]
    })
    await helpers.ensureLoaded(WT)
    expect(panes()).toHaveLength(1)
  })
})

describe('a rolled-back spawn that exits at once leaves no ghost (D2)', () => {
  it('an exit event whose status answer is "unknown" removes the pane and raises no toast', async () => {
    split({ spawnedAt: NOW - 500 })
    await settle()
    status = { known: false }
    exitCbs.get('pty-a')!({ exitCode: 1 })
    await settle()
    expect(panes()).toHaveLength(0)
    expect(useUiStore().toasts.filter((t) => t.kind === 'danger')).toHaveLength(0)
  })
})
