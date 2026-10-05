import { describe, it, expect } from 'vitest'
import {
  generateWorktreeMd,
  dirTemplateFor,
  type RepoProbe
} from '../src/main/worktree-md-generate'
import { resolveManifest } from '../src/main/worktree-manifest'

/** A zeroed probe — every heuristic off. Tests turn individual signals on. */
function baseProbe(overrides: Partial<RepoProbe> = {}): RepoProbe {
  return {
    repoName: 'acme',
    packageManager: null,
    hasPackageJson: false,
    hasComposer: false,
    hasEnv: false,
    hasEnvExample: false,
    envExampleName: null,
    hasNodeModules: false,
    hasVendor: false,
    defaultBranch: null,
    usesClaudeWorktrees: false,
    ...overrides
  }
}

/** Round-trip the generated markdown back through the READER (the whole point:
 *  a scaffolded manifest must parse to the recipe the heuristics intended, with
 *  ZERO warnings — a bare `seed:`/`setup:` with only comments would warn). */
function roundTrip(probe: RepoProbe, branch = 'feat/login') {
  const md = generateWorktreeMd(probe)
  return resolveManifest({ worktreeMd: md }, { branch, repo: probe.repoName })
}

describe('generateWorktreeMd — package-manager install command', () => {
  const cases: Array<[RepoProbe['packageManager'], string]> = [
    ['npm', 'npm ci'],
    ['pnpm', 'pnpm install --frozen-lockfile'],
    ['yarn', 'yarn install --frozen-lockfile'],
    ['bun', 'bun install --frozen-lockfile']
  ]
  for (const [pm, cmd] of cases) {
    it(`picks \`${cmd}\` for a ${pm} lockfile`, () => {
      const m = roundTrip(baseProbe({ packageManager: pm, hasPackageJson: true }))
      expect(m.setup).toEqual([cmd])
      expect(m.warnings).toEqual([])
    })
  }

  it('leaves the install commented when a package.json has no lockfile', () => {
    const probe = baseProbe({ hasPackageJson: true, packageManager: null })
    const md = generateWorktreeMd(probe)
    expect(md).toContain('#   - npm install')
    const m = resolveManifest({ worktreeMd: md }, { branch: 'x', repo: 'acme' })
    expect(m.setup).toEqual([]) // commented → default empty, no warning
    expect(m.warnings).toEqual([])
  })
})

describe('generateWorktreeMd — seed heuristics', () => {
  it('seeds a real .env via seed.copy', () => {
    const m = roundTrip(baseProbe({ hasEnv: true }))
    expect(m.seed.copy).toEqual(['.env'])
    expect(m.warnings).toEqual([])
  })

  it('offers node_modules as a COMMENTED seed.link (never active by default)', () => {
    const probe = baseProbe({ hasEnv: true, hasNodeModules: true })
    const md = generateWorktreeMd(probe)
    expect(md).toContain('# link: [node_modules/]')
    const m = resolveManifest({ worktreeMd: md }, { branch: 'x', repo: 'acme' })
    expect(m.seed.link).toEqual([]) // commented → never symlinked automatically
    expect(m.warnings).toEqual([])
  })

  it('keeps the whole seed block commented when there is no real .env', () => {
    const probe = baseProbe({ hasNodeModules: true }) // node_modules but no .env
    const md = generateWorktreeMd(probe)
    // The active `seed:` header must NOT appear (it would parse to null → warning).
    expect(md).not.toMatch(/^seed:/m)
    expect(md).toContain('# seed:')
    const m = roundTrip(probe)
    expect(m.seed).toEqual({ copy: [], link: [] })
    expect(m.warnings).toEqual([])
  })

  it('offers `cp .env.example .env` as a commented setup step when only a template exists', () => {
    const probe = baseProbe({ hasEnvExample: true, envExampleName: '.env.example' })
    const md = generateWorktreeMd(probe)
    expect(md).toContain('# setup:')
    expect(md).toContain('cp .env.example .env')
    const m = roundTrip(probe)
    expect(m.setup).toEqual([]) // still commented — never runs unreviewed
    expect(m.seed.copy).toEqual([]) // a template is not a secret to copy
    expect(m.warnings).toEqual([])
  })

  it('honours a .env.sample template name', () => {
    const probe = baseProbe({ hasEnvExample: true, envExampleName: '.env.sample' })
    expect(generateWorktreeMd(probe)).toContain('cp .env.sample .env')
  })
})

describe('generateWorktreeMd — dir convention', () => {
  it('defaults to a sibling worktrees dir', () => {
    expect(dirTemplateFor(baseProbe())).toBe('../{repo}-worktrees/{slug}')
    const m = roundTrip(baseProbe(), 'feat/login')
    expect(m.dir).toBe('../acme-worktrees/feat-login') // {slug}, dir-safe
    expect(m.dirExplicit).toBe(true)
  })

  it('matches an existing .claude/worktrees layout when detected', () => {
    const probe = baseProbe({ usesClaudeWorktrees: true })
    expect(dirTemplateFor(probe)).toBe('.claude/worktrees/{slug}')
    const m = roundTrip(probe, 'feat/login')
    expect(m.dir).toBe('.claude/worktrees/feat-login')
    expect(m.warnings).toEqual([])
  })
})

describe('generateWorktreeMd — from (default branch)', () => {
  it('sets `from` to a detected default branch', () => {
    expect(roundTrip(baseProbe({ defaultBranch: 'main' })).from).toBe('main')
    expect(roundTrip(baseProbe({ defaultBranch: 'master' })).from).toBe('master')
  })

  it('leaves `from` commented (→ HEAD) when no default branch was detected', () => {
    const md = generateWorktreeMd(baseProbe({ defaultBranch: null }))
    expect(md).toContain('# from: main')
    expect(md).not.toMatch(/^from:/m)
    expect(roundTrip(baseProbe({ defaultBranch: null })).from).toBe('HEAD')
  })
})

describe('generateWorktreeMd — PHP (composer)', () => {
  it('adds `composer install` and a commented vendor link', () => {
    const probe = baseProbe({
      hasComposer: true,
      hasVendor: true,
      hasEnv: true,
      defaultBranch: 'main'
    })
    const md = generateWorktreeMd(probe)
    expect(md).toContain('# link: [vendor/]')
    const m = roundTrip(probe)
    expect(m.setup).toEqual(['composer install'])
    expect(m.seed.copy).toEqual(['.env'])
    expect(m.warnings).toEqual([])
  })

  it('combines a JS install and composer install in order', () => {
    const probe = baseProbe({ packageManager: 'npm', hasPackageJson: true, hasComposer: true })
    expect(roundTrip(probe).setup).toEqual(['npm ci', 'composer install'])
  })
})

describe('generateWorktreeMd — always a clean, complete manifest', () => {
  it('the bare (nothing-detected) manifest still resolves with zero warnings', () => {
    const m = roundTrip(baseProbe())
    expect(m.source).toBe('worktree-md')
    expect(m.warnings).toEqual([])
    expect(m.setup).toEqual([])
    expect(m.seed).toEqual({ copy: [], link: [] })
  })

  it('documents all 7 keys and carries the repo name in the body', () => {
    const md = generateWorktreeMd(baseProbe({ repoName: 'my-app' }))
    expect(md).toContain('# Worktree setup — my-app')
    for (const key of ['dir', 'from', 'seed', 'setup', 'create', 'remove', 'boot']) {
      expect(md).toContain(key)
    }
    // The trust reminder must survive into the body.
    expect(md).toContain('Review, adjust, and commit it')
  })

  it('is deterministic — same probe in, identical markdown out', () => {
    const probe = baseProbe({
      packageManager: 'pnpm',
      hasPackageJson: true,
      hasEnv: true,
      defaultBranch: 'main'
    })
    expect(generateWorktreeMd(probe)).toBe(generateWorktreeMd(probe))
  })

  it('a realistic Node repo resolves to exactly the intended recipe', () => {
    const probe = baseProbe({
      repoName: 'harnu',
      packageManager: 'npm',
      hasPackageJson: true,
      hasEnv: true,
      hasNodeModules: true,
      defaultBranch: 'main',
      usesClaudeWorktrees: true
    })
    const m = roundTrip(probe, 'feat/t87')
    expect(m).toMatchObject({
      dir: '.claude/worktrees/feat-t87',
      from: 'main',
      setup: ['npm ci'],
      seed: { copy: ['.env'], link: [] },
      warnings: []
    })
  })
})
