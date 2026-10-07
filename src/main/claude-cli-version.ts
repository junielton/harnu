/**
 * Pure parse + compare for the installed Claude Code version (T200 §3.1).
 * No I/O: the probe and the cache live in `claude-cli.ts`.
 */

export interface ClaudeVersion {
  /** The full stdout line, trimmed: "2.1.222 (Claude Code)". */
  raw: string
  major: number
  minor: number
  patch: number
  /** "beta.1" for 2.1.193-beta.1, else null. */
  prerelease: string | null
}

const SEMVER = /(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.]+))?/

/**
 * Matches the first semver in the first non-empty line and ignores the rest
 * (`(Claude Code)` today, anything tomorrow). Anything else → null.
 */
export function parseClaudeVersion(stdout: string): ClaudeVersion | null {
  const line = stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.length > 0)
  if (!line) return null
  const m = SEMVER.exec(line)
  if (!m) return null
  return {
    raw: line,
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    prerelease: m[4] ?? null
  }
}

function cmp(a: number, b: number): -1 | 0 | 1 {
  return a < b ? -1 : a > b ? 1 : 0
}

/** Numeric per component; a prerelease sorts below its release (semver). */
export function compareClaudeVersions(a: ClaudeVersion, b: ClaudeVersion): -1 | 0 | 1 {
  const core = cmp(a.major, b.major) || cmp(a.minor, b.minor) || cmp(a.patch, b.patch)
  if (core !== 0) return core
  if (a.prerelease === b.prerelease) return 0
  if (a.prerelease === null) return 1
  if (b.prerelease === null) return -1
  return a.prerelease < b.prerelease ? -1 : 1
}

/** `null` (unknown) behaves as the oldest supported version: false. */
export function isAtLeast(v: ClaudeVersion | null, target: string): boolean {
  if (!v) return false
  const t = parseClaudeVersion(target)
  if (!t) return false
  return compareClaudeVersions(v, t) >= 0
}
