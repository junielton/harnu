/**
 * T217 — bundled skills: the PURE core.
 *
 * Everything in this module is plain data in / plain data out, so the rules that
 * actually decide what a session can see are unit-testable without Electron
 * (ADR-0001 pure-core / thin-shell). The env-bound half — reading
 * `resources/skills/`, staging into `<userData>`, the `~/.claude` writes — lives
 * in `bundled-skills.ts`.
 *
 * The three decisions that matter, all here:
 *  - {@link parseSkillFrontmatter} — a `SKILL.md`'s `name` + `description`, with
 *    PER-ENTRY fail-soft: a malformed file drops THAT skill, never the catalog
 *    (same posture as `contributes.themes` / `contributes.modes`, T138).
 *  - {@link resolveSkillEnabled} — the tri-state cascade `folder ?? global ?? false`.
 *    Default OFF is the product rule (spec §4.2): a skill silently added to a
 *    session's catalog changes model behaviour without consent.
 *  - {@link insertPluginDirArg} — the argv step. An EMPTY enabled set emits NO
 *    `--plugin-dir` at all, which is what makes AC-2's negative half true by
 *    construction rather than by prompt discipline.
 */

import { createHash } from 'node:crypto'
import yaml from 'js-yaml'

import { insertOptionArgs, splitOptionArgs } from './claude-args'

/** One catalog entry, as the panel renders it and the CLI sees it. */
export interface BundledSkill {
  /** Directory name under `skills/`, and the CLI's skill id (`harnu:<name>`). */
  name: string
  /** The `SKILL.md` frontmatter description — model-facing trigger text AND the
   *  panel's one-line purpose. One source of truth, never i18n'd (spec §3.1). */
  description: string
}

/** Per-skill boolean map. A MISSING key means "not set" (inherit / default). */
export type SkillFlags = Record<string, boolean | undefined>

/** On-disk schema for `<userData>/bundled-skills.json` (spec §4.1). */
export interface BundledSkillsPrefs {
  version: 1
  /** Global per-skill on/off. Missing key ⇒ OFF (spec §4.2). */
  enabled: SkillFlags
  /** Per-skill "Also outside Harnu" opt-in (`~/.claude/skills/<name>/`, spec §4.3). */
  userLevelInstall: SkillFlags
}

/** A fresh install: nothing enabled, nothing installed outside Harnu. */
export const EMPTY_PREFS: BundledSkillsPrefs = {
  version: 1,
  enabled: {},
  userLevelInstall: {}
}

// ---- Version marker ------------------------------------------------------------

/**
 * Parse the catalog's version marker (`<!-- harnu-skills vN (date) -->`, or the pre-rename `capy-skills`), mirroring
 * `harnu-features.ts`'s `HARNU_FEATURES_VERSION`. `'v0'` when the marker is absent,
 * so a hand-mangled catalog still stages (and still re-stages once the marker
 * comes back) instead of throwing at boot.
 */
export function parseBundledSkillsVersion(raw: string): string {
  const m = /<!--\s*(?:harnu|capy)-skills\s+(v\d+)/i.exec(raw)
  return m ? m[1] : 'v0'
}

// ---- Frontmatter ---------------------------------------------------------------

/** Strip one layer of matching surrounding quotes from a scalar. */
function unquote(v: string): string {
  const t = v.trim()
  if (t.length >= 2 && ((t[0] === '"' && t.endsWith('"')) || (t[0] === "'" && t.endsWith("'")))) {
    return t.slice(1, -1)
  }
  return t
}

/**
 * Read a `SKILL.md`'s frontmatter into `{ name, description }`.
 *
 * Deliberately shallow: the CLI's own skill frontmatter is a flat `name:` /
 * `description:` pair, and a full YAML parser would be a dependency plus a much
 * larger surface for a file we ship ourselves. Supports a quoted scalar and a
 * folded continuation (an indented line following `description:`), which is the
 * only multi-line shape long trigger descriptions actually use.
 *
 * Returns `null` — the fail-soft signal — when there is no frontmatter block, no
 * `name`, or no `description`. The caller drops that ONE skill.
 *
 * `dirName`, when given, must match the parsed `name`: the CLI resolves a skill by
 * its directory, so a mismatch would make the panel promise a name the session
 * never sees. Such an entry is dropped rather than silently renamed.
 */
/**
 * Frontmatter YAML constructs that can name a key without writing it, or hide one from a text scan:
 * an explicit `? key`, a tag (`!x`), an anchor (`&x`), an alias (`*x`) and a merge key (`<<:`).
 */
const FRONTMATTER_HIDING_FORMS: readonly RegExp[] = [
  /^[ \t]*\?(?:[ \t]|$)/m,
  /(?:^|[\s:\-[{,])[!&*]\S/m,
  /(?:^|[\s,{])<<[ \t]*:/m
]

/** True when `value` is, or contains at any depth, an object key spelled `hooks` in any casing. */
function hasHooksKey(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasHooksKey)
  if (value && typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>).some(
      ([k, v]) => /hooks/i.test(k) || hasHooksKey(v)
    )
  }
  return false
}

/**
 * BUG-169: must an `observe` tick refuse this SKILL.md because its frontmatter may declare `hooks:`?
 * Such a skill runs the shell commands it names (PreToolUse / PostToolUse / Stop) whenever it is
 * loaded, with no shell TOOL involved, so `--tools` and `--disallowedTools` do not touch it.
 *
 * The CLI's YAML reader decides what a hook is, and a text scan for one spelling of the key is
 * easy to walk around (`? [hooks]`, a tag, an anchor, an escape). So this does not try to prove a
 * skill is clean; it refuses anything it cannot positively read as a plain header. A frontmatter is
 * refused when ANY of these holds:
 *
 * 1. the token `hooks` appears anywhere in it, in any casing, in prose or in a key;
 * 2. it contains a backslash, so no escaped spelling of a key survives to be missed;
 * 3. it uses a YAML construct that can hide a key: `? ` explicit keys, tags, anchors, aliases,
 *    merge keys;
 * 4. it does not load cleanly under js-yaml's CORE_SCHEMA (the library the repo already uses):
 *    syntax errors, duplicate keys, several documents, a non-mapping root;
 * 5. after loading, a key spelled `hooks` exists at any depth;
 * 6. the fence opens and never closes.
 *
 * False positives are accepted by design: the skill is simply refused in observe, still works in an
 * act worker, and the cost is a re-word. The cost of a false negative is a command running in a
 * tick that promised to be read-only. A file with no frontmatter fence is not read for hooks by the
 * CLI, so it is not refused; the fence may follow a BOM or blank lines, which a lenient reader
 * might skip.
 */
export function skillDeclaresHooks(raw: string): boolean {
  return skillFrontmatterVerdict(raw) !== 'ok'
}

/** What an `observe` tick makes of a SKILL.md header. */
export type FrontmatterVerdict = 'ok' | 'hooks' | 'unsafe-frontmatter'

/** Whitespace and invisible characters a lenient reader might skip before an opening fence. */
const INVISIBLE_LEAD = /^[\s\u180E\u200B-\u200F\u2060\uFEFF]*/

/**
 * The verdict behind {@link skillDeclaresHooks}: `ok`, `hooks` (the header may declare hooks, by
 * rules 1-5 above) or `unsafe-frontmatter` (the FENCE cannot be read unambiguously, rule 6 and the
 * two below).
 *
 * The CLI opens frontmatter with `^---\s*\n` after stripping one BOM, and its `\s` covers `\r`,
 * `\f`, `\v`, U+00A0, U+2028 and U+FEFF, so `--- \n` or `---\r\r\n` is a fence to it. A fence regex
 * written to the letter of YAML, as this one first was, calls those "no frontmatter" and lets the
 * hooks through (confirmed against claude 2.1.294). So nothing here is left to interpretation:
 *
 * - after at most ONE BOM, a file that starts with `---` must have a first line of exactly `---\n`
 *   or `---\r\n`; `--- \n`, `----`, `--- yaml` and every other near-fence is refused;
 * - a file that starts with whitespace or invisible characters and THEN `---` is refused (it is
 *   not valid frontmatter, but a reader that skips the lead-in would parse it);
 * - the header closes at the first line that starts with `---`, and that line must be exactly
 *   `---` (a trailing `\r` allowed); a line that starts with `---` and is anything else is
 *   ambiguous about where the header ends, so it is refused too. A header that never closes is
 *   refused.
 *
 * A file whose first characters are anything else has no frontmatter to the CLI and is `ok`.
 */
export function skillFrontmatterVerdict(raw: string): FrontmatterVerdict {
  const text = raw.startsWith('\uFEFF') ? raw.slice(1) : raw
  if (!text.startsWith('---')) {
    const lead = INVISIBLE_LEAD.exec(text)?.[0] ?? ''
    return lead.length > 0 && text.startsWith('---', lead.length) ? 'unsafe-frontmatter' : 'ok'
  }
  const open = /^---\r?\n/.exec(text)
  if (!open) return 'unsafe-frontmatter'

  const lines = text.slice(open[0].length).split('\n')
  let closeAt = -1
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].startsWith('---')) continue
    if (lines[i] !== '---' && lines[i] !== '---\r') return 'unsafe-frontmatter'
    closeAt = i
    break
  }
  if (closeAt < 0) return 'unsafe-frontmatter'
  const inner = lines.slice(0, closeAt).join('\n')

  if (/hooks/i.test(inner) || inner.includes('\\')) return 'hooks'
  if (FRONTMATTER_HIDING_FORMS.some((re) => re.test(inner))) return 'hooks'

  let doc: unknown
  try {
    doc = yaml.load(inner, { schema: yaml.CORE_SCHEMA })
  } catch {
    return 'hooks'
  }
  if (doc === undefined || doc === null) return 'ok'
  if (typeof doc !== 'object' || Array.isArray(doc)) return 'hooks'
  return hasHooksKey(doc) ? 'hooks' : 'ok'
}

export function parseSkillFrontmatter(raw: string, dirName?: string): BundledSkill | null {
  const open = /^---\r?\n/.exec(raw)
  if (!open) return null
  const afterOpen = raw.slice(open[0].length)
  const close = /\r?\n---[ \t]*(?:\r?\n|$)/.exec(afterOpen)
  if (!close) return null
  const inner = afterOpen.slice(0, close.index)

  const fields: Record<string, string> = {}
  let currentKey: string | null = null
  for (const line of inner.split(/\r?\n/)) {
    // A continuation line: indented, and we are inside a key with an empty or
    // folded value. Join with a space, YAML-folded style.
    if (currentKey && /^\s+\S/.test(line)) {
      fields[currentKey] = (fields[currentKey] ? fields[currentKey] + ' ' : '') + line.trim()
      continue
    }
    const m = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line)
    if (!m) {
      currentKey = null
      continue
    }
    currentKey = m[1]
    fields[currentKey] = m[2].trim()
  }

  const name = unquote(fields.name ?? '')
  const description = unquote(fields.description ?? '')
  if (!name || !description) return null
  if (dirName !== undefined && name !== dirName) return null
  return { name, description }
}

// ---- The cascade ---------------------------------------------------------------

/**
 * The tri-state cascade (spec §4.1): a folder value of `undefined` INHERITS, an
 * explicit `true`/`false` wins over the global one in both directions, and neither
 * set resolves to `false` — the default-OFF rule behind AC-1.
 *
 * This is the whole of AC-3's first half: `folder ?? global ?? false`, folder first.
 */
export function resolveSkillEnabled(
  global: SkillFlags | undefined,
  folder: SkillFlags | undefined,
  name: string
): boolean {
  const f = folder?.[name]
  if (f !== undefined) return f
  const g = global?.[name]
  if (g !== undefined) return g
  return false
}

/**
 * The names of the catalog entries enabled for a folder, in catalog order. This
 * is exactly the set that gets staged — an "off" skill is never copied, so the
 * session cannot see it even in principle.
 */
export function enabledSkillNames(
  catalog: readonly BundledSkill[],
  global: SkillFlags | undefined,
  folder: SkillFlags | undefined
): string[] {
  return catalog.filter((s) => resolveSkillEnabled(global, folder, s.name)).map((s) => s.name)
}

// ---- argv ----------------------------------------------------------------------

/**
 * Insert Harnu's `--plugin-dir <stagedDir>` into a `claude-*` argv.
 *
 * Three invariants, all load-bearing:
 *  - an EMPTY `enabled` set emits NOTHING — no flag, no empty plugin dir, so the
 *    default-off install spawns byte-identical argv to today's;
 *  - the flag is emitted exactly ONCE, and never when this exact directory is
 *    already present (an idempotent re-injection must not double it);
 *  - the flag lands BEFORE the bare `--` separator. It used to be appended to the
 *    end of an argv that already ended with `-- <pre-prompt>`, which made it a
 *    positional argument: the CLI never parsed it, and freshly spawned sessions
 *    silently had no bundled skills at all (BUG-86). `insertOptionArgs` is the
 *    separator-safe splice.
 *
 * `--plugin-dir` is documented repeatable, so a user's own `--plugin-dir` in their
 * Claude Boot extra args coexists with Harnu's rather than displacing it — which is
 * why this inserts instead of ordering like `orderMcpArgs` has to. The
 * already-present scan looks only at the OPTION portion, so a pre-prompt that
 * happens to quote `--plugin-dir <dir>` cannot suppress the real flag.
 */
export function insertPluginDirArg(
  args: readonly string[],
  stagedDir: string,
  enabled: readonly string[]
): string[] {
  if (enabled.length === 0) return [...args]
  if (!stagedDir) return [...args]
  const { options } = splitOptionArgs(args)
  for (let i = 0; i < options.length - 1; i++) {
    if (options[i] === '--plugin-dir' && options[i + 1] === stagedDir) return [...args]
  }
  return insertOptionArgs(args, ['--plugin-dir', stagedDir])
}

// ---- Staging identity ----------------------------------------------------------

/**
 * The per-folder staging key (spec §2.2): the enabled set is per-folder, and one
 * shared directory cannot express two folders with different sets while both have
 * live sessions. A short content hash of the folder path keeps the directory name
 * filesystem-safe on every platform and leaks no path into `<userData>`'s listing.
 */
export function folderStageKey(folder: string): string {
  return createHash('sha256')
    .update(folder || '<none>')
    .digest('hex')
    .slice(0, 16)
}

/**
 * The stamp that decides whether a folder's staged copy is still current: the
 * catalog version AND the exact enabled set. One mechanism covers both re-stage
 * triggers — an app update that bumps the marker, and a toggle that changes the
 * set (so "toggle off removes" needs no separate path).
 */
export function stageStamp(version: string, enabled: readonly string[]): string {
  return `${version}:${[...enabled].sort().join(',')}`
}

// ---- Collision detection -------------------------------------------------------

/**
 * Which bundled skills collide by NAME with something the operator already has
 * personally — `~/.claude/skills/<name>/` or `~/.claude/commands/<name>.md`.
 *
 * Pure over two directory listings (injected by the shell) because the panel needs
 * this on every render and the answer is a disclosure, never a suppression: Harnu
 * does not delete, rename, move or disable a user's own skill, ever (spec §6.3).
 * With `--plugin-dir` both are offered — theirs as `<name>`, Harnu's as
 * `harnu:<name>` — so the row's job is to say so.
 */
export function detectSkillCollisions(
  catalog: readonly BundledSkill[],
  personalSkillDirs: readonly string[],
  personalCommandFiles: readonly string[]
): string[] {
  const skills = new Set(personalSkillDirs)
  const commands = new Set(
    personalCommandFiles.map((f) => (f.endsWith('.md') ? f.slice(0, -3) : f))
  )
  return catalog.filter((s) => skills.has(s.name) || commands.has(s.name)).map((s) => s.name)
}
