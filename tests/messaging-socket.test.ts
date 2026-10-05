import { describe, it, expect } from 'vitest'
import {
  activityDescription,
  bodyHashPrefix,
  buildPeerEnvelope,
  buildUserFrame,
  harnuOwnsSession,
  classifyReachability,
  isMessageableOwner,
  MESSAGE_MAX_CHARS,
  messageAuditSummary,
  messagingSocketCandidates,
  MESSAGING_SOCKET_CAPTURED_FROM,
  MESSAGING_SOCKET_PATH_MAX,
  PEER_FROM_NAME
} from '../src/main/messaging-socket'

/**
 * T215 — the pure core of `message_session`: socket addressing, the recipient
 * predicate, the reachability rungs, and the wire shapes.
 *
 * Everything here is a DECISION Harnu makes about another process's inbox, so
 * each one is pinned separately. Two are load-bearing beyond correctness:
 *
 *  1. the recipient predicate must NOT consult the board — a card-bound check
 *     would have refused every manually dispatched session, which is the
 *     most-used path (spec §3.2a's rejected-candidates table);
 *  2. the envelope must NEVER carry `from-mode` — asserting permission parity
 *     is what defeats the recipient's own hold, i.e. the laundering vector the
 *     2026-08-23 probe found.
 */

const LINUX_ENV = { XDG_RUNTIME_DIR: '/run/user/1000' }
const TMP = '/tmp'

describe('messagingSocketCandidates — mirrors the CLI resolver', () => {
  it('puts $XDG_RUNTIME_DIR/cc-socks/<pid>.sock first', () => {
    const candidates = messagingSocketCandidates(758734, LINUX_ENV, 1000, TMP)
    expect(candidates[0]).toBe('/run/user/1000/cc-socks/758734.sock')
  })

  it('still offers the /tmp/cc-socks-<uid>/ branch as a second candidate', () => {
    // "Probe two candidate directories, never trust one path" — a stale or
    // unusual machine may have the socket in the fallback dir even when the
    // primary path would have fit.
    const candidates = messagingSocketCandidates(758734, LINUX_ENV, 1000, TMP)
    expect(candidates).toContain('/tmp/cc-socks-1000/758734.sock')
  })

  it('DROPS the primary and uses /tmp/cc-socks-<uid>/ when it exceeds the 103-byte cap', () => {
    // The CLI silently switches branches above the cap, so a path over it is
    // one no `claude` can ever have bound — offering it would invite a write
    // into nothing. This is the latent bug a hardcoded
    // `$XDG_RUNTIME_DIR/cc-socks` would ship on any long-runtime-dir machine.
    const longRuntime = '/run/user/1000/' + 'a'.repeat(80)
    const candidates = messagingSocketCandidates(
      758734,
      { XDG_RUNTIME_DIR: longRuntime },
      1000,
      TMP
    )
    const primary = `${longRuntime}/cc-socks/758734.sock`
    expect(Buffer.byteLength(primary)).toBeGreaterThan(MESSAGING_SOCKET_PATH_MAX)
    expect(candidates).toEqual(['/tmp/cc-socks-1000/758734.sock'])
  })

  it('keeps a path exactly AT the cap (the boundary is <=, not <)', () => {
    // Build a runtime dir that lands the primary exactly on 103 bytes.
    const tail = '/cc-socks/1.sock'
    const runtime = '/r'.padEnd(MESSAGING_SOCKET_PATH_MAX - tail.length, 'x')
    const candidates = messagingSocketCandidates(1, { XDG_RUNTIME_DIR: runtime }, 1000, TMP)
    expect(Buffer.byteLength(`${runtime}${tail}`)).toBe(MESSAGING_SOCKET_PATH_MAX)
    expect(candidates[0]).toBe(`${runtime}${tail}`)
  })

  it('falls back to CLAUDE_CODE_TMPDIR, then os.tmpdir(), when XDG_RUNTIME_DIR is absent', () => {
    // The macOS shape (spec O-3): no XDG_RUNTIME_DIR, so the base is
    // `$CLAUDE_CODE_TMPDIR || $TMPDIR`.
    expect(messagingSocketCandidates(42, { CLAUDE_CODE_TMPDIR: '/custom/tmp' }, 501, TMP)[0]).toBe(
      '/custom/tmp/cc-socks/42.sock'
    )
    expect(messagingSocketCandidates(42, {}, 501, '/var/folders/xy/T')[0]).toBe(
      '/var/folders/xy/T/cc-socks/42.sock'
    )
  })

  it('uses $PREFIX/tmp for the fallback branch under Termux', () => {
    const longRuntime = '/run/user/1000/' + 'a'.repeat(80)
    const candidates = messagingSocketCandidates(
      7,
      {
        XDG_RUNTIME_DIR: longRuntime,
        TERMUX_VERSION: '0.118',
        PREFIX: '/data/data/com.termux/files/usr'
      },
      1000,
      TMP
    )
    expect(candidates).toEqual(['/data/data/com.termux/files/usr/tmp/cc-socks-1000/7.sock'])
  })

  it('never returns an empty candidate list, and never duplicates a path', () => {
    for (const env of [LINUX_ENV, {}, { CLAUDE_CODE_TMPDIR: '/t' }]) {
      const candidates = messagingSocketCandidates(9, env, 0, TMP)
      expect(candidates.length).toBeGreaterThan(0)
      expect(new Set(candidates).size).toBe(candidates.length)
    }
  })

  it('names the CLI release it was captured from (the re-verification ritual)', () => {
    expect(MESSAGING_SOCKET_CAPTURED_FROM).toMatch(/^\d+\.\d+\.\d+$/)
  })
})

describe('harnuOwnsSession — the recipient predicate (spec §3.2a)', () => {
  it('is true for a live index hit', () => {
    expect(harnuOwnsSession(true, false)).toBe(true)
  })

  it('is true for a PARKED key with no index entry', () => {
    // `hibernateSession` removes the index entry BEFORE flagging, so without
    // this arm the whole wake path would be dead code.
    expect(harnuOwnsSession(false, true)).toBe(true)
  })

  it('the two arms are independent — either alone suffices, and both is fine', () => {
    expect(harnuOwnsSession(true, true)).toBe(true)
  })

  it('is false when Harnu owns no process at all', () => {
    // The shape a live `claude` Harnu did NOT spawn produces — the operator's
    // own terminal session — and equally a cold transcript. One observable,
    // one refusal.
    expect(harnuOwnsSession(false, false)).toBe(false)
  })

  it('REGRESSION GUARD: it takes no board/card input at all', () => {
    // The rejected candidate was "recipient is bound to a board card". Harnu
    // binds `session` to a card only on manifest/board dispatch; a
    // `create_worktree` + `create_session` pair leaves the session unbound BY
    // DESIGN. A card-scoped predicate would therefore have refused the
    // most-used dispatch path. This pins the shape: two booleans, both about
    // Harnu's own process state, nothing else.
    expect(harnuOwnsSession.length).toBe(2)
    // A manually dispatched session — no card, no binding, just a live PTY.
    expect(harnuOwnsSession(true, false)).toBe(true)
  })
})

describe('isMessageableOwner — the ownership marker (T215 DoD)', () => {
  it('admits an agent-spawned recipient', () => {
    expect(isMessageableOwner('agent')).toBe(true)
  })

  it('refuses a recipient the operator opened in Harnu', () => {
    expect(isMessageableOwner('operator')).toBe(false)
  })

  it('FAILS CLOSED on an absent marker', () => {
    // A spawn path that forgets to stamp the origin must refuse, never
    // silently open the operator's own session to agent traffic.
    expect(isMessageableOwner(undefined)).toBe(false)
  })

  it('narrows harnuOwnsSession and never widens it', () => {
    // The residual `harnuOwnsSession` could not close: a session the operator
    // opens INSIDE Harnu goes through the same spawn and lands in the same
    // index, so the predicate says "owned" while the marker says "hands off".
    expect(harnuOwnsSession(true, false)).toBe(true)
    expect(isMessageableOwner('operator')).toBe(false)
  })
})

describe('classifyReachability — the five rungs (spec §6.1)', () => {
  const base = { known: true, indexHit: false, isParked: false }

  it('unknown-session wins over everything else', () => {
    expect(classifyReachability({ ...base, known: false, indexHit: true, pid: 7 })).toEqual({
      rung: 'unknown-session'
    })
  })

  it('socket: a Harnu-owned process whose socket answered', () => {
    expect(
      classifyReachability({ ...base, indexHit: true, pid: 7, socket: '/run/x/7.sock' })
    ).toEqual({ rung: 'socket', pid: 7, socket: '/run/x/7.sock' })
  })

  it('no-socket: a Harnu-owned process with nothing answering', () => {
    expect(classifyReachability({ ...base, indexHit: true, pid: 7 })).toEqual({
      rung: 'no-socket',
      pid: 7
    })
  })

  it('parked: Harnu killed it to reclaim memory; wakeable', () => {
    expect(classifyReachability({ ...base, isParked: true })).toEqual({ rung: 'parked' })
  })

  it('cold: NO PROCESS HARNU OWNS — never "nothing is running"', () => {
    expect(classifyReachability(base)).toEqual({ rung: 'cold' })
  })

  it('a live index hit beats the parked flag (a live session is never reported parked)', () => {
    expect(classifyReachability({ ...base, indexHit: true, isParked: true, pid: 3 })).toEqual({
      rung: 'no-socket',
      pid: 3
    })
  })

  it('parked and cold NEVER collapse, in any combination', () => {
    // T213's rung 3 wakes `parked` and must not wake `cold`; folding them
    // would respawn a session behind a gate that never contemplated it.
    for (const socket of [undefined, '/run/x/1.sock']) {
      const parked = classifyReachability({
        ...base,
        isParked: true,
        ...(socket ? { socket } : {})
      })
      const cold = classifyReachability({ ...base, ...(socket ? { socket } : {}) })
      expect(parked.rung).toBe('parked')
      expect(cold.rung).toBe('cold')
      expect(parked.rung).not.toBe(cold.rung)
    }
  })

  it('an index hit with no pid is not reported as reachable', () => {
    // Defensive: the pid IS the address, so "indexed but no pid" must not
    // classify as a live process a caller could try to write to.
    expect(classifyReachability({ ...base, indexHit: true })).toEqual({ rung: 'cold' })
  })
})

describe('the wire shapes — what Harnu actually writes', () => {
  it('NEVER emits from-mode', () => {
    // The laundering vector: a bypass-mode recipient HOLDS a message with no
    // `from-mode` and ACCEPTS the same one when the sender asserts
    // `from-mode="bypass"`. Omitting it is what leaves the hold able to fire.
    const envelope = buildPeerEnvelope({ fromSession: 'sess-1', body: 'hello' })
    expect(envelope).not.toContain('from-mode')
    expect(buildUserFrame(envelope)).not.toContain('from-mode')
  })

  it('never emits a `from` reply address either', () => {
    // Harnu binds no socket, so `from` could only ever be a fabrication — which
    // makes the recipient log an ENOENT at best, and misdirects a receipt into
    // another live session at worst.
    const envelope = buildPeerEnvelope({ fromSession: 'sess-1', body: 'hello' })
    expect(envelope).not.toMatch(/\bfrom="/)
  })

  it("carries Harnu's attribution: from-name and from-session", () => {
    const envelope = buildPeerEnvelope({ fromSession: 'sess-1', body: 'hello' })
    expect(envelope).toContain(`from-name="${PEER_FROM_NAME}"`)
    expect(envelope).toContain('from-session="sess-1"')
  })

  it('opens and closes with the tags the recipient strips', () => {
    const envelope = buildPeerEnvelope({ fromSession: 's', body: 'hello' })
    expect(envelope.startsWith('<cross-session-message ')).toBe(true)
    expect(envelope.endsWith('\n</cross-session-message>')).toBe(true)
    expect(envelope).toContain('\nhello\n')
  })

  it('escapes an attribute value so a crafted session id cannot break out', () => {
    const envelope = buildPeerEnvelope({ fromSession: 'a"><script>', body: 'x' })
    expect(envelope).toContain('from-session="a&quot;&gt;&lt;script&gt;"')
    // The opening tag still ends where it should.
    expect(envelope.split('\n')[0].endsWith('">')).toBe(true)
  })

  it("the frame is the CLI's own documented recipe: one NDJSON line, type user", () => {
    const line = buildUserFrame('hi')
    expect(line).not.toContain('\n')
    expect(JSON.parse(line)).toEqual({ type: 'user', message: { role: 'user', content: 'hi' } })
  })

  it('the frame asserts NO origin, senderTaskId or auth of its own', () => {
    // The RECIPIENT builds the origin and stamps `kind:"peer"` itself; a
    // sender-supplied one is discarded. Harnu asserts nothing.
    const parsed = JSON.parse(buildUserFrame('hi')) as Record<string, unknown>
    expect(parsed.origin).toBeUndefined()
    expect(parsed.senderTaskId).toBeUndefined()
    expect(Object.keys(parsed).sort()).toEqual(['message', 'type'])
  })
})

describe('audit + activity shaping (spec §3.6)', () => {
  it('the audit summary names the recipient, pid, length and a HASH — never the body', () => {
    const body = 'the deploy key is hunter2, please use it'
    const summary = messageAuditSummary({
      sessionId: 'sess-1',
      pid: 4242,
      chars: body.length,
      bytes: 512,
      body
    })
    expect(summary).toContain('sess-1')
    expect(summary).toContain('pid 4242')
    expect(summary).toContain(`${body.length} chars`)
    expect(summary).toContain('512 bytes')
    expect(summary).toContain(`sha256:${bodyHashPrefix(body)}`)
    // The point of the hash: 200 ring entries x 4 KiB of plaintext persisted to
    // userData would be a transcript of every inter-agent message.
    expect(summary).not.toContain('hunter2')
    expect(summary).not.toContain(body)
  })

  it('the hash pins WHAT was said — different bodies, different prefixes', () => {
    expect(bodyHashPrefix('a')).not.toBe(bodyHashPrefix('b'))
    expect(bodyHashPrefix('a')).toBe(bodyHashPrefix('a'))
    expect(bodyHashPrefix('a')).toHaveLength(12)
  })

  it('the Activity description passes a short body through untouched', () => {
    expect(activityDescription('short')).toBe('short')
  })

  it('truncates a long body to the cap with an EXPLICIT marker', () => {
    // A clipped message must never be mistaken for the whole one.
    const long = 'x'.repeat(MESSAGE_MAX_CHARS)
    const out = activityDescription(long, 100)
    expect(out).toHaveLength(100)
    expect(out.endsWith('… (truncated)')).toBe(true)
  })

  it('the message cap is the one the catalog schema advertises', () => {
    expect(MESSAGE_MAX_CHARS).toBe(4096)
  })
})
