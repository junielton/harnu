import { describe, it, expect } from 'vitest'
import { shapeDenial } from '../src/main/mcp/deny-hint'

/**
 * Pure tests for T44 Slice 1 — "errors that steer". The gate reason → agent-
 * actionable hint. No electron/IPC — just the shaping.
 */

describe('shapeDenial (T44 S1 — errors that steer)', () => {
  it('FOLDER_NOT_ALLOWED → names the explicit operator block (post free-by-default reversal)', () => {
    const d = shapeDenial('FOLDER_NOT_ALLOWED')
    expect(d).not.toBeNull()
    expect(d!.error).toBe('FOLDER_NOT_ALLOWED')
    expect(d!.message).toMatch(/explicitly blocked/i)
    expect(d!.nextActions.length).toBeGreaterThan(0)
    expect(d!.nextActions[0].do).toMatch(/Allow agent control|blocked folders/i)
  })

  it('does NOT describe this as a missing allowlist grant — there is no allowlist any more', () => {
    const d = shapeDenial('FOLDER_NOT_ALLOWED')
    expect(d!.message).not.toMatch(/not agent-allowed/i)
    expect(d!.message).not.toMatch(/human-gated/i)
  })

  it('includes the offending folder path in the message when provided', () => {
    const d = shapeDenial('FOLDER_NOT_ALLOWED', { folder: '/home/u/repo/wt' })
    expect(d!.message).toContain('/home/u/repo/wt')
  })

  it('does NOT suggest adopt_folder (blocking is a separate, absolute mechanism)', () => {
    const d = shapeDenial('FOLDER_NOT_ALLOWED', { folder: '/home/u/repo' })
    const text = JSON.stringify(d)
    expect(text).not.toMatch(/adopt_folder/)
  })

  it('PATH_ESCAPE → steer to a contained path, framed as the guarded-mode boundary', () => {
    const d = shapeDenial('PATH_ESCAPE', { folder: '/etc/passwd' })
    expect(d!.error).toBe('PATH_ESCAPE')
    expect(d!.message).toMatch(/outside the known repositor/i)
    expect(d!.message).toMatch(/guarded|ask/i)
    expect(d!.nextActions[0].do).toMatch(/inside a folder Harnu/i)
  })

  it('SERVER_DISABLED → steer to enabling the control server', () => {
    const d = shapeDenial('SERVER_DISABLED')
    expect(d!.error).toBe('SERVER_DISABLED')
    expect(d!.nextActions[0].do).toMatch(/control server/i)
  })

  it('PANE_FOLDER_UNKNOWN (2026-07-13 agent-pane-routing) → steer to a KNOWN folder, never a phantom stack', () => {
    const d = shapeDenial('PANE_FOLDER_UNKNOWN', { folder: '/home/u/repo/' })
    expect(d).not.toBeNull()
    expect(d!.error).toBe('PANE_FOLDER_UNKNOWN')
    expect(d!.message).toContain('/home/u/repo/')
    expect(d!.message).toMatch(/doesn't match any folder Harnu currently tracks/i)
    expect(d!.nextActions[0].do).toMatch(/get_fleet|list_worktrees/i)
  })

  it('SESSION_ALREADY_IN_FLIGHT (this card, AC3) → steer away from a concurrent duplicate spawn', () => {
    const d = shapeDenial('SESSION_ALREADY_IN_FLIGHT', { folder: '/home/u/repo' })
    expect(d).not.toBeNull()
    expect(d!.error).toBe('SESSION_ALREADY_IN_FLIGHT')
    expect(d!.message).toContain('/home/u/repo')
    expect(d!.message).toMatch(/already in flight/i)
    expect(d!.nextActions[0].do).toMatch(/wait/i)
  })

  it('SPAWN_NOT_MATERIALIZED (this card, AC2) → names the timeout and the refund', () => {
    const d = shapeDenial('SPAWN_NOT_MATERIALIZED', { folder: '/home/u/repo' })
    expect(d).not.toBeNull()
    expect(d!.error).toBe('SPAWN_NOT_MATERIALIZED')
    expect(d!.message).toContain('/home/u/repo')
    expect(d!.message).toMatch(/refunded/i)
    expect(d!.nextActions[0].do).toMatch(/get_session|get_fleet/i)
    expect(d!.syntheticId).toBeUndefined()
  })

  it('SPAWN_NOT_MATERIALIZED with a syntheticId (BUG-58) → carries it and steers to adopt/poll it', () => {
    const d = shapeDenial('SPAWN_NOT_MATERIALIZED', {
      folder: '/home/u/repo',
      syntheticId: 'synthetic-123'
    })
    expect(d).not.toBeNull()
    expect(d!.syntheticId).toBe('synthetic-123')
    expect(d!.message).toContain('synthetic-123')
    expect(d!.message).toMatch(/NOT torn down/i)
    expect(d!.nextActions[0].do).toContain('synthetic-123')
    expect(d!.nextActions[0].why).toMatch(/SESSION_ALREADY_IN_FLIGHT/)
  })

  // ---- T215 `message_session` refusals ------------------------------------

  it('SESSION_NOT_FOUND → steers to get_fleet, never to a blind retry', () => {
    const d = shapeDenial('SESSION_NOT_FOUND')
    expect(d).not.toBeNull()
    expect(d!.error).toBe('SESSION_NOT_FOUND')
    expect(d!.nextActions.length).toBeGreaterThan(0)
    expect(d!.nextActions[0].do).toMatch(/get_fleet/)
  })

  it('RECIPIENT_NOT_HARNU_SPAWNED → names get_fleet + create_session, and NEVER suggests resuming a foreign session', () => {
    const d = shapeDenial('RECIPIENT_NOT_HARNU_SPAWNED', { folder: '/home/u/repo' })
    expect(d).not.toBeNull()
    expect(d!.error).toBe('RECIPIENT_NOT_HARNU_SPAWNED')
    expect(d!.nextActions.length).toBeGreaterThan(0)
    const all = d!.nextActions.map((a) => `${a.do} ${a.why}`).join(' ')
    expect(all).toMatch(/get_fleet/)
    expect(all).toMatch(/create_session/)
    // Resuming a session Harnu did not start would put a SECOND process on one
    // transcript — the exact hazard `pty:create`'s dedup exists to prevent, and
    // the reason the old `SESSION_NOT_LIVE` hint was actively wrong.
    expect(all).not.toMatch(/resum/i)
    // It also states, rather than diagnoses, that the two causes are
    // indistinguishable to Harnu.
    expect(d!.message).toMatch(/cold transcript/i)
    expect(d!.message).toMatch(/outside Harnu/i)
  })

  it("RECIPIENT_OPERATOR_OWNED → steers to notify or a session of the agent's own", () => {
    const d = shapeDenial('RECIPIENT_OPERATOR_OWNED')
    expect(d).not.toBeNull()
    expect(d!.error).toBe('RECIPIENT_OPERATOR_OWNED')
    const all = d!.nextActions.map((a) => `${a.do} ${a.why}`).join(' ')
    expect(all).toMatch(/notify/)
    expect(all).toMatch(/create_session/)
    expect(all).not.toMatch(/resum/i)
  })

  it('WAKE_TIMEOUT → says the message was NOT sent and refuses the create_session workaround', () => {
    const d = shapeDenial('WAKE_TIMEOUT')
    expect(d).not.toBeNull()
    expect(d!.message).toMatch(/NOT SENT/i)
    const all = d!.nextActions.map((a) => `${a.do} ${a.why}`).join(' ')
    expect(all).toMatch(/get_session/)
    // A retry loop here could put a second process on one transcript.
    expect(all).toMatch(/Do NOT call create_session/)
  })

  it('PEER_NO_SOCKET → ENUMERATES four causes, diagnoses none, and names BOTH remedies', () => {
    const d = shapeDenial('PEER_NO_SOCKET')
    expect(d).not.toBeNull()
    // The four causes (spec §2.1): old CLI, gate off, remote thin client, bind failure.
    expect(d!.message).toMatch(/2\.1\.224/)
    expect(d!.message).toMatch(/gate is off/i)
    expect(d!.message).toMatch(/thin client/i)
    expect(d!.message).toMatch(/bind failed/i)
    // Harnu cannot tell WHICH — and says so instead of guessing.
    expect(d!.message).toMatch(/cannot tell which/i)
    // The O-5 correction: this cause DOES have operator remedies, and both are named.
    const all = d!.nextActions.map((a) => `${a.do} ${a.why}`).join(' ')
    expect(all).toContain('CLAUDE_CODE_HARBOR_KITE')
    expect(all).toContain('crossSessionInbound')
  })

  it('PEER_SOCKET_DEAD → names the stale-socket cause', () => {
    const d = shapeDenial('PEER_SOCKET_DEAD')
    expect(d).not.toBeNull()
    expect(d!.message).toMatch(/stale/i)
    expect(d!.nextActions[0].do).toMatch(/get_fleet/)
  })

  it('SOCKET_WRITE_FAILED → retry ONCE, then surface (never a loop)', () => {
    const d = shapeDenial('SOCKET_WRITE_FAILED')
    expect(d).not.toBeNull()
    expect(d!.message).toMatch(/Nothing was queued/i)
    expect(d!.nextActions[0].do).toMatch(/Retry once/i)
  })

  it('MESSAGE_TOO_LARGE → steers to open_file + the path', () => {
    const d = shapeDenial('MESSAGE_TOO_LARGE')
    expect(d).not.toBeNull()
    expect(d!.nextActions[0].do).toMatch(/open_file/)
  })

  it('T309/ADR-0013: TARGET_NOT_HARNU_SPAWNED → names get_fleet, and self-arming needs your own sessionId', () => {
    const d = shapeDenial('TARGET_NOT_HARNU_SPAWNED', { folder: '/home/u/repo' })
    expect(d).not.toBeNull()
    expect(d!.error).toBe('TARGET_NOT_HARNU_SPAWNED')
    const all = d!.nextActions.map((a) => `${a.do} ${a.why}`).join(' ')
    expect(all).toMatch(/get_fleet/)
    expect(all).toMatch(/own sessionId|own id/i)
  })

  it('T309/ADR-0013: TARGET_OPERATOR_OWNED → points at the renderer promote gesture, never a workaround', () => {
    const d = shapeDenial('TARGET_OPERATOR_OWNED')
    expect(d).not.toBeNull()
    expect(d!.error).toBe('TARGET_OPERATOR_OWNED')
    expect(d!.message).toMatch(/operator/i)
    const all = d!.nextActions.map((a) => `${a.do} ${a.why}`).join(' ')
    expect(all).toMatch(/Promote to orchestrator/i)
  })

  it('every T215 refusal is steerable with a NON-EMPTY nextActions', () => {
    // Spec §7: "Every failure mode in §3.5 is a distinct, steerable code."
    const codes = [
      'SESSION_NOT_FOUND',
      'FOLDER_NOT_ALLOWED',
      'RECIPIENT_NOT_HARNU_SPAWNED',
      'RECIPIENT_OPERATOR_OWNED',
      'WAKE_TIMEOUT',
      'PEER_NO_SOCKET',
      'PEER_SOCKET_DEAD',
      'SOCKET_WRITE_FAILED',
      'MESSAGE_TOO_LARGE',
      'VOICE_DISABLED',
      'VOICE_MUTED_FOR_FOLDER',
      'SPEAK_RATE_LIMITED',
      'TARGET_NOT_HARNU_SPAWNED',
      'TARGET_OPERATOR_OWNED'
    ]
    const messages = new Set<string>()
    for (const code of codes) {
      const d = shapeDenial(code)
      expect(d, code).not.toBeNull()
      expect(d!.error, code).toBe(code)
      expect(d!.nextActions.length, code).toBeGreaterThan(0)
      for (const a of d!.nextActions) {
        expect(a.do.length, code).toBeGreaterThan(0)
        expect(a.why.length, code).toBeGreaterThan(0)
      }
      messages.add(d!.message)
    }
    // DISTINCT: no two codes may share a message, or the agent cannot tell
    // which wall it hit.
    expect(messages.size).toBe(codes.length)
  })

  it('SESSION_NOT_LIVE does NOT ship — one observable, one code', () => {
    // An earlier draft carried it for "on disk, no PTY, not flagged parked",
    // which is the SAME observable state as a live foreign `claude`. Two codes
    // for one observable would have shipped a distinction Harnu cannot make.
    expect(shapeDenial('SESSION_NOT_LIVE')).toBeNull()
  })

  it('T238: the two voice refusals steer DIFFERENTLY — a mute is not a missing global', () => {
    // The distinction is the whole reason there are two codes. Telling the agent
    // to go ask for the global switch would talk the operator into undoing a
    // per-folder mute they set on purpose.
    const disabled = shapeDenial('VOICE_DISABLED', { folder: '/repo/app' })!
    const muted = shapeDenial('VOICE_MUTED_FOR_FOLDER', { folder: '/repo/app' })!
    expect(disabled.message).toMatch(/globally/)
    expect(disabled.nextActions[0].do).toMatch(/Settings/)
    expect(muted.message).toMatch(/outranks/)
    expect(muted.nextActions[0].do).toMatch(/not ask for the global/)
    // Both point the agent at the channel that DOES leave a trace.
    expect(disabled.nextActions[0].do).toMatch(/notify/)
    expect(muted.nextActions[0].do).toMatch(/notify/)
  })

  it('T238: the rate-limit steer tells the agent to stop, not to retry', () => {
    const d = shapeDenial('SPEAK_RATE_LIMITED')!
    expect(d.nextActions[0].do).toMatch(/Stop speaking/)
    expect(d.message).toMatch(/does not count against you/)
  })

  it('returns null for results with no actionable affordance (passthrough)', () => {
    expect(shapeDenial('BAD_ARGS: branch is required')).toBeNull()
    expect(shapeDenial('UNKNOWN_TOOL')).toBeNull()
    expect(shapeDenial('confirm')).toBeNull()
    expect(shapeDenial('denied by operator (timeout)')).toBeNull()
  })
})
