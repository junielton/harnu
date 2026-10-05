import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

/**
 * Pure confirm-gate core. A privileged MCP mutation "parks" a confirm that
 * settles only when the operator responds, the fail-closed TTL elapses, the
 * transport aborts, or the server shuts down. The gate fails CLOSED: every
 * non-affirmative path resolves `deny`.
 *
 * T44 S4 changed the shape: `park` returns a discriminated {@link ParkResult}
 * (immediate `denied`, or a `live` confirm with `id`/`mode`/`settled`), the
 * render `mode` comes from an injected `isFocused`, and there is NO 30s auto-deny
 * — a live confirm stays until answered or the long `PARK_TTL_MS` backstop.
 */
import {
  createConfirmCore,
  CONFIRM_WINDOW_MS,
  PARK_TTL_MS,
  HOOK_DEADLINE_MS,
  MCP_CLIENT_TIMEOUT_MS,
  MAX_PENDING_CONFIRMS,
  type ConfirmDisclosure,
  type ConfirmWire,
  type ConfirmOutcome,
  type ConfirmCore
} from '../src/main/mcp/confirm-core'

const disclosure = (over: Partial<ConfirmDisclosure> = {}): ConfirmDisclosure => ({
  prompt: over.prompt ?? 'Allow agent to boot with elevated flags?',
  permissionMode: over.permissionMode ?? 'default',
  nonDefaultFlags: over.nonDefaultFlags ?? ['--dangerously-skip-permissions'],
  ...(over.commands !== undefined ? { commands: over.commands } : {}),
  ...(over.worktreeInheritOffer !== undefined
    ? { worktreeInheritOffer: over.worktreeInheritOffer }
    : {}),
  ...(over.inheritDiscoveryOffer !== undefined
    ? { inheritDiscoveryOffer: over.inheritDiscoveryOffer }
    : {})
})

function makeCore(opts: { send?: (w: ConfirmWire) => boolean; focused?: boolean } = {}) {
  const send = vi.fn(opts.send ?? (() => true))
  const onSettled = vi.fn()
  const core = createConfirmCore({
    send,
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (h) => clearTimeout(h),
    now: () => Date.now(),
    isFocused: () => opts.focused ?? true,
    onSettled
  })
  return { send, onSettled, core }
}

/** Park and assert it went live; return the live fields. */
function parkLive(
  core: ConfirmCore,
  d: ConfirmDisclosure = disclosure()
): { id: string; mode: 'modal' | 'parked'; settled: Promise<ConfirmOutcome> } {
  const r = core.park(d)
  if (r.kind !== 'live') throw new Error(`expected live park, got ${r.kind}`)
  return { id: r.id, mode: r.mode, settled: r.settled }
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('park (mint id + disclosure payload + wire)', () => {
  it('mints an id, builds the disclosure payload, and sends it over the wire', () => {
    const { send, core } = makeCore()
    const d = disclosure({ permissionMode: 'acceptEdits', nonDefaultFlags: ['--add-dir', '/etc'] })
    core.park(d)
    expect(send).toHaveBeenCalledTimes(1)
    const wire = send.mock.calls[0][0]
    expect(typeof wire.id).toBe('string')
    expect(wire.id.length).toBeGreaterThan(0)
    expect(wire.prompt).toBe(d.prompt)
    expect(wire.permissionMode).toBe('acceptEdits')
    expect(wire.nonDefaultFlags).toEqual(['--add-dir', '/etc'])
  })

  it('carries create_worktree commands onto the wire as a defensive copy (T08)', () => {
    const { send, core } = makeCore()
    const cmds = ['npm ci', 'echo build {branch}']
    core.park(disclosure({ commands: cmds }))
    const wire = send.mock.calls[0][0]
    expect(wire.commands).toEqual(['npm ci', 'echo build {branch}'])
    cmds.push('rm -rf /')
    expect(wire.commands).toEqual(['npm ci', 'echo build {branch}'])
  })

  it('normalizes an omitted commands field to [] on the wire', () => {
    const { send, core } = makeCore()
    core.park(disclosure())
    expect(send.mock.calls[0][0].commands).toEqual([])
  })

  it('parks the confirm (pending) until it is settled', () => {
    const { core } = makeCore()
    core.park(disclosure())
    expect(core.pendingCount()).toBe(1)
  })
})

describe('render mode from isFocused (T44 S4)', () => {
  it('focused → modal', () => {
    const { send, core } = makeCore({ focused: true })
    const r = parkLive(core)
    expect(r.mode).toBe('modal')
    expect(send.mock.calls[0][0].mode).toBe('modal')
  })

  it('not focused → parked', () => {
    const { send, core } = makeCore({ focused: false })
    const r = parkLive(core)
    expect(r.mode).toBe('parked')
    expect(send.mock.calls[0][0].mode).toBe('parked')
  })

  it('isFocused absent → parked (fail toward the notify-the-human surface)', () => {
    const send = vi.fn(() => true)
    const core = createConfirmCore({
      send,
      setTimer: (fn, ms) => setTimeout(fn, ms),
      clearTimer: (h) => clearTimeout(h),
      now: () => Date.now()
    })
    const r = core.park(disclosure())
    expect(r.kind === 'live' && r.mode).toBe('parked')
  })
})

describe('respond', () => {
  it("respond(id,'allow') settles the live confirm with 'allow'", async () => {
    const { core } = makeCore()
    const { id, settled } = parkLive(core)
    expect(core.respond(id, 'allow')).toBe('allow')
    await expect(settled).resolves.toEqual({ verdict: 'allow', reason: 'RESPONDED' })
    expect(core.pendingCount()).toBe(0)
  })

  it('respond(unknownId) returns false (nothing parked to settle)', () => {
    const { core } = makeCore()
    expect(core.respond('confirm-does-not-exist', 'allow')).toBe(false)
  })

  it('double respond is a no-op (the second settle returns false)', async () => {
    const { core } = makeCore()
    const { id, settled } = parkLive(core)
    expect(core.respond(id, 'deny')).toBe('deny')
    expect(core.respond(id, 'allow')).toBe(false)
    await expect(settled).resolves.toEqual({ verdict: 'deny', reason: 'RESPONDED' })
  })

  // T61: the create_worktree inherit checkbox rides back on the outcome.
  it('carries the worktree inherit opt-out onto the settled outcome', async () => {
    const { core } = makeCore()
    const { id, settled } = parkLive(core, disclosure({ worktreeInheritOffer: true }))
    expect(core.respond(id, 'allow', { inheritWorktreeControl: false })).toBe('allow')
    await expect(settled).resolves.toEqual({
      verdict: 'allow',
      reason: 'RESPONDED',
      inheritWorktreeControl: false
    })
  })

  it('omits inheritWorktreeControl when no response data is passed', async () => {
    const { core } = makeCore()
    const { id, settled } = parkLive(core)
    core.respond(id, 'allow')
    const out = await settled
    expect(out).toEqual({ verdict: 'allow', reason: 'RESPONDED' })
    expect('inheritWorktreeControl' in out).toBe(false)
  })

  // T102: the manifest checklist's per-card substrate override rides back on the outcome.
  it('carries the manifest substrate overrides onto the settled outcome', async () => {
    const { core } = makeCore()
    const { id, settled } = parkLive(core)
    expect(
      core.respond(id, 'allow', { manifestSubstrateOverrides: { 'card-1': 'worktree' } })
    ).toBe('allow')
    await expect(settled).resolves.toEqual({
      verdict: 'allow',
      reason: 'RESPONDED',
      manifestSubstrateOverrides: { 'card-1': 'worktree' }
    })
  })

  it('omits manifestSubstrateOverrides when no response data is passed', async () => {
    const { core } = makeCore()
    const { id, settled } = parkLive(core)
    core.respond(id, 'allow')
    const out = await settled
    expect('manifestSubstrateOverrides' in out).toBe(false)
  })

  it('park sends worktreeInheritOffer on the wire (default false)', () => {
    const { send, core } = makeCore()
    core.park(disclosure())
    expect(send.mock.calls[0][0].worktreeInheritOffer).toBe(false)
    core.park(disclosure({ worktreeInheritOffer: true }))
    expect(send.mock.calls[1][0].worktreeInheritOffer).toBe(true)
  })

  // T72: the inheritance-discovery scope rides back on the outcome (mirrors T61).
  it("carries inheritScope:'always' onto the settled outcome (Always)", async () => {
    const { core } = makeCore()
    const { id, settled } = parkLive(core, disclosure({ inheritDiscoveryOffer: true }))
    expect(core.respond(id, 'allow', { inheritScope: 'always' })).toBe('allow')
    await expect(settled).resolves.toEqual({
      verdict: 'allow',
      reason: 'RESPONDED',
      inheritScope: 'always'
    })
  })

  it("carries inheritScope:'once' onto the settled outcome (Only this)", async () => {
    const { core } = makeCore()
    const { id, settled } = parkLive(core, disclosure({ inheritDiscoveryOffer: true }))
    core.respond(id, 'allow', { inheritScope: 'once' })
    await expect(settled).resolves.toEqual({
      verdict: 'allow',
      reason: 'RESPONDED',
      inheritScope: 'once'
    })
  })

  it('omits inheritScope when no response data is passed (parked → actuation defaults once)', async () => {
    const { core } = makeCore()
    const { id, settled } = parkLive(core, disclosure({ inheritDiscoveryOffer: true }))
    core.respond(id, 'allow')
    const out = await settled
    expect(out).toEqual({ verdict: 'allow', reason: 'RESPONDED' })
    expect('inheritScope' in out).toBe(false)
  })

  it('a fail-closed settle (TTL) ignores any scope — stays a bare deny', async () => {
    const { core } = makeCore()
    const { settled } = parkLive(core, disclosure({ inheritDiscoveryOffer: true }))
    vi.advanceTimersByTime(PARK_TTL_MS)
    const out = await settled
    expect(out).toEqual({ verdict: 'deny', reason: 'TTL_EXPIRED' })
    expect('inheritScope' in out).toBe(false)
  })

  it('park sends inheritDiscoveryOffer on the wire (default false)', () => {
    const { send, core } = makeCore()
    core.park(disclosure())
    expect(send.mock.calls[0][0].inheritDiscoveryOffer).toBe(false)
    core.park(disclosure({ inheritDiscoveryOffer: true }))
    expect(send.mock.calls[1][0].inheritDiscoveryOffer).toBe(true)
  })
})

describe('fail-CLOSED paths (every non-affirmative outcome is DENY)', () => {
  it('the long TTL backstop elapses -> DENY/TTL_EXPIRED (never allow, never abstain)', async () => {
    const { core } = makeCore()
    const { settled } = parkLive(core)
    // No deny at the inline window — only after the long TTL.
    vi.advanceTimersByTime(CONFIRM_WINDOW_MS)
    expect(core.pendingCount()).toBe(1)
    vi.advanceTimersByTime(PARK_TTL_MS)
    const out = await settled
    expect(out.verdict).toBe('deny')
    expect(out.reason).toBe('TTL_EXPIRED')
    expect(out.verdict).not.toBe('allow')
    expect(core.pendingCount()).toBe(0)
  })

  it('NO_WINDOW (send returns false) -> immediate denied, nothing parked', () => {
    const { send, core } = makeCore({ send: () => false })
    const r = core.park(disclosure())
    expect(r).toEqual({ kind: 'denied', outcome: { verdict: 'deny', reason: 'NO_WINDOW' } })
    expect(send).toHaveBeenCalledTimes(1)
    expect(core.pendingCount()).toBe(0)
  })

  it('over the pending cap -> new park immediately denied (DENY_BUSY), no extra wire send', () => {
    const { send, core } = makeCore()
    for (let i = 0; i < MAX_PENDING_CONFIRMS; i++) core.park(disclosure())
    expect(core.pendingCount()).toBe(MAX_PENDING_CONFIRMS)
    const r = core.park(disclosure())
    expect(r).toEqual({ kind: 'denied', outcome: { verdict: 'deny', reason: 'DENY_BUSY' } })
    expect(send).toHaveBeenCalledTimes(MAX_PENDING_CONFIRMS)
    expect(core.pendingCount()).toBe(MAX_PENDING_CONFIRMS)
  })
})

describe('onSettled (T44 S4 — prune parked rows on any settle)', () => {
  it('fires on respond, cancel, and TTL — with the id + outcome', () => {
    const { core, onSettled } = makeCore()
    const { id } = parkLive(core)
    core.respond(id, 'allow')
    expect(onSettled).toHaveBeenCalledWith(id, { verdict: 'allow', reason: 'RESPONDED' })

    const b = parkLive(core)
    core.cancel(b.id)
    expect(onSettled).toHaveBeenCalledWith(b.id, { verdict: 'deny', reason: 'CANCELLED' })

    const c = parkLive(core)
    vi.advanceTimersByTime(PARK_TTL_MS)
    expect(onSettled).toHaveBeenCalledWith(c.id, { verdict: 'deny', reason: 'TTL_EXPIRED' })
  })

  it('is NOT called for an immediate denied park (nothing was parked)', () => {
    const { core, onSettled } = makeCore({ send: () => false })
    core.park(disclosure())
    expect(onSettled).not.toHaveBeenCalled()
  })
})

describe('cancel / rejectAll', () => {
  it('cancel(id) (transport abort) resolves DENY and removes the pending entry', async () => {
    const { core } = makeCore()
    const { id, settled } = parkLive(core)
    expect(core.pendingCount()).toBe(1)
    expect(core.cancel(id)).toBe(true)
    await expect(settled).resolves.toEqual({ verdict: 'deny', reason: 'CANCELLED' })
    expect(core.pendingCount()).toBe(0)
    expect(core.cancel(id)).toBe(false)
  })

  it('rejectAll denies every pending confirm and clears them', async () => {
    const { core } = makeCore()
    const a = parkLive(core)
    const b = parkLive(core)
    expect(core.pendingCount()).toBe(2)
    core.rejectAll()
    expect(core.pendingCount()).toBe(0)
    await expect(a.settled).resolves.toEqual({ verdict: 'deny', reason: 'REJECT_ALL' })
    await expect(b.settled).resolves.toEqual({ verdict: 'deny', reason: 'REJECT_ALL' })
  })
})

describe('list (BUG-25 — re-hydration snapshot)', () => {
  it('returns the wire of every still-live confirm, including one parked before any listener attached', () => {
    // Reproduces the bug: `park` already fired `send` once (nobody was
    // listening — e.g. a renderer reload mid-park). `list()` is the only way
    // a NEW listener can ever learn the confirm still exists.
    const { core } = makeCore({ focused: false })
    const { id } = parkLive(core, disclosure({ prompt: 'Allow plan_mission grant?' }))
    const snapshot = core.list()
    expect(snapshot).toHaveLength(1)
    expect(snapshot[0]).toMatchObject({ id, prompt: 'Allow plan_mission grant?', mode: 'parked' })
  })

  it('omits a confirm once it settles (respond/TTL/cancel/rejectAll)', async () => {
    const { core } = makeCore()
    const a = parkLive(core)
    parkLive(core)
    expect(core.list()).toHaveLength(2)
    core.respond(a.id, 'deny')
    await a.settled
    const snapshot = core.list()
    expect(snapshot).toHaveLength(1)
    expect(snapshot.some((w) => w.id === a.id)).toBe(false)
  })

  it('reflects the ORIGINAL park-time mode, not the current focus state', () => {
    const { core } = makeCore({ focused: true })
    parkLive(core)
    // isFocused is only sampled at park time — a later focus change must not
    // retroactively rewrite an already-parked wire's mode.
    expect(core.list()[0].mode).toBe('modal')
  })

  it('returns [] when nothing is parked', () => {
    const { core } = makeCore()
    expect(core.list()).toEqual([])
  })
})

describe('timing constants', () => {
  it('inline window is finite, above the hook deadline, below the MCP client timeout', () => {
    expect(Number.isFinite(CONFIRM_WINDOW_MS)).toBe(true)
    expect(CONFIRM_WINDOW_MS).toBeGreaterThan(HOOK_DEADLINE_MS)
    expect(CONFIRM_WINDOW_MS).toBeLessThan(MCP_CLIENT_TIMEOUT_MS)
    expect(HOOK_DEADLINE_MS).toBe(3500)
  })

  it('the fail-closed TTL is far longer than the inline window', () => {
    expect(Number.isFinite(PARK_TTL_MS)).toBe(true)
    expect(PARK_TTL_MS).toBeGreaterThan(CONFIRM_WINDOW_MS)
  })
})
