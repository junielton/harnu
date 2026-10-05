import { describe, it, expect } from 'vitest'
import {
  buildWorktreeAddArgs,
  validateWorktreeRequest,
  chooseWorktreeAddSpec,
  resolveWorktreeBase,
  planWorktreeBase,
  remoteTrackingTarget,
  finalizeWorktreeBase,
  parseGitDirPair,
  validateResolvedBase,
  explicitBehindRemoteWarning,
  badExplicitBaseError,
  type WorktreeBasePlan
} from '../src/main/worktree-core'

const WT = '/home/u/repo/.claude/worktrees/feat-login'

describe('buildWorktreeAddArgs', () => {
  it('creates a new branch with -b <branch> <path> <baseRef>', () => {
    expect(
      buildWorktreeAddArgs({ kind: 'new-branch', branch: 'feat/login', path: WT, baseRef: 'main' })
    ).toEqual(['worktree', 'add', '-b', 'feat/login', WT, 'main'])
  })

  it('emits --no-track when the base is an implicitly-chosen remote ref (BUG-26)', () => {
    // Without --no-track, `branch.autoSetupMerge` would give the new branch `origin/main`
    // as its upstream, and a bare `git push` under push.default=simple then refuses.
    expect(
      buildWorktreeAddArgs({
        kind: 'new-branch',
        branch: 'feat/login',
        path: WT,
        baseRef: 'origin/main',
        noTrack: true
      })
    ).toEqual(['worktree', 'add', '--no-track', '-b', 'feat/login', WT, 'origin/main'])
  })

  it('checks out an existing branch with <path> <branch>', () => {
    expect(
      buildWorktreeAddArgs({ kind: 'existing-branch', branch: 'feat/login', path: WT })
    ).toEqual(['worktree', 'add', WT, 'feat/login'])
  })

  it('checks out a detached worktree with --detach <path> <baseRef>', () => {
    expect(buildWorktreeAddArgs({ kind: 'detached', path: WT, baseRef: 'abc1234' })).toEqual([
      'worktree',
      'add',
      '--detach',
      WT,
      'abc1234'
    ])
  })
})

describe('chooseWorktreeAddSpec (T44 S2 — checkout existing ref)', () => {
  const base = { branch: 'pr-123', path: WT, base: 'main' }

  it('no ref → new-branch from base (default create)', () => {
    expect(chooseWorktreeAddSpec(base)).toEqual({
      kind: 'new-branch',
      branch: 'pr-123',
      path: WT,
      baseRef: 'main'
    })
    // blank ref is treated as absent
    expect(chooseWorktreeAddSpec({ ...base, ref: '  ' }).kind).toBe('new-branch')
  })

  it('ref, not checked out elsewhere → existing-branch (DWIM local/remote)', () => {
    expect(chooseWorktreeAddSpec({ ...base, ref: 'feature/foo' })).toEqual({
      kind: 'existing-branch',
      branch: 'feature/foo',
      path: WT
    })
  })

  it('ref already checked out in another worktree → detached at the ref (BUG-6)', () => {
    expect(
      chooseWorktreeAddSpec({ ...base, ref: 'feature/foo', refCheckedOutElsewhere: true })
    ).toEqual({ kind: 'detached', path: WT, baseRef: 'feature/foo' })
  })

  it('the chosen spec round-trips through buildWorktreeAddArgs', () => {
    expect(buildWorktreeAddArgs(chooseWorktreeAddSpec({ ...base, ref: 'feature/foo' }))).toEqual([
      'worktree',
      'add',
      WT,
      'feature/foo'
    ])
  })
})

describe('resolveWorktreeBase (T64/BUG-12 — branch from the passed folder)', () => {
  it('pins the bare HEAD sentinel to the folder tip (the BUG-12 default)', () => {
    // No explicit base, manifest `from` at its default 'HEAD' → must pin to the
    // folder's own HEAD (resolved git-side), NOT the shared repo root's HEAD.
    expect(resolveWorktreeBase(undefined, 'HEAD')).toEqual({ base: 'HEAD', pinToFolderHead: true })
    expect(resolveWorktreeBase('', 'HEAD')).toEqual({ base: 'HEAD', pinToFolderHead: true })
    expect(resolveWorktreeBase('   ', 'HEAD')).toEqual({ base: 'HEAD', pinToFolderHead: true })
  })

  it('lets an explicit baseRef win and passes it through unpinned', () => {
    expect(resolveWorktreeBase('origin/main', 'HEAD')).toEqual({
      base: 'origin/main',
      pinToFolderHead: false
    })
    // explicit base trims and wins even over a named manifest `from`
    expect(resolveWorktreeBase('  release/2.0  ', 'develop')).toEqual({
      base: 'release/2.0',
      pinToFolderHead: false
    })
  })

  it('uses a named manifest `from` as-is (same commit from any worktree)', () => {
    expect(resolveWorktreeBase(undefined, 'main')).toEqual({ base: 'main', pinToFolderHead: false })
    expect(resolveWorktreeBase(undefined, '  develop  ')).toEqual({
      base: 'develop',
      pinToFolderHead: false
    })
  })

  it('treats a blank manifest `from` as the HEAD sentinel (pins to the folder)', () => {
    expect(resolveWorktreeBase(undefined, '')).toEqual({ base: 'HEAD', pinToFolderHead: true })
  })
})

/**
 * BUG-26. The scenario, taken verbatim from the live findings on the card:
 *
 * A long orchestration session runs for hours in the repo's PRIMARY worktree. Nobody
 * ever pulls there, so LOCAL `main` sits 6 commits behind `origin/main` (finding 1) —
 * and at the exact moment of one `create_worktree` call, ANOTHER Harnu session sharing
 * that same checkout had it mid-work on an unrelated feature branch, so `rev-parse HEAD`
 * returned that branch's tip (finding 3).
 *
 * This fake ref database models exactly that repo. It exists so the assertions below can
 * be about the COMMIT a worktree ends up on, not merely the ref string we hand to git.
 */
const REPO = {
  /** `origin/main` — 6 commits ahead of local `main`. The base we must land on. */
  originMainTip: '3c31816',
  /** local `main` — stale, never fast-forwarded (finding 1). */
  localMainTip: 'e5175a4',
  /** the unrelated `feat/file-explorer` tip the shared checkout happened to be on (finding 3). */
  sharedCheckoutHead: '19984f534d12bd2e3a80f363153462c8b047a532',
  /** a linked worktree's own tip — the legitimate T64 stacking base. */
  linkedWorktreeHead: 'aa11bb22',
  /** the tip of a sibling feature branch this card lets a caller explicitly stack on. */
  stackedParentTip: 'ff99ee88'
} as const

const REMOTES = ['origin']

/** Resolve a ref the way git would in the repo above. */
function revParse(ref: string): string {
  const table: Record<string, string> = {
    'origin/main': REPO.originMainTip,
    main: REPO.localMainTip,
    'origin/develop': 'dd44ee55',
    'stacked-parent-branch': REPO.stackedParentTip
  }
  return table[ref] ?? ref
}

/**
 * The `worktree-ipc` shell, in miniature: probe → finalize. `folderHead` is whatever
 * `git -C <folder> rev-parse HEAD` would return for the folder being branched FROM.
 */
function resolveBase(
  plan: WorktreeBasePlan,
  env: { folderHead: string | null; remotes?: readonly string[]; defaultBranch?: string | null }
): { base: string; commit: string; remoteTracked: boolean; warning?: string } {
  const remotes = env.remotes ?? REMOTES
  const name =
    plan.kind === 'named'
      ? plan.name
      : plan.kind === 'remote-default'
        ? (env.defaultBranch ?? null)
        : null
  // Mirror the shell: it picks `origin`, else the repo's only remote, and passes that
  // through as the preferred remote (worktree-ipc `probeWorktreeBase`).
  const primaryRemote = remotes.includes('origin') ? 'origin' : remotes[0]
  const target = name ? remoteTrackingTarget(name, remotes, primaryRemote) : null
  // Stand in for the shell's `fetch` + `rev-parse --verify`: the tracking ref resolves
  // only when it actually exists in the repo above.
  const remoteRef =
    target && revParse(target.trackingRef) !== target.trackingRef ? target.trackingRef : null

  const resolved = finalizeWorktreeBase(plan, { remoteRef, folderHead: env.folderHead })
  return { ...resolved, commit: revParse(resolved.base) }
}

describe('planWorktreeBase (BUG-26 — deterministic base, not the shared checkout)', () => {
  it('routes a bare manifest `from` to the remote, not the local branch tip', () => {
    expect(planWorktreeBase(undefined, 'main', { folderIsPrimaryWorktree: true })).toEqual({
      kind: 'named',
      name: 'main'
    })
  })

  it('routes the HEAD sentinel in the SHARED primary worktree to the remote default', () => {
    // This is the finding-3 path: the primary checkout's HEAD is transient state that a
    // concurrent session can move under us, so it must not decide the base at all.
    expect(planWorktreeBase(undefined, 'HEAD', { folderIsPrimaryWorktree: true })).toEqual({
      kind: 'remote-default'
    })
  })

  it('keeps pinning the HEAD sentinel to a LINKED worktree tip (T64 stacking survives)', () => {
    expect(planWorktreeBase(undefined, 'HEAD', { folderIsPrimaryWorktree: false })).toEqual({
      kind: 'folder-head'
    })
  })

  it('lets an explicit baseRef through untouched — no remote resolution at all', () => {
    // The PR-review flow says exactly what it wants; BUG-26 must not reinterpret it.
    expect(planWorktreeBase('pr-branch', 'main', { folderIsPrimaryWorktree: true })).toEqual({
      kind: 'explicit',
      base: 'pr-branch'
    })
    expect(planWorktreeBase('  abc1234  ', 'HEAD', { folderIsPrimaryWorktree: false })).toEqual({
      kind: 'explicit',
      base: 'abc1234'
    })
  })
})

describe('remoteTrackingTarget (BUG-26 — which ref to fetch)', () => {
  it('maps a bare branch name onto origin', () => {
    expect(remoteTrackingTarget('main', REMOTES)).toEqual({
      remote: 'origin',
      branch: 'main',
      trackingRef: 'origin/main'
    })
  })

  it('recognizes an already-remote-qualified name and still freshens it', () => {
    // `origin/main` on disk goes stale exactly like local `main` does — it is worth a fetch.
    expect(remoteTrackingTarget('origin/main', REMOTES)).toEqual({
      remote: 'origin',
      branch: 'main',
      trackingRef: 'origin/main'
    })
  })

  it('keeps a slashed BRANCH name (not a remote prefix) under origin', () => {
    expect(remoteTrackingTarget('release/2.0', REMOTES)).toEqual({
      remote: 'origin',
      branch: 'release/2.0',
      trackingRef: 'origin/release/2.0'
    })
  })

  it('honors a non-origin remote when it is the one named', () => {
    expect(remoteTrackingTarget('upstream/main', ['origin', 'upstream'])).toEqual({
      remote: 'upstream',
      branch: 'main',
      trackingRef: 'upstream/main'
    })
  })

  it('returns null for a SHA (already one immutable commit) and for a remote-less repo', () => {
    expect(remoteTrackingTarget('19984f534d12bd2e3a80f363153462c8b047a532', REMOTES)).toBeNull()
    expect(remoteTrackingTarget('main', [])).toBeNull()
  })

  it('resolves against the repo’s only remote even when it is not called origin', () => {
    // A fork whose remote is `upstream` must still get a deterministic base, not degrade.
    expect(remoteTrackingTarget('main', ['upstream'], 'upstream')).toEqual({
      remote: 'upstream',
      branch: 'main',
      trackingRef: 'upstream/main'
    })
    // …but with no preferred remote passed, a repo without `origin` has nothing to map to.
    expect(remoteTrackingTarget('main', ['upstream'])).toBeNull()
  })
})

describe('BUG-26 end to end — the base a worktree is actually cut from', () => {
  it('`from: main` in the stale primary worktree lands on origin/main, NOT local main', () => {
    const plan = planWorktreeBase(undefined, 'main', { folderIsPrimaryWorktree: true })
    const got = resolveBase(plan, { folderHead: REPO.sharedCheckoutHead })

    expect(got.base).toBe('origin/main')
    expect(got.commit).toBe(REPO.originMainTip)
    // The whole bug, asserted negatively: not the 6-commits-stale local tip…
    expect(got.commit).not.toBe(REPO.localMainTip)
    // …and not whatever the shared checkout happened to be sitting on.
    expect(got.commit).not.toBe(REPO.sharedCheckoutHead)
    expect(got.remoteTracked).toBe(true)
    expect(got.warning).toBeUndefined()
  })

  it('the HEAD sentinel cannot be poisoned by a concurrent session in the shared checkout', () => {
    // Finding 3: another Harnu session had the primary worktree mid-work on an unrelated
    // branch. Before the fix the new worktree was cut from THAT tip. It must not be
    // reachable from this path at all now.
    const plan = planWorktreeBase(undefined, 'HEAD', { folderIsPrimaryWorktree: true })
    const got = resolveBase(plan, {
      folderHead: REPO.sharedCheckoutHead,
      defaultBranch: 'main'
    })

    expect(got.base).toBe('origin/main')
    expect(got.commit).toBe(REPO.originMainTip)
    expect(got.commit).not.toBe(REPO.sharedCheckoutHead)
  })

  it('stacking on a linked worktree still cuts from that worktree tip (T64 not regressed)', () => {
    const plan = planWorktreeBase(undefined, 'HEAD', { folderIsPrimaryWorktree: false })
    const got = resolveBase(plan, { folderHead: REPO.linkedWorktreeHead })

    expect(got.base).toBe(REPO.linkedWorktreeHead)
    expect(got.remoteTracked).toBe(false)
  })

  it('an explicit baseRef is cut from exactly what the caller named (PR review unchanged)', () => {
    const plan = planWorktreeBase('feat/some-pr', 'main', { folderIsPrimaryWorktree: true })
    const got = resolveBase(plan, { folderHead: REPO.sharedCheckoutHead })

    expect(got.base).toBe('feat/some-pr')
    // Not re-pointed at origin, and no --no-track: git's normal tracking behavior stands.
    expect(got.remoteTracked).toBe(false)
    expect(got.warning).toBeUndefined()
  })

  it('degrades to the literal local name — with a warning — when there is no remote', () => {
    // Offline / remote-less repo: a worktree must still be created, but the operator is
    // told the base may be stale rather than silently re-living the bug.
    const plan = planWorktreeBase(undefined, 'main', { folderIsPrimaryWorktree: true })
    const got = resolveBase(plan, { folderHead: REPO.sharedCheckoutHead, remotes: [] })

    expect(got.base).toBe('main')
    expect(got.remoteTracked).toBe(false)
    expect(got.warning).toMatch(/stale/i)
  })

  it('degrades the remote default to the folder HEAD — with a warning — when unresolvable', () => {
    const plan = planWorktreeBase(undefined, 'HEAD', { folderIsPrimaryWorktree: true })
    const got = resolveBase(plan, { folderHead: REPO.sharedCheckoutHead, defaultBranch: null })

    expect(got.base).toBe(REPO.sharedCheckoutHead)
    expect(got.warning).toMatch(/shared/i)
  })

  it('falls back to the HEAD sentinel when even the folder HEAD cannot be read', () => {
    const primary = planWorktreeBase(undefined, 'HEAD', { folderIsPrimaryWorktree: true })
    expect(resolveBase(primary, { folderHead: null, defaultBranch: null }).base).toBe('HEAD')

    const linked = planWorktreeBase(undefined, 'HEAD', { folderIsPrimaryWorktree: false })
    expect(resolveBase(linked, { folderHead: null }).base).toBe('HEAD')
  })

  it('a non-default manifest `from` (develop) also resolves against the remote', () => {
    const plan = planWorktreeBase(undefined, 'develop', { folderIsPrimaryWorktree: true })
    const got = resolveBase(plan, { folderHead: REPO.sharedCheckoutHead })

    expect(got.base).toBe('origin/develop')
    expect(got.commit).toBe('dd44ee55')
  })

  it('warns when it overrides the line of development the checkout is actually on', () => {
    // Release-line workflow: the operator keeps the main checkout on `develop`. With no
    // explicit base we still (deterministically) cut from `origin/main` — correct, but it
    // must not be SILENT, or they discover it at PR time.
    const plan = planWorktreeBase(undefined, 'HEAD', { folderIsPrimaryWorktree: true })
    const got = finalizeWorktreeBase(plan, {
      remoteRef: 'origin/main',
      folderHead: null,
      folderBranch: 'develop'
    })

    expect(got.base).toBe('origin/main')
    expect(got.warning).toMatch(/develop/)
  })

  it('stays quiet when the remote default IS the branch the checkout is on', () => {
    const plan = planWorktreeBase(undefined, 'HEAD', { folderIsPrimaryWorktree: true })
    expect(
      finalizeWorktreeBase(plan, {
        remoteRef: 'origin/main',
        folderHead: null,
        folderBranch: 'main'
      }).warning
    ).toBeUndefined()
    // Detached HEAD has no branch to compare against — nothing to warn about.
    expect(
      finalizeWorktreeBase(plan, {
        remoteRef: 'origin/main',
        folderHead: null,
        folderBranch: 'HEAD'
      }).warning
    ).toBeUndefined()
  })
})

describe('create_worktree explicit `base` (this card — stacking one branch on another)', () => {
  it('a stacked base resolves to exactly the parent branch tip, not origin/main', () => {
    // The regression this card fixes: `create_worktree({ base: <parent branch> })` must
    // land the new worktree on the PARENT's tip, never silently on origin/main.
    const plan = planWorktreeBase('stacked-parent-branch', 'main', {
      folderIsPrimaryWorktree: true
    })
    const got = resolveBase(plan, { folderHead: REPO.sharedCheckoutHead })

    expect(got.base).toBe('stacked-parent-branch')
    expect(got.commit).toBe(REPO.stackedParentTip)
    expect(got.commit).not.toBe(REPO.originMainTip)
    expect(got.remoteTracked).toBe(false)
  })

  it('finalizeWorktreeBase warns (not refuses) when the explicit base trails its remote', () => {
    const plan: WorktreeBasePlan = { kind: 'explicit', base: 'feat/stacked' }
    const got = finalizeWorktreeBase(plan, {
      remoteRef: null,
      folderHead: null,
      explicitBehindRemote: { aheadCount: 3, upstream: 'origin/feat/stacked' }
    })

    expect(got.base).toBe('feat/stacked') // still cuts from the named base
    expect(got.remoteTracked).toBe(false)
    expect(got.warning).toMatch(/3 commit/)
    expect(got.warning).toMatch(/origin\/feat\/stacked/)
  })

  it('finalizeWorktreeBase stays quiet when the explicit base has no behind-remote probe', () => {
    const plan: WorktreeBasePlan = { kind: 'explicit', base: 'feat/stacked' }
    expect(
      finalizeWorktreeBase(plan, { remoteRef: null, folderHead: null }).warning
    ).toBeUndefined()
    expect(
      finalizeWorktreeBase(plan, {
        remoteRef: null,
        folderHead: null,
        explicitBehindRemote: null
      }).warning
    ).toBeUndefined()
  })

  it('explicitBehindRemoteWarning names the base, the count, and the upstream', () => {
    const msg = explicitBehindRemoteWarning('feat/stacked', {
      aheadCount: 2,
      upstream: 'origin/feat/stacked'
    })
    expect(msg).toContain('feat/stacked')
    expect(msg).toContain('2 commit')
    expect(msg).toContain('origin/feat/stacked')
  })

  it('badExplicitBaseError names the missing ref and is not a silent fallback', () => {
    // Acceptance criterion: a non-existent base is a loud, steerable error — this is
    // the message text the agent actually sees, never a quiet substitution of main.
    expect(badExplicitBaseError('no/such/ref')).toBe(
      'BAD_BASE: base ref "no/such/ref" does not exist'
    )
  })
})

describe('parseGitDirPair (BUG-26 — the probe that decides primary vs linked)', () => {
  it('reads the pair, primary (relative) and linked (absolute) alike', () => {
    expect(parseGitDirPair('.git\n.git\n')).toEqual({ gitDir: '.git', commonDir: '.git' })
    expect(parseGitDirPair('/r/.git/worktrees/x\n/r/.git\n')).toEqual({
      gitDir: '/r/.git/worktrees/x',
      commonDir: '/r/.git'
    })
    expect(parseGitDirPair('.git\r\n.git\r\n')).toEqual({ gitDir: '.git', commonDir: '.git' })
  })

  it('rejects the OLD-GIT ECHO of an unsupported flag instead of reading it as a path', () => {
    // The trap this function exists for: `git rev-parse` does not FAIL on an unknown
    // option — it echoes it and exits 0. On git < 2.31 (Ubuntu 20.04, Debian 11), asking
    // for `--path-format=absolute` therefore yields THREE lines, and a naive parse reads
    // the flag as the git-dir, decides "primary != common → linked worktree", and falls
    // right back onto the shared-checkout HEAD that BUG-26 is about. Must be a hard null.
    expect(parseGitDirPair('--path-format=absolute\n/r/.git\n/r/.git\n')).toBeNull()
    // …and a flag echoed into a two-line result must not be mistaken for a path either.
    expect(parseGitDirPair('--path-format=absolute\n/r/.git\n')).toBeNull()
  })

  it('rejects anything that is not exactly two paths (caller then fails OPEN)', () => {
    expect(parseGitDirPair('')).toBeNull()
    expect(parseGitDirPair('.git\n')).toBeNull()
  })
})

describe('validateResolvedBase (BUG-26 — the manifest `from` never had a validator)', () => {
  it('accepts the refs a base legitimately takes', () => {
    for (const ok of ['main', 'origin/main', 'release/2.0', '19984f5', 'HEAD', 'v1.2^{commit}']) {
      expect(validateResolvedBase(ok)).toEqual({ ok: true })
    }
  })

  it('rejects a base git would parse as an OPTION (`WORKTREE.md` is not always ours)', () => {
    // `from` lands in the last argv slot of `git worktree add`, which reads a leading-dash
    // positional as a flag — and Harnu opens whatever repo the user points it at.
    expect(validateResolvedBase('--upload-pack=evil').ok).toBe(false)
    expect(validateResolvedBase('-f').ok).toBe(false)
    expect(validateResolvedBase('').ok).toBe(false)
    expect(validateResolvedBase('main;rm -rf /').ok).toBe(false)
  })
})

describe('validateWorktreeRequest', () => {
  const root = '/home/u/repo'

  it('accepts a clean branch + baseRef', () => {
    expect(validateWorktreeRequest({ root, branch: 'feat/login', baseRef: 'main' })).toEqual({
      ok: true
    })
  })

  it('accepts an explicit path that stays inside the worktrees root', () => {
    expect(
      validateWorktreeRequest({ root, branch: 'feat/login', explicitPath: 'custom-dir' }).ok
    ).toBe(true)
  })

  it('rejects a branch containing a semicolon', () => {
    expect(validateWorktreeRequest({ root, branch: 'feat;rm -rf' }).ok).toBe(false)
  })

  it('rejects a branch containing a space', () => {
    expect(validateWorktreeRequest({ root, branch: 'feat login' }).ok).toBe(false)
  })

  it('rejects a branch containing ".."', () => {
    expect(validateWorktreeRequest({ root, branch: 'feat/../etc' }).ok).toBe(false)
  })

  it('rejects a branch that starts with "-" (argv injection)', () => {
    expect(validateWorktreeRequest({ root, branch: '-force' }).ok).toBe(false)
  })

  it('rejects a baseRef that starts with "-" (argv injection)', () => {
    expect(
      validateWorktreeRequest({ root, branch: 'feat/login', baseRef: '--upload-pack=evil' }).ok
    ).toBe(false)
  })

  it('accepts a clean ref (T44 S2), incl. remote-style and rev syntax', () => {
    expect(validateWorktreeRequest({ root, branch: 'pr-123', ref: 'feature/foo' }).ok).toBe(true)
    expect(validateWorktreeRequest({ root, branch: 'pr-123', ref: 'origin/feature/foo' }).ok).toBe(
      true
    )
  })

  it('rejects a ref that starts with "-", contains "..", or has bad chars', () => {
    expect(validateWorktreeRequest({ root, branch: 'pr-123', ref: '--upload-pack=evil' }).ok).toBe(
      false
    )
    expect(validateWorktreeRequest({ root, branch: 'pr-123', ref: 'a..b' }).ok).toBe(false)
    expect(validateWorktreeRequest({ root, branch: 'pr-123', ref: 'foo bar' }).ok).toBe(false)
  })

  it('rejects an explicit path that traverses outside the worktrees root', () => {
    expect(
      validateWorktreeRequest({ root, branch: 'feat/login', explicitPath: '../../../etc/cron.d' })
        .ok
    ).toBe(false)
  })

  it('rejects an empty branch', () => {
    expect(validateWorktreeRequest({ root, branch: '   ' }).ok).toBe(false)
  })
})
