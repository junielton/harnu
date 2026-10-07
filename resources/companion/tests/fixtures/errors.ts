/** Golden fixtures for protocol failures (contract §12). HTTP status is 200 for every one. */
import type { Failure } from '../../hooks/contract'

export const failureProtoUnsupported: Failure = { ok: false, code: 'PROTO_UNSUPPORTED' }
export const failureUnauthorized: Failure = { ok: false, code: 'UNAUTHORIZED' }
export const failureUnknownSession: Failure = { ok: false, code: 'UNKNOWN_SESSION' }
export const failureStaleConn: Failure = { ok: false, code: 'STALE_CONN' }
export const failureBadEnvelope: Failure = {
  ok: false,
  code: 'BAD_ENVELOPE',
  message: 'events must be an array'
}
export const failureSlowDown: Failure = { ok: false, code: 'SLOW_DOWN', retryAfterMs: 1000 }
export const failureFeatureDisabled: Failure = { ok: false, code: 'FEATURE_DISABLED' }
export const failureHostShuttingDown: Failure = { ok: false, code: 'HOST_SHUTTING_DOWN' }
