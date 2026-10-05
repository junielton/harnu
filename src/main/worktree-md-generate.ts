/**
 * Pure heuristic generator for a scaffolded `WORKTREE.md` (T87 — the creator half
 * of the manifest substrate; the reader is {@link './worktree-manifest'.resolveManifest}).
 *
 * SIDE-EFFECT-FREE by contract (ADR-0001 pure-core / thin-shell): this module
 * never touches the filesystem or the network and never calls an LLM. The shell
 * (`worktree-md-ipc.ts`) probes the repo on disk and hands the findings in via
 * {@link RepoProbe}; this module turns them into a commented markdown proposal.
 *
 * Trust boundary (T87, non-negotiable): the output is a **PROPOSAL** the human
 * reviews and commits. A committed `WORKTREE.md` runs arbitrary shell at
 * worktree-create time, so Harnu never auto-writes + immediately executes a
 * generated manifest — the generated file opens in the markdown pane (T74) for
 * review, and the create-time confirm (`worktree-ipc.ts`) stays the runtime guard.
 *
 * Fidelity: the emitted front matter parses cleanly through {@link resolveManifest}
 * with **zero warnings** — only confidently-detected keys are active; everything
 * else is documented as a `#` comment so a bare `seed:`/`setup:` never degrades to
 * a null value (which the resolver would warn on).
 */

/** JS package managers we recognise from a lockfile → the frozen-install command. */
export type JsPackageManager = 'npm' | 'pnpm' | 'yarn' | 'bun'

/**
 * Deterministic findings the shell probed off disk. Every field maps to a manifest
 * decision (see the heuristics table in the T87 card / the `worktree-manifest`
 * skill). No field implies any I/O here — this is a plain value object.
 */
export interface RepoProbe {
  /** Repo directory basename — fills the `{repo}` token and the body heading. */
  repoName: string
  /** JS package manager from the lockfile flavour, or `null` if none/ambiguous. */
  packageManager: JsPackageManager | null
  /** A `package.json` exists at the repo root (Node project). */
  hasPackageJson: boolean
  /** A `composer.json` exists at the repo root (PHP project). */
  hasComposer: boolean
  /** A real `.env` exists at the repo root → `seed.copy: [.env]`. */
  hasEnv: boolean
  /** A `.env.example` / `.env.sample` template exists → optional `cp … .env`. */
  hasEnvExample: boolean
  /** The exact env-template filename found (`.env.example` vs `.env.sample`). */
  envExampleName: string | null
  /** `node_modules/` exists → a commented `seed.link` suggestion. */
  hasNodeModules: boolean
  /** `vendor/` exists (PHP deps materialised) → a commented `seed.link` suggestion. */
  hasVendor: boolean
  /** Default base branch (`main`/`master`/…) if detected, else `null` → `from`. */
  defaultBranch: string | null
  /** Repo already keeps worktrees under `.claude/worktrees/*` → the `dir` convention. */
  usesClaudeWorktrees: boolean
}

/** The frozen/CI install command for a detected package manager. */
function installCommand(pm: JsPackageManager): string {
  switch (pm) {
    case 'npm':
      return 'npm ci'
    case 'pnpm':
      return 'pnpm install --frozen-lockfile'
    case 'yarn':
      return 'yarn install --frozen-lockfile'
    case 'bun':
      return 'bun install --frozen-lockfile'
  }
}

/** The `dir` template that matches the repo's existing layout convention. */
export function dirTemplateFor(probe: RepoProbe): string {
  return probe.usesClaudeWorktrees ? '.claude/worktrees/{slug}' : '../{repo}-worktrees/{slug}'
}

/** A YAML inline list literal (`[a, b]`) or `[]` for the empty case. */
function inlineList(items: string[]): string {
  return items.length === 0 ? '[]' : `[${items.join(', ')}]`
}

/** Emit the `seed:` block — active when a real `.env` is copied, else fully commented. */
function seedSection(probe: RepoProbe): string[] {
  const linkSuggestions: string[] = []
  if (probe.hasNodeModules) linkSuggestions.push('node_modules/')
  if (probe.hasVendor) linkSuggestions.push('vendor/')

  const lines: string[] = []
  lines.push('# seed — files brought into each fresh worktree BEFORE the session starts.')

  if (probe.hasEnv) {
    lines.push(
      '#   copy = cp -a/--reflink (symlink-preserving); put real, gitignored files (.env) here.'
    )
    lines.push('seed:')
    lines.push(`  copy: ${inlineList(['.env'])}`)
    lines.push('  # link = symlink shared dirs in — cheap, but every worktree shares ONE tree,')
    lines.push(
      '  #        which is wrong the moment a branch changes deps. Prefer a `setup` install.'
    )
    if (linkSuggestions.length > 0) {
      lines.push(`  # link: ${inlineList(linkSuggestions)}`)
    }
    return lines
  }

  // No real .env → keep the whole block commented so it resolves to the default
  // (an active `seed:` with only commented children parses as null → resolver warns).
  lines.push(
    '#   copy = cp -a/--reflink (symlink-preserving); put real, gitignored files (.env) here.'
  )
  lines.push(
    '#   link = symlink shared dirs in — cheap, but shares ONE mutable tree across worktrees.'
  )
  lines.push('# seed:')
  lines.push('#   copy: [.env]')
  if (linkSuggestions.length > 0) {
    lines.push(`#   link: ${inlineList(linkSuggestions)}`)
  }
  return lines
}

/** Emit the `setup:` block — active when there is a confident install command. */
function setupSection(probe: RepoProbe): string[] {
  const active: string[] = []
  const commented: string[] = []

  if (probe.packageManager) {
    active.push(installCommand(probe.packageManager))
  } else if (probe.hasPackageJson) {
    commented.push('npm install   # no lockfile found — set your package manager + install command')
  }
  if (probe.hasComposer) active.push('composer install')
  if (probe.hasEnvExample && !probe.hasEnv) {
    commented.push(
      `cp ${probe.envExampleName ?? '.env.example'} .env   # generate a local .env from the template`
    )
  }

  const lines: string[] = []
  lines.push('# setup — commands run inside the fresh worktree, in order, non-interactively.')
  lines.push(
    '#         Disclosed VERBATIM in Harnu’s create-worktree confirm — keep them short + auditable.'
  )

  if (active.length > 0) {
    lines.push('setup:')
    for (const cmd of active) lines.push(`  - ${cmd}`)
    for (const cmd of commented) lines.push(`  # - ${cmd}`)
    return lines
  }

  // Nothing confident to run → comment the whole block (an all-commented list
  // parses as null and the resolver would warn on it).
  lines.push('# setup:')
  if (commented.length > 0) {
    for (const cmd of commented) lines.push(`#   - ${cmd}`)
  } else {
    lines.push('#   - echo "add your install/build steps here"')
  }
  return lines
}

/** Emit the `from:` line — active when a default branch was detected. */
function fromSection(probe: RepoProbe): string[] {
  const lines = ['# from — default base ref for new branches (branch, tag, or sha; kept verbatim).']
  if (probe.defaultBranch) {
    lines.push(`from: ${probe.defaultBranch}`)
  } else {
    lines.push('# from: main')
  }
  return lines
}

/** The human-readable body: what was detected + a compact key reference + reminders. */
function body(probe: RepoProbe): string[] {
  const detected: string[] = []
  if (probe.packageManager) {
    detected.push(
      `- **${probe.packageManager}** lockfile → \`${installCommand(probe.packageManager)}\` in \`setup\`.`
    )
  } else if (probe.hasPackageJson) {
    detected.push(
      '- `package.json` but no lockfile → install step left commented; pick your manager.'
    )
  }
  if (probe.hasComposer) detected.push('- `composer.json` → `composer install` in `setup`.')
  if (probe.hasEnv) detected.push('- `.env` present → seeded with `seed.copy` (real dev secrets).')
  else if (probe.hasEnvExample) {
    detected.push(
      `- \`${probe.envExampleName ?? '.env.example'}\` present → optional \`cp … .env\` left commented.`
    )
  }
  if (probe.hasNodeModules) {
    detected.push(
      '- `node_modules/` present → a `seed.link` shortcut is offered (commented — see caveat).'
    )
  }
  if (probe.hasVendor)
    detected.push('- `vendor/` present → a `seed.link` shortcut is offered (commented).')
  detected.push(
    `- \`dir\` set to \`${dirTemplateFor(probe)}\`${
      probe.usesClaudeWorktrees
        ? ' (matches this repo’s existing `.claude/worktrees/` layout).'
        : '.'
    }`
  )
  if (probe.defaultBranch) detected.push(`- Default branch \`${probe.defaultBranch}\` → \`from\`.`)

  const lines: string[] = []
  lines.push(`# Worktree setup — ${probe.repoName}`)
  lines.push('')
  lines.push(
    'Harnu scaffolded this manifest from what it found in the repo. **Review, adjust, and commit it** —'
  )
  lines.push(
    'it is trusted repo content (like a post-checkout hook) that runs its `setup` at worktree-create time.'
  )
  lines.push('')
  lines.push('## What Harnu detected')
  lines.push('')
  lines.push(...detected)
  lines.push('')
  lines.push('## The 7 keys')
  lines.push('')
  lines.push(
    '- **dir** — where worktrees are created, relative to the repo root. Tokens: `{repo}` `{branch}` `{slug}`.'
  )
  lines.push('- **from** — default base ref for new branches (branch, tag, or sha).')
  lines.push(
    '- **seed.copy / seed.link** — files copied (`cp -a`) or symlinked into each fresh worktree.'
  )
  lines.push(
    '- **setup** — commands run in the new worktree, in order (disclosed verbatim in the confirm).'
  )
  lines.push(
    '- **create / remove** — override the built-in `git worktree` flow (only if your repo has its own tooling).'
  )
  lines.push('- **boot** — defaults (`model`, `prompt`) for a session booted into these worktrees.')
  lines.push('')
  lines.push(
    '> **`seed.link` caveat.** Symlinking `node_modules/`/`vendor/` is instant but every worktree then'
  )
  lines.push(
    '> shares ONE dependency tree — wrong the moment a branch changes deps. Default to installing in'
  )
  lines.push(
    '> `setup` (correct per-branch); reach for `seed.link` only when speed matters and deps rarely move.'
  )
  return lines
}

/**
 * Build a scaffolded `WORKTREE.md` from deterministic repo findings. Pure: same
 * probe in → same markdown out. The result is a valid manifest (front matter +
 * body) that resolves through {@link resolveManifest} without warnings.
 */
export function generateWorktreeMd(probe: RepoProbe): string {
  const fm: string[] = []
  fm.push('---')
  fm.push('# dir — where worktrees are created, relative to the repo root.')
  fm.push('#   Tokens: {repo} (repo dir name), {branch} (raw ref), {slug} (dir-safe branch).')
  fm.push(`dir: ${dirTemplateFor(probe)}`)
  fm.push(...fromSection(probe))
  fm.push(...seedSection(probe))
  fm.push(...setupSection(probe))
  fm.push(
    '# create / remove — override the built-in git worktree flow (only if the repo has its own tooling).'
  )
  fm.push('# create: bin/worktree/new.sh {slug} {from}')
  fm.push('# remove: bin/worktree/rm.sh {slug}')
  fm.push('# boot — defaults for a session booted into these worktrees.')
  fm.push(
    '#   model = alias (sonnet/opus/haiku) or full id; prompt = boot template (quote a leading @).'
  )
  fm.push('# boot:')
  fm.push('#   model: sonnet')
  fm.push('#   prompt: "/resume-task {prd}"')
  fm.push('---')

  return `${fm.join('\n')}\n\n${body(probe).join('\n')}\n`
}
