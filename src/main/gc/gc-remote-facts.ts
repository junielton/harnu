// Finding out what the remote copy of a branch is before anything deletes it (delta-1 items 5-7).
// Pure parsers, plus `probeRemoteFacts` over injected `git` and `gh` runners; the real runners are
// bound in gc-remote-shell.ts. Every failure is a null answer, which the rule reads as "do not".

import type { WorktreeBundle } from './bundle-core'
import type { RemoteFacts } from './gc-remote-delete'

/** Whether a bundle's branch is a candidate for the remote delete at all: a merged PR's strong proof. */
export const isRemoteCandidate = (b: WorktreeBundle): boolean =>
  !!b.item.branch &&
  b.fate.fate === 'merged' &&
  b.fate.strong &&
  b.fate.signal === 'gh-merged' &&
  (b.bucket === 'ready' || b.bucket === 'review')

export interface RemoteRunners {
  /** `git -C <repo> <args>`; rejects on a non-zero exit (the error carries `code`). */
  git(repo: string, args: string[]): Promise<string>
  /** `gh <args>` run in `repo`; rejects when gh is absent, unauthenticated or fails. */
  gh(repo: string, args: string[]): Promise<string>
}

/** A branch name that can never be read as an option and holds no path tricks. */
export const SAFE_BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/
/** A remote name, the same way. */
export const SAFE_REMOTE = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/
const SHA = /^[0-9a-f]{40,64}$/

const OPEN_PR_LIMIT = 200

/** `owner/repo` of a GitHub remote URL (https, scp-like ssh or ssh://), or null for anything else. */
export function parseGithubRepo(url: string): { owner: string; repo: string } | null {
  const u = url.trim()
  const m =
    /^https?:\/\/(?:[^@/]+@)?github\.com\/([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(u) ??
    /^(?:ssh:\/\/)?git@github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(u)
  return m ? { owner: m[1]!, repo: m[2]! } : null
}

/**
 * Whether an open pull request has `branch` as head or base, from `gh pr list --json
 * headRefName,baseRefName`. A full page that does not name it is incomplete: null, not false.
 */
export function parseOpenPrs(
  stdout: string,
  branch: string,
  limit = OPEN_PR_LIMIT
): boolean | null {
  let rows: unknown
  try {
    rows = JSON.parse(stdout)
  } catch {
    return null
  }
  if (!Array.isArray(rows)) return null
  const hit = rows.some((r) => {
    const x = r as { headRefName?: unknown; baseRefName?: unknown }
    return x?.headRefName === branch || x?.baseRefName === branch
  })
  if (hit) return true
  return rows.length >= limit ? null : false
}

export interface OpenPrRefs {
  heads: string[]
  bases: string[]
}

/** The heads and bases of an open-PR list, or null when it is malformed or a full page (incomplete). */
export function parseOpenPrRefs(stdout: string, limit = OPEN_PR_LIMIT): OpenPrRefs | null {
  let rows: unknown
  try {
    rows = JSON.parse(stdout)
  } catch {
    return null
  }
  if (!Array.isArray(rows) || rows.length >= limit) return null
  const heads: string[] = []
  const bases: string[] = []
  for (const r of rows) {
    const x = r as { headRefName?: unknown; baseRefName?: unknown }
    if (typeof x?.headRefName !== 'string' || typeof x?.baseRefName !== 'string') return null
    heads.push(x.headRefName)
    bases.push(x.baseRefName)
  }
  return { heads, bases }
}

/**
 * The open pull requests out of the scanner's bulk PR list (its cache entry), when that list can
 * answer: it is fresh, current-version, not capped, and every open row carries its base. Otherwise
 * null, and the caller asks `gh` once for the repo.
 */
export function openPrRefsFromCache(
  entry: unknown,
  isFresh: boolean,
  version: number
): OpenPrRefs | null {
  const e = entry as { version?: unknown; complete?: unknown; prs?: unknown } | null
  if (!e || typeof e !== 'object' || !isFresh) return null
  if (e.version !== version || e.complete !== true || !Array.isArray(e.prs)) return null
  const heads: string[] = []
  const bases: string[] = []
  for (const r of e.prs) {
    const x = r as { state?: unknown; headRefName?: unknown; baseRefName?: unknown }
    if (x?.state !== 'OPEN') continue
    if (typeof x.headRefName !== 'string' || typeof x.baseRefName !== 'string') return null
    heads.push(x.headRefName)
    bases.push(x.baseRefName)
  }
  return { heads, bases }
}

export interface OpenPrListerDeps {
  now(): number
  /** The scanner's list for a repo, or null when it cannot answer. */
  fromScanner(repo: string): Promise<OpenPrRefs | null>
  /** `gh pr list --state open … --json headRefName,baseRefName` for a GitHub repo; rejects on failure. */
  list(repo: string, slug: string): Promise<string>
  ttlMs?: number
}

/**
 * "Does an open pull request use this branch as head or base?", answered from the scanner's bulk
 * list when it can, else from ONE `gh` list per GitHub repo (kept for ten minutes), never one per
 * branch. A failure is null ("could not tell") and is retried, not remembered.
 */
export function createOpenPrLister(
  deps: OpenPrListerDeps
): (repo: string, slug: string, branch: string) => Promise<boolean | null> {
  const ttl = deps.ttlMs ?? 10 * 60_000
  const lists = new Map<string, { at: number; refs: Promise<OpenPrRefs | null> }>()
  const has = (r: OpenPrRefs, branch: string): boolean =>
    r.heads.includes(branch) || r.bases.includes(branch)
  return async (repo, slug, branch) => {
    try {
      const scanned = await deps.fromScanner(repo)
      if (scanned) return has(scanned, branch)
    } catch {
      // fall through to gh
    }
    const known = lists.get(slug)
    let entry = known && deps.now() - known.at < ttl ? known : undefined
    if (!entry) {
      entry = {
        at: deps.now(),
        refs: deps
          .list(repo, slug)
          .then((out) => parseOpenPrRefs(out))
          .catch(() => null)
      }
      lists.set(slug, entry)
    }
    const refs = await entry.refs
    if (!refs) {
      // Not remembered: the next ask tries again.
      if (lists.get(slug) === entry) lists.delete(slug)
      return null
    }
    return has(refs, branch)
  }
}

/** GitHub protects the branch: the branch's own flag, or any active rule that applies to it. */
export function parseProtection(branchFlag: string, rules: string): boolean | null {
  const flag = branchFlag.trim()
  if (flag !== 'true' && flag !== 'false') return null
  let list: unknown
  try {
    list = JSON.parse(rules)
  } catch {
    return null
  }
  if (!Array.isArray(list)) return null
  return flag === 'true' || list.length > 0
}

/** The `gh` arguments for the open pull requests of a GitHub repo. */
export const openPrListArgs = (slug: string): string[] => [
  'pr',
  'list',
  '-R',
  slug,
  '--state',
  'open',
  '--limit',
  String(OPEN_PR_LIMIT),
  '--json',
  'headRefName,baseRefName'
]

const encodeRef = (branch: string): string => branch.split('/').map(encodeURIComponent).join('/')

const NONE: RemoteFacts = {
  remote: null,
  remoteSha: null,
  remoteMatchesLocal: null,
  openPr: null,
  ghProtected: null
}

/** What the remote holds of this bundle's branch right now. Never throws. */
export interface ProbeHooks {
  /** Answers "does an open PR use this branch?" from a shared list; absent means ask `gh` directly. */
  openPr?(repo: string, slug: string, branch: string): Promise<boolean | null>
}

export async function probeRemoteFacts(
  b: WorktreeBundle,
  r: RemoteRunners,
  hooks: ProbeHooks = {}
): Promise<RemoteFacts> {
  const branch = b.item.branch
  const repo = b.item.repoPath
  if (!branch || !SAFE_BRANCH.test(branch) || branch.includes('..')) return { ...NONE }
  const facts: RemoteFacts = { ...NONE }
  let remote = ''
  try {
    remote = (await r.git(repo, ['config', '--get', `branch.${branch}.remote`])).trim()
  } catch {
    // tracks nothing
  }
  if (!remote || remote === '.' || !SAFE_REMOTE.test(remote)) return facts
  facts.remote = remote

  try {
    const out = await r.git(repo, ['ls-remote', '--heads', remote, `refs/heads/${branch}`])
    const sha = out.trim().split(/\s+/)[0] ?? ''
    if (SHA.test(sha)) facts.remoteSha = sha
  } catch {
    // unreachable: stays unknown
  }
  const tip = b.localTip
  if (facts.remoteSha && typeof tip === 'string' && SHA.test(tip)) {
    if (facts.remoteSha === tip) {
      facts.remoteMatchesLocal = true
    } else {
      try {
        await r.git(repo, ['merge-base', '--is-ancestor', facts.remoteSha, tip])
        facts.remoteMatchesLocal = true
      } catch (err) {
        // `merge-base --is-ancestor` answers "no" with exit status 1. Any other failure is
        // either a remote commit this clone has never fetched (so it cannot be an ancestor of the
        // local tip: "no") or something we cannot tell (null).
        const exit = (e: unknown): unknown =>
          (e as { code?: unknown; status?: unknown })?.code ?? (e as { status?: unknown })?.status
        if (exit(err) === 1) {
          facts.remoteMatchesLocal = false
        } else {
          try {
            await r.git(repo, ['rev-parse', '--verify', '--quiet', `${facts.remoteSha}^{commit}`])
            facts.remoteMatchesLocal = null
          } catch (e2) {
            facts.remoteMatchesLocal = exit(e2) === 1 ? false : null
          }
        }
      }
    }
  }

  let gh: { owner: string; repo: string } | null = null
  try {
    gh = parseGithubRepo(await r.git(repo, ['remote', 'get-url', remote]))
  } catch {
    // no such remote
  }
  if (!gh) return facts
  const slug = `${gh.owner}/${gh.repo}`
  try {
    facts.openPr = hooks.openPr
      ? await hooks.openPr(repo, slug, branch)
      : parseOpenPrs(await r.gh(repo, openPrListArgs(slug)), branch)
  } catch {
    // gh unavailable: unknown
  }
  try {
    const [flag, rules] = await Promise.all([
      r.gh(repo, ['api', `repos/${slug}/branches/${encodeRef(branch)}`, '--jq', '.protected']),
      r.gh(repo, ['api', `repos/${slug}/rules/branches/${encodeRef(branch)}`])
    ])
    facts.ghProtected = parseProtection(flag, rules)
  } catch {
    // unknown
  }
  return facts
}
