// Finding out what the remote copy of a branch is before anything deletes it (delta-1 items 5-7).
// Pure parsers, plus `probeRemoteFacts` over injected `git` and `gh` runners; the real runners are
// bound in gc-remote-shell.ts. Every failure is a null answer, which the rule reads as "do not".

import type { WorktreeBundle } from './bundle-core'
import type { RemoteFacts } from './gc-remote-delete'

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

const encodeRef = (branch: string): string => branch.split('/').map(encodeURIComponent).join('/')

const NONE: RemoteFacts = {
  remote: null,
  remoteSha: null,
  remoteMatchesLocal: null,
  openPr: null,
  ghProtected: null
}

/** What the remote holds of this bundle's branch right now. Never throws. */
export async function probeRemoteFacts(b: WorktreeBundle, r: RemoteRunners): Promise<RemoteFacts> {
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
    facts.openPr = parseOpenPrs(
      await r.gh(repo, [
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
      ]),
      branch
    )
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
