// Parsing of the untrusted `gc:clean` options (T441 delta 1). The renderer is not trusted to
// send well-formed facts; a malformed entry is dropped, which makes that id fail closed with
// `missing-expected` instead of being compared against something invented.

import type { GcCleanOptions, GcExpected } from './gc-wire'

/** Narrows an untrusted `expected` entry; anything malformed is dropped, which refuses that id. */
function parseExpected(raw: unknown): GcExpected | null {
  if (!raw || typeof raw !== 'object') return null
  const e = raw as Record<string, unknown>
  const strings = (v: unknown): string[] | null =>
    Array.isArray(v) && v.every((x) => typeof x === 'string') ? (v as string[]) : null
  const bucket = e.bucket
  const stackIds = strings(e.stackIds)
  const ownedVolumes = strings(e.ownedVolumes)
  if (
    (bucket !== 'ready' &&
      bucket !== 'review' &&
      bucket !== 'in-use' &&
      bucket !== 'orphan-volume') ||
    !stackIds ||
    !ownedVolumes ||
    !(e.reasonCode === null || typeof e.reasonCode === 'string') ||
    !(e.headSha === null || typeof e.headSha === 'string') ||
    !(e.bytes === null || typeof e.bytes === 'number') ||
    !(e.path === null || typeof e.path === 'string')
  ) {
    return null
  }
  const project = e.project === undefined || typeof e.project === 'string' || e.project === null
  if (!project) return null
  return {
    bucket,
    reasonCode: e.reasonCode,
    headSha: e.headSha,
    stackIds,
    ownedVolumes,
    bytes: e.bytes,
    path: e.path,
    ...(e.project !== undefined ? { project: e.project as string | null } : {})
  }
}

/**
 * `confirmed` and `expected` from an untrusted payload. There is deliberately no blanket
 * "confirm everything" flag: a stray `confirmDecide` or `confirmReview` is ignored, so it confirms nothing.
 */
export function parseOptions(raw: unknown): GcCleanOptions {
  const r = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  const confirmed = Array.isArray(r.confirmed)
    ? r.confirmed.filter((x): x is string => typeof x === 'string').slice(0, 500)
    : []
  const expected: Record<string, GcExpected> = {}
  if (r.expected && typeof r.expected === 'object' && !Array.isArray(r.expected)) {
    for (const [id, value] of Object.entries(r.expected as Record<string, unknown>)) {
      const parsed = parseExpected(value)
      if (parsed) expected[id] = parsed
    }
  }
  return { confirmed, expected }
}
