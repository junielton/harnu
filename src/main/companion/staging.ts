import { createHash } from 'node:crypto'
import { promises as fs, readFileSync, unlinkSync } from 'node:fs'
import path from 'node:path'
import { app } from 'electron'
import {
  devModeDecision,
  gcVictims,
  renderCoords,
  stageFileList,
  stageKeyFor,
  stageManifest,
  type Coords,
  type StageEntry
} from './staging-core'

/**
 * Immutable, versioned staging of the companion mod (P1W2 §7.3).
 *
 * Target: `<userData>/companion/<stageKey>/harnu-companion/`. A staged tree is never rewritten:
 * a write would hot-reload the mod in every live session that loaded it (smoke A5). A changed
 * source, a different data directory or a same-user edit stages a SIBLING key instead. This
 * file is fs glue (coverage-excluded); every decision is in `staging-core.ts`.
 */

const PLUGIN_DIR = 'harnu-companion'
const STAMP = '.stamp'
const TYPES_DIR = '.claude-plugin/types'
const KEY_RE = /^\d+\.\d+\.\d+(\.[0-9a-f]{8}(-\d+)?)?$/
const MAX_SIBLINGS = 8

export interface StagerDeps {
  userData: string
  /** The source folder: `resources/companion` (dev) or `<resources>/companion` (packaged). */
  resourceDir: string
  isPackaged: boolean
  /** `HARNU_COMPANION_DEV === '1'`, read by main, never by the mod (SEC-4). */
  devFlag: boolean
  now(): number
  pid: number
  isPidAlive(pid: number): boolean
  log(msg: string): void
}

const sha = (b: Buffer | string): string => createHash('sha256').update(b).digest('hex')
const posix = (p: string): string => p.split(path.sep).join('/')

async function walk(dir: string, base = dir): Promise<string[]> {
  const out: string[] = []
  for (const e of await fs.readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) out.push(...(await walk(p, base)))
    else if (e.isFile()) out.push(posix(path.relative(base, p)))
  }
  return out
}

/** Files of a STAGED tree that count toward its content digest (typings and stamp excluded). */
async function stagedFiles(dir: string): Promise<{ rel: string; sha256: string }[]> {
  const rels = (await walk(dir)).filter((r) => r !== STAMP && !r.startsWith(`${TYPES_DIR}/`))
  return Promise.all(
    rels.map(async (rel) => ({ rel, sha256: sha(await fs.readFile(path.join(dir, rel))) }))
  )
}

const contentDigest = (files: { rel: string; sha256: string }[]): string => stageManifest(files, '')

async function readStamp(dir: string): Promise<{ wanted: string; content: string } | null> {
  const raw = await fs.readFile(path.join(dir, STAMP), 'utf8').catch(() => null)
  if (raw === null) return null
  const [wanted, content] = raw.split('\n')
  return wanted && content ? { wanted, content } : null
}

export function createStager(deps: StagerDeps): {
  ensureStaged(): Promise<string | null>
  gc(): Promise<void>
  pinStagedDir(fn: () => string[]): void
} {
  const root = path.join(deps.userData, 'companion')
  const pins: Array<() => string[]> = []
  let failureLogged = false
  let chosen: { dir: string; wanted: string } | null = null
  let devDir: string | null = null
  let inflight: Promise<string | null> | null = null

  const fail = (err: unknown): null => {
    if (!failureLogged) {
      failureLogged = true
      deps.log(`[companion] staging failed: ${err instanceof Error ? err.message : String(err)}`)
    }
    return null
  }

  async function readSource(): Promise<{
    modVersion: string
    files: { rel: string; sha256: string; abs: string }[]
  }> {
    const manifest = JSON.parse(
      await fs.readFile(path.join(deps.resourceDir, '.claude-plugin', 'plugin.json'), 'utf8')
    ) as { version?: string }
    if (!manifest.version) throw new Error('plugin.json has no version')
    const rels = stageFileList(await walk(deps.resourceDir))
    const files = await Promise.all(
      rels.map(async (rel) => {
        const abs = path.join(deps.resourceDir, rel)
        return { rel, abs, sha256: sha(await fs.readFile(abs)) }
      })
    )
    return { modVersion: manifest.version, files }
  }

  const coordsFor = (modVersion: string, stagedAt: number): Coords => ({
    RENDEZVOUS_PATH: path.join(root, 'endpoint.json'),
    MOD_VERSION: modVersion,
    STAGED_AT: stagedAt
  })

  /** 'valid' = stamped with `wanted` and its files still hash to the stamp. */
  async function inspect(dir: string, wanted: string): Promise<'absent' | 'valid' | 'other'> {
    const stamp = await readStamp(dir)
    if (!stamp) return (await fs.stat(dir).catch(() => null)) ? 'other' : 'absent'
    if (stamp.wanted !== wanted) return 'other'
    const ok = contentDigest(await stagedFiles(dir).catch(() => [])) === stamp.content
    return ok ? 'valid' : 'other'
  }

  async function build(
    key: string,
    wanted: string,
    modVersion: string,
    files: { rel: string; abs: string }[]
  ): Promise<void> {
    await fs.mkdir(root, { recursive: true, mode: 0o700 })
    const tmp = path.join(root, `.tmp-${key}-${deps.pid}-${deps.now().toString(36)}`)
    const plugin = path.join(tmp, PLUGIN_DIR)
    try {
      await fs.rm(tmp, { recursive: true, force: true }).catch(() => {})
      for (const f of files) {
        const to = path.join(plugin, f.rel)
        await fs.mkdir(path.dirname(to), { recursive: true, mode: 0o700 })
        await fs.writeFile(to, await fs.readFile(f.abs), { mode: 0o600 })
      }
      const coordsPath = path.join(plugin, 'hooks', 'coords.gen.ts')
      await fs.mkdir(path.dirname(coordsPath), { recursive: true, mode: 0o700 })
      await fs.writeFile(coordsPath, renderCoords(coordsFor(modVersion, deps.now())), {
        mode: 0o600
      })
      const content = contentDigest(await stagedFiles(plugin))
      await fs.writeFile(path.join(plugin, STAMP), `${wanted}\n${content}\n`, { mode: 0o600 })
      for (const d of [tmp, plugin]) await fs.chmod(d, 0o700)
      await fs.rename(tmp, path.join(root, key))
    } finally {
      await fs.rm(tmp, { recursive: true, force: true }).catch(() => {})
    }
  }

  /**
   * Picks the stage directory for the current source and coordinates. With `create` false it
   * only LOOKS (garbage collection must not stage anything, least of all with the mode off) and
   * answers null when no valid directory exists yet.
   */
  async function select(create: boolean): Promise<string | null> {
    const { modVersion, files } = await readSource()
    // The digest covers the files and the coordinates; STAGED_AT is a timestamp, so it is
    // fixed at 0 here: otherwise every spawn would look like a changed stage.
    const wanted = stageManifest(files, renderCoords(coordsFor(modVersion, 0)))

    if (chosen && chosen.wanted === wanted && (await inspect(chosen.dir, wanted)) === 'valid') {
      return chosen.dir
    }

    const primary = await readStamp(path.join(root, modVersion, PLUGIN_DIR))
    const first = stageKeyFor(modVersion, wanted, primary?.wanted ?? null)
    const sibling = `${modVersion}.${wanted.slice(0, 8)}`
    const candidates = [first]
    if (first === modVersion) candidates.push(sibling)
    for (let n = 2; n <= MAX_SIBLINGS; n++) candidates.push(`${sibling}-${n}`)

    for (const key of [...new Set(candidates)]) {
      const dir = path.join(root, key, PLUGIN_DIR)
      const state = await inspect(dir, wanted)
      if (state === 'valid') return (chosen = { dir, wanted }).dir
      if (state === 'absent') {
        if (!create) return null
        await build(key, wanted, modVersion, files)
        if ((await inspect(dir, wanted)) === 'valid') return (chosen = { dir, wanted }).dir
        // lost a rename race against another process: try the next key
      }
    }
    if (!create) return null
    throw new Error('no usable stage directory')
  }

  async function devRepoFolder(): Promise<string | null> {
    const lockPath = path.join(deps.resourceDir, '.dev-lock')
    const raw = await fs.readFile(lockPath, 'utf8').catch(() => null)
    const pid = raw === null ? NaN : Number.parseInt(raw, 10)
    const decision = devModeDecision({
      flag: deps.devFlag,
      packaged: deps.isPackaged,
      lock: Number.isFinite(pid) ? { pid } : null,
      selfPid: deps.pid,
      pidAlive: deps.isPidAlive
    })
    if (decision.warn) deps.log(`[companion] ${decision.warn}`)
    if (decision.mode !== 'repo') return null
    if (devDir) return devDir
    const { modVersion } = await readSource()
    await fs.writeFile(lockPath, String(deps.pid))
    // STAGED_AT stays 0 in dev mode: a boot-time timestamp would rewrite the file (and reload
    // every live session) on each launch for nothing.
    const body = renderCoords(coordsFor(modVersion, 0))
    const target = path.join(deps.resourceDir, 'hooks', 'coords.gen.ts')
    const current = await fs.readFile(target, 'utf8').catch(() => null)
    if (current !== body) await fs.writeFile(target, body)
    process.once('exit', () => {
      try {
        if (readFileSync(lockPath, 'utf8') === String(deps.pid)) unlinkSync(lockPath)
      } catch {
        /* nothing to release */
      }
    })
    return (devDir = deps.resourceDir)
  }

  async function ensureStaged(): Promise<string | null> {
    if (inflight) return inflight
    inflight = (async () => {
      try {
        if (deps.devFlag && !deps.isPackaged) {
          const dev = await devRepoFolder()
          if (dev) return dev
        }
        return await select(true)
      } catch (err) {
        return fail(err)
      } finally {
        inflight = null
      }
    })()
    return inflight
  }

  async function gc(): Promise<void> {
    try {
      const current = deps.devFlag && !deps.isPackaged && devDir ? devDir : await select(false)
      const names = (await fs.readdir(root, { withFileTypes: true }).catch(() => []))
        .filter((e) => e.isDirectory() && KEY_RE.test(e.name))
        .map((e) => e.name)
      const entries: StageEntry[] = []
      for (const key of names) {
        const dir = path.join(root, key, PLUGIN_DIR)
        const st = await fs.stat(path.join(dir, STAMP)).catch(() => null)
        if (st) entries.push({ key, dir, stampMs: st.mtimeMs })
      }
      const pinnedDirs = pins.flatMap((fn) => {
        try {
          return fn()
        } catch {
          return []
        }
      })
      for (const key of gcVictims({
        entries,
        currentDir: current,
        pinnedDirs,
        nowMs: deps.now()
      })) {
        await fs.rm(path.join(root, key), { recursive: true, force: true }).catch(() => {})
      }
    } catch (err) {
      fail(err)
    }
  }

  return {
    ensureStaged,
    gc,
    pinStagedDir(fn) {
      pins.push(fn)
    }
  }
}

// ---- The app's one stager --------------------------------------------------------------

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

let appStager: ReturnType<typeof createStager> | null = null
const earlyPins: Array<() => string[]> = []

function stager(): ReturnType<typeof createStager> {
  if (appStager) return appStager
  appStager = createStager({
    userData: app.getPath('userData'),
    resourceDir: app.isPackaged
      ? path.join(process.resourcesPath, 'companion')
      : path.join(app.getAppPath(), 'resources', 'companion'),
    isPackaged: app.isPackaged,
    devFlag: process.env.HARNU_COMPANION_DEV === '1',
    now: () => Date.now(),
    pid: process.pid,
    isPidAlive,
    log: (m) => console.warn(m)
  })
  for (const fn of earlyPins) appStager.pinStagedDir(fn)
  return appStager
}

/**
 * The one interface other waves call for the staged directory (P4W1, P4W3). Memoised per app
 * run, re-validated per spawn. `null` means: spawn with no companion.
 */
export function ensureStaged(): Promise<string | null> {
  return stager().ensureStaged()
}

/** Boot-time collection of old stage directories. Never during a session. */
export function gcStagedDirs(): Promise<void> {
  return stager().gc()
}

/** Another holder (a spawn record, P4W3's install record) keeps a stage directory alive. */
export function pinStagedDir(fn: () => string[]): void {
  if (appStager) appStager.pinStagedDir(fn)
  else earlyPins.push(fn)
}
