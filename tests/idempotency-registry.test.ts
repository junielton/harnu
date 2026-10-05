/**
 * Regression tests for BUG-57 — a failed `create_session` poisoned its own
 * retries for the full 10-minute idempotency TTL. Restored from the
 * 2026-07-20 orphan-spawn post-mortem's repro (defect D1).
 */

import { describe, it, expect, beforeEach } from 'vitest'
import {
  beginCall,
  completeCall,
  deriveCallId,
  _resetIdempotencyRegistry
} from '../src/main/mcp/idempotency-registry'

describe('idempotency registry: a failed call must not poison its own retry', () => {
  beforeEach(() => _resetIdempotencyRegistry())

  it('lets an identical retry actuate again after a genuine failure', () => {
    const args = { folder: '/w/ACME-10933-booking-services', prePrompt: 'Review PR #3922' }
    const callId = deriveCallId('create_session', args.folder, args)

    // First attempt actuates and genuinely fails (SPAWN_NOT_MATERIALIZED).
    expect(beginCall(callId)).toBeUndefined()
    completeCall(callId, 'failed', {
      content: [{ type: 'text', text: '{"ok":false,"error":"SPAWN_NOT_MATERIALIZED"}' }]
    })

    // The agent retries the SAME intent. create_session advertises this as
    // "a real failure, safe to retry into the SAME folder".
    const retry = beginCall(callId)

    // Observed: `{ status: 'failed', result: <cached SPAWN_NOT_MATERIALIZED> }`,
    // replayed for 10 minutes without dispatching anything. The audit log for the
    // incident shows 8/8 retries as verdict=duplicate-replay result=failed.
    expect(retry).toBeUndefined()
  })

  it('still dedupes a retry of a call that SUCCEEDED', () => {
    const callId = deriveCallId('create_session', '/w/ok', { folder: '/w/ok' })
    expect(beginCall(callId)).toBeUndefined()
    completeCall(callId, 'applied', { content: [{ type: 'text', text: '{"ok":true}' }] })
    // This half of the contract is correct and must stay: never spawn twice.
    expect(beginCall(callId)).toMatchObject({ status: 'applied' })
  })
})
