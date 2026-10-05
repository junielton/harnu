/**
 * T389 P4W1 part A — pure core of the Mods audit pane (Settings → Mods).
 *
 * A "mod" is a Claude Code plugin with a hooks module. This file knows nothing about
 * Electron, the filesystem or the `claude` binary: it turns what the CLI printed
 * (`claude plugin validate --json`, `claude plugin list --json`) into rows and
 * capability chips, and decides what is cached. The shell in `mods-audit.ts` runs
 * the processes and passes the text in.
 *
 * What the chips are: facts the source DECLARES it can do ("can run processes"),
 * never a verdict. The validate report lists hooks and calls as free text and does
 * not list destinations, arguments or paths, so none appear here (SEC-7, R16).
 */
import * as path from 'node:path'

// ── types ──────────────────────────────────────────────────────────────────

export type ModSource = 'harnu' | 'harnu-skills' | 'installed' | 'skills-dir' | 'boot-arg'

export type ModScope = 'user' | 'project' | 'local' | 'synced'

export type CapabilityId =
  | 'process'
  | 'network'
  | 'files'
  | 'prompts'
  | 'system-prompt'
  | 'tool-calls'
  | 'permissions'
  | 'submit'
  | 'model'
  | 'mcp'
  | 'other-mods'
  | 'gate'
  | 'env'
  | 'terminal'
  | 'opaque'

/** The fixed chip order of the spec (§7.5). */
export const CAPABILITY_ORDER: readonly CapabilityId[] = [
  'process',
  'network',
  'files',
  'prompts',
  'system-prompt',
  'tool-calls',
  'permissions',
  'submit',
  'model',
  'mcp',
  'other-mods',
  'gate',
  'env',
  'terminal',
  'opaque'
]

export interface ModHook {
  file: string
  event: string
  matcher?: string
  opaque: boolean
}

export interface ModCall {
  file: string
  /** `noun.method`, without the `$.` the source spells. */
  op: string
  via?: string
}

export interface ModAnalysis {
  status: 'ok' | 'invalid' | 'failed' | 'unsupported'
  hasModule: boolean
  /** Hex sha256, full; the pane shows the first 8. */
  hash: string
  hashKind: 'content' | 'stat'
  /** Epoch ms the analysis was computed (not the time it was read from the cache). */
  analysedAt: number
  cliVersion: string
  /** `analysedAt` of the previous analysis, when its hash differed. */
  changedSince?: number
  hooks: ModHook[]
  calls: ModCall[]
  env: { reads: string[]; writes: string[] }
  state: { reads: string[]; writes: string[]; foreignUnchecked: string[] }
  /** Notes the parser did not recognise, shown verbatim. */
  unparsed: string[]
  errors: string[]
  warnings: string[]
  capabilities: CapabilityId[]
}

export interface ModRow {
  /** `${source}\u0000${id ?? name}\u0000${root}` */
  key: string
  name: string
  id?: string
  source: ModSource
  scope?: ModScope
  root: string
  version?: string
  /** null: not knowable (skills-dir, boot-arg). */
  enabled: boolean | null
  loadsInFolder: 'yes' | 'no' | 'unknown'
  /** null: never analysed. */
  analysis: ModAnalysis | null
}

export type PolicyState = 'loads' | 'off-here' | 'off-remote' | 'unknown'

export interface ModsAuditView {
  cli: { path: string | null; version: string | null }
  policy: PolicyState
  /** Companion first, then by name. */
  rows: ModRow[]
  /** Plugins that were analysed and have no hooks module: counted, not listed. */
  withoutModule: number
  /** The CLI could not list installed plugins (the other sources still list). */
  installedUnreadable: boolean
  /** The folder's Claude Boot has `--safe-mode` or `--bare`: no mod loads there. */
  safeMode: boolean
  listedAt: number
}

// ── key helpers ────────────────────────────────────────────────────────────

export function rowKey(source: ModSource, idOrName: string, root: string): string {
  return `${source}\u0000${idOrName}\u0000${root}`
}

export function cacheKey(hash: string, cliVersion: string): string {
  return `${hash}\u0000${cliVersion}`
}

/** Resolve a root the way a set comparison needs it: normalised, no trailing slash. */
export function normRoot(p: string): string {
  const n = path.normalize(p)
  return n.length > 1 && n.endsWith(path.sep) ? n.slice(0, -1) : n
}

// ── validate report → facts ────────────────────────────────────────────────

export interface ParsedReport {
  /** The text was a validate report at all (has `success` and a manifest or contents). */
  ok: boolean
  success: boolean
  /** `manifest.type`: "plugin", "marketplace", … */
  type: string | null
  /** `contents[]` was a non-empty array. */
  hasContents: boolean
  hasModule: boolean
  hooks: ModHook[]
  calls: ModCall[]
  env: { reads: string[]; writes: string[] }
  state: { reads: string[]; writes: string[]; foreignUnchecked: string[] }
  unparsed: string[]
  errors: string[]
  warnings: string[]
}

const NOTE_RE =
  /^(?<file>\S+) (?<label>hooks|calls|env reads|env writes|state reads|state writes|state of other plugins, not checked)(?: \([^)]*\))?: (?<list>.*)$/s

const HOOK_ITEM_RE = /^(?<event>[A-Za-z_*][\w.*-]*)(?:\{(?<matcher>.*)\})?$/s
const CALL_ITEM_RE = /^\$\.(?<op>[A-Za-z_]\w*(?:\.\w+)+)(?: \(via (?<via>.+)\))?$/s

const MAX_MESSAGES = 20
const MAX_MESSAGE_LEN = 500

/**
 * Split a note's list on `, ` outside `{…}` and `(…)`. Braces nest (a matcher can
 * hold `{kind=?}`); an unbalanced opener swallows the rest of the list as one item,
 * which then fails the item grammar and lands in `unparsed` verbatim.
 */
export function splitList(list: string): string[] {
  const items: string[] = []
  let depth = 0
  let start = 0
  for (let i = 0; i < list.length; i++) {
    const c = list[i]
    if (c === '{' || c === '(') depth++
    else if (c === '}' || c === ')') depth = Math.max(0, depth - 1)
    else if (c === ',' && depth === 0 && list[i + 1] === ' ') {
      items.push(list.slice(start, i))
      start = i + 2
    }
  }
  items.push(list.slice(start))
  return items.map((s) => s.trim()).filter((s) => s.length > 0)
}

function pushUnique(into: string[], values: readonly string[]): void {
  for (const v of values) if (!into.includes(v)) into.push(v)
}

function messagesOf(list: unknown): string[] {
  if (!Array.isArray(list)) return []
  const out: string[] = []
  for (const item of list) {
    const text =
      typeof item === 'string'
        ? item
        : item &&
            typeof item === 'object' &&
            typeof (item as { message?: unknown }).message === 'string'
          ? (item as { message: string }).message
          : null
    if (text === null) continue
    out.push(text.length > MAX_MESSAGE_LEN ? `${text.slice(0, MAX_MESSAGE_LEN)}…` : text)
    if (out.length >= MAX_MESSAGES) break
  }
  return out
}

function emptyParsed(): ParsedReport {
  return {
    ok: false,
    success: false,
    type: null,
    hasContents: false,
    hasModule: false,
    hooks: [],
    calls: [],
    env: { reads: [], writes: [] },
    state: { reads: [], writes: [], foreignUnchecked: [] },
    unparsed: [],
    errors: [],
    warnings: []
  }
}

function parseNote(note: string, out: ParsedReport): boolean {
  const m = NOTE_RE.exec(note)
  if (!m?.groups) {
    out.unparsed.push(note)
    return false
  }
  const { file, label, list } = m.groups as { file: string; label: string; list: string }
  const items = list.trim() === 'nothing' ? [] : splitList(list)
  switch (label) {
    case 'hooks':
      for (const item of items) {
        const h = HOOK_ITEM_RE.exec(item)
        if (!h?.groups) {
          out.unparsed.push(`${file} ${label}: ${item}`)
          continue
        }
        const matcher = h.groups['matcher']
        out.hooks.push({
          file,
          event: h.groups['event'] as string,
          ...(matcher !== undefined ? { matcher } : {}),
          opaque: matcher !== undefined && matcher.includes('?')
        })
      }
      return true
    case 'calls':
      for (const item of items) {
        const c = CALL_ITEM_RE.exec(item)
        if (!c?.groups) {
          out.unparsed.push(`${file} ${label}: ${item}`)
          continue
        }
        const via = c.groups['via']
        out.calls.push({ file, op: c.groups['op'] as string, ...(via ? { via } : {}) })
      }
      return true
    case 'env reads':
      pushUnique(out.env.reads, items)
      return false
    case 'env writes':
      pushUnique(out.env.writes, items)
      return false
    case 'state reads':
      pushUnique(out.state.reads, items)
      return false
    case 'state writes':
      pushUnique(out.state.writes, items)
      return false
    default:
      pushUnique(out.state.foreignUnchecked, items)
      return false
  }
}

/** Parse one `claude plugin validate --json` report. Never throws. */
export function parseValidateReport(raw: unknown): ParsedReport {
  const out = emptyParsed()
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out
  const r = raw as Record<string, unknown>
  const manifest =
    r['manifest'] && typeof r['manifest'] === 'object'
      ? (r['manifest'] as Record<string, unknown>)
      : null
  const contents = Array.isArray(r['contents']) ? (r['contents'] as unknown[]) : null
  if (typeof r['success'] !== 'boolean' || (!manifest && !contents)) return out

  out.ok = true
  out.success = r['success']
  out.type = manifest && typeof manifest['type'] === 'string' ? manifest['type'] : null
  out.hasContents = contents !== null && contents.length > 0
  if (manifest) {
    out.errors.push(...messagesOf(manifest['errors']))
    out.warnings.push(...messagesOf(manifest['warnings']))
  }
  for (const entry of contents ?? []) {
    if (!entry || typeof entry !== 'object') continue
    const e = entry as Record<string, unknown>
    out.errors.push(...messagesOf(e['errors']))
    out.warnings.push(...messagesOf(e['warnings']))
    const notes = Array.isArray(e['notes']) ? e['notes'] : []
    let declaresHooksOrCalls = false
    for (const note of notes) {
      if (typeof note !== 'string') continue
      if (parseNote(note, out)) declaresHooksOrCalls = true
    }
    if (e['type'] === 'hooks' && declaresHooksOrCalls) out.hasModule = true
  }
  out.errors.splice(MAX_MESSAGES)
  out.warnings.splice(MAX_MESSAGES)
  return out
}

/**
 * The marketplace trap (smoke D2): a directory that also holds a `marketplace.json`
 * validates as a marketplace with `contents: []` and `success: true`. Returns the
 * `plugin.json` path for the one retry, or null when there is nothing to retry.
 */
export function retargetPath(
  parsed: ParsedReport,
  root: string,
  pluginJsonExists: boolean
): string | null {
  if (!parsed.ok || !pluginJsonExists) return null
  const trapped = (parsed.type !== null && parsed.type !== 'plugin') || !parsed.hasContents
  return trapped ? path.join(root, '.claude-plugin', 'plugin.json') : null
}

// ── capabilities ───────────────────────────────────────────────────────────

const OTHER_MODS_NOUNS = new Set(['http', 'env', 'store', 'state', 'fs'])

function globMatches(pattern: string, event: string): boolean {
  if (pattern === event) return true
  if (!pattern.includes('*')) return false
  const re = new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`)
  return re.test(event)
}

interface CapabilityFacts {
  hooks: readonly Pick<ModHook, 'event' | 'opaque'>[]
  calls: readonly Pick<ModCall, 'op'>[]
  env: { reads: readonly string[] }
}

/** The closed table of §7.5, in `CAPABILITY_ORDER`. */
export function deriveCapabilities(facts: CapabilityFacts): CapabilityId[] {
  const hooks = (...events: string[]): boolean =>
    facts.hooks.some((h) => events.some((e) => globMatches(h.event, e)))
  const calls = (...ops: string[]): boolean => facts.calls.some((c) => ops.includes(c.op))

  const has: Record<CapabilityId, boolean> = {
    process: calls('process.run', 'process.spawn'),
    network: calls('http.fetch'),
    files: facts.calls.some((c) => c.op.startsWith('fs.')),
    prompts: hooks('prompt.submit', 'turn.start', 'classic.UserPromptSubmit'),
    'system-prompt': hooks('prompt.compose', 'prompt.section', 'prompt.context'),
    'tool-calls': hooks('tool.call', 'classic.PreToolUse'),
    permissions: hooks('tool.check', 'classic.PermissionRequest'),
    submit: calls('prompt.submit', 'command.run', 'session.send'),
    model: calls('model.complete', 'model.fork', 'model.classify'),
    mcp: calls('mcp.call'),
    'other-mods': facts.hooks.some((h) => OTHER_MODS_NOUNS.has(h.event.split('.')[0] ?? '')),
    gate: hooks('plugin.register'),
    env: facts.env.reads.length > 0,
    terminal: hooks('ui.render'),
    opaque: facts.hooks.some((h) => h.opaque)
  }
  return CAPABILITY_ORDER.filter((id) => has[id])
}

// ── analysis record ────────────────────────────────────────────────────────

export interface AnalysisMeta {
  hash: string
  hashKind: 'content' | 'stat'
  cliVersion: string
  /** Epoch ms of the run. */
  now: number
  /** Why there is no report: the CLI rejected `validate`/`--json`, or the run failed. */
  outcome?: 'unsupported' | 'failed'
}

/**
 * Turn a parsed report into the stored analysis. `parsed` is null (or `ok: false`)
 * when the run produced nothing usable. `previous` is the earlier analysis of the
 * same row: a different hash there becomes `changedSince`.
 */
export function buildAnalysis(
  parsed: ParsedReport | null,
  meta: AnalysisMeta,
  previous: ModAnalysis | null
): ModAnalysis {
  const base = {
    hash: meta.hash,
    hashKind: meta.hashKind,
    analysedAt: meta.now,
    cliVersion: meta.cliVersion,
    ...(previous
      ? previous.hash !== meta.hash
        ? { changedSince: previous.analysedAt }
        : // same bytes (a forced refresh): the earlier change is still the last one
          previous.changedSince !== undefined
          ? { changedSince: previous.changedSince }
          : {}
      : {})
  }
  if (!parsed || !parsed.ok) {
    return {
      ...base,
      status: meta.outcome === 'unsupported' ? 'unsupported' : 'failed',
      hasModule: false,
      hooks: [],
      calls: [],
      env: { reads: [], writes: [] },
      state: { reads: [], writes: [], foreignUnchecked: [] },
      unparsed: [],
      errors: [],
      warnings: [],
      capabilities: []
    }
  }
  return {
    ...base,
    status: parsed.success ? 'ok' : 'invalid',
    hasModule: parsed.hasModule,
    hooks: parsed.hooks,
    calls: parsed.calls,
    env: parsed.env,
    state: parsed.state,
    unparsed: parsed.unparsed,
    errors: parsed.errors,
    warnings: parsed.warnings,
    capabilities: deriveCapabilities(parsed)
  }
}

// ── installed plugins (`claude plugin list --json`) ────────────────────────

export interface InstalledMod {
  id: string
  /** The part of `id` before `@`. */
  name: string
  version?: string
  scope?: ModScope
  enabled: boolean
  root: string
  loadsInFolder: 'yes' | 'no'
}

const SCOPE_PREFERENCE: readonly ModScope[] = ['user', 'synced', 'project', 'local']

function asScope(v: unknown): ModScope | undefined {
  return SCOPE_PREFERENCE.find((s) => s === v)
}

/**
 * One entry per `id` + `installPath` (the CLI repeats a plugin once per project it
 * is enabled for: 202 rows for 18 ids on the machine this was measured on). A plugin
 * loads when an enabled row is of `user`/`synced` scope, or is a `project`/`local`
 * row whose `projectPath` is this folder. Returns null when the output is not an
 * array (the shape changed): the caller drops the `installed` source.
 */
export function normalizeInstalled(raw: unknown, folder: string | null): InstalledMod[] | null {
  if (!Array.isArray(raw)) return null
  const forFolder = folder === null ? null : normRoot(folder)
  const groups = new Map<string, Record<string, unknown>[]>()
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const r = item as Record<string, unknown>
    if (typeof r['id'] !== 'string' || typeof r['installPath'] !== 'string') continue
    const k = `${r['id']}\u0000${r['installPath']}`
    const list = groups.get(k)
    if (list) list.push(r)
    else groups.set(k, [r])
  }

  const out: InstalledMod[] = []
  for (const rows of groups.values()) {
    const first = rows[0] as Record<string, unknown>
    const qualifying = rows.filter((r) => {
      if (r['enabled'] !== true) return false
      const scope = asScope(r['scope'])
      if (scope === 'user' || scope === 'synced') return true
      return (
        (scope === 'project' || scope === 'local') &&
        forFolder !== null &&
        typeof r['projectPath'] === 'string' &&
        normRoot(r['projectPath']) === forFolder
      )
    })
    const reported =
      qualifying.length > 0
        ? [...qualifying].sort(
            (a, b) =>
              SCOPE_PREFERENCE.indexOf(asScope(a['scope']) ?? 'local') -
              SCOPE_PREFERENCE.indexOf(asScope(b['scope']) ?? 'local')
          )[0]!
        : first
    const id = first['id'] as string
    const scope = asScope(reported['scope'])
    out.push({
      id,
      name: id.includes('@') ? id.slice(0, id.indexOf('@')) : id,
      ...(typeof first['version'] === 'string' ? { version: first['version'] } : {}),
      ...(scope ? { scope } : {}),
      enabled: qualifying.length > 0 ? true : first['enabled'] === true,
      root: normRoot(first['installPath'] as string),
      loadsInFolder: qualifying.length > 0 ? 'yes' : 'no'
    })
  }
  return out
}

// ── row planning ───────────────────────────────────────────────────────────

export const COMPANION_NAME = 'harnu-companion'
export const HARNU_SKILLS_NAME = 'harnu'

export interface RootCandidate {
  name: string
  root: string
}

export interface PlanInput {
  folder: string | null
  /** `ensureStaged()` of the companion (P1W2): null while it is absent. */
  harnuDir: string | null
  /** The staged bundled-skills plugin directory, only when it exists. */
  harnuSkillsDir: string | null
  installed: readonly InstalledMod[]
  skillsDirs: readonly RootCandidate[]
  bootDirs: readonly RootCandidate[]
}

/**
 * One row per resolved root, with the precedence harnu, harnu-skills, installed,
 * skills-dir, boot-arg. Installed plugins that cannot load in this scope are not
 * listed. Rows come back without analysis; the companion is first, then by name.
 */
export function planRows(input: PlanInput): ModRow[] {
  const seen = new Set<string>()
  const rows: ModRow[] = []
  const add = (row: Omit<ModRow, 'key' | 'analysis'>, idOrName: string): void => {
    const root = normRoot(row.root)
    if (seen.has(root)) return
    seen.add(root)
    rows.push({ ...row, root, key: rowKey(row.source, idOrName, root), analysis: null })
  }

  if (input.harnuDir) {
    add(
      {
        name: COMPANION_NAME,
        source: 'harnu',
        root: input.harnuDir,
        enabled: true,
        loadsInFolder: 'yes'
      },
      COMPANION_NAME
    )
  }
  if (input.harnuSkillsDir) {
    add(
      {
        name: HARNU_SKILLS_NAME,
        source: 'harnu-skills',
        root: input.harnuSkillsDir,
        enabled: true,
        loadsInFolder: 'yes'
      },
      HARNU_SKILLS_NAME
    )
  }
  for (const m of input.installed) {
    if (m.loadsInFolder !== 'yes') continue
    add(
      {
        name: m.name,
        id: m.id,
        source: 'installed',
        ...(m.scope ? { scope: m.scope } : {}),
        root: m.root,
        ...(m.version ? { version: m.version } : {}),
        enabled: m.enabled,
        loadsInFolder: 'yes'
      },
      m.id
    )
  }
  for (const c of input.skillsDirs) {
    add(
      { name: c.name, source: 'skills-dir', root: c.root, enabled: null, loadsInFolder: 'unknown' },
      c.name
    )
  }
  for (const c of input.bootDirs) {
    add(
      { name: c.name, source: 'boot-arg', root: c.root, enabled: null, loadsInFolder: 'yes' },
      c.name
    )
  }

  return rows.sort((a, b) => {
    if ((a.source === 'harnu') !== (b.source === 'harnu')) return a.source === 'harnu' ? -1 : 1
    return a.name.localeCompare(b.name) || a.root.localeCompare(b.root)
  })
}

// ── boot arguments and settings env ────────────────────────────────────────

/** `--plugin-dir <dir>` and `--plugin-dir=<dir>` tokens of a tokenised argv. */
export function pluginDirsFromArgs(tokens: readonly string[]): string[] {
  const out: string[] = []
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i] as string
    if (t === '--plugin-dir') {
      const next = tokens[i + 1]
      if (next && !next.startsWith('--')) {
        out.push(next)
        i++
      }
    } else if (t.startsWith('--plugin-dir=') && t.length > '--plugin-dir='.length) {
      out.push(t.slice('--plugin-dir='.length))
    }
  }
  return out
}

/** `CLAUDE_CODE_PLUGIN_DIRS`: absolute paths (`~` allowed) separated by the platform's list separator. */
export function pluginDirsFromEnvValue(value: unknown, home: string): string[] {
  if (typeof value !== 'string') return []
  return value
    .split(path.delimiter)
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
    .map((p) => (p === '~' ? home : p.startsWith('~/') ? path.join(home, p.slice(2)) : p))
    .filter((p) => path.isAbsolute(p))
}

// ── cache ──────────────────────────────────────────────────────────────────

export const MAX_CACHE_ENTRIES = 500

export interface CacheEntry {
  rowKey: string
  analysis: ModAnalysis
}

export interface CacheFile {
  v: 1
  entries: Record<string, CacheEntry>
}

export function emptyCache(): CacheFile {
  return { v: 1, entries: {} }
}

/** A corrupt or foreign file is an empty cache; a bad entry is dropped, not the file. */
export function parseCacheFile(text: string): CacheFile {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return emptyCache()
  }
  if (!raw || typeof raw !== 'object') return emptyCache()
  const r = raw as { v?: unknown; entries?: unknown }
  if (r.v !== 1 || !r.entries || typeof r.entries !== 'object' || Array.isArray(r.entries)) {
    return emptyCache()
  }
  const entries: Record<string, CacheEntry> = {}
  for (const [k, v] of Object.entries(r.entries as Record<string, unknown>)) {
    const e = v as Partial<CacheEntry> | null
    const a = e?.analysis
    if (
      e &&
      typeof e.rowKey === 'string' &&
      a &&
      typeof a === 'object' &&
      typeof a.hash === 'string' &&
      typeof a.analysedAt === 'number'
    ) {
      entries[k] = { rowKey: e.rowKey, analysis: a }
    }
  }
  return { v: 1, entries }
}

/** Keep the `max` most recently analysed entries. */
export function evictOldest(cache: CacheFile, max: number = MAX_CACHE_ENTRIES): CacheFile {
  const keys = Object.keys(cache.entries)
  if (keys.length <= max) return cache
  const newest = keys
    .sort((a, b) => cache.entries[b]!.analysis.analysedAt - cache.entries[a]!.analysis.analysedAt)
    .slice(0, max)
  const entries: Record<string, CacheEntry> = {}
  for (const k of newest) entries[k] = cache.entries[k]!
  return { v: 1, entries }
}

/** The newest stored analysis of a row: what a changed hash is compared against. */
export function previousAnalysisFor(cache: CacheFile, key: string): ModAnalysis | null {
  let best: ModAnalysis | null = null
  for (const e of Object.values(cache.entries)) {
    if (e.rowKey === key && (!best || e.analysis.analysedAt > best.analysedAt)) best = e.analysis
  }
  return best
}

// ── permissionHookers (master Q31) ─────────────────────────────────────────

/**
 * The rows that load in the folder, other than the companion, whose CACHED analysis
 * carries the `permissions` or `tool-calls` chip and still matches the directory's
 * current hash. Spawns nothing: a never-analysed or changed mod is not in the answer,
 * so this is a lower bound. `currentHashOf` returns null for a vanished directory.
 */
export function pickPermissionHookers(
  rows: readonly ModRow[],
  currentHashOf: (root: string) => string | null
): { name: string; root: string }[] {
  return rows
    .filter(
      (r) =>
        r.source !== 'harnu' &&
        r.loadsInFolder === 'yes' &&
        r.analysis !== null &&
        r.analysis.status === 'ok' &&
        currentHashOf(r.root) === r.analysis.hash &&
        (r.analysis.capabilities.includes('permissions') ||
          r.analysis.capabilities.includes('tool-calls'))
    )
    .map((r) => ({ name: r.name, root: r.root }))
}
