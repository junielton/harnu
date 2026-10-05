import { describe, it, expect, beforeEach } from 'vitest'
import {
  deriveCallId,
  beginCall,
  completeCall,
  wasRecentlyFailed,
  IDEMPOTENCY_TTL_MS,
  _resetIdempotencyRegistry
} from '../src/main/mcp/idempotency-registry'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'

/**
 * Pure tests for BUG-33 §3.1 — the idempotency registry that recognizes a
 * retry of a timed-out (or already-completed) mutating call by its derived
 * `callId`, so an `in-flight`/`applied` retry replays the recorded outcome
 * instead of actuating a second time. A `failed` retry is the BUG-57
 * exception — see the `beginCall` test below and `idempotency-registry.test.ts`
 * for the full regression. No electron/fs — a plain in-memory Map (ADR-0001).
 */

beforeEach(() => {
  _resetIdempotencyRegistry()
})

const okResult: CallToolResult = { content: [{ type: 'text', text: '{"ok":true}' }] }
const errResult: CallToolResult = { content: [{ type: 'text', text: 'BOOM' }], isError: true }

describe('deriveCallId', () => {
  it('is deterministic for the same op/folder/args', () => {
    const a = deriveCallId('create_session', '/home/u/repo', { folder: '/home/u/repo' })
    const b = deriveCallId('create_session', '/home/u/repo', { folder: '/home/u/repo' })
    expect(a).toBe(b)
  })

  it('is stable across key order in args (stable stringify)', () => {
    const a = deriveCallId('create_card', '/home/u/repo', { title: 'x', kind: 'bug' })
    const b = deriveCallId('create_card', '/home/u/repo', { kind: 'bug', title: 'x' })
    expect(a).toBe(b)
  })

  it('differs when the op differs', () => {
    const a = deriveCallId('create_session', '/home/u/repo', { folder: '/home/u/repo' })
    const b = deriveCallId('create_worktree', '/home/u/repo', { folder: '/home/u/repo' })
    expect(a).not.toBe(b)
  })

  it('differs when the folder differs', () => {
    const a = deriveCallId('create_session', '/home/u/repo-a', { x: 1 })
    const b = deriveCallId('create_session', '/home/u/repo-b', { x: 1 })
    expect(a).not.toBe(b)
  })

  it('differs when the args differ', () => {
    const a = deriveCallId('create_card', '/home/u/repo', { title: 'x' })
    const b = deriveCallId('create_card', '/home/u/repo', { title: 'y' })
    expect(a).not.toBe(b)
  })

  it('an explicit idempotencyKey overrides args — same key, different args, same id', () => {
    const a = deriveCallId('create_card', '/home/u/repo', { title: 'x' }, 'my-key')
    const b = deriveCallId('create_card', '/home/u/repo', { title: 'y' }, 'my-key')
    expect(a).toBe(b)
  })

  it('a different idempotencyKey derives a different id', () => {
    const a = deriveCallId('create_card', '/home/u/repo', { title: 'x' }, 'key-1')
    const b = deriveCallId('create_card', '/home/u/repo', { title: 'x' }, 'key-2')
    expect(a).not.toBe(b)
  })
})

describe('beginCall / completeCall — dedupe a retry (AC1)', () => {
  it('a fresh callId returns undefined (proceed) and marks it in-flight', () => {
    const callId = 'create_session:abc'
    expect(beginCall(callId)).toBeUndefined()
    // A second begin before completion sees it as in-flight — the caller
    // must not actuate a second time.
    expect(beginCall(callId)).toEqual({ status: 'in-flight', result: undefined })
  })

  it('a retry while the original call is still in-flight is NOT re-actuated', () => {
    const callId = 'create_session:abc'
    beginCall(callId) // original starts
    const retry = beginCall(callId) // client retried after a client-side timeout
    expect(retry?.status).toBe('in-flight')
  })

  it('a retry after the original completed successfully replays the cached result', () => {
    const callId = 'create_worktree:def'
    beginCall(callId)
    completeCall(callId, 'applied', okResult)
    const retry = beginCall(callId)
    expect(retry).toEqual({ status: 'applied', result: okResult })
  })

  it('a retry after the original FAILED re-actuates instead of replaying (BUG-57)', () => {
    const callId = 'submit_manifest:ghi'
    beginCall(callId)
    completeCall(callId, 'failed', errResult)
    // A recorded failure applied nothing durable — replaying it for the full
    // TTL would turn a transient failure into a guaranteed dead end for an
    // agent that correctly retries with identical args. See idempotency-
    // registry.test.ts for the full BUG-57 regression coverage.
    const retry = beginCall(callId)
    expect(retry).toBeUndefined()
    // The re-actuation is itself tracked as in-flight, same as a fresh call —
    // a THIRD begin before it settles must not actuate a third time.
    expect(beginCall(callId)).toEqual({ status: 'in-flight', result: undefined })
  })

  it('a callId past its TTL is treated as fresh (not returned as an existing call)', () => {
    const callId = 'create_session:jkl'
    const start = 1_000_000
    beginCall(callId, start)
    completeCall(callId, 'applied', okResult, start)
    const afterTtl = start + IDEMPOTENCY_TTL_MS + 1
    expect(beginCall(callId, afterTtl)).toBeUndefined()
  })

  it('IDEMPOTENCY_TTL_MS is comfortably above the 120s tool deadline', () => {
    expect(IDEMPOTENCY_TTL_MS).toBeGreaterThan(120_000)
  })
})

describe('wasRecentlyFailed — audit peek for a BUG-57 re-actuation', () => {
  it('is false for an unknown callId', () => {
    expect(wasRecentlyFailed('create_session:never-seen')).toBe(false)
  })

  it('is true only while a failed entry is live, and never mutates state', () => {
    const callId = 'create_session:peek-me'
    beginCall(callId)
    completeCall(callId, 'failed', errResult)
    expect(wasRecentlyFailed(callId)).toBe(true)
    // Peeking must not re-arm the entry — beginCall still sees it as failed
    // (and thus still proceeds) on the next real call.
    expect(wasRecentlyFailed(callId)).toBe(true)
  })

  it('is false once the entry is applied', () => {
    const callId = 'create_session:peek-applied'
    beginCall(callId)
    completeCall(callId, 'applied', okResult)
    expect(wasRecentlyFailed(callId)).toBe(false)
  })

  it('is false once the failed entry expires', () => {
    const callId = 'create_session:peek-expired'
    const start = 1_000_000
    beginCall(callId, start)
    completeCall(callId, 'failed', errResult, start)
    expect(wasRecentlyFailed(callId, start + IDEMPOTENCY_TTL_MS + 1)).toBe(false)
  })
})

describe('2026-07-20 orphan-spawn incident (BUG-57 D1 repro)', () => {
  it('lets an identical create_session retry actuate again after a genuine failure', () => {
    const args = { folder: '/w/ACME-10933-booking-services', prePrompt: 'Review PR #3922' }
    const callId = deriveCallId('create_session', args.folder, args)

    // First attempt actuates and genuinely fails (SPAWN_NOT_MATERIALIZED).
    expect(beginCall(callId)).toBeUndefined()
    completeCall(callId, 'failed', {
      content: [{ type: 'text', text: '{"ok":false,"error":"SPAWN_NOT_MATERIALIZED"}' }]
    })

    // The agent retries the SAME intent. create_session advertises this as
    // "a real failure, safe to retry into the SAME folder" — it must actually
    // be able to, not replay the 8-of-8 duplicate-replay the incident showed.
    expect(beginCall(callId)).toBeUndefined()
  })

  it('still dedupes a retry of a call that SUCCEEDED — never spawns twice', () => {
    const callId = deriveCallId('create_session', '/w/ok', { folder: '/w/ok' })
    expect(beginCall(callId)).toBeUndefined()
    completeCall(callId, 'applied', { content: [{ type: 'text', text: '{"ok":true}' }] })
    expect(beginCall(callId)).toMatchObject({ status: 'applied' })
  })
})

describe('_resetIdempotencyRegistry', () => {
  it('clears all entries', () => {
    const callId = 'create_session:reset-me'
    beginCall(callId)
    _resetIdempotencyRegistry()
    expect(beginCall(callId)).toBeUndefined()
  })
})
