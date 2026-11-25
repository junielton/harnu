import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createBridgeRuntime, createWalkService } from '../src/main/walk/walk-service'
import { createWalkProbe } from '../src/main/walk/walk-links'
import { liveTerminalPtyId } from '../src/renderer/src/lib/live-pty-resolver'

/**
 * A turn sent to a live session whose `claude` process died without being parked must NOT be marked delivered
 * (stp-19 F-5). The renderer answers `delivered` only for a terminal whose process is alive; a dead one answers
 * `parked`, main tries to wake it, and until the session comes back the turn waits in the run's outbox, exactly as
 * it does for a parked session.
 */

let root: string
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'walk-dead-peer-')))
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

describe('the live terminal of a session (what the renderer pastes into)', () => {
  it('is the PTY of a live entry and nothing for a dead or missing one', () => {
    expect(liveTerminalPtyId({ ptyId: 'pty-1', dead: false })).toBe('pty-1')
    // the process exited on its own: the entry stays cached (its scrollback stays viewable) but is no one to talk to
    expect(liveTerminalPtyId({ ptyId: 'pty-1', dead: true })).toBeNull()
    expect(liveTerminalPtyId(undefined)).toBeNull()
  })
})

describe('a turn for a session whose claude process died', () => {
  it('stays in the outbox, is not marked delivered, and is replayed once the session is back', async () => {
    // a stand-in for the renderer: one cached terminal, whose process can die
    const terminal = { ptyId: 'pty-1', dead: false }
    const pasted: string[] = []
    let canWake = false
    const runtime = createBridgeRuntime(
      {
        async dispatch(command) {
          if (command === 'session.userTurn') {
            const pty = liveTerminalPtyId(terminal)
            return pty
              ? (pasted.push(command), { delivered: true, sessionId: 'sess-owner' })
              : { parked: true, sessionId: 'sess-owner' }
          }
          if (command === 'session.wake') {
            if (!canWake) return { error: 'the session could not be resumed' }
            terminal.dead = false
            return { ok: true }
          }
          return { ok: true }
        }
      },
      async () => true
    )
    const svc = createWalkService(root, { runtime: () => runtime })
    const opened = await svc.open({
      sessionId: 'sess-owner',
      script: {
        title: 'Dead peer',
        purpose: 'check',
        source: { kind: 'feature', text: 'A feature that talks to a session' },
        checks: [
          {
            id: 'c1',
            title: 'Check c1',
            why: 'why',
            where: { text: 'the page' },
            do: [{ text: 'Do it.', see: 'It works.' }],
            passes: 'It works.',
            fails: 'It does not.',
            check: { how: 'look at it' }
          }
        ]
      },
      probe: createWalkProbe({
        folder: root,
        knownFolders: [root],
        cardSlugs: () => [],
        mission: () => null
      })
    })
    if (!opened.ok) throw new Error(JSON.stringify(opened))
    const { walkId, runId } = opened
    await svc.operate({ walkId, runId, op: 'start' })
    await svc.idle()

    // the claude process dies (killed, not parked) while the terminal stays cached
    terminal.dead = true
    await svc.operate({ walkId, runId, op: 'done' })
    await svc.idle()
    expect(pasted).toEqual([])
    const pending = await svc.store.pendingOutbox(walkId, runId)
    expect(pending.map((o) => o.kind)).toEqual(['done'])

    // the session comes back: the same turn is replayed, once
    canWake = true
    expect(await svc.replay()).toEqual({ delivered: 1, pending: 0 })
    expect(pasted).toHaveLength(1)
    expect(await svc.store.pendingOutbox(walkId, runId)).toEqual([])
  })
})
