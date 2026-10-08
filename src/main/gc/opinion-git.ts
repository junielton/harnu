// The git facts of an advisor dossier, gathered so that a failure is never mistaken for an empty
// answer (design: workspace-gc §8, T444 delta 4). Every fact is `ok` or `error`: a diff that git could
// not produce is not "no difference", and a status that overflowed its buffer or timed out is not "no
// uncommitted files". Those two empty readings are exactly what the advisor takes as "safe", so an
// error is carried to the prompt and to the cache key as an error. Electron-free and read-only: the
// only git calls are `symbolic-ref`, `rev-parse`, `diff --stat` and `status --porcelain`.

/** `git -C <cwd> <args>`: resolves with stdout, rejects on a non-zero exit, a timeout or an overflow. */
export type GitRunner = (cwd: string, args: string[]) => Promise<string>

export type Gathered<T> = { ok: true; value: T } | { ok: false; reason: string }

const REASON_MAX = 160

const oneLine = (text: string): string => {
  const first = text.split('\n').find((l) => l.trim().length > 0) ?? ''
  const t = first.trim()
  return t.length > REASON_MAX ? `${t.slice(0, REASON_MAX - 1)}…` : t
}

/** A short, human reason for a failed git call: an overflow, a timeout, or git's own first line. */
export function describeGitError(err: unknown): string {
  if (typeof err === 'string') return oneLine(err) || 'git failed'
  const e = (err ?? {}) as {
    code?: unknown
    killed?: unknown
    signal?: unknown
    stderr?: unknown
    message?: unknown
  }
  const message = typeof e.message === 'string' ? e.message : ''
  if (e.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' || /maxBuffer/i.test(message)) {
    return 'git output too large'
  }
  if (e.killed === true || (typeof e.signal === 'string' && e.signal !== '')) return 'git timed out'
  const stderr = typeof e.stderr === 'string' ? oneLine(e.stderr) : ''
  return stderr || oneLine(message) || 'git failed'
}

const fail = (err: unknown): { ok: false; reason: string } => ({
  ok: false,
  reason: describeGitError(err)
})

/**
 * The branch a worktree is compared with, as a ref that exists: what `origin/HEAD` points at, else
 * `origin/main`, `origin/master`, `main`, `master`, the first of them that resolves to a commit. No
 * network (`ls-remote` is out). The item's own branch (and its `origin/` counterpart) is never a candidate:
 * an item on `main` compared with `main` would read as "no difference", the exact answer that means safe.
 * And no silent fallback: if none exists that is an error, so a repo
 * with a `master` default, a `remote add` without `set-head`, or no remote at all is handled, and a
 * repo with none of these is reported instead of being compared with a ref that is not there.
 */
export async function resolveDefaultRef(
  git: GitRunner,
  repoPath: string,
  ownBranch: string | null = null
): Promise<Gathered<string>> {
  const own = ownBranch ? new Set([ownBranch, `origin/${ownBranch}`]) : new Set<string>()
  const candidates: string[] = []
  try {
    const head = (
      await git(repoPath, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])
    ).trim()
    if (head && !own.has(head)) candidates.push(head)
  } catch {
    // origin/HEAD is simply not set: the other candidates cover it.
  }
  for (const ref of ['origin/main', 'origin/master', 'main', 'master']) {
    if (!candidates.includes(ref) && !own.has(ref)) candidates.push(ref)
  }
  for (const ref of candidates) {
    try {
      await git(repoPath, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])
      return { ok: true, value: ref }
    } catch {
      // not a ref here
    }
  }
  return {
    ok: false,
    reason: `no default branch found (tried ${candidates.join(', ')})`
  }
}

/** `git diff --stat` of the worktree's HEAD against the default branch. Empty output is a real "no difference". */
export async function gatherDiff(
  git: GitRunner,
  repoPath: string,
  path: string,
  ownBranch: string | null = null
): Promise<Gathered<string> & { ref?: string }> {
  const ref = await resolveDefaultRef(git, repoPath, ownBranch)
  if (!ref.ok) return ref
  try {
    return {
      ok: true,
      value: await git(path, ['diff', '--stat', '--stat-width=120', `${ref.value}...HEAD`]),
      ref: ref.value
    }
  } catch (err) {
    return fail(err)
  }
}

/** The head and the uncommitted files: what the cache key reads. Cheap, and each can fail on its own. */
export async function gatherKeyGit(
  git: GitRunner,
  path: string
): Promise<{ head: Gathered<string>; dirty: Gathered<string[]> }> {
  const [head, dirty] = await Promise.all([
    git(path, ['rev-parse', 'HEAD']).then(
      (out): Gathered<string> =>
        out.trim() ? { ok: true, value: out.trim() } : { ok: false, reason: 'no HEAD commit' },
      fail
    ),
    // `-unormal`: a repo's `status.showUntrackedFiles=no` must not hide untracked files from the advisor.
    git(path, ['status', '--porcelain', '-unormal']).then(
      (out): Gathered<string[]> => ({
        ok: true,
        value: out.split('\n').filter((l) => l.trim().length > 0)
      }),
      fail
    )
  ])
  return { head, dirty }
}
