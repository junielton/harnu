/**
 * The host-side replay of the golden fixtures and the `contract.ts` re-export (AC-P1W1-1, contract
 * half). Later waves append their own cases here (AC-P3W2-29, AC-P4W2-18); none creates this file.
 */
import { describe, expect, it } from 'vitest'
import * as viaMain from '../../src/main/companion/contract'
import * as canonical from '../../resources/companion/hooks/contract'
import type { HelloResponse } from '../../src/main/companion/contract'
import {
  failureBadEnvelope,
  failureFeatureDisabled,
  failureHostShuttingDown,
  failureProtoUnsupported,
  failureSlowDown,
  failureStaleConn,
  failureUnauthorized,
  failureUnknownSession
} from '../../resources/companion/tests/fixtures/errors'
import {
  helloHeadlessRequest,
  helloResponseEnabled,
  helloResponseHeadless,
  helloResponseOk,
  helloResumeRequest,
  helloSpawnRequest
} from '../../resources/companion/tests/fixtures/hello'
import { validateHello } from '../../src/main/companion/wire-core'

/** Structural check of a `HelloResponse`; the host side of the contract (shared with server.test). */
export function isHelloResponse(v: unknown): v is HelloResponse {
  if (typeof v !== 'object' || v === null) return false
  const r = v as Record<string, unknown>
  if (r.ok === false) {
    return typeof r.code === 'string'
  }
  if (r.ok !== true) return false
  const config = r.config as Record<string, unknown> | undefined
  return (
    typeof r.proto === 'number' &&
    typeof r.conn === 'string' &&
    /^c_[0-9a-f]{32}$/.test(r.conn) &&
    typeof r.bootId === 'string' &&
    r.bootId.startsWith('b_') &&
    (r.sessionKey === null || typeof r.sessionKey === 'string') &&
    ['interactive', 'headless', 'external'].includes(r.profile as string) &&
    Array.isArray(r.enable) &&
    r.enable.every((f) => typeof f === 'string') &&
    typeof config === 'object' &&
    config !== null &&
    Object.keys(canonical.DEFAULT_CONFIG).every((k) => typeof config[k] === 'number')
  )
}

describe('contract.ts re-export', () => {
  it('main re-exports exactly the canonical constants', () => {
    expect(Object.keys(viaMain).sort()).toEqual(Object.keys(canonical).sort())
    for (const k of Object.keys(canonical) as (keyof typeof canonical)[]) {
      expect(viaMain[k]).toEqual(canonical[k])
    }
  })

  it('carries the values the specs pin', () => {
    expect(canonical.SOCKET_PATH_MAX_BYTES).toBe(90)
    expect(canonical.LEASE_TTL_MS).toBe(20_000)
    expect(canonical.LEASE_SWEEP_MS).toBe(5_000)
    expect(canonical.RATE_WINDOW_MS).toBe(10_000)
    expect(canonical.RATE_MAX_REQUESTS).toBe(200)
    expect(canonical.BODY_MAX_BYTES).toBe(1_048_576)
    expect(canonical.HELLO_SLA_MS).toBe(2_000)
    expect(canonical.SPAWN_REDEEM_WINDOW_MS).toBe(600_000)
  })
})

describe('golden fixtures', () => {
  it('the hello fixtures validate as HelloResponse through the re-export', () => {
    for (const res of [helloResponseOk, helloResponseEnabled, helloResponseHeadless]) {
      expect(isHelloResponse(res)).toBe(true)
    }
    for (const f of [
      failureProtoUnsupported,
      failureUnauthorized,
      failureUnknownSession,
      failureStaleConn,
      failureBadEnvelope,
      failureSlowDown,
      failureFeatureDisabled,
      failureHostShuttingDown
    ]) {
      expect(f.ok).toBe(false)
      expect(isHelloResponse(f)).toBe(true)
    }
    expect(isHelloResponse({ ok: true })).toBe(false)
    expect(isHelloResponse(null)).toBe(false)
  })

  it('the hello request fixtures validate on the host', () => {
    for (const req of [helloSpawnRequest, helloResumeRequest, helloHeadlessRequest]) {
      expect(validateHello(req).ok).toBe(true)
    }
  })

  it('no fixture carries a real-looking secret', () => {
    const all = JSON.stringify([helloSpawnRequest, helloResumeRequest, helloResponseOk])
    expect(all).toMatch(/sp_00000000/)
    expect(all).not.toMatch(/Bearer/)
  })
})
