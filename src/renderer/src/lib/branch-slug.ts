/**
 * Branch-name slugification for the New worktree dialog.
 *
 * The real-world input is a ticket title pasted out of an issue tracker
 * (`ACME-10996 Report Export Date Range Filter`), which is not a valid git
 * branch name. This turns it into one, with the team's prefix convention and
 * the case rule under the user's control.
 *
 * Neither existing slug helper fits: `slugifyBranch` (main-process
 * `worktree-core.ts`) maps a branch to a *directory* name and never lowercases;
 * `slugifyTitle` (`roadmap-core.ts`) lowercases unconditionally and truncates.
 */

export interface BranchSlugOptions {
  /** Literal prefix to prepend, e.g. `feature/`. Empty = none. */
  prefix?: string
  /** Run the prefix through the same slug transform (`feature/` → `feature-`). */
  slugifyPrefix?: boolean
  /** Keep the original casing instead of lowercasing. */
  preserveCase?: boolean
}

/**
 * Mirror of `SAFE_BRANCH`'s character class in `src/main/worktree-core.ts`.
 * Deliberately duplicated rather than imported: that regex is the
 * shell-injection safety boundary for the git seam and must not grow a
 * renderer-side consumer that could pressure it to loosen.
 */
const SAFE_PREFIX_CHARS = /[^A-Za-z0-9._/-]+/g

/** Combining diacritical marks, stripped after an NFKD decomposition. */
const COMBINING_MARKS = /[\u0300-\u036f]/g

/** A prefix ending in one of these already separates itself from the body. */
const SEPARATORS = ['/', '-', '_']

/**
 * The body transform: every run of non-alphanumerics collapses to a single
 * dash. One rule, and it deliberately eats `.` and `_` too — the strip is
 * opt-in, so a user who wants `release/1.2.0` verbatim simply doesn't apply it.
 */
function slugBody(raw: string, preserveCase: boolean): string {
  const folded = raw.trim().normalize('NFKD').replace(COMBINING_MARKS, '')
  const cased = preserveCase ? folded : folded.toLowerCase()
  return cased.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
}

/** Resolve the prefix into the exact string that gets prepended, separator included. */
function buildPrefix(prefix: string, slugifyPrefix: boolean, preserveCase: boolean): string {
  const trimmed = prefix.trim()
  if (!trimmed) return ''

  if (slugifyPrefix) {
    const slug = slugBody(trimmed, preserveCase)
    return slug ? `${slug}-` : ''
  }

  const sanitized = trimmed.replace(SAFE_PREFIX_CHARS, '-')
  if (!sanitized) return ''
  return SEPARATORS.some((s) => sanitized.endsWith(s)) ? sanitized : `${sanitized}-`
}

function startsWithCaseInsensitive(haystack: string, needle: string): boolean {
  return haystack.slice(0, needle.length).toLowerCase() === needle.toLowerCase()
}

/**
 * Slugify `raw` into a git-safe branch name.
 *
 * Idempotent — `f(f(x)) === f(x)` — which is what makes the suggestion strip
 * vanish after the user applies it. That relies on stripping an already-present
 * prefix *before* slugifying the rest; without it `feature/foo` would re-slug
 * into `feature-foo` and then `feature/feature-foo`.
 *
 * Returns `''` when there is nothing to suggest (empty input, or a body that
 * slugs away to nothing) — never a bare prefix, which is not a valid branch.
 */
export function slugifyBranchName(raw: string, opts: BranchSlugOptions = {}): string {
  const { prefix = '', slugifyPrefix = false, preserveCase = false } = opts

  const prefixOut = buildPrefix(prefix, slugifyPrefix, preserveCase)

  let rest = raw.trim()
  if (prefixOut && startsWithCaseInsensitive(rest, prefixOut)) {
    rest = rest.slice(prefixOut.length)
  }

  const body = slugBody(rest, preserveCase)
  return body ? prefixOut + body : ''
}
