/**
 * T217 — bundled skills: Harnu ships its own skills, per-skill on/off.
 *
 * Harnu has an actuator (the MCP verbs, the dispatch manifest, worktrees) and until
 * now shipped no method for using it: the delivery loop lived entirely in one
 * operator's `~/.claude`. This module is the delivery channel for that method.
 *
 * The mechanism (spec §2.2, ADR-0009):
 *
 * ```
 * resources/skills/                      ← checked in, human-owned product asset
 *   .claude-plugin/plugin.json           ← { name: "harnu", … }
 *   skills/<name>/SKILL.md
 *        │  copy ONLY the enabled skills, per folder
 *        ▼
 * <userData>/skills/<folder-hash>/harnu/ ← staged, Harnu-owned, outside every repo
 *        │  pty.ts appends at spawn
 *        ▼
 * claude … --plugin-dir <that dir>       → session sees harnu:<name>
 * ```
 *
 * **Per-skill on/off is expressed by what gets staged.** The CLI offers no
 * per-skill filter, so an "off" skill is simply not copied and the session cannot
 * see it even in principle — which is what makes the panel's promise ("nothing
 * hidden") enforced by construction, and AC-2's negative half falsifiable.
 *
 * **Nothing is written into the user's repository.** The staged tree is an absolute
 * path under `<userData>`, and the per-folder override lives in Harnu's own
 * `projects.json` — not in `.claude/settings.local.json`, not in a gitignored file.
 * The one exception is the explicit, default-OFF "Also outside Harnu" switch (§4.3),
 * which writes `~/.claude/skills/<name>/SKILL.md` and refuses to overwrite anything
 * Harnu did not itself install.
 *
 * **Fail-soft everywhere**, mirroring `orchestrator-guard.ts`: a copy failure logs
 * and never throws, and a missing staged directory means no `--plugin-dir` is
 * passed — degrading to today's behaviour rather than breaking the spawn.
 *
 * env-bound (electron `app` + `node:fs`) ⇒ e2e-only per ADR-0001; every DECISION
 * this module makes is delegated to the pure, unit-tested `bundled-skills-core.ts`.
 */

import { app, ipcMain } from 'electron'
import { createHash } from 'node:crypto'
import { promises as fs, constants as fsConstants } from 'node:fs'
import { homedir } from 'node:os'
import * as path from 'node:path'
import catalogDoc from '../../resources/skills/CATALOG.md?raw'
import {
  EMPTY_PREFS,
  insertPluginDirArg,
  detectSkillCollisions,
  enabledSkillNames,
  folderStageKey,
  parseBundledSkillsVersion,
  parseSkillFrontmatter,
  skillDeclaresHooks,
  stageStamp,
  type BundledSkill,
  type BundledSkillsPrefs,
  type SkillFlags
} from './bundled-skills-core'
import { getUserProjectSkills, setUserProjectSkill } from './user-projects'

/**
 * The catalog version, parsed from `resources/skills/CATALOG.md`'s marker at build
 * time (embedded via `?raw`, exactly like `HARNU_FEATURES_VERSION`). Bumping the
 * marker is what re-stages every folder after an app update.
 */
export const BUNDLED_SKILLS_VERSION = parseBundledSkillsVersion(catalogDoc)

/** On-disk file name under `app.getPath('userData')`. */
const PREFS_FILE = 'bundled-skills.json'

/** The plugin directory name inside a folder's staged tree — the CLI namespace. */
const PLUGIN_NAME = 'harnu'

/** Pre-rename plugin namespace. A persisted worker prompt or a habit-typed
 *  `/capy:mission` must keep resolving, so it is an alias of `PLUGIN_NAME`. */
const LEGACY_PLUGIN_NAMES: readonly string[] = ['capy']

/** Marker file Harnu writes beside a user-level install so it can tell its own
 *  file from the operator's (spec §6.4, open question 5 — resolved as a sidecar
 *  stamp rather than a frontmatter key, which would be visible to the model and
 *  would pollute the skill's own trigger text). */
const MANAGED_STAMP = '.harnu-managed.json'
/** The stamp written before the Capy → Harnu rename. Still recognized as ours (so a
 *  legacy-stamped install is never "occupied"), replaced on the next install. */
const LEGACY_MANAGED_STAMP = '.capy-managed.json'

// ---- Paths ---------------------------------------------------------------------

/**
 * `resources/skills/` — the checked-in catalog, a human-owned product asset (never
 * bundled into the JS). Mirrors `orchestrator-guard.ts`'s `guardResourceDir()`:
 * dev runs read straight from the repo, a packaged build ships it unpacked via
 * `extraResources`.
 */
function skillsResourceDir(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'skills')
    : path.join(app.getAppPath(), 'resources', 'skills')
}

/** `<userData>/skills/` — the root of every folder's staged tree. */
function stagingRoot(): string {
  return path.join(app.getPath('userData'), 'skills')
}

/**
 * `<userData>/skills/<folder-hash>/harnu` — the directory handed to `--plugin-dir`.
 * Keyed per folder because the enabled set is per folder: one shared directory
 * cannot express two folders with different sets while both have live sessions.
 */
export function stagedPluginDir(
  folder: string,
  mentions: readonly string[] = [],
  observe = false
): string {
  // A worker's mentioned skills are keyed INTO the directory, not merged into the
  // folder's shared one (T305). Interactive sessions in the same folder stage the
  // enabled-bundled set and nothing else; if a worker's mentions landed in that
  // same directory the two would fight over the `.stamp` and re-copy the tree on
  // every spawn — and a session would silently inherit a worker's skills.
  // BUG-169: an observe tick resolves and filters the same mentions differently from an act one
  // (bundled first, hooks refused), so the two must not share a directory either: they would
  // re-stage over each other on every tick of two workers in one folder.
  const key =
    mentions.length === 0
      ? folder
      : `${folder}\u0000${[...mentions].sort().join(',')}${observe ? '\u0000observe' : ''}`
  return path.join(stagingRoot(), folderStageKey(key), PLUGIN_NAME)
}

/**
 * Boot-time cleanup of the pre-rename staging dirs. The userData migration copies
 * `<userData>/skills/<hash>/capy/` across, but nothing stages into it any more (the
 * plugin dir is `<hash>/harnu/` now), so each one is a dead copy of the catalog.
 * Removes every legacy-named plugin dir directly under a folder-hash dir and returns
 * how many it removed. Best-effort: a missing root or an undeletable dir is skipped.
 */
export async function cleanStaleLegacyStaging(): Promise<number> {
  let removed = 0
  let hashes: string[]
  try {
    hashes = await fs.readdir(stagingRoot())
  } catch {
    return 0
  }
  for (const hash of hashes) {
    for (const legacy of LEGACY_PLUGIN_NAMES) {
      const dir = path.join(stagingRoot(), hash, legacy)
      try {
        const st = await fs.stat(dir)
        if (!st.isDirectory()) continue
        await fs.rm(dir, { recursive: true, force: true })
        removed++
      } catch {
        // not there (the usual case), or not removable — leave it for the next boot
      }
    }
  }
  return removed
}

function prefsPath(): string {
  return path.join(app.getPath('userData'), PREFS_FILE)
}

/** `~/.claude/skills/<name>/` — where the opt-in "Also outside Harnu" install lands. */
function userLevelSkillDir(name: string): string {
  return path.join(homedir(), '.claude', 'skills', name)
}

// ---- Catalog -------------------------------------------------------------------

let catalogCache: BundledSkill[] | null = null

/**
 * Read the shipped catalog: one entry per `skills/<name>/SKILL.md` whose
 * frontmatter parses. PER-ENTRY fail-soft — a malformed or unreadable `SKILL.md`
 * drops THAT skill and never the catalog, and an unreadable `resources/skills/`
 * yields `[]` (which in turn means no `--plugin-dir`, i.e. today's behaviour).
 *
 * Cached for the app's lifetime: the source is a packaged, read-only asset that
 * only changes with the app itself.
 */
export async function readBundledCatalog(): Promise<BundledSkill[]> {
  if (catalogCache) return catalogCache
  const root = path.join(skillsResourceDir(), 'skills')
  let dirs: string[]
  try {
    dirs = (await fs.readdir(root, { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort()
  } catch (err) {
    console.error('[bundled-skills] catalog unreadable', err)
    return []
  }
  const out: BundledSkill[] = []
  for (const dir of dirs) {
    try {
      const raw = await fs.readFile(path.join(root, dir, 'SKILL.md'), 'utf8')
      const parsed = parseSkillFrontmatter(raw, dir)
      if (parsed) out.push(parsed)
      else console.warn(`[bundled-skills] skipping ${dir}: unparseable SKILL.md frontmatter`)
    } catch (err) {
      console.warn(`[bundled-skills] skipping ${dir}`, err)
    }
  }
  catalogCache = out
  return out
}

// ---- Skill discovery outside the catalog (T305) ---------------------------------

/** Where a skill a tick can stage came from. Shown verbatim on the form's chips. */
export type SkillOrigin = 'bundled' | 'personal' | 'project'

/** One skill a worker's prompt may name, and where Harnu would copy it from. */
export interface AvailableSkill {
  /** The directory name — the id the prompt writes as `/name`. */
  name: string
  /** `SKILL.md` frontmatter description, or `''` when it does not parse. */
  description: string
  origin: SkillOrigin
}

/** `~/.claude/skills` — the operator's own skills. */
function personalSkillsRoot(): string {
  return path.join(homedir(), '.claude', 'skills')
}

/** `<folder>/.claude/skills` — the repo's own skills. */
function projectSkillsRoot(folder: string): string {
  return path.join(folder, '.claude', 'skills')
}

/** The immediate subdirectory names of `root`, or `[]` when it is unreadable. */
async function readSkillDirNames(root: string): Promise<string[]> {
  return fs
    .readdir(root, { withFileTypes: true })
    .then((e) => e.filter((d) => d.isDirectory()).map((d) => d.name))
    .catch(() => [] as string[])
}

/**
 * The skills under `root` that actually carry a `SKILL.md`.
 *
 * The id is the DIRECTORY name, not the frontmatter `name`: the directory is
 * what gets copied into the staged tree, so it is what the tick ends up seeing.
 * Unparseable frontmatter costs the row its description, never its place in the
 * list — a skill that exists on disk would stage, so hiding it from the picker
 * would be a lie the operator only discovers at 3am.
 */
async function readSkillsAt(root: string, origin: SkillOrigin): Promise<AvailableSkill[]> {
  const out: AvailableSkill[] = []
  for (const name of await readSkillDirNames(root)) {
    const raw = await fs.readFile(path.join(root, name, 'SKILL.md'), 'utf8').catch(() => null)
    if (raw === null) continue
    out.push({ name, description: parseSkillFrontmatter(raw)?.description ?? '', origin })
  }
  return out
}

/**
 * Every skill a tick in `folder` could be told to stage: Harnu's bundled catalog
 * unioned with the operator's `~/.claude/skills/` and the repo's own
 * `<folder>/.claude/skills/`, each tagged with where it came from.
 *
 * The union is FOLDER-DEPENDENT, which is why the form re-reads it whenever the
 * Folder field changes.
 *
 * A name present in several places is returned ONCE PER PLACE, ordered **project
 * → personal → bundled** — most specific first, which is the order
 * `resolveMention` resolves a bare mention in. The form collapses that to one
 * row per name for the picker, but keeps the shadowed entries so `harnu:mission`
 * can still resolve to the bundled skill when a personal `mission` shadows the
 * bare name — exactly as a tick would resolve it.
 */
export async function listAvailableSkills(folder: string): Promise<AvailableSkill[]> {
  const [bundled, personal, project] = await Promise.all([
    readBundledCatalog().then((c) =>
      c.map((s): AvailableSkill => ({
        name: s.name,
        description: s.description,
        origin: 'bundled'
      }))
    ),
    readSkillsAt(personalSkillsRoot(), 'personal'),
    folder ? readSkillsAt(projectSkillsRoot(folder), 'project') : Promise.resolve([])
  ])
  const rank: Record<SkillOrigin, number> = { project: 0, personal: 1, bundled: 2 }
  return [...project, ...personal, ...bundled].sort(
    (a, b) => a.name.localeCompare(b.name) || rank[a.origin] - rank[b.origin]
  )
}

/**
 * Where a single `/mention` would be copied from, or `null` when nothing on this
 * machine answers to that name.
 *
 * A `harnu:` prefix (or its legacy alias `capy:`) pins the mention to the bundled
 * catalog — the operator asking for Harnu's own skill even though a personal one shadows the bare name. Any
 * OTHER namespace (`dtk:review`) names a plugin the operator installed through
 * their settings, and `--setting-sources ''` means a tick never loads those:
 * unresolvable is the honest answer, and the form renders it as a warning chip
 * rather than staging something else and hoping.
 */
async function resolveMention(
  mention: string,
  folder: string,
  catalogNames: ReadonlySet<string>,
  bundledFirst = false
): Promise<{ name: string; src: string; origin: SkillOrigin } | null> {
  // BUG-169: an `observe` tick matches the bundled catalog case-insensitively and always answers
  // with the catalog's own spelling, so `/Status` can never reach a project `Status` directory
  // (on a case-insensitive filesystem that directory IS `status`).
  const canonical = (name: string): string | undefined =>
    bundledFirst
      ? [...catalogNames].find((n) => n.toLowerCase() === name.toLowerCase())
      : catalogNames.has(name)
        ? name
        : undefined
  const bundled = (name: string): { name: string; src: string; origin: SkillOrigin } => ({
    name,
    src: path.join(skillsResourceDir(), 'skills', name),
    origin: 'bundled'
  })

  const colon = mention.indexOf(':')
  if (colon !== -1) {
    const ns = mention.slice(0, colon)
    const nsOk = [PLUGIN_NAME, ...LEGACY_PLUGIN_NAMES].includes(
      bundledFirst ? ns.toLowerCase() : ns
    )
    const bare = canonical(mention.slice(colon + 1))
    if (!nsOk || bare === undefined) return null
    return bundled(bare)
  }
  // BUG-169: an `observe` tick resolves a bare name that the bundled catalog owns to the bundled
  // skill, so a repo cannot shadow `/delivery-watchdog` with its own copy. Act mode and the picker
  // keep the most-specific-first order.
  if (bundledFirst) {
    const hit = canonical(mention)
    if (hit !== undefined) return bundled(hit)
  }
  for (const [root, origin] of [
    [folder ? projectSkillsRoot(folder) : '', 'project'],
    [personalSkillsRoot(), 'personal']
  ] as const) {
    if (!root) continue
    const dir = path.join(root, mention)
    const ok = await fs
      .access(path.join(dir, 'SKILL.md'))
      .then(() => true)
      .catch(() => false)
    if (ok) return { name: mention, src: dir, origin }
  }
  const hit = canonical(mention)
  return hit !== undefined ? bundled(hit) : null
}

/** BUG-169: the most an observe tick will copy out of one non-bundled skill. */
const SKILL_MAX_FILES = 200
const SKILL_MAX_FILE_BYTES = 2 * 1024 * 1024
const SKILL_MAX_TOTAL_BYTES = 8 * 1024 * 1024

/** A skill read into memory, ready to be written out byte for byte. */
type ObserveSkill =
  { ok: true; files: Map<string, Buffer> } | { ok: false; reason: 'hooks' | 'unsafe-layout' }

const UNSAFE: ObserveSkill = { ok: false, reason: 'unsafe-layout' }

/**
 * Read one regular file without following a symlink at the last component (`O_NOFOLLOW`), and
 * confirm on the open handle that it is a regular file within the size cap. Returns `null` for
 * anything else, so a file swapped for a link between the directory scan and the read is refused
 * rather than followed.
 */
async function readRegularFile(file: string, budget: { left: number }): Promise<Buffer | null> {
  const fh = await fs.open(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW).catch(() => null)
  if (!fh) return null
  try {
    const st = await fh.stat()
    if (!st.isFile() || st.size > SKILL_MAX_FILE_BYTES || st.size > budget.left) return null
    const buf = await fh.readFile()
    budget.left -= buf.length
    return buf
  } finally {
    await fh.close().catch(() => {})
  }
}

/**
 * BUG-169: read the skill at `dir` into memory for an `observe` tick, or say why it is refused.
 *
 * The bytes that are checked are the bytes that get written: `SKILL.md` is read ONCE, the hooks
 * check runs on that buffer, and the staged file is that same buffer. (The first version checked a
 * file and then `fs.cp`-ed the directory, two reads with a gap a swap could use.) Everything else
 * is read the same way and held in memory, so nothing about the directory is consulted again.
 *
 * Refused (`unsafe-layout`): a symlink anywhere, a directory or file called `hooks` / `hooks.json`
 * at any depth, a non-regular file (a FIFO would hang a copy), or more than the file / byte caps.
 * Skipped silently: dot-files and dot-directories (`.claude-plugin/`, `.mcp.json`, `.claude/`,
 * `.DS_Store`), which a skill needs none of and which are not copied. Unreadable means refused.
 */
async function readSkillForObserve(dir: string): Promise<ObserveSkill> {
  const root = await fs.lstat(dir).catch(() => null)
  if (!root || !root.isDirectory()) return UNSAFE

  const budget = { left: SKILL_MAX_TOTAL_BYTES }
  const manifest = await fs.lstat(path.join(dir, 'SKILL.md')).catch(() => null)
  if (!manifest || !manifest.isFile()) return UNSAFE
  const skillMd = await readRegularFile(path.join(dir, 'SKILL.md'), budget)
  if (!skillMd) return UNSAFE
  if (skillDeclaresHooks(skillMd.toString('utf8'))) return { ok: false, reason: 'hooks' }

  const files = new Map<string, Buffer>([['SKILL.md', skillMd]])
  const walk = async (rel: string): Promise<boolean> => {
    const names = await fs.readdir(path.join(dir, rel)).catch(() => null)
    if (!names) return false
    for (const name of names) {
      if (name.startsWith('.')) continue
      const childRel = rel ? path.join(rel, name) : name
      if (childRel === 'SKILL.md') continue
      const lower = name.toLowerCase()
      const abs = path.join(dir, childRel)
      const st = await fs.lstat(abs).catch(() => null)
      if (!st || st.isSymbolicLink()) return false
      if (st.isDirectory()) {
        if (lower === 'hooks' || !(await walk(childRel))) return false
      } else if (st.isFile()) {
        if (lower === 'hooks.json' || files.size >= SKILL_MAX_FILES) return false
        const buf = await readRegularFile(abs, budget)
        if (!buf) return false
        files.set(childRel, buf)
      } else {
        return false
      }
    }
    return true
  }
  return (await walk('')) ? { ok: true, files } : UNSAFE
}

/** A mention's contribution to the stage stamp: identity AND freshness. */
async function mentionStamp(
  name: string,
  src: string,
  origin: SkillOrigin,
  files?: ReadonlyMap<string, Buffer>
): Promise<string> {
  // An observe skill is held in memory, so its identity is its content.
  if (files) {
    const h = createHash('sha256')
    for (const [rel, buf] of [...files].sort(([a], [b]) => a.localeCompare(b))) {
      h.update(rel).update('\0').update(buf).update('\0')
    }
    return `@${origin}:${name}:${h.digest('hex').slice(0, 16)}`
  }
  // A personal or project skill is a file the operator edits; the bundled catalog
  // only moves when the app does. Without the mtime an edited skill would keep
  // staging its old copy until the mention set itself changed.
  const mtime = await fs
    .stat(path.join(src, 'SKILL.md'))
    .then((st) => Math.round(st.mtimeMs))
    .catch(() => 0)
  return `@${origin}:${name}:${mtime}`
}

// ---- Prefs ---------------------------------------------------------------------

/** Read `<userData>/bundled-skills.json`. A missing/corrupt file is a fresh
 *  install: nothing enabled (spec §4.2's default-OFF rule). Never throws. */
export async function readBundledSkillsPrefs(): Promise<BundledSkillsPrefs> {
  try {
    const parsed = JSON.parse(await fs.readFile(prefsPath(), 'utf8'))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return emptyPrefs()
    const p = parsed as Partial<BundledSkillsPrefs>
    return {
      version: 1,
      enabled: isFlagMap(p.enabled) ? p.enabled : {},
      userLevelInstall: isFlagMap(p.userLevelInstall) ? p.userLevelInstall : {}
    }
  } catch {
    return emptyPrefs()
  }
}

/** A FRESH empty prefs object. `{ ...EMPTY_PREFS }` would share the constant's own
 *  `enabled`/`userLevelInstall` objects with every caller — one mutation away from
 *  a fresh install silently inheriting another read's flags. */
function emptyPrefs(): BundledSkillsPrefs {
  return { ...EMPTY_PREFS, enabled: {}, userLevelInstall: {} }
}

function isFlagMap(v: unknown): v is SkillFlags {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

async function writeBundledSkillsPrefs(prefs: BundledSkillsPrefs): Promise<void> {
  await fs.mkdir(app.getPath('userData'), { recursive: true })
  await fs.writeFile(prefsPath(), JSON.stringify(prefs, null, 2) + '\n', 'utf8')
}

// ---- Staging -------------------------------------------------------------------

/**
 * Stage the skills enabled for `folder` into `<userData>/skills/<hash>/harnu/` and
 * return that directory, or `null` when NOTHING is enabled (the caller must then
 * pass no `--plugin-dir` at all).
 *
 * Idempotent through a `.stamp` carrying the catalog version AND the exact enabled
 * set, so one check covers both re-stage triggers: an app update that bumps the
 * marker, and a toggle that changes the set. A stale stamp wipes the tree and
 * rewrites it — which is also how "toggle off removes" happens, with no separate
 * deletion path to get wrong.
 *
 * Best-effort: any failure logs and returns `null`, degrading the spawn to
 * no-bundled-skills rather than breaking it.
 */
export interface StagedSkills {
  /** Absolute path to hand to `--plugin-dir`. */
  dir: string
  /** The skill names actually staged there — non-empty by construction. */
  enabled: string[]
  /** Of `mentions`, the ones that resolved to something on disk (T305). */
  mentioned: string[]
  /** BUG-169: mentions an `observe` tick refused to stage. Always `[]` outside observe mode. */
  rejected: SkillRejection[]
}

/** BUG-169: a `/mention` an `observe` tick refused to stage, and why. */
export interface SkillRejection {
  mention: string
  /**
   * `hooks`: the frontmatter declares (or may declare) hooks, which run shell commands outside the
   * tool allowlist. `unsafe-layout`: the skill directory holds something an observe tick will not
   * copy (a symlink, a hooks directory, a non-regular file, or too much data).
   */
  reason: 'hooks' | 'unsafe-layout'
}

/** Which kind of tick is staging: `observe` is the restricted one (BUG-169). */
export type StageMode = 'observe' | 'act'

/**
 * Stage for a Scheduler tick and report what was refused. Unlike {@link stageSkillsForFolder} this
 * keeps the rejections when nothing ends up staged (every mention refused and no bundled skill
 * enabled returns `staged: null`), which is exactly the case where the operator most needs to know.
 */
export async function stageSkillsForTick(
  folder: string,
  mentions: readonly string[],
  mode: StageMode
): Promise<{ staged: StagedSkills | null; rejected: SkillRejection[] }> {
  const rejected: SkillRejection[] = []
  const staged = await stageInternal(folder, mentions, mode === 'observe', rejected)
  return { staged, rejected }
}

/**
 * `mentions` (T305) are the skill names a scheduler worker's PROMPT asks for,
 * parsed from that string by `parseSkillMentions`. They are staged ON TOP of the
 * enabled bundled set, including a bundled skill that is globally off — naming a
 * skill in the prompt is an explicit request, not a suggestion.
 *
 * They also key the staged directory (see `stagedPluginDir`), so a worker's set
 * never collides with the plain enabled set an interactive session in the same
 * folder stages.
 */
export async function stageSkillsForFolder(
  folder: string,
  mentions: readonly string[] = [],
  opts: { observe?: boolean } = {}
): Promise<StagedSkills | null> {
  return stageInternal(folder, mentions, opts.observe === true, [])
}

async function stageInternal(
  folder: string,
  mentions: readonly string[],
  observe: boolean,
  rejected: SkillRejection[]
): Promise<StagedSkills | null> {
  try {
    const catalog = await readBundledCatalog()
    const prefs = await readBundledSkillsPrefs()
    const folderFlags = folder ? await getUserProjectSkills(folder) : {}
    const bundledEnabled = enabledSkillNames(catalog, prefs.enabled, folderFlags)
    const catalogNames = new Set(catalog.map((c) => c.name))
    const dir = stagedPluginDir(folder, mentions, observe)

    // src by staged directory name. Bundled first so a mention that resolves to a
    // personal or project skill of the same name REPLACES it — one directory name
    // can only hold one skill, and the more specific source is the one the picker
    // showed the operator.
    const sources = new Map<
      string,
      { src: string; origin: SkillOrigin; files?: ReadonlyMap<string, Buffer> }
    >()
    for (const name of bundledEnabled) {
      sources.set(name, { src: path.join(skillsResourceDir(), 'skills', name), origin: 'bundled' })
    }
    const mentioned: string[] = []
    const mentionStamps: string[] = []
    for (const mention of mentions) {
      const hit = await resolveMention(mention, folder, catalogNames, observe)
      if (!hit) continue
      // BUG-169: an observe tick never stages a personal or project skill it could not read as a
      // plain header and a plain directory: frontmatter hooks run shell commands whatever the tool
      // allowlist says, and a symlink or a nested hooks/ dir is the same hole by another door.
      // Refused, not stripped: an edited copy would be a skill the operator did not write. The
      // bundled skills are Harnu's own and are copied as before.
      let files: ReadonlyMap<string, Buffer> | undefined
      if (observe && hit.origin !== 'bundled') {
        const read = await readSkillForObserve(hit.src)
        if (!read.ok) {
          rejected.push({ mention, reason: read.reason })
          continue
        }
        files = read.files
      }
      sources.set(hit.name, { src: hit.src, origin: hit.origin, ...(files ? { files } : {}) })
      mentioned.push(mention)
      mentionStamps.push(await mentionStamp(hit.name, hit.src, hit.origin, files))
    }

    const enabled = [...sources.keys()]
    if (enabled.length === 0) {
      // Nothing enabled: remove any tree staged by a previous, wider enabled set so
      // a stale copy can never be picked up, then tell the caller to pass no flag.
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
      return null
    }

    const wanted = stageStamp(BUNDLED_SKILLS_VERSION, [...enabled, ...mentionStamps])
    const stampFile = path.join(dir, '.stamp')
    const current = await fs.readFile(stampFile, 'utf8').catch(() => null)
    if (current?.trim() === wanted) return { dir, enabled, mentioned, rejected }

    // Build in a SIBLING temp dir and swap it in, rather than wiping `dir` and
    // copying into it: two sessions can start in the same folder at once, and a
    // spawn that hands `claude` a half-copied tree would silently lose skills. The
    // swap is not atomic (no cross-directory replace for a non-empty dir), but it
    // narrows the window from the whole copy to a single rename.
    const src = skillsResourceDir()
    const tmp = `${dir}.staging-${process.pid}-${Date.now().toString(36)}`
    try {
      await fs.rm(tmp, { recursive: true, force: true }).catch(() => {})
      await fs.mkdir(path.join(tmp, '.claude-plugin'), { recursive: true })
      await fs.copyFile(
        path.join(src, '.claude-plugin', 'plugin.json'),
        path.join(tmp, '.claude-plugin', 'plugin.json')
      )
      for (const [name, from] of sources) {
        if (from.files) {
          // BUG-169: write the bytes that were checked, never re-read the source directory.
          for (const [rel, buf] of from.files) {
            const out = path.join(tmp, 'skills', name, rel)
            await fs.mkdir(path.dirname(out), { recursive: true })
            await fs.writeFile(out, buf)
          }
        } else {
          await fs.cp(from.src, path.join(tmp, 'skills', name), { recursive: true })
        }
      }
      await fs.writeFile(path.join(tmp, '.stamp'), wanted + '\n', 'utf8')
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
      await fs.mkdir(path.dirname(dir), { recursive: true })
      await fs.rename(tmp, dir)
    } finally {
      await fs.rm(tmp, { recursive: true, force: true }).catch(() => {})
    }
    return { dir, enabled, mentioned, rejected }
  } catch (err) {
    console.error('[bundled-skills] staging failed', err)
    return null
  }
}

/**
 * The spawn-time entry point (`pty.ts`): stage this folder's enabled skills and
 * emit `--plugin-dir <staged>` into the OPTION portion of `args`. Returns `args`
 * UNCHANGED when nothing is enabled or staging failed — no flag, no empty plugin
 * dir.
 */
export async function injectBundledSkillArgs(
  args: readonly string[],
  folder: string
): Promise<string[]> {
  const staged = await stageSkillsForFolder(folder)
  if (!staged) return [...args]
  return insertPluginDirArg(args, staged.dir, staged.enabled)
}

// ---- Collision disclosure ------------------------------------------------------

/**
 * Which catalog entries share a name with something already in the operator's own
 * `~/.claude/skills/` or `~/.claude/commands/`. A cheap `readdir`, no content
 * parsing — the answer is a DISCLOSURE on the row ("both will be available, yours
 * as `<name>`, Harnu's as `harnu:<name>`"), never a suppression.
 */
export async function scanSkillCollisions(): Promise<string[]> {
  const catalog = await readBundledCatalog()
  const [skillDirs, commandFiles] = await Promise.all([
    fs
      .readdir(path.join(homedir(), '.claude', 'skills'), { withFileTypes: true })
      .then((e) => e.filter((d) => d.isDirectory()).map((d) => d.name))
      .catch(() => [] as string[]),
    fs
      .readdir(path.join(homedir(), '.claude', 'commands'), { withFileTypes: true })
      .then((e) => e.filter((d) => d.isFile()).map((d) => d.name))
      .catch(() => [] as string[])
  ])
  return detectSkillCollisions(catalog, skillDirs, commandFiles)
}

// ---- "Also outside Harnu" (spec §4.3) -------------------------------------------

/** Whether `~/.claude/skills/<name>/` exists AND carries our sidecar stamp —
 *  the current `.harnu-managed.json` or the legacy `.capy-managed.json`. */
async function isHarnuManaged(name: string): Promise<boolean> {
  for (const stamp of [MANAGED_STAMP, LEGACY_MANAGED_STAMP]) {
    try {
      await fs.access(path.join(userLevelSkillDir(name), stamp))
      return true
    } catch {
      /* try the next stamp */
    }
  }
  return false
}

export type UserLevelInstallResult =
  { ok: true; installed: boolean } | { ok: false; reason: 'occupied' | 'unknown-skill' | 'failed' }

/**
 * Install (or remove) a bundled skill at USER level — the opt-in, default-OFF
 * "Also outside Harnu" switch. The flat layout `~/.claude/skills/<name>/SKILL.md`
 * is the one the CLI auto-loads with no flags at all, which is exactly why this is
 * the only part of T217 that writes outside Harnu's own userData.
 *
 * REFUSES rather than overwrites when the directory already exists and was not
 * written by Harnu (`occupied`): a user's own configuration is not Harnu's to edit.
 * Removal only ever deletes a directory carrying Harnu's own stamp.
 *
 * Note the cost, which the panel states: a skill installed this way is
 * UNNAMESPACED, so it competes by name with a personal skill — unlike the
 * `--plugin-dir` path, where both coexist as `<name>` and `harnu:<name>`.
 */
export async function setUserLevelInstall(
  name: string,
  install: boolean
): Promise<UserLevelInstallResult> {
  const catalog = await readBundledCatalog()
  if (!catalog.some((s) => s.name === name)) return { ok: false, reason: 'unknown-skill' }
  const dir = userLevelSkillDir(name)
  try {
    if (!install) {
      if (await isHarnuManaged(name)) await fs.rm(dir, { recursive: true, force: true })
      await patchPrefs((p) => {
        const next = { ...p.userLevelInstall }
        delete next[name]
        return { ...p, userLevelInstall: next }
      })
      return { ok: true, installed: false }
    }

    const exists = await fs
      .access(dir)
      .then(() => true)
      .catch(() => false)
    if (exists && !(await isHarnuManaged(name))) return { ok: false, reason: 'occupied' }

    const src = path.join(skillsResourceDir(), 'skills', name, 'SKILL.md')
    await fs.mkdir(dir, { recursive: true })
    await fs.copyFile(src, path.join(dir, 'SKILL.md'))
    await fs.writeFile(
      path.join(dir, MANAGED_STAMP),
      JSON.stringify(
        { managedBy: 'harnu', skill: name, version: BUNDLED_SKILLS_VERSION },
        null,
        2
      ) + '\n',
      'utf8'
    )
    await fs.rm(path.join(dir, LEGACY_MANAGED_STAMP), { force: true }) // replaced, not kept beside
    await patchPrefs((p) => ({ ...p, userLevelInstall: { ...p.userLevelInstall, [name]: true } }))
    return { ok: true, installed: true }
  } catch (err) {
    console.error('[bundled-skills] user-level install failed', err)
    return { ok: false, reason: 'failed' }
  }
}

async function patchPrefs(
  fn: (p: BundledSkillsPrefs) => BundledSkillsPrefs
): Promise<BundledSkillsPrefs> {
  const next = fn(await readBundledSkillsPrefs())
  await writeBundledSkillsPrefs(next)
  return next
}

// ---- IPC -----------------------------------------------------------------------

/** Everything the Settings → Skills pane needs in one round-trip. */
export interface BundledSkillsView {
  version: string
  catalog: BundledSkill[]
  /** Global per-skill on/off. */
  enabled: Record<string, boolean>
  /** Per-skill "Also outside Harnu". */
  userLevelInstall: Record<string, boolean>
  /** Names colliding with a personal skill/command of the same name. */
  collisions: string[]
}

/** Register the pane's IPC. Read-mostly; every write re-reads and returns the view. */
export function registerBundledSkillsHandlers(): void {
  ipcMain.handle('bundledSkills:get', async (): Promise<BundledSkillsView> => {
    const [catalog, prefs, collisions] = await Promise.all([
      readBundledCatalog(),
      readBundledSkillsPrefs(),
      scanSkillCollisions()
    ])
    return {
      version: BUNDLED_SKILLS_VERSION,
      catalog,
      enabled: compact(prefs.enabled),
      userLevelInstall: compact(prefs.userLevelInstall),
      collisions
    }
  })

  ipcMain.handle('bundledSkills:setGlobal', async (_e, name: string, enabled: boolean) => {
    await patchPrefs((p) => ({ ...p, enabled: { ...p.enabled, [name]: enabled === true } }))
    return true
  })

  ipcMain.handle('bundledSkills:getFolder', async (_e, folder: string) =>
    folder ? getUserProjectSkills(folder) : {}
  )

  ipcMain.handle(
    'bundledSkills:setFolder',
    async (_e, folder: string, name: string, enabled: boolean | null) => {
      if (!folder) return {}
      await setUserProjectSkill(folder, name, enabled === null ? undefined : enabled === true)
      return getUserProjectSkills(folder)
    }
  )

  ipcMain.handle('bundledSkills:setUserLevel', async (_e, name: string, install: boolean) =>
    setUserLevelInstall(name, install === true)
  )

  // T305 — everything a scheduler tick in `folder` could be told to stage. The
  // Settings → Skills pane answers "what does Harnu ship"; this answers "what can
  // this folder's tick actually reach", which is a different, wider question.
  ipcMain.handle('skills:available', async (_e, folder: string): Promise<AvailableSkill[]> =>
    listAvailableSkills(typeof folder === 'string' ? folder : '')
  )
}

/** Drop `undefined` values so the renderer gets a plain boolean map over IPC. */
function compact(flags: SkillFlags): Record<string, boolean> {
  const out: Record<string, boolean> = {}
  for (const [k, v] of Object.entries(flags)) if (typeof v === 'boolean') out[k] = v
  return out
}
