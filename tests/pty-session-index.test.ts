import { describe, it, expect, beforeEach } from 'vitest'
import { PtySessionIndex } from '../src/main/pty-session-index'
import { harnuOwnsSession } from '../src/main/messaging-socket'

describe('PtySessionIndex', () => {
  let idx: PtySessionIndex
  beforeEach(() => {
    idx = new PtySessionIndex()
  })

  it('returns undefined for an unknown key', () => {
    expect(idx.getPtyId('nope')).toBeUndefined()
    expect(idx.has('nope')).toBe(false)
  })

  it('register then getPtyId returns the ptyId', () => {
    idx.register('session-a', 'pty-1')
    expect(idx.getPtyId('session-a')).toBe('pty-1')
    expect(idx.has('session-a')).toBe(true)
  })

  it('re-registering a key to a new ptyId drops the stale reverse entry', () => {
    idx.register('session-a', 'pty-1')
    idx.register('session-a', 'pty-2')
    expect(idx.getPtyId('session-a')).toBe('pty-2')
    // pty-1 is no longer mapped to anything
    idx.removeByPtyId('pty-1')
    expect(idx.getPtyId('session-a')).toBe('pty-2') // unaffected
  })

  it('rekey moves the binding to the new key, same ptyId', () => {
    idx.register('synthetic-x', 'pty-1')
    idx.rekey('synthetic-x', 'real-uuid')
    expect(idx.getPtyId('synthetic-x')).toBeUndefined()
    expect(idx.getPtyId('real-uuid')).toBe('pty-1')
  })

  it('rekey is a no-op when the source key is unknown', () => {
    idx.rekey('ghost', 'real-uuid')
    expect(idx.getPtyId('real-uuid')).toBeUndefined()
  })

  it('removeByPtyId clears both directions', () => {
    idx.register('session-a', 'pty-1')
    idx.removeByPtyId('pty-1')
    expect(idx.getPtyId('session-a')).toBeUndefined()
    expect(idx.has('session-a')).toBe(false)
  })

  it('after rekey, removeByPtyId clears the new key', () => {
    idx.register('synthetic-x', 'pty-1')
    idx.rekey('synthetic-x', 'real-uuid')
    idx.removeByPtyId('pty-1')
    expect(idx.getPtyId('real-uuid')).toBeUndefined()
  })

  // Reverse lookup + liveness set (T13/BUG-1): pty.ts resolves the exiting
  // pty's key to prune the hook state, and the MCP filter reads the live keys.
  describe('getSessionKey / liveKeys (task-state liveness)', () => {
    it('getSessionKey returns the bound key, and the REAL key after rekey', () => {
      idx.register('synthetic-x', 'pty-1')
      expect(idx.getSessionKey('pty-1')).toBe('synthetic-x')
      idx.rekey('synthetic-x', 'real-uuid')
      expect(idx.getSessionKey('pty-1')).toBe('real-uuid')
    })

    it('getSessionKey returns undefined after removeByPtyId', () => {
      idx.register('session-a', 'pty-1')
      idx.removeByPtyId('pty-1')
      expect(idx.getSessionKey('pty-1')).toBeUndefined()
    })

    it('liveKeys reflects register / rekey / remove', () => {
      idx.register('a', 'pty-1')
      idx.register('b', 'pty-2')
      expect(idx.liveKeys()).toEqual(new Set(['a', 'b']))
      idx.rekey('a', 'a-real')
      expect(idx.liveKeys()).toEqual(new Set(['a-real', 'b']))
      idx.removeByPtyId('pty-2')
      expect(idx.liveKeys()).toEqual(new Set(['a-real']))
    })
  })

  // The `pty:replayForSession` handler (fleet-status-board spec §4.2) is a thin
  // fail-safe wrapper over getPtyId: the risk-bearing resolution lives here, not
  // in the node-pty-loading handler. These cases mirror its three branches.
  describe('replayForSession resolution contract', () => {
    it('live session → resolves to its ptyId (handler then snapshots that ring)', () => {
      idx.register('synthetic-abc', 'pty-9')
      expect(idx.getPtyId('synthetic-abc')).toBe('pty-9')
    })

    it('unknown sessionKey → undefined (handler returns empty snapshot)', () => {
      expect(idx.getPtyId('cold-disk-session')).toBeUndefined()
    })

    it('session whose pty was killed → undefined after removeByPtyId (empty snapshot)', () => {
      idx.register('synthetic-abc', 'pty-9')
      idx.removeByPtyId('pty-9')
      expect(idx.getPtyId('synthetic-abc')).toBeUndefined()
    })
  })
})

describe('T215 — the recipient predicate over the index lifecycle', () => {
  /**
   * `harnuOwnsSession(indexHit, isParked)` is the whole predicate, so what these
   * cases pin is the INDEX ARM's behaviour across the four transitions the spec
   * calls out: register, rekey (synth→real), park, and process exit.
   */
  it('survives a synth→real rekey — true under the synthetic id, then under the real uuid', () => {
    const idx = new PtySessionIndex()
    idx.register('synthetic-abc', 'pty-1')
    expect(harnuOwnsSession(idx.has('synthetic-abc'), false)).toBe(true)

    idx.rekey('synthetic-abc', 'real-uuid')
    // NEVER both at once — a reachable id must be exactly one id.
    expect(harnuOwnsSession(idx.has('synthetic-abc'), false)).toBe(false)
    expect(harnuOwnsSession(idx.has('real-uuid'), false)).toBe(true)
    // The process itself never moved.
    expect(idx.getPtyId('real-uuid')).toBe('pty-1')
  })

  it('park → wake: index arm false while parked, parked arm carries it, index arm true again', () => {
    const idx = new PtySessionIndex()
    idx.register('s1', 'pty-1')
    expect(harnuOwnsSession(idx.has('s1'), false)).toBe(true)

    // `hibernateSession` removes the index entry BEFORE flagging, so this is
    // exactly the window the parked arm exists to cover.
    idx.removeByPtyId('pty-1')
    expect(idx.has('s1')).toBe(false)
    expect(harnuOwnsSession(idx.has('s1'), true)).toBe(true)

    // The wake's own `pty:create` re-registers it.
    idx.register('s1', 'pty-2')
    expect(harnuOwnsSession(idx.has('s1'), false)).toBe(true)
  })

  it('a process that exits drops out of the predicate (no lingering reachability)', () => {
    const idx = new PtySessionIndex()
    idx.register('s1', 'pty-1')
    idx.removeByPtyId('pty-1')
    expect(harnuOwnsSession(idx.has('s1'), false)).toBe(false)
  })

  it('a fresh index is empty — an app restart is a TRUE negative, not a regression', () => {
    // `ptys` and the parked set are module-level, so a restart wipes both. The
    // process is gone too, so refusing is correct.
    const idx = new PtySessionIndex()
    expect(harnuOwnsSession(idx.has('s1'), false)).toBe(false)
  })

  it('a session with NO card binding is reachable — the predicate never sees the board', () => {
    // Regression guard for the rejected card-bound predicate. A
    // `create_worktree` + `create_session` pair leaves the session unbound by
    // design, and that is the most-used dispatch path.
    const idx = new PtySessionIndex()
    idx.register('manually-dispatched', 'pty-7')
    expect(harnuOwnsSession(idx.has('manually-dispatched'), false)).toBe(true)
  })
})
