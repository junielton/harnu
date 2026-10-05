import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  fetchPrHead,
  lastFetchedAt,
  localHeadFreshness,
  localPrRef,
  mainWorktreeFrom,
  pullHeadRef,
  resolvePrBase,
  resolvePrHead,
  type GitRun
} from '../src/main/review-head'

/**
 * T246 — reviewing a PR this machine never checked out.
 *
 * These are the claims that, if they stopped being true, would make the review
 * pane actively dangerous rather than merely incomplete:
 *
 *  - AC-1/AC-3 "not fetched yet" is a NAMED state, and opening never fetches.
 *  - AC-2      the head comes from `refs/pull/<n>/head` for every PR.
 *  - AC-4      an unresolvable base refuses instead of diffing against a guess.
 *  - AC-7      a fetch that FAILED is distinct from having nothing to fetch.
 *  - the cwd   read-only git plus `fetch`, never `checkout`/`reset`/`stash`.
 */

const REPO = join(import.meta.dirname, '..')

/** A `GitRun` that records every invocation and answers from a lookup table. */
function fakeGit(answers: Record<string, string | null> = {}): GitRun & { calls: string[][] } {
  const calls: string[][] = []
  const run = (async (args: readonly string[]) => {
    calls.push([...args])
    for (const [needle, value] of Object.entries(answers)) {
      if (args.join(' ').includes(needle)) return value
    }
    return null
  }) as GitRun & { calls: string[][] }
  run.calls = calls
  return run
}

const PR = {
  number: 412,
  headRefName: 'feat/their-branch',
  baseRefName: 'main',
  headOid: 'aaaa1111'
}

// ── The ref shape ───────────────────────────────────────────────────────────

describe('the head ref', () => {
  it('is `refs/pull/<n>/head` for every PR, fork or not', () => {
    expect(pullHeadRef(412)).toBe('refs/pull/412/head')
    expect(localPrRef(412)).toBe('refs/harnu/pr/412')
  })

  /**
   * The two representations (hole 3). `assembleEvidence` matches PRs on the
   * BARE `headRefName`; pass the pull ref as the branch and the match silently
   * finds nothing, which takes the PR/CI chips down with it.
   */
  it('separates the ref it diffs from the name it matches on', async () => {
    const git = fakeGit({ 'rev-parse --verify': 'aaaa1111\n' })

    const head = await resolvePrHead(git, PR, { fetch: false })

    expect(head.ref).toBe('refs/harnu/pr/412')
    expect(head.name).toBe('feat/their-branch')
    expect(head.name).not.toContain('refs/')
  })
})

// ── AC-3 / AC-1 ─────────────────────────────────────────────────────────────

describe('AC-3 — opening does not go to the network', () => {
  it('runs no `fetch` when `fetch` is false', async () => {
    const git = fakeGit({ 'rev-parse --verify': 'aaaa1111\n' })

    await resolvePrHead(git, PR, { fetch: false })

    expect(git.calls.some((c) => c.includes('fetch'))).toBe(false)
  })

  it('runs exactly one fetch, forced and into a Harnu-owned ref, when asked', async () => {
    const git = fakeGit({ fetch: 'ok\n', 'rev-parse --verify': 'aaaa1111\n' })

    await resolvePrHead(git, PR, { fetch: true })

    const fetches = git.calls.filter((c) => c.includes('fetch'))
    expect(fetches).toHaveLength(1)
    // `+` matters: PR authors force-push, and a non-forced fetch of a rewritten
    // head fails as "non-fast-forward" — which would present as a dead network.
    expect(fetches[0]).toContain('+refs/pull/412/head:refs/harnu/pr/412')
    expect(fetches[0]).toContain('origin')
  })
})

describe('AC-1 — "not fetched yet" is a state, never an empty diff', () => {
  /**
   * The one that would have shipped a real defect. `runGit` swallows every
   * failure to `null`, so a diff against a ref that does not exist produces
   * exactly `commitsAhead: 0` — the "no commits on this branch" empty state. An
   * operator reads "no commits", concludes nothing happened, and Closes.
   */
  it('reports `not-fetched` — not a readable head with nothing in it', async () => {
    const git = fakeGit() // every rev-parse fails: the ref is not on disk

    const head = await resolvePrHead(git, PR, { fetch: false })

    expect(head.state).toBe('not-fetched')
    expect(head.state).not.toBe('ready')
    expect(head.fetchFailed).toBe(false)
  })

  it('reports `ready` once the ref resolves', async () => {
    const git = fakeGit({ 'rev-parse --verify': 'aaaa1111\n' })

    const head = await resolvePrHead(git, PR, { fetch: false })

    expect(head.state).toBe('ready')
  })
})

// ── AC-7 ────────────────────────────────────────────────────────────────────

describe('AC-7 — a fetch that failed is its own state', () => {
  it('distinguishes "the fetch failed" from "nothing has been fetched"', async () => {
    const failed = await resolvePrHead(fakeGit(), PR, { fetch: true })
    const never = await resolvePrHead(fakeGit(), PR, { fetch: false })

    expect(failed.state).toBe('fetch-failed')
    expect(never.state).toBe('not-fetched')
    expect(failed.state).not.toBe(never.state)
  })

  it('still renders the older copy when a refresh fails, and says the refresh failed', async () => {
    // The fetch fails; a previously-fetched ref is still on disk.
    const git = fakeGit({ 'rev-parse --verify': 'aaaa1111\n' })

    const head = await resolvePrHead(git, PR, { fetch: true })

    expect(head.state).toBe('ready')
    expect(head.fetchFailed).toBe(true)
  })

  it('retries with the head alone when the base refspec is what failed', async () => {
    // A PR whose base branch was deleted — GitHub retargets, the branch is gone.
    let seen = 0
    const git: GitRun & { calls: string[][] } = Object.assign(
      async (args: readonly string[]) => {
        git.calls.push([...args])
        if (!args.includes('fetch')) return null
        seen += 1
        return seen === 1 ? null : 'ok\n'
      },
      { calls: [] as string[][] }
    )

    const ok = await fetchPrHead(git, 412, 'gone-base')

    expect(ok).toBe(true)
    const fetches = git.calls.filter((c) => c.includes('fetch'))
    expect(fetches).toHaveLength(2)
    expect(fetches[0].join(' ')).toContain('refs/heads/gone-base')
    expect(fetches[1].join(' ')).not.toContain('gone-base')
  })
})

// ── AC-4 ────────────────────────────────────────────────────────────────────

describe('AC-4 — the base comes from the PR, and refuses when it cannot', () => {
  it('prefers the remote-tracking base over a possibly stale local branch', async () => {
    const git = fakeGit({ 'rev-parse --verify --quiet origin/main': 'bbbb\n' })

    expect(await resolvePrBase(git, 'main')).toBe('origin/main')
  })

  it('falls through to the local branch when there is no remote-tracking ref', async () => {
    const git = fakeGit({ 'rev-parse --verify --quiet main^{commit}': 'bbbb\n' })

    expect(await resolvePrBase(git, 'main')).toBe('main')
  })

  /**
   * A wrong base rendered confidently is worse than no diff: diffing against
   * the repo default when the PR targets something else shows the parent
   * branch's commits as this PR's own.
   */
  it('returns null — refuse — when the PR base resolves nowhere', async () => {
    expect(await resolvePrBase(fakeGit(), 'feat/deleted-parent')).toBeNull()
  })
})

// ── AC-6 ────────────────────────────────────────────────────────────────────

describe('AC-6 — staleness is a boolean, not an age', () => {
  it('says `current` when the local ref matches `headRefOid`', async () => {
    const git = fakeGit({ 'rev-parse --verify': 'aaaa1111\n' })

    expect((await resolvePrHead(git, PR, { fetch: false })).freshness).toBe('current')
  })

  it('says `moved` when it does not', async () => {
    const git = fakeGit({ 'rev-parse --verify': 'cccc9999\n' })

    expect((await resolvePrHead(git, PR, { fetch: false })).freshness).toBe('moved')
  })

  it('says `unknown` rather than guessing when gh gave no head SHA', async () => {
    const git = fakeGit({ 'rev-parse --verify': 'aaaa1111\n' })

    const head = await resolvePrHead(git, { ...PR, headOid: null }, { fetch: false })

    expect(head.freshness).toBe('unknown')
  })

  it('falls back to when the ref was last fetched, read from its reflog', async () => {
    const git = fakeGit({
      'rev-parse --verify': 'aaaa1111\n',
      reflog: 'harnu/pr/412@{1787904118}\n'
    })

    const head = await resolvePrHead(git, { ...PR, headOid: null }, { fetch: false })

    expect(head.fetchedAt).toBe(1787904118 * 1000)
  })

  it('reports no fetch time rather than a wrong one when the reflog is empty', async () => {
    expect(await lastFetchedAt(fakeGit(), 'refs/harnu/pr/412')).toBeNull()
  })

  /**
   * A local branch that differs from the PR's head means the OPERATOR moved,
   * not the PR. Same comparison, deliberately a different sentence downstream:
   * "the PR has moved since you fetched" would be a confident lie about which
   * side is stale.
   */
  it('compares a local branch too, so its own sentence can be chosen', async () => {
    const same = fakeGit({ 'rev-parse --verify': 'aaaa1111\n' })
    const diff = fakeGit({ 'rev-parse --verify': 'zzzz0000\n' })

    expect(await localHeadFreshness(same, 'feat/mine', 'aaaa1111')).toBe('current')
    expect(await localHeadFreshness(diff, 'feat/mine', 'aaaa1111')).toBe('moved')
    expect(await localHeadFreshness(same, 'feat/mine', null)).toBe('unknown')
  })
})

// ── The cwd is the repo's main worktree ─────────────────────────────────────

describe('the review runs in the repo main worktree', () => {
  it('takes the parent of `--git-common-dir`', () => {
    expect(mainWorktreeFrom('/repos/harnu/.git\n', '/repos/harnu/wt/x')).toBe('/repos/harnu')
  })

  it('keeps the folder when git answered relatively — that folder IS the main one', () => {
    expect(mainWorktreeFrom('.git', '/repos/harnu')).toBe('/repos/harnu')
    expect(mainWorktreeFrom(null, '/repos/harnu')).toBe('/repos/harnu')
  })
})

// ── The rule that makes the shared cwd safe ─────────────────────────────────

describe('read-only git plus `fetch`, and nothing else', () => {
  const FORBIDDEN = [
    'checkout',
    'reset',
    'stash',
    'switch',
    'restore',
    'merge',
    'rebase',
    'cherry-pick',
    'clean',
    'commit',
    'push'
  ]

  /**
   * The cwd for a foreign PR is the repo's MAIN worktree, which normally has
   * the operator's own uncommitted work sitting in it. A review that switched
   * the branch underneath them would be a far worse bug than whatever it was
   * simplifying — so this is a test, not a comment, because the next person
   * will reach for `checkout` to "simplify" the fetch.
   */
  it('never issues a working-tree-mutating command, in any scenario', async () => {
    // One recorder across every scenario, so the assertion sees the union of
    // what the module can run rather than the last call's arguments.
    const found = fakeGit({ 'rev-parse --verify': 'aaaa1111\n' })
    const missing = fakeGit()
    for (const git of [found, missing]) {
      await resolvePrHead(git, PR, { fetch: false })
      await resolvePrHead(git, PR, { fetch: true })
      await fetchPrHead(git, 412, 'main')
      await fetchPrHead(git, 412, null)
      await resolvePrBase(git, 'main')
      await localHeadFreshness(git, 'feat/x', 'aaaa1111')
      await lastFetchedAt(git, 'refs/harnu/pr/412')
    }

    // The verb is the first argument that is neither a flag nor a `-c` value.
    const calls = [...found.calls, ...missing.calls]
    const verbs = calls.map((c) => c.find((a) => !a.startsWith('-') && !a.includes('=')) ?? '')
    for (const forbidden of FORBIDDEN) {
      expect(verbs, `a review command ran \`git ${forbidden}\``).not.toContain(forbidden)
    }
    expect(new Set(verbs)).toEqual(new Set(['fetch', 'rev-parse', 'reflog']))
  })

  /**
   * The behavioural test above only covers the paths it calls. This one covers
   * the source: a `checkout` added to a branch no test exercises would slip
   * past it, and this is the file where someone would add it.
   */
  it('the review shell holds no working-tree-mutating verb, in code', () => {
    for (const rel of ['src/main/review-head.ts', 'src/main/review-ipc.ts']) {
      const text = readFileSync(join(REPO, rel), 'utf8')
      // Comments are prose ABOUT the rule — only code may not do these things.
      const code = text
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .split('\n')
        .filter((l) => !l.trim().startsWith('*') && !l.trim().startsWith('//'))
        .join('\n')
      for (const forbidden of FORBIDDEN) {
        expect(code, `${rel} names \`${forbidden}\``).not.toContain(`'${forbidden}'`)
      }
    }
  })
})
