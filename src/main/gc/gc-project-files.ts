// Where a folder pins its Docker Compose project name, beyond the root (T441 delta 3b, item
// 10). A compose file or an `.env` in `docker/` or `ops/prod/stack/` names the project just as
// the root ones do, so every `.env` and every `compose*.y*ml` / `docker-compose*.y*ml` down to
// depth 3 is read. `${VAR}` in a name is resolved from the `.env` beside it; a name that cannot
// be resolved marks the folder as unresolved, which the callers treat as "any volume may be
// this folder's" (fail closed). The walk is pure over an injected filesystem probe.

import { normalizeComposeProjectName } from './housekeeping-core'

export interface ProjectFile {
  path: string
  /** The folder the file lies in; an `.env` only resolves variables for files in its own folder. */
  dir: string
  kind: 'env' | 'compose'
  text: string
}

export interface FsProbe {
  readdir(dir: string): Promise<Array<{ name: string; isDir: boolean }>>
  /** Undefined when the file cannot be read or is too large to be a project file. */
  readFile(path: string): Promise<string | undefined>
}

export const MAX_DEPTH = 3
const MAX_FILES = 100
const MAX_ENTRIES_PER_DIR = 500
const SKIP_DIRS = new Set(['node_modules', 'vendor', '.git', '.venv'])

export const isEnvFile = (name: string): boolean => name === '.env'
export const isComposeFile = (name: string): boolean =>
  /^(docker-)?compose(\..+)?\.ya?ml$/.test(name)

export interface ProjectScan {
  files: ProjectFile[]
  /**
   * A cap cut the scan short: a folder with more entries than {@link MAX_ENTRIES_PER_DIR}, more
   * matching files than {@link MAX_FILES}, or a matching file that could not be read (too large,
   * or gone). What was not read may name a project, so the caller must not treat the files
   * found as the whole answer.
   */
  truncated: boolean
}

/**
 * Every `.env` and compose file under `root`, breadth first, to {@link MAX_DEPTH} levels, with
 * the skipped folders never entered. A folder that cannot be listed contributes nothing, as it
 * did before; a cap that cuts the scan short is reported in `truncated`, never swallowed.
 */
export async function scanProjectFiles(
  root: string,
  probe: FsProbe,
  maxDepth = MAX_DEPTH
): Promise<ProjectScan> {
  const out: ProjectFile[] = []
  let truncated = false
  let level: string[] = [root]
  for (let depth = 0; depth <= maxDepth && level.length > 0; depth++) {
    const next: string[] = []
    for (const dir of level) {
      let entries: Array<{ name: string; isDir: boolean }>
      try {
        entries = await probe.readdir(dir)
      } catch {
        continue
      }
      if (entries.length > MAX_ENTRIES_PER_DIR) {
        truncated = true
        entries = entries.slice(0, MAX_ENTRIES_PER_DIR)
      }
      for (const e of entries) {
        const path = `${dir}/${e.name}`
        if (e.isDir) {
          if (!SKIP_DIRS.has(e.name)) next.push(path)
          continue
        }
        const kind = isEnvFile(e.name) ? 'env' : isComposeFile(e.name) ? 'compose' : null
        if (!kind) continue
        if (out.length >= MAX_FILES) {
          truncated = true
          continue
        }
        const text = await probe.readFile(path)
        if (text === undefined) truncated = true
        else out.push({ path, dir, kind, text })
      }
    }
    level = next
  }
  return { files: out, truncated }
}

/** The files alone, for callers that do not care whether a cap cut the scan short. */
export async function collectProjectFiles(
  root: string,
  probe: FsProbe,
  maxDepth = MAX_DEPTH
): Promise<ProjectFile[]> {
  return (await scanProjectFiles(root, probe, maxDepth)).files
}

// ---- values ------------------------------------------------------------------------------

const ENV_ASSIGN = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/
const NAME_LINE = /^name:\s*(.*)$/
const INTERPOLATED = /^\$\{([A-Za-z_][A-Za-z0-9_]*)(?::?-([^}]*))?\}$/

/**
 * Strips a trailing comment and surrounding quotes. A value that is `${VAR}` or
 * `${VAR:-default}` takes VAR from `vars`, then the default; anything else with a `$`, and a
 * variable with neither, cannot be resolved (null).
 */
export function readValue(raw: string, vars: Readonly<Record<string, string>> = {}): string | null {
  let v = raw.trim()
  const quote = v[0] === '"' || v[0] === "'" ? v[0] : null
  if (quote) {
    const end = v.indexOf(quote, 1)
    v = end > 0 ? v.slice(1, end) : v.slice(1)
  } else {
    const hash = v.search(/\s#/)
    if (hash >= 0) v = v.slice(0, hash)
    v = v.trim()
  }
  if (!v.includes('$')) return v
  const m = INTERPOLATED.exec(v)
  if (!m) return null
  const given = vars[m[1]!]
  if (given !== undefined && given !== '') return given
  return m[2] !== undefined && m[2].trim() !== '' ? m[2].trim() : null
}

/** Every `KEY=value` of an `.env`, values already stripped of quotes and comments. */
export function parseEnvVars(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of text.split(/\r?\n/)) {
    const m = ENV_ASSIGN.exec(line)
    if (!m || line.trimStart().startsWith('#')) continue
    const value = readValue(m[2]!)
    if (value !== null) out[m[1]!] = value
  }
  return out
}

export interface ProjectNames {
  /** Normalized the way compose normalizes them. */
  names: string[]
  /** A name was written that could not be resolved. */
  unresolved: boolean
}

/**
 * The project names a set of files pins: `COMPOSE_PROJECT_NAME` of each `.env` and the
 * top-level `name:` of each compose file, with `${VAR}` taken from the `.env` of the same
 * folder only. Both an env and a compose name are returned when both exist, since which one
 * wins depends on how compose is run and protecting too much is the safe direction.
 */
export function projectNamesFromFiles(files: readonly ProjectFile[]): ProjectNames {
  const varsByDir = new Map<string, Record<string, string>>()
  for (const f of files) {
    if (f.kind === 'env') varsByDir.set(f.dir, { ...varsByDir.get(f.dir), ...parseEnvVars(f.text) })
  }
  const names = new Set<string>()
  let unresolved = false
  const add = (raw: string, dir: string): void => {
    const value = readValue(raw, varsByDir.get(dir))
    const name = value === null ? '' : normalizeComposeProjectName(value)
    if (value === null) unresolved = true
    else if (name) names.add(name)
  }
  for (const f of files) {
    for (const line of f.text.split(/\r?\n/)) {
      if (f.kind === 'env') {
        const m = ENV_ASSIGN.exec(line)
        if (m && m[1] === 'COMPOSE_PROJECT_NAME' && !line.trimStart().startsWith('#'))
          add(m[2]!, f.dir)
      } else {
        const m = NAME_LINE.exec(line)
        if (m) add(m[1]!, f.dir)
      }
    }
  }
  return { names: [...names], unresolved }
}
