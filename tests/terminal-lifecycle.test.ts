/**
 * T479 (agent terminals B2) — what main tells the renderer about a terminal: the
 * `terminal:status` answer (AC-B2-4), the re-dispatch after a reload (AC-B2-6, AC-B2-8) and the
 * tombstone snapshot (AC-B2-3). Pure core, no electron.
 */
import { describe, it, expect, vi } from 'vitest'
import {
  paneSplitFor,
  redispatchLiveTerminals,
  terminalStatus
} from '../src/main/terminal-lifecycle'
import {
  TOMBSTONE_SNAPSHOT_LINES,
  TerminalRegistry,
  tailSnapshot
} from '../src/main/terminal-registry'

function registryWith(): { reg: TerminalRegistry; clock: { t: number } } {
  const clock = { t: 1_000 }
  return { reg: new TerminalRegistry(() => clock.t), clock }
}

function add(
  reg: TerminalRegistry,
  id: string,
  over: Partial<Parameters<TerminalRegistry['register']>[0]> = {}
): void {
  reg.register({
    terminalId: id,
    ptyId: `pty-${id}`,
    folder: '/repo/a',
    origin: 'agent',
    ownerSessionId: 'sess-1',
    size: { cols: 120, rows: 30 },
    ...over
  })
}

describe('terminalStatus', () => {
  it('reports an unknown id (and a non-string) as not known', () => {
    const { reg } = registryWith()
    expect(terminalStatus(reg, 'h-ghost')).toEqual({ known: false })
    expect(terminalStatus(reg, 42)).toEqual({ known: false })
  })

  it('AC-B2-4: an exit that happened before anyone asked is reported, with its time and snapshot', () => {
    const { reg, clock } = registryWith()
    add(reg, 'h-a')
    clock.t = 1_400
    reg.markExited('pty-h-a', 3, 'bye\r\n')
    expect(terminalStatus(reg, 'h-a')).toEqual({
      known: true,
      state: 'exited',
      spawnedAt: 1_000,
      exit: { code: 3, at: 1_400, reason: 'natural' },
      snapshot: 'bye\r\n'
    })
  })

  it('a running terminal carries its spawn time and no exit', () => {
    const { reg } = registryWith()
    add(reg, 'h-a')
    expect(terminalStatus(reg, 'h-a')).toEqual({ known: true, state: 'running', spawnedAt: 1_000 })
  })
})

describe('redispatchLiveTerminals', () => {
  it('AC-B2-6: re-announces each live agent terminal exactly once, with its original pty and spawn time', async () => {
    const { reg } = registryWith()
    add(reg, 'h-a')
    add(reg, 'h-b', { folder: '/repo/b', ownerSessionId: null })
    const dispatch = vi.fn(async () => ({ paneId: 'x' }))

    await expect(redispatchLiveTerminals(reg, dispatch)).resolves.toBe(2)

    expect(dispatch).toHaveBeenCalledTimes(2)
    expect(dispatch).toHaveBeenCalledWith('pane.split', {
      target: 'split',
      worktreePath: '/repo/a',
      cwd: '/repo/a',
      kind: 'shell',
      paneId: 'h-a',
      ptyId: 'pty-h-a',
      ownerSessionId: 'sess-1',
      spawnedAt: 1_000,
      redispatch: true
    })
    expect(dispatch).toHaveBeenCalledWith(
      'pane.split',
      expect.objectContaining({ paneId: 'h-b', worktreePath: '/repo/b', ownerSessionId: null })
    )
  })

  it('skips exited terminals and operator-opened ones', async () => {
    const { reg } = registryWith()
    add(reg, 'h-live')
    add(reg, 'h-dead')
    add(reg, 'h-op', { origin: 'operator' })
    reg.markExited('pty-h-dead', 0)
    const dispatch = vi.fn(async () => ({}))
    await redispatchLiveTerminals(reg, dispatch)
    expect(dispatch.mock.calls.map((c) => (c[1] as { paneId: string }).paneId)).toEqual(['h-live'])
  })

  it('a rejected dispatch (the renderer reloaded again) does not stop the others', async () => {
    const { reg } = registryWith()
    add(reg, 'h-a')
    add(reg, 'h-b')
    const dispatch = vi
      .fn()
      .mockRejectedValueOnce(new Error('renderer-reload'))
      .mockResolvedValueOnce({})
    await expect(redispatchLiveTerminals(reg, dispatch)).resolves.toBe(2)
    expect(dispatch).toHaveBeenCalledTimes(2)
  })

  it('AC-B2-8: a terminal that was mounted before the reload is re-announced under the SAME ptyId and was never closed', async () => {
    const { reg } = registryWith()
    add(reg, 'h-a')
    // The renderer unload only tells main its xterm is gone — it never destroys the PTY.
    reg.setRendererAttached('h-a', false)
    const dispatch = vi.fn(async () => ({}))
    await redispatchLiveTerminals(reg, dispatch)
    expect(reg.get('h-a')).toMatchObject({ state: 'running', ptyId: 'pty-h-a' })
    expect(reg.get('h-a')?.exit).toBeUndefined()
    expect(dispatch).toHaveBeenCalledWith(
      'pane.split',
      expect.objectContaining({ ptyId: 'pty-h-a' })
    )
  })
})

describe('paneSplitFor', () => {
  it('builds the pane.split payload from the record', () => {
    const { reg } = registryWith()
    add(reg, 'h-a')
    expect(paneSplitFor(reg.get('h-a')!)).toMatchObject({ paneId: 'h-a', kind: 'shell' })
  })
})

describe('tailSnapshot', () => {
  it('keeps short output whole', () => {
    expect(tailSnapshot('a\r\nb\r\n')).toBe('a\r\nb\r\n')
  })

  it(`keeps only the last ${TOMBSTONE_SNAPSHOT_LINES} lines`, () => {
    const lines = Array.from({ length: 500 }, (_, i) => `line ${i}`)
    const out = tailSnapshot(lines.join('\n'))
    const kept = out.split('\n')
    expect(kept).toHaveLength(TOMBSTONE_SNAPSHOT_LINES)
    expect(kept.at(-1)).toBe('line 499')
    expect(kept[0]).toBe('line 300')
  })

  it('caps one enormous line, keeping its tail', () => {
    const out = tailSnapshot('x'.repeat(200_000) + 'END')
    expect(out.length).toBeLessThanOrEqual(64 * 1024)
    expect(out.endsWith('END')).toBe(true)
  })
})

describe('the registry additions', () => {
  it('starts without a renderer xterm and flips back on xtermGone', () => {
    const { reg } = registryWith()
    add(reg, 'h-a')
    expect(reg.get('h-a')?.rendererAttached).toBe(false)
    reg.setRendererAttached('h-a', true)
    expect(reg.get('h-a')?.rendererAttached).toBe(true)
    reg.setRendererAttached('h-a', false)
    expect(reg.get('h-a')?.rendererAttached).toBe(false)
    reg.setRendererAttached('h-ghost', false) // unknown id: a no-op, not a throw
  })
})
