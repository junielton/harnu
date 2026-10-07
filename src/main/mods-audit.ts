/**
 * T389 P4W1 part A — shell of the Mods audit pane (Settings → Mods).
 *
 * Finds the mods a session started in a folder can load (five sources, spec §7.2),
 * hashes each plugin directory, asks the CLI for a static read of it
 * (`claude plugin validate --json`) and caches the answer by content hash + CLI
 * version. Every decision lives in the pure `mods-audit-core.ts`; this file only
 * touches the filesystem, runs processes and carries IPC.
 *
 * The audit is read-only and static: nothing here enables, disables, installs or
 * removes a mod, and nothing runs a mod. The renderer passes ROW KEYS, never
 * paths; main resolves a key against its own last listing, so no caller can make
 * Harnu run the CLI on a directory it did not discover itself (P4W1-S3).
 */
import { app, BrowserWindow, ipcMain } from 'electron'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { sanitizeSpawnEnv } from './appimage-env'
import { tokenizeArgs } from './claude-args'
import { resolveClaudePath } from './claude-cli'
import { getResolvedConfig } from './claude-config'
import { readClaudeSettings } from './claude-settings'
import { stagedPluginDir } from './bundled-skills'
import {
  buildAnalysis,
  cacheKey,
  emptyCache,
  evictOldest,
  normRoot,
  normalizeInstalled,
  parseCacheFile,
  parseValidateReport,
  pickPermissionHookers,
  planRows,
  pluginDirsFromArgs,
  pluginDirsFromEnvValue,
  previousAnalysisFor,
  retargetPath,
  type CacheFile,
  type InstalledMod,
  type ModAnalysis,
  type ModRow,
  type ModsAuditView,
  type ParsedReport,
  type PolicyState,
  type RootCandidate
} from './mods-audit-core'

export type { ModRow, ModsAuditView } from './mods-audit-core'

const VALIDATE_TIMEOUT_MS = 10_000
const LIST_TIMEOUT_MS = 10_000
const VERSION_TIMEOUT_MS = 5_000
const MAX_BUFFER = 4 << 20
const MAX_ROWS = 200
const CONCURRENCY = 2
const HASH_MAX_FILES = 2_000
const HASH_MAX_BYTES = 16 << 20

/** Result of one CLI run. Exit codes 0 and 1 both carry a validate report. */
export interface CliResult {
  stdout: string
  stderr: string
  code: number | null
  timedOut: boolean
  spawnError: boolean
}

export interface BootFacts {
  extraArgs?: string
  safeMode?: boolean
  bare?: boolean
}

/** Everything the service needs from the outside, so tests run it on real temp dirs. */
export interface ModsAuditDeps {
  resolveClaude: () => Promise<string | null>
  runCli: (bin: string, args: string[], opts: { timeoutMs: number }) => Promise<CliResult>
  now: () => number
  home: () => string
  cachePath: string
  /** `ensureStaged()` of the companion (P1W2): null while absent. */
  companionDir: () => Promise<string | null>
  /** The folder's staged bundled-skills plugin directory (it may not exist). */
  harnuSkillsDir: (folder: string) => Promise<string | null>
  /** The folder's resolved Claude Boot facts. */
  readBoot: (folder: string) => Promise<BootFacts>
  /** `env.CLAUDE_CODE_PLUGIN_DIRS` of `~/.claude/settings.json`. */
  settingsPluginDirs: () => Promise<string | undefined>
  /** The shared policy probe (P1W4); `unknown` while it is absent. */
  policy: () => Promise<PolicyState>
  emitRow: (row: ModRow) => void
}

// ── filesystem helpers ─────────────────────────────────────────────────────

/** Resolved directory, or null when it is gone or not a directory. */
async function resolveDir(p: string): Promise<string | null> {
  try {
    const real = await fs.realpath(p)
    return (await fs.stat(real)).isDirectory() ? normRoot(real) : null
  } catch {
    return null
  }
}

async function readPluginName(root: string): Promise<string | null> {
  try {
    const j = JSON.parse(
      await fs.readFile(path.join(root, '.claude-plugin', 'plugin.json'), 'utf8')
    )
    return j && typeof j.name === 'string' && j.name.length > 0 ? j.name : null
  } catch {
    return null
  }
}

async function exists(p: string): Promise<boolean> {
  return fs
    .access(p)
    .then(() => true)
    .catch(() => false)
}

const HASH_SKIP = new Set(['.git', 'node_modules'])

interface FileEntry {
  rel: string
  abs: string
  size: number
  mtimeMs: number
  link: string | null
}

async function walk(root: string, rel: string, out: FileEntry[]): Promise<void> {
  let names: string[]
  try {
    names = await fs.readdir(path.join(root, rel))
  } catch {
    return
  }
  for (const name of names) {
    const childRel = rel === '' ? name : `${rel}/${name}`
    if (HASH_SKIP.has(name)) continue
    // `.claude-plugin/types/` appears only after a session loaded the mod (smoke D3)
    if (childRel === '.claude-plugin/types') continue
    const abs = path.join(root, childRel)
    let st
    try {
      st = await fs.lstat(abs)
    } catch {
      continue
    }
    if (st.isDirectory()) await walk(root, childRel, out)
    else {
      const link = st.isSymbolicLink() ? await fs.readlink(abs).catch(() => '') : null
      out.push({ rel: childRel, abs, size: st.size, mtimeMs: st.mtimeMs, link })
    }
    if (out.length > HASH_MAX_FILES) return
  }
}

/**
 * Content hash of a plugin directory: sha256 over the sorted
 * `(relative path, size, sha256 of bytes)` list. Over 2 000 files or 16 MiB it hashes
 * `(relative path, size, mtimeMs)` instead. Null when the directory is gone.
 */
export async function hashPluginDir(
  root: string
): Promise<{ hash: string; hashKind: 'content' | 'stat' } | null> {
  if (!(await resolveDir(root))) return null
  const files: FileEntry[] = []
  await walk(root, '', files)
  files.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0))
  const total = files.reduce((n, f) => n + f.size, 0)
  const statOnly = files.length > HASH_MAX_FILES || total > HASH_MAX_BYTES
  const h = createHash('sha256')
  for (const f of files) {
    if (statOnly) {
      h.update(`${f.rel}\u0000${f.size}\u0000${f.mtimeMs}\n`)
    } else if (f.link !== null) {
      h.update(`${f.rel}\u0000link\u0000${f.link}\n`)
    } else {
      const bytes = await fs.readFile(f.abs).catch(() => Buffer.alloc(0))
      h.update(`${f.rel}\u0000${f.size}\u0000${createHash('sha256').update(bytes).digest('hex')}\n`)
    }
  }
  return { hash: h.digest('hex'), hashKind: statOnly ? 'stat' : 'content' }
}

async function candidatesUnder(dir: string): Promise<RootCandidate[]> {
  let names: string[]
  try {
    names = await fs.readdir(dir)
  } catch {
    return []
  }
  const out: RootCandidate[] = []
  for (const n of names.sort()) {
    const root = await resolveDir(path.join(dir, n))
    if (!root || !(await exists(path.join(root, '.claude-plugin', 'plugin.json')))) continue
    out.push({ name: (await readPluginName(root)) ?? n, root })
  }
  return out
}

async function namedCandidates(
  paths: readonly string[],
  base: string | null
): Promise<RootCandidate[]> {
  const out: RootCandidate[] = []
  for (const p of paths) {
    const abs = path.isAbsolute(p) ? p : base ? path.resolve(base, p) : null
    if (!abs) continue
    const root = await resolveDir(abs)
    if (!root) continue
    out.push({ name: (await readPluginName(root)) ?? path.basename(root), root })
  }
  return out
}

// ── cli helpers ────────────────────────────────────────────────────────────

const UNSUPPORTED_RE = /unknown (command|option)|unrecognized|too many arguments|did you mean/i

function tryJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

function versionOf(stdout: string): string {
  return /(\d+\.\d+\.\d+\S*)/.exec(stdout)?.[1] ?? 'unknown'
}

// ── service ────────────────────────────────────────────────────────────────

interface Listing {
  bin: string
  cliVersion: string
  rows: ModRow[]
}

interface Job {
  row: ModRow
  listing: Listing
  force: boolean
}

export interface ModsAuditService {
  list: (folder: string | null) => Promise<ModsAuditView>
  analyse: (req: {
    folder: string | null
    keys?: string[]
    force?: boolean
  }) => Promise<{ queued: number }>
  /** Resolves when no analysis is running or waiting. */
  idle: () => Promise<void>
  /** Master Q31: rows that load in the folder and can decide a permission, from the cache only. */
  permissionHookers: (folder: string | null) => Promise<{ name: string; root: string }[]>
}

export function createModsAudit(deps: ModsAuditDeps): ModsAuditService {
  const listings = new Map<string, Listing>()
  const versions = new Map<string, string>()
  let cache: CacheFile | null = null
  let persistChain: Promise<void> = Promise.resolve()
  const pending: Job[] = []
  let active = 0
  let idleWaiters: (() => void)[] = []

  const folderKey = (folder: string | null): string => folder ?? '\u0000global'

  async function loadCache(): Promise<CacheFile> {
    if (cache) return cache
    try {
      cache = parseCacheFile(await fs.readFile(deps.cachePath, 'utf8'))
    } catch {
      cache = emptyCache()
    }
    return cache
  }

  function persist(): void {
    const snapshot = JSON.stringify(cache ?? emptyCache())
    persistChain = persistChain
      .then(async () => {
        await fs.mkdir(path.dirname(deps.cachePath), { recursive: true })
        const tmp = `${deps.cachePath}.${process.pid}.tmp`
        await fs.writeFile(tmp, snapshot)
        await fs.rename(tmp, deps.cachePath)
      })
      .catch(() => {})
  }

  async function cliVersion(bin: string): Promise<string> {
    const known = versions.get(bin)
    if (known) return known
    const r = await deps.runCli(bin, ['--version'], { timeoutMs: VERSION_TIMEOUT_MS })
    const v = r.spawnError || r.timedOut ? 'unknown' : versionOf(r.stdout)
    versions.set(bin, v)
    return v
  }

  async function discover(
    bin: string,
    folder: string | null
  ): Promise<{ rows: ModRow[]; installedUnreadable: boolean; safeMode: boolean }> {
    const home = deps.home()
    const boot: BootFacts = folder ? await deps.readBoot(folder).catch(() => ({})) : {}

    // installed marketplace plugins
    let installedUnreadable = false
    let installed: InstalledMod[] = []
    const listRun = await deps.runCli(bin, ['plugin', 'list', '--json'], {
      timeoutMs: LIST_TIMEOUT_MS
    })
    const normalised =
      listRun.spawnError || listRun.timedOut || listRun.code !== 0
        ? null
        : normalizeInstalled(tryJson(listRun.stdout), folder)
    if (normalised === null) installedUnreadable = true
    else installed = normalised
    const present: InstalledMod[] = []
    for (const m of installed) {
      const root = await resolveDir(m.root)
      if (root) present.push({ ...m, root })
    }

    // the companion and the staged skills
    const companion = await deps.companionDir().catch(() => null)
    const harnuDir = companion ? await resolveDir(companion) : null
    const stagedSkills = folder ? await deps.harnuSkillsDir(folder).catch(() => null) : null
    const harnuSkillsDir = stagedSkills ? await resolveDir(stagedSkills) : null

    // skills folders, then --plugin-dir sources
    const skillsDirs = [
      ...(await candidatesUnder(path.join(home, '.claude', 'skills'))),
      ...(folder ? await candidatesUnder(path.join(folder, '.claude', 'skills')) : [])
    ]
    const envDirs = pluginDirsFromEnvValue(
      await deps.settingsPluginDirs().catch(() => undefined),
      home
    )
    const bootArgDirs = folder ? pluginDirsFromArgs(tokenizeArgs(boot.extraArgs ?? '')) : []
    const bootDirs = [
      ...(await namedCandidates(
        bootArgDirs.map((p) => expandHome(p, home)),
        folder
      )),
      ...(await namedCandidates(envDirs, null))
    ]

    const rows = planRows({
      folder,
      harnuDir,
      harnuSkillsDir,
      installed: present,
      skillsDirs,
      bootDirs
    }).slice(0, MAX_ROWS)
    return {
      rows,
      installedUnreadable,
      safeMode: folder !== null && (boot.safeMode === true || boot.bare === true)
    }
  }

  async function list(folder: string | null): Promise<ModsAuditView> {
    const bin = await deps.resolveClaude()
    if (!bin) {
      listings.delete(folderKey(folder))
      return {
        cli: { path: null, version: null },
        policy: 'unknown',
        rows: [],
        withoutModule: 0,
        installedUnreadable: false,
        safeMode: false,
        listedAt: deps.now()
      }
    }
    const version = await cliVersion(bin)
    const [found, policy, store] = await Promise.all([
      discover(bin, folder),
      deps.policy().catch((): PolicyState => 'unknown'),
      loadCache()
    ])

    let withoutModule = 0
    const rows: ModRow[] = []
    for (const row of found.rows) {
      const hashed = await hashPluginDir(row.root)
      const hit = hashed ? store.entries[cacheKey(hashed.hash, version)] : undefined
      const analysis = hit?.analysis ?? null
      if (analysis && analysis.status === 'ok' && !analysis.hasModule) {
        withoutModule++
        continue
      }
      rows.push({ ...row, analysis })
    }
    listings.set(folderKey(folder), { bin, cliVersion: version, rows })
    return {
      cli: { path: bin, version },
      policy,
      rows,
      withoutModule,
      installedUnreadable: found.installedUnreadable,
      safeMode: found.safeMode,
      listedAt: deps.now()
    }
  }

  // ── analysis queue ───────────────────────────────────────────────────────

  function notifyIfIdle(): void {
    if (active === 0 && pending.length === 0) {
      const waiters = idleWaiters
      idleWaiters = []
      for (const w of waiters) w()
    }
  }

  function pump(): void {
    while (active < CONCURRENCY && pending.length > 0) {
      const job = pending.shift() as Job
      active++
      void runJob(job)
        .catch(() => {})
        .finally(() => {
          active--
          pump()
          notifyIfIdle()
        })
    }
  }

  async function validate(
    bin: string,
    target: string
  ): Promise<{ parsed: ParsedReport | null; outcome: 'unsupported' | 'failed' }> {
    const r = await deps.runCli(bin, ['plugin', 'validate', target, '--json'], {
      timeoutMs: VALIDATE_TIMEOUT_MS
    })
    if (r.spawnError || r.timedOut) return { parsed: null, outcome: 'failed' }
    const parsed = parseValidateReport(tryJson(r.stdout))
    if (parsed.ok) return { parsed, outcome: 'failed' }
    return {
      parsed: null,
      outcome: UNSUPPORTED_RE.test(`${r.stderr}\n${r.stdout}`) ? 'unsupported' : 'failed'
    }
  }

  async function runJob({ row, listing, force }: Job): Promise<void> {
    const store = await loadCache()
    const settle = (analysis: ModAnalysis): void => {
      const next = { ...row, analysis }
      const i = listing.rows.findIndex((r) => r.key === row.key)
      if (i >= 0) listing.rows[i] = next
      deps.emitRow(next)
    }
    const meta = { cliVersion: listing.cliVersion, now: deps.now() }
    const hashed = await hashPluginDir(row.root)
    if (!hashed) {
      settle(
        buildAnalysis(null, { ...meta, hash: '', hashKind: 'content', outcome: 'failed' }, null)
      )
      return
    }
    const key = cacheKey(hashed.hash, listing.cliVersion)
    const hit = store.entries[key]
    if (!force && hit) {
      settle(hit.analysis)
      return
    }

    let run = await validate(listing.bin, row.root)
    if (run.parsed) {
      const retry = retargetPath(
        run.parsed,
        row.root,
        await exists(path.join(row.root, '.claude-plugin', 'plugin.json'))
      )
      if (retry) run = await validate(listing.bin, retry)
    }
    const analysis = buildAnalysis(
      run.parsed,
      { ...meta, ...hashed, now: deps.now(), outcome: run.outcome },
      previousAnalysisFor(store, row.key)
    )
    // a failed or unsupported run is not cached: Retry, or the next CLI, tries again
    if (analysis.status === 'ok' || analysis.status === 'invalid') {
      // merge into the CURRENT cache: another job may have stored since this one started
      cache = evictOldest({
        v: 1,
        entries: { ...(cache ?? store).entries, [key]: { rowKey: row.key, analysis } }
      })
      persist()
    }
    settle(analysis)
  }

  async function analyse(req: {
    folder: string | null
    keys?: string[]
    force?: boolean
  }): Promise<{ queued: number }> {
    const listing = listings.get(folderKey(req.folder ?? null))
    if (!listing) return { queued: 0 }
    const force = req.force === true
    let rows: ModRow[]
    if (Array.isArray(req.keys)) {
      const wanted = new Set(req.keys.filter((k): k is string => typeof k === 'string'))
      rows = listing.rows.filter((r) => wanted.has(r.key))
    } else {
      rows = listing.rows.filter((r) => force || r.analysis === null)
    }
    const queuedKeys = new Set(pending.map((j) => j.row.key))
    let queued = 0
    for (const row of rows) {
      if (queuedKeys.has(row.key)) continue
      pending.push({ row, listing, force })
      queued++
    }
    pump()
    return { queued }
  }

  function idle(): Promise<void> {
    if (active === 0 && pending.length === 0) return persistChain
    return new Promise<void>((resolve) => idleWaiters.push(resolve)).then(() => persistChain)
  }

  async function permissionHookers(
    folder: string | null
  ): Promise<{ name: string; root: string }[]> {
    const listing = listings.get(folderKey(folder))
    if (!listing) return []
    const current = new Map<string, string | null>()
    for (const r of listing.rows) {
      if (r.analysis) current.set(r.root, (await hashPluginDir(r.root))?.hash ?? null)
    }
    return pickPermissionHookers(listing.rows, (root) => current.get(root) ?? null)
  }

  return { list, analyse, idle, permissionHookers }
}

function expandHome(p: string, home: string): string {
  return p === '~' ? home : p.startsWith('~/') ? path.join(home, p.slice(2)) : p
}

// ── providers owned by other waves ─────────────────────────────────────────

let companionProvider: (() => Promise<string | null>) | null = null
let policyProvider: (() => Promise<PolicyState>) | null = null

/** P1W2 registers `ensureStaged` here. Until it does, the companion row is absent. */
export function setModsAuditCompanionProvider(fn: (() => Promise<string | null>) | null): void {
  companionProvider = fn
}

/** P1W4 registers the shared policy probe here. Until it does the pane reports `unknown`. */
export function setModsAuditPolicyProvider(fn: (() => Promise<PolicyState>) | null): void {
  policyProvider = fn
}

// ── real wiring ────────────────────────────────────────────────────────────

function runCli(bin: string, args: string[], opts: { timeoutMs: number }): Promise<CliResult> {
  return new Promise((resolve) => {
    // Neutral cwd and a sanitised env, like usage.ts: a project's CLAUDE.md and hooks
    // are not loaded, and an AppImage's $APPDIR-rooted PATH does not leak into the child.
    execFile(
      bin,
      args,
      {
        cwd: os.homedir(),
        env: sanitizeSpawnEnv(process.env, { execPath: process.execPath }),
        timeout: opts.timeoutMs,
        maxBuffer: MAX_BUFFER,
        encoding: 'utf8'
      },
      (err, stdout, stderr) => {
        if (!err) {
          resolve({ stdout, stderr, code: 0, timedOut: false, spawnError: false })
          return
        }
        const e = err as unknown as { killed?: boolean; code?: number | string }
        const exited = typeof e.code === 'number'
        resolve({
          stdout: stdout ?? '',
          stderr: stderr ?? '',
          code: exited ? (e.code as number) : null,
          timedOut: e.killed === true,
          spawnError: !exited && e.killed !== true
        })
      }
    )
  })
}

let service: ModsAuditService | null = null

function realService(): ModsAuditService {
  if (service) return service
  service = createModsAudit({
    resolveClaude: resolveClaudePath,
    runCli,
    now: () => Date.now(),
    home: () => os.homedir(),
    cachePath: path.join(app.getPath('userData'), 'mods-audit-cache.json'),
    companionDir: async () => (companionProvider ? companionProvider() : null),
    harnuSkillsDir: async (folder) => stagedPluginDir(folder),
    readBoot: async (folder) => {
      const cfg = await getResolvedConfig(folder)
      return { extraArgs: cfg.extraArgs, safeMode: cfg.safeMode, bare: cfg.bare }
    },
    settingsPluginDirs: async () => {
      const settings = await readClaudeSettings(path.join(os.homedir(), '.claude', 'settings.json'))
      const env = settings['env']
      const v =
        env && typeof env === 'object'
          ? (env as Record<string, unknown>)['CLAUDE_CODE_PLUGIN_DIRS']
          : undefined
      return typeof v === 'string' ? v : undefined
    },
    policy: async () => (policyProvider ? policyProvider() : 'unknown'),
    emitRow: (row) => {
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) win.webContents.send('modsAudit:row', row)
      }
    }
  })
  return service
}

/** The cached-analysis answer P3W1 needs (master Q31): a lower bound, never spawns. */
export function permissionHookers(
  folder: string | null
): Promise<{ name: string; root: string }[]> {
  return realService().permissionHookers(folder)
}

export function registerModsAuditHandlers(): void {
  ipcMain.handle('modsAudit:list', (_e, folder: unknown): Promise<ModsAuditView> =>
    realService().list(typeof folder === 'string' && folder.length > 0 ? folder : null)
  )
  ipcMain.handle(
    'modsAudit:analyse',
    (_e, req: { folder?: unknown; keys?: unknown; force?: unknown } | null) =>
      realService().analyse({
        folder: typeof req?.folder === 'string' && req.folder.length > 0 ? req.folder : null,
        keys: Array.isArray(req?.keys)
          ? (req.keys as unknown[]).filter((k): k is string => typeof k === 'string')
          : undefined,
        force: req?.force === true
      })
  )
}
