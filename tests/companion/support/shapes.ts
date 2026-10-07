import { DEFAULT_CONFIG, type HelloResponse } from '../../../src/main/companion/contract'

/** Structural check of a `HelloResponse`: the host side of the contract, shared by two suites. */
export function isHelloResponse(v: unknown): v is HelloResponse {
  if (typeof v !== 'object' || v === null) return false
  const r = v as Record<string, unknown>
  if (r.ok === false) return typeof r.code === 'string'
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
    Object.keys(DEFAULT_CONFIG).every((k) => typeof config[k] === 'number')
  )
}
