import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  parseGithubRepo,
  parseOpenPrs,
  parseProtection,
  probeRemoteFacts,
  type RemoteRunners
} from '../src/main/gc/gc-remote-facts'
import {
  remoteDeleteRefusal,
  type RemoteFacts,
  type RemotePolicy
} from '../src/main/gc/gc-remote-delete'
import { createGcOps, type GcShellDeps } from '../src/main/gc/gc-shell'
import type { WorktreeBundle } from '../src/main/gc/bundle-core'
import type { ExecutorDeps } from '../src/main/reaper/executor-core'
import { bundle, NOW, reapItem } from './gc-fixtures'

/**
 * Delta-1 items 5, 6 and 7: a remote branch is shared state. It is offered, and deleted, only when
 * a MERGED pull request records the merge, no OPEN pull request uses the branch as head or base,
 * GitHub does not protect it, and the delete goes to the branch's own upstream remote (never
 * assumed to be `origin`) and only while the remote tip is the local tip or one of its ancestors.
 * Any answer Harnu could not get reads as "do not".
 */

const POLICY: RemotePolicy = { neverDeleteRemote: false, protectedBranches: ['main'] }
const GOOD: RemoteFacts = {
  remote: 'origin',
  remoteSha: 'a'.repeat(40),
  remoteMatchesLocal: true,
  openPr: false,
  ghProtected: false
}

function mergedBundle(over: Partial<WorktreeBundle> = {}, branch = 'feat/x'): WorktreeBundle {
  const b = bundle('/ws/wt/feat-x', 'ready')
  return {
    ...b,
    fate: { fate: 'merged', signal: 'gh-merged', strong: true },
    item: reapItem('/ws/wt/feat-x', { branch, needsRemoteDelete: true }),
    ...over
  }
}

describe('the rule, with the facts', () => {
  it('accepts a merged PR, no open PR, not protected, same tip', () => {
    expect(remoteDeleteRefusal(mergedBundle(), POLICY, GOOD)).toBeNull()
  })

  it.each([
    [
      'an open PR uses the branch (as head or as the base of a stacked one)',
      { openPr: true },
      'open-pr'
    ],
    ['GitHub protects it', { ghProtected: true }, 'github-protected'],
    ['the protection check failed', { ghProtected: null }, 'unverified'],
    ['the open-PR check failed (gh unavailable)', { openPr: null }, 'unverified'],
    ['no upstream remote is configured', { remote: null }, 'no-upstream'],
    ['the remote moved past the local tip', { remoteMatchesLocal: false }, 'remote-moved'],
    ['the remote tip could not be compared', { remoteMatchesLocal: null }, 'unverified']
  ] as const)('refuses when %s', (_why, over, code) => {
    expect(remoteDeleteRefusal(mergedBundle(), POLICY, { ...GOOD, ...over })).toBe(code)
  })

  it('refuses a branch that is merely an ancestor of main, with no merged PR (staging, release/x)', () => {
    const b = mergedBundle({ fate: { fate: 'merged', signal: 'ancestor', strong: true } })
    expect(remoteDeleteRefusal(b, POLICY, GOOD)).toBe('no-merged-pr')
  })

  it('refuses when nothing was verified at all', () => {
    expect(remoteDeleteRefusal(mergedBundle(), POLICY, null)).toBe('unverified')
    expect(remoteDeleteRefusal(mergedBundle(), POLICY, undefined)).toBe('unverified')
  })
})

describe('parsers', () => {
  it('parseGithubRepo reads https and ssh remotes, and nothing else', () => {
    expect(parseGithubRepo('https://github.com/acme/web.git')).toEqual({
      owner: 'acme',
      repo: 'web'
    })
    expect(parseGithubRepo('git@github.com:acme/web.git')).toEqual({ owner: 'acme', repo: 'web' })
    expect(parseGithubRepo('ssh://git@github.com/acme/web')).toEqual({ owner: 'acme', repo: 'web' })
    expect(parseGithubRepo('https://gitlab.com/acme/web.git')).toBeNull()
    expect(parseGithubRepo('/srv/git/origin.git')).toBeNull()
  })
  it('parseOpenPrs: head or base; a full page means the list is incomplete', () => {
    const rows = [
      { headRefName: 'feat/a', baseRefName: 'main' },
      { headRefName: 'feat/b', baseRefName: 'feat/x' }
    ]
    expect(parseOpenPrs(JSON.stringify(rows), 'feat/x', 200)).toBe(true)
    expect(parseOpenPrs(JSON.stringify(rows), 'feat/a', 200)).toBe(true)
    expect(parseOpenPrs(JSON.stringify(rows), 'feat/zzz', 200)).toBe(false)
    expect(parseOpenPrs(JSON.stringify(Array(200).fill(rows[0])), 'feat/zzz', 200)).toBeNull()
    expect(parseOpenPrs('not json', 'feat/x', 200)).toBeNull()
  })
  it('parseProtection: the branch flag or any active rule means protected', () => {
    expect(parseProtection('false', '[]')).toBe(false)
    expect(parseProtection('true', '[]')).toBe(true)
    expect(parseProtection('false', '[{"type":"deletion"}]')).toBe(true)
    expect(parseProtection('garbage', '[]')).toBeNull()
    expect(parseProtection('false', 'garbage')).toBeNull()
  })
})

describe('probeRemoteFacts with fake git and gh', () => {
  const TIP = 'a'.repeat(40)
  function runners(
    over: Partial<Record<string, string | Error>> = {}
  ): RemoteRunners & { calls: string[] } {
    const calls: string[] = []
    const answer = (key: string, dflt: string): string => {
      const v = over[key] ?? dflt
      if (v instanceof Error) throw v
      return v
    }
    return {
      calls,
      git: async (_repo, args) => {
        calls.push(`git ${args.join(' ')}`)
        if (args[0] === 'config') return answer('upstream', 'origin\n')
        if (args[0] === 'remote') return answer('url', 'git@github.com:acme/web.git\n')
        if (args[0] === 'ls-remote') return answer('lsremote', `${TIP}\trefs/heads/feat/x\n`)
        if (args[0] === 'merge-base') return answer('mergebase', '')
        throw new Error('unexpected git ' + args.join(' '))
      },
      gh: async (_repo, args) => {
        calls.push(`gh ${args.join(' ')}`)
        if (args[0] === 'pr') return answer('prs', '[]')
        if (args[1]?.includes('/rules/')) return answer('rules', '[]')
        return answer('branch', 'false\n')
      }
    }
  }
  const b = (): WorktreeBundle => mergedBundle({ localTip: TIP })

  it('reads the upstream remote, the live sha and the three checks', async () => {
    const r = runners()
    expect(await probeRemoteFacts(b(), r)).toEqual({
      remote: 'origin',
      remoteSha: TIP,
      remoteMatchesLocal: true,
      openPr: false,
      ghProtected: false
    })
    // The PR and protection checks name the repo of the upstream remote, not the cwd's default.
    expect(r.calls.find((c) => c.startsWith('gh pr'))).toContain('acme/web')
  })

  it('no upstream configured: no remote, and nothing else is asked of one', async () => {
    const f = await probeRemoteFacts(b(), runners({ upstream: new Error('exit 1') }))
    expect(f.remote).toBeNull()
    expect(f.remoteSha).toBeNull()
  })

  it('a remote tip that is behind the local tip still matches; one that is not an ancestor does not', async () => {
    const behind = await probeRemoteFacts(
      b(),
      runners({ lsremote: `${'b'.repeat(40)}\trefs/heads/feat/x\n` })
    )
    expect(behind.remoteMatchesLocal).toBe(true)
    const ahead = await probeRemoteFacts(
      b(),
      runners({
        lsremote: `${'c'.repeat(40)}\trefs/heads/feat/x\n`,
        mergebase: Object.assign(new Error('not ancestor'), { code: 1 })
      })
    )
    expect(ahead.remoteMatchesLocal).toBe(false)
    const unknown = await probeRemoteFacts(
      b(),
      runners({
        lsremote: `${'c'.repeat(40)}\trefs/heads/feat/x\n`,
        mergebase: Object.assign(new Error('bad object'), { code: 128 })
      })
    )
    expect(unknown.remoteMatchesLocal).toBeNull()
  })

  it('gh failing leaves both GitHub answers unknown, never "false"', async () => {
    const f = await probeRemoteFacts(
      b(),
      runners({ prs: new Error('gh: not logged in'), branch: new Error('gh down') })
    )
    expect(f.openPr).toBeNull()
    expect(f.ghProtected).toBeNull()
  })

  it('a remote that is not on GitHub leaves them unknown too', async () => {
    const f = await probeRemoteFacts(b(), runners({ url: '/srv/git/origin.git\n' }))
    expect(f.openPr).toBeNull()
    expect(f.ghProtected).toBeNull()
  })

  it('a branch with a dangerous name is never handed to a command line', async () => {
    const f = await probeRemoteFacts(mergedBundle({ localTip: TIP }, '--force'), runners())
    expect(f.remote).toBeNull()
  })
})

// ---- real git: the fork case -------------------------------------------------------------------------

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim()

describe('against real remotes (a fork upstream and a colleague’s same-named branch on origin)', () => {
  let root: string
  let repo: string
  let origin: string
  let fork: string
  const WT = '/ws/wt/feat-x'

  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), 'harnu-remote-facts-'))
    origin = path.join(root, 'origin.git')
    fork = path.join(root, 'fork.git')
    repo = path.join(root, 'repo')
    for (const r of [origin, fork]) {
      mkdirSync(r)
      execFileSync('git', ['init', '--bare', '-q', '-b', 'main', r])
    }
    mkdirSync(repo)
    execFileSync('git', ['init', '-q', '-b', 'main', repo])
    git(repo, 'config', 'user.email', 'a@b.c')
    git(repo, 'config', 'user.name', 'T')
    writeFileSync(path.join(repo, 'f.txt'), '1')
    git(repo, 'add', '.')
    git(repo, 'commit', '-q', '-m', 'one')
    git(repo, 'remote', 'add', 'origin', origin)
    git(repo, 'remote', 'add', 'fork', fork)
    git(repo, 'push', '-q', 'origin', 'main')
    // my branch, pushed to my fork, tracking it
    git(repo, 'checkout', '-q', '-b', 'feat/x')
    writeFileSync(path.join(repo, 'g.txt'), '2')
    git(repo, 'add', '.')
    git(repo, 'commit', '-q', '-m', 'mine')
    git(repo, 'push', '-q', '-u', 'fork', 'feat/x')
    // a colleague's branch of the same name on origin, different history
    git(repo, 'checkout', '-q', '--orphan', 'tmp')
    git(repo, 'rm', '-rfq', '.')
    writeFileSync(path.join(repo, 'h.txt'), '3')
    git(repo, 'add', '.')
    git(repo, 'commit', '-q', '-m', 'colleague')
    git(repo, 'push', '-q', 'origin', 'tmp:feat/x')
    git(repo, 'checkout', '-q', 'main')
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  const has = (remote: string): boolean =>
    git(remote, 'for-each-ref', '--format=%(refname:short)', 'refs/heads/feat/x') !== ''

  const real: RemoteRunners = {
    git: async (r, args) => execFileSync('git', ['-C', r, ...args], { encoding: 'utf8' }),
    gh: async (_r, args) =>
      args[0] === 'pr' ? '[]' : args[1]?.includes('/rules/') ? '[]' : 'false\n'
  }

  function shellDeps(tipOverride?: string): GcShellDeps {
    const executor: ExecutorDeps = {
      probeStatus: async () => ({ trackedDirty: false, untracked: [] }),
      hasUnpushed: async () => false,
      trash: async () => undefined,
      git: real.git,
      resolveSha: async (r, rev) => git(r, 'rev-parse', rev),
      archiveTip: async (_r, ref) => ref,
      archiveWip: async (_r, ref) => ref,
      detachSidebar: async () => undefined,
      canUnregister: async () => true,
      removeWorktreeAdmin: async () => true,
      appendTombstone: async () => undefined,
      now: () => NOW
    }
    return {
      executor,
      allowRemoteDelete: true,
      remotePolicy: async () => POLICY,
      // The real git facts; gh answers stay fake (no GitHub here), and the URL is not GitHub, so
      // the GitHub checks are supplied as already-verified.
      remoteFacts: async (b: WorktreeBundle) => ({
        ...(await probeRemoteFacts({ ...b, localTip: tipOverride ?? b.localTip }, real)),
        openPr: false,
        ghProtected: false
      })
    } as unknown as GcShellDeps
  }

  const bundleAt = (): WorktreeBundle => {
    const tip = git(repo, 'rev-parse', 'feat/x')
    const b = mergedBundle({ localTip: tip })
    return { ...b, item: { ...b.item, repoPath: repo, path: WT, remoteSha: tip } }
  }

  it('deletes the branch on the fork it tracks, and leaves the colleague’s on origin alone', async () => {
    const out = await createGcOps(shellDeps()).cleanGit(bundleAt(), { deleteRemote: true })
    expect(has(fork)).toBe(false)
    expect(has(origin)).toBe(true)
    expect(out).toEqual({ remoteDelete: { branch: 'feat/x', ok: true } })
  })

  it('deletes nothing anywhere when the branch tracks no remote', async () => {
    git(repo, 'branch', '--unset-upstream', 'feat/x')
    const out = await createGcOps(shellDeps()).cleanGit(bundleAt(), { deleteRemote: true })
    expect(has(fork)).toBe(true)
    expect(has(origin)).toBe(true)
    expect(out?.remoteDelete).toMatchObject({
      ok: false,
      error: expect.stringContaining('no-upstream')
    })
  })

  it('does not delete a remote branch that has moved past the local tip', async () => {
    const other = path.join(root, 'other')
    execFileSync('git', ['clone', '-q', fork, other])
    git(other, 'config', 'user.email', 'a@b.c')
    git(other, 'config', 'user.name', 'T')
    git(other, 'checkout', '-q', 'feat/x')
    writeFileSync(path.join(other, 'z.txt'), '4')
    git(other, 'add', '.')
    git(other, 'commit', '-q', '-m', 'someone pushed more')
    git(other, 'push', '-q', 'origin', 'feat/x')
    const out = await createGcOps(shellDeps()).cleanGit(bundleAt(), { deleteRemote: true })
    expect(has(fork)).toBe(true)
    expect(out?.remoteDelete).toMatchObject({
      ok: false,
      error: expect.stringContaining('remote-moved')
    })
  })
})
