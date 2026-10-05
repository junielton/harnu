/**
 * T246 — Review pane: resolving the head of a PR this machine never checked out.
 *
 * The review pane's diff is 100% local `git`, which is why it worked only for
 * branches sitting in a worktree. Reviewing someone ELSE's PR needs three things
 * this module owns, and nothing else in the pane has to know about any of them:
 *
 *  1. **One ref shape for every PR.** GitHub publishes `refs/pull/<n>/head` for
 *     fork and same-repo PRs alike, so there is no branch in the logic to get
 *     wrong and no class of PR that silently takes a different path. Building
 *     `origin/<headRefName>` with a fork fallback would make the RARE case the
 *     tested one and the common case the accident — most "someone else's PR" is
 *     a fork, whose head does not exist under `origin` at all.
 *  2. **Two representations of the head.** `assembleEvidence` matches PRs on the
 *     BARE `headRefName` (`pr-stack-core.ts`), while the diff needs a ref that
 *     resolves locally. They are not the same string: pass `refs/pull/12/head`
 *     as the branch and the PR match silently finds nothing, which breaks both
 *     this card's base resolution and the PR/CI chips that already work. Hence
 *     {@link ReviewHead.name} (match on this) vs {@link ReviewHead.ref} (diff
 *     this).
 *  3. **"Not fetched yet" as a state, not an absence.** `runGit` swallows every
 *     failure to `null`, so a diff against a ref that does not exist renders
 *     IDENTICALLY to `commitsAhead: 0` — the "no commits on this branch" empty
 *     state. An operator would read "no commits", conclude nothing happened and
 *     Close. That is the exact R2 failure the review pane exists to prevent,
 *     reached from a new direction, so the unfetched head is a named state that
 *     REFUSES the diff rather than rendering an empty one.
 *
 * **This module may run read-only git plus `fetch`, and nothing else.** Never
 * `checkout`, `reset`, `stash`, `switch` or `restore`. The cwd for a foreign PR
 * is the repo's MAIN worktree, which normally has the operator's own uncommitted
 * work sitting in it; `fetch` and `diff <a>...<b>` never touch the working tree,
 * the index or HEAD, and that is the entire reason this is safe. A review that
 * switched the branch under an operator would be a far worse bug than whatever
 * it was simplifying — `tests/review-head.test.ts` pins the rule so the next
 * person who reaches for `checkout` finds a red test instead of a merge.
 *
 * Pure of Electron and `child_process`: everything runs through the injected
 * {@link GitRun}, which is what makes "opening performs no network call"
 * (AC-3) a unit test instead of a promise.
 */

/**
 * Run `git` in the review's cwd and return stdout, or `null` on ANY failure —
 * the same degrade-to-null contract `review-ipc.ts`'s `runGit` has, lifted to an
 * injectable seam.
 */
export type GitRun = (args: readonly string[]) => Promise<string | null>

/** Where the head came from. `local` is the folder's own branch (pre-T246). */
export type HeadKind = 'local' | 'pr'

/**
 * Why there is (or is not) a diff to render.
 *
 * `base-unresolved` is about the BASE rather than the head, and lives here on
 * purpose: this enum is the single "should we diff at all?" gate, and splitting
 * it across two fields would mean every reader has to remember to check both. A
 * wrong base rendered confidently is worse than no diff (AC-4).
 */
export type HeadState = 'ready' | 'not-fetched' | 'fetch-failed' | 'base-unresolved'

/** Is the copy being read still the PR's current head? */
export type HeadFreshness = 'current' | 'moved' | 'unknown'

export interface HeadInfo {
  kind: HeadKind
  state: HeadState
  /** The git ref actually diffed — `refs/harnu/pr/12`, or the branch name. */
  ref: string
  /**
   * The COMMIT the head resolved to, or `null` when it did not resolve.
   *
   * T244 AC-6 / T247: {@link ref} is not a durable identity. `refs/harnu/pr/<n>`
   * is force-overwritten by every refresh ({@link fetchPrHead}), so a consumer
   * that pins the ref name keeps succeeding against different content. The SHA
   * is immutable, which is what lets a downstream consumer (the head pin on a
   * submitted review; the companion's orientation) be self-verifying instead of
   * merely well-formed.
   */
  sha: string | null
  prNumber: number | null
  freshness: HeadFreshness
  /** ms epoch the local ref was last fetched; `null` when not knowable. */
  fetchedAt: number | null
  /** A fetch ran on THIS load and failed — true even when an older copy renders. */
  fetchFailed: boolean
}

/** The head, in both of the two representations the pane needs. */
export interface ReviewHead extends HeadInfo {
  /** The BARE branch name. What PR matching and the header render. */
  name: string
}

/** The remote ref GitHub publishes for every PR, fork or not. */
export function pullHeadRef(prNumber: number): string {
  return `refs/pull/${prNumber}/head`
}

/**
 * Where a fetched PR head lands locally.
 *
 * A Harnu-owned namespace rather than `refs/heads/*` or `refs/remotes/origin/*`:
 * it cannot collide with a branch the operator owns, `git branch` never lists
 * it, and nothing in a normal workflow will move or delete it behind us.
 */
export function localPrRef(prNumber: number): string {
  return `refs/harnu/pr/${prNumber}`
}

/** A ref name that git will not choke on. Defensive: `number` comes from `gh`. */
function validPrNumber(n: number | null | undefined): n is number {
  return typeof n === 'number' && Number.isInteger(n) && n > 0
}

/**
 * The commit `ref` resolves to here, or `null` when it resolves to nothing.
 *
 * Exported because the SHA is now a first-class field on {@link HeadInfo} and on
 * the snapshot's base, and both are resolved through this one predicate — a
 * second `rev-parse` spelling elsewhere is how the two halves of "which commits
 * am I looking at" start disagreeing.
 */
export async function resolveCommit(git: GitRun, ref: string): Promise<string | null> {
  const out = await git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])
  const sha = out?.trim() ?? ''
  return sha.length > 0 ? sha : null
}

/**
 * When the local ref was last written, from its reflog.
 *
 * The fetch asks for `core.logAllRefUpdates=always` precisely so this exists:
 * git only journals `refs/heads`, `refs/remotes` and `refs/notes` by default,
 * and a Harnu-owned ref would otherwise carry no history at all. Reading a real
 * git fact beats an in-memory timestamp, which would evaporate on restart and
 * leave the pane claiming it knows nothing about a ref it fetched an hour ago.
 */
export async function lastFetchedAt(git: GitRun, ref: string): Promise<number | null> {
  const out = await git(['reflog', 'show', '--date=unix', '--format=%gd', '-1', ref])
  const m = /@\{(\d+)\}/.exec(out ?? '')
  if (!m) return null
  const seconds = Number.parseInt(m[1], 10)
  return Number.isFinite(seconds) ? seconds * 1000 : null
}

/**
 * Fetch a PR head (and its base, when known) into refs Harnu owns.
 *
 * Both refspecs ride ONE call so the common case costs one round trip, and the
 * base rides along because a stale `origin/<base>` is the other half of "a wrong
 * base rendered confidently" — the head being current is not much use when the
 * thing it is diffed against is a week old. The base refspec is the fragile one
 * (GitHub retargets a PR onto the default branch when its base is deleted, so
 * the branch may simply not exist any more), which is why a failure retries with
 * the head alone rather than giving up on the head too.
 *
 * `+` on both: PR authors force-push, and a non-forced fetch of a rewritten head
 * fails with "non-fast-forward" — which would present as "the network is down".
 */
export async function fetchPrHead(
  git: GitRun,
  prNumber: number,
  baseBranch: string | null
): Promise<boolean> {
  if (!validPrNumber(prNumber)) return false
  const head = `+${pullHeadRef(prNumber)}:${localPrRef(prNumber)}`
  // `-c core.logAllRefUpdates=always`: see `lastFetchedAt`.
  const prefix = ['-c', 'core.logAllRefUpdates=always', 'fetch', '--no-tags', '--quiet', 'origin']
  if (baseBranch && /^[\w.\-/]+$/.test(baseBranch)) {
    const withBase = await git([
      ...prefix,
      head,
      `+refs/heads/${baseBranch}:refs/remotes/origin/${baseBranch}`
    ])
    if (withBase !== null) return true
  }
  return (await git([...prefix, head])) !== null
}

/**
 * The base to diff against, and whether it resolved at all.
 *
 * `origin/<base>` is preferred over the local branch of the same name: the PR is
 * proposed against the REMOTE's base, and on a repo the operator has not pulled
 * in a week the local branch is a different commit. Falling through to the local
 * branch keeps a repo with no remote-tracking refs working.
 *
 * `null` means REFUSE — the caller renders a stated reason instead of a diff.
 * The alternative (silently falling back to the repo default, which is what
 * `resolveBase` does for the local path) would render a confident diff against
 * a base the PR never named, and a wrong diff is worse than no diff (AC-4).
 */
export async function resolvePrBase(git: GitRun, baseBranch: string): Promise<string | null> {
  const wanted = baseBranch.trim()
  if (!wanted) return null
  for (const candidate of [`origin/${wanted}`, wanted]) {
    if (await resolveCommit(git, candidate)) return candidate
  }
  return null
}

/** What {@link resolvePrHead} needs to know about the PR, from `gh pr list`. */
export interface PrHeadInput {
  number: number
  /** The BARE `headRefName`. */
  headRefName: string
  baseRefName: string
  /** `headRefOid` — the PR's current head SHA, when `gh` could tell us. */
  headOid: string | null
}

/**
 * Resolve the head of a foreign PR: fetch it when asked, then report what is
 * actually readable.
 *
 * `fetch` is false on OPEN and true only on the explicit refresh gesture. The
 * pane is offline-first by design (git-only evidence is a first-class state, not
 * an error), and going to the network because a view was opened is exactly the
 * implicit-cost behaviour that premise rules out.
 */
export async function resolvePrHead(
  git: GitRun,
  pr: PrHeadInput,
  opts: { fetch: boolean }
): Promise<ReviewHead> {
  const ref = localPrRef(pr.number)
  const head: ReviewHead = {
    kind: 'pr',
    name: pr.headRefName,
    ref,
    sha: null,
    state: 'not-fetched',
    prNumber: pr.number,
    freshness: 'unknown',
    fetchedAt: null,
    fetchFailed: false
  }
  if (!validPrNumber(pr.number)) return { ...head, state: 'fetch-failed' }

  if (opts.fetch) head.fetchFailed = !(await fetchPrHead(git, pr.number, pr.baseRefName))

  const localOid = await resolveCommit(git, ref)
  if (!localOid) {
    // A fetch that FAILED is a different fact from having nothing to fetch
    // (AC-7): one says "try again / check the network", the other says "press
    // refresh". Collapsing them would make an offline machine look like a repo
    // with nothing in it.
    head.state = head.fetchFailed ? 'fetch-failed' : 'not-fetched'
    return head
  }

  head.state = 'ready'
  // The commit the mutable ref currently points at, kept rather than discarded:
  // it is the only immutable name for what is on screen (T244 AC-6 / T247).
  head.sha = localOid
  head.fetchedAt = await lastFetchedAt(git, ref)
  head.freshness = pr.headOid ? (pr.headOid === localOid ? 'current' : 'moved') : 'unknown'
  return head
}

/**
 * Freshness for a head that IS the folder's own branch.
 *
 * Same comparison, deliberately a different sentence downstream: when a local
 * branch differs from `headRefOid` it is the operator who moved, not the PR, and
 * "the PR has moved since you fetched" would be a confident lie about which side
 * is stale.
 */
export async function localHeadState(
  git: GitRun,
  branch: string,
  headOid: string | null
): Promise<{ sha: string | null; freshness: HeadFreshness }> {
  const local = await resolveCommit(git, branch)
  if (!headOid || !local) return { sha: local, freshness: 'unknown' }
  return { sha: local, freshness: local === headOid ? 'current' : 'moved' }
}

/**
 * {@link localHeadState}'s freshness half, for callers that do not want the SHA.
 * One `rev-parse` either way — the two answers come from the same resolution, so
 * they cannot drift apart.
 */
export async function localHeadFreshness(
  git: GitRun,
  branch: string,
  headOid: string | null
): Promise<HeadFreshness> {
  return (await localHeadState(git, branch, headOid)).freshness
}

/**
 * The repo's main worktree, given any folder inside it.
 *
 * `--git-common-dir` is the one path every linked worktree shares; its parent is
 * the main checkout. That checkout always exists (there is no PR card without a
 * known repo) and, unlike "whichever folder the canvas happened to be opened
 * from", it is the same answer every time — which is what makes the ref fetched
 * on one open findable on the next.
 *
 * A RELATIVE answer (`.git`) means `folder` already is the main worktree: git
 * only prints the common dir absolutely when asked, and an older git that
 * ignores `--path-format` must not silently resolve to the filesystem root.
 */
export function mainWorktreeFrom(gitCommonDir: string | null, folder: string): string {
  const dir = gitCommonDir?.trim() ?? ''
  const absolute = dir.startsWith('/') || /^[A-Za-z]:[\\/]/.test(dir)
  if (!absolute) return folder
  const cut = dir.replace(/[\\/]+$/, '').search(/[\\/][^\\/]*$/)
  return cut > 0 ? dir.slice(0, cut) : folder
}
