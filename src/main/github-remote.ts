/**
 * Topbar "Pull requests on GitHub" — turns a folder's `origin` remote URL into
 * the repo's `https://github.com/<owner>/<repo>/pulls` page, or `null` when the
 * remote isn't on github.com. Pure (no Electron, no git) so it is unit-testable;
 * the IPC that reads the remote lives in `external.ts`.
 *
 * The URL is REBUILT from the parsed owner/repo, never derived from the remote
 * string itself, so credentials embedded in an https remote
 * (`https://user:token@github.com/…`) can never leak into the opened URL.
 *
 * Accepted shapes:
 * - `https://github.com/owner/repo(.git)` (also `http://`, `www.`, `user:token@`)
 * - `ssh://git@github.com(:22)/owner/repo(.git)`, `git://github.com/owner/repo.git`
 * - scp-like `git@github.com:owner/repo(.git)`
 * - ssh-config host aliases in the common multi-account form `github.com-<alias>`
 *   (`git@github.com-work:owner/repo.git`)
 */

const OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/
const REPO_RE = /^[A-Za-z0-9._-]+$/

function isGithubHost(host: string): boolean {
  const h = host.toLowerCase()
  return h === 'github.com' || h === 'www.github.com' || h.startsWith('github.com-')
}

export interface GithubRepoRef {
  owner: string
  repo: string
}

function repoFromPath(path: string): GithubRepoRef | null {
  const parts = path.replace(/^\/+/, '').replace(/\/+$/, '').split('/')
  if (parts.length !== 2) return null
  const owner = parts[0]
  const repo = parts[1].replace(/\.git$/i, '')
  if (!OWNER_RE.test(owner) || !REPO_RE.test(repo) || repo === '.' || repo === '..') return null
  return { owner, repo }
}

/**
 * `{ owner, repo }` of a github.com remote URL (any accepted shape above), or
 * `null`. Shared by the pulls-page builder and the PR-link matcher so both
 * agree on what "this repo" means.
 */
export function githubRepoFromRemote(remote: string): GithubRepoRef | null {
  const raw = remote.trim()
  if (!raw) return null

  // scp-like syntax: `[user@]host:path` — no scheme, and the colon comes before
  // any slash (otherwise it's a local path such as `/srv/a:b`).
  const scp = /^(?:[^@/\s]+@)?([^:/\s]+):(?!\/)(.+)$/.exec(raw)
  if (scp && !raw.includes('://')) {
    return isGithubHost(scp[1]) ? repoFromPath(scp[2]) : null
  }

  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return null
  }
  if (!['https:', 'http:', 'ssh:', 'git:', 'git+ssh:'].includes(url.protocol)) return null
  if (!isGithubHost(url.hostname)) return null
  return repoFromPath(url.pathname)
}

export function githubPullsUrlFromRemote(remote: string): string | null {
  const ref = githubRepoFromRemote(remote)
  return ref ? `https://github.com/${ref.owner}/${ref.repo}/pulls` : null
}

export interface GithubPrRef extends GithubRepoRef {
  number: number
}

/** Subpaths of a PR page that still identify the same PR. */
const PR_SUBPATHS = new Set(['files', 'commits', 'checks'])

/**
 * Parses a github.com pull-request page URL —
 * `https://github.com/<owner>/<repo>/pull/<n>` with an optional `/files`,
 * `/commits` or `/checks` tail, query and `#fragment` — into its parts, or
 * `null` for anything else (other hosts, `/pulls`, issues, non-positive or
 * non-integer numbers). Only `http(s)` and the plain `github.com` /
 * `www.github.com` hosts are accepted: a transcript URL is untrusted text.
 */
export function parseGithubPrUrl(raw: string): GithubPrRef | null {
  let url: URL
  try {
    url = new URL(raw.trim())
  } catch {
    return null
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
  const host = url.hostname.toLowerCase()
  if (host !== 'github.com' && host !== 'www.github.com') return null
  const parts = url.pathname.replace(/^\/+/, '').replace(/\/+$/, '').split('/')
  if (parts.length < 4 || parts.length > 5) return null
  const [owner, repo, kind, num, sub] = parts
  if (kind !== 'pull') return null
  if (sub !== undefined && !PR_SUBPATHS.has(sub)) return null
  if (!OWNER_RE.test(owner) || !REPO_RE.test(repo) || repo === '.' || repo === '..') return null
  if (!/^\d+$/.test(num)) return null
  const number = Number(num)
  if (!Number.isSafeInteger(number) || number <= 0) return null
  return { owner, repo, number }
}

/**
 * The PR number a transcript link points at, when (and only when) it is a PR
 * of THE SAME repo as `remote`. Owner/repo compare case-insensitively (GitHub
 * does). Pure: the IO shell in `pr-stack.ts` reads the remote and asks `gh`.
 */
export function matchPrLinkToRemote(remote: string, url: string): number | null {
  const repo = githubRepoFromRemote(remote)
  const pr = parseGithubPrUrl(url)
  if (!repo || !pr) return null
  if (repo.owner.toLowerCase() !== pr.owner.toLowerCase()) return null
  if (repo.repo.toLowerCase() !== pr.repo.toLowerCase()) return null
  return pr.number
}

/** True when `gh pr view --json state` stdout reports an OPEN pull request. */
export function isOpenPrViewJson(stdout: string): boolean {
  try {
    const parsed: unknown = JSON.parse(stdout)
    return (
      !!parsed && typeof parsed === 'object' && (parsed as Record<string, unknown>).state === 'OPEN'
    )
  } catch {
    return false
  }
}
