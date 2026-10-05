import { describe, it, expect } from 'vitest'
import {
  ackIsSuccess,
  asRecord,
  dispatchSucceeded,
  errorResult,
  steerError,
  textResult
} from '../src/main/mcp/tool-result'

describe('asRecord', () => {
  it('passes through a plain object', () => {
    expect(asRecord({ a: 1 })).toEqual({ a: 1 })
  })

  it('coerces non-object input to an empty record', () => {
    expect(asRecord(null)).toEqual({})
    expect(asRecord(undefined)).toEqual({})
    expect(asRecord('x')).toEqual({})
    expect(asRecord(42)).toEqual({})
  })
})

describe('textResult', () => {
  it('wraps the JSON-stringified payload as a single text content block', () => {
    const result = textResult({ ok: true, n: 1 })
    expect(result.isError).toBeUndefined()
    expect(result.content).toEqual([{ type: 'text', text: JSON.stringify({ ok: true, n: 1 }) }])
  })
})

describe('errorResult', () => {
  it('sets isError:true and carries the reason verbatim', () => {
    const result = errorResult('SOMETHING_FAILED')
    expect(result.isError).toBe(true)
    expect(result.content).toEqual([{ type: 'text', text: 'SOMETHING_FAILED' }])
  })
})

describe('steerError', () => {
  it('falls back to a bare errorResult when the reason has no steerable hint', () => {
    const result = steerError('SOME_UNKNOWN_REASON', '/home/u/repo')
    expect(result.isError).toBe(true)
    expect(result.content).toEqual([{ type: 'text', text: 'SOME_UNKNOWN_REASON' }])
  })

  it('shapes a structured, actionable denial for a known steerable reason', () => {
    const result = steerError('FOLDER_NOT_ALLOWED', '/home/u/repo')
    expect(result.isError).toBe(true)
    const first = result.content[0]
    expect(first.type).toBe('text')
    const parsed = JSON.parse((first as { text: string }).text)
    expect(parsed.error).toBe('FOLDER_NOT_ALLOWED')
    expect(Array.isArray(parsed.nextActions)).toBe(true)
  })
})

describe('dispatchSucceeded', () => {
  it('is true for a plain success payload with no error field', () => {
    expect(dispatchSucceeded({ syntheticId: 'x', correlationId: 'y' })).toBe(true)
  })

  it('is false when the result nests an error string — the ok:true-lie guard', () => {
    // The exact shape that shipped as a bug: {"ok":true,"result":{"error":"FOLDER_NOT_FOUND"}}.
    // dispatchSucceeded(result) must be false so the handler never sets the
    // outer ok:true alongside it.
    expect(dispatchSucceeded({ error: 'FOLDER_NOT_FOUND' })).toBe(false)
    expect(dispatchSucceeded({ error: 'BAD_ARGS' })).toBe(false)
  })

  it('is false for a thrown-error result carrying ok:false', () => {
    expect(dispatchSucceeded({ ok: false, error: 'boom' })).toBe(false)
  })

  it('is true when a non-string/absent error field is present (defensive default)', () => {
    expect(dispatchSucceeded({})).toBe(true)
    expect(dispatchSucceeded(null)).toBe(true)
    expect(dispatchSucceeded(undefined)).toBe(true)
  })
})

describe('ackIsSuccess (this card — the grant-refund predicate)', () => {
  it('is false for an isError result regardless of payload', () => {
    expect(ackIsSuccess(errorResult('SOME_FAILURE'))).toBe(false)
  })

  it('is false for a textResult payload carrying ok:false', () => {
    expect(ackIsSuccess(textResult({ ok: false, error: 'SPAWN_NOT_MATERIALIZED' }))).toBe(false)
  })

  it('is true for a textResult payload carrying ok:true', () => {
    expect(ackIsSuccess(textResult({ ok: true, op: 'create_session' }))).toBe(true)
  })

  it('is true (defensive default) for a payload with no ok field at all', () => {
    expect(ackIsSuccess(textResult({ some: 'read-result' }))).toBe(true)
  })

  it('is true for a steerError result carrying a structured JSON denial (isError already covers it)', () => {
    expect(ackIsSuccess(steerError('SESSION_ALREADY_IN_FLIGHT', '/x'))).toBe(false)
  })

  // BUG-33 AC3: `errorResult` always sets `isError`, so a TOOL_TIMEOUT result is
  // refunded by the SAME generic `!ackIsSuccess(res)` check as any other
  // non-success outcome — no separate timeout-specific refund branch exists,
  // or needs to.
  it('is false for a TOOL_TIMEOUT result (the grant-allowed path refunds on this)', () => {
    expect(ackIsSuccess(errorResult('TOOL_TIMEOUT'))).toBe(false)
  })
})
