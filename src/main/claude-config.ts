import { app, ipcMain } from 'electron'
import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import {
  buildClaudeArgs,
  mergeBootConfig,
  type ClaudeBootConfig,
  type EndpointProfile
} from './claude-args'

/**
 * "Claude Boot" config persistence (global + per-folder launch options) plus
 * the global custom-endpoint registry (local-provider-endpoints spec).
 *
 * Owns `<userData>/claude-boot.json`:
 *
 *   { version: 2,
 *     global: ClaudeBootConfig,
 *     folders: { <normPath>: ClaudeBootConfig },
 *     endpoints: EndpointProfile[] }
 *
 * Per-folder config is keyed by a **deterministic normalized absolute path**
 * (`folderKey` — pure, no `fs.realpath`, so save-key === load-key always), NOT by
 * the pinned-projects list — so it applies to every folder, including
 * auto-discovered ones from `~/.claude/projects/`.
 *
 * The spawn path (`pty.ts`) calls {@link resolveClaudeBootArgs} which reads the
 * file fresh on every launch (spawns are infrequent; reading per-spawn keeps the
 * config live after edits), merges global ⊕ folder ⊕ the app-managed base args
 * to build the argv, AND resolves the merged `provider` against the registry to
 * the `ANTHROPIC_*` env vars the spawn injects. No CLI flag carries the provider.
 */

export interface ClaudeBootFile {
  version: 2
  global: ClaudeBootConfig
  folders: Record<string, ClaudeBootConfig>
  endpoints: EndpointProfile[]
}

const FILE_NAME = 'claude-boot.json'
const TMP_SUFFIX = '.tmp'

function bootFilePath(): string {
  return path.join(app.getPath('userData'), FILE_NAME)
}

/**
 * Deterministic key for a folder's per-folder config.
 *
 * IMPORTANT: this is **pure + synchronous** — `~` expansion + `path.resolve` +
 * `path.normalize` + trailing-separator strip, and deliberately NO `fs.realpath`.
 * The old key used `user-projects.normalizePath`, whose final `fs.realpath`
 * *falls back to the unresolved path on any error* — so the key could differ
 * between the save call and a later load/spawn call (symlinked path component, a
 * transient realpath failure, or the folder briefly missing), silently dropping
 * the folder override. Every caller (dialog save/load, spawn cwd) passes the same
 * folder-path string, so a deterministic string→key mapping round-trips reliably.
 *
 * Exported (T97): the routing-policy per-folder store (`routing-policy.ts`)
 * reuses this EXACT key so a folder's Claude Boot config and its routing table
 * never drift apart on a symlink/realpath edge case.
 */
export function folderKey(input: string): string {
  const expanded = input.startsWith('~') ? path.join(os.homedir(), input.slice(1)) : input
  const normalized = path.normalize(path.resolve(expanded))
  if (normalized.length <= 1) return normalized
  if (process.platform === 'win32' && /^[A-Za-z]:\\$/.test(normalized)) return normalized
  return normalized.endsWith(path.sep) ? normalized.slice(0, -1) : normalized
}

function emptyFile(): ClaudeBootFile {
  return { version: 2, global: {}, folders: {}, endpoints: [] }
}

/** Coerce a persisted blob (v1 or v2) into the current v2 shape. */
function sanitizeEndpoints(raw: unknown): EndpointProfile[] {
  if (!Array.isArray(raw)) return []
  const out: EndpointProfile[] = []
  for (const e of raw) {
    if (!e || typeof e !== 'object') continue
    const { id, name, baseUrl, model, authToken } = e as Partial<EndpointProfile>
    if (typeof id !== 'string' || !id) continue
    if (typeof baseUrl !== 'string' || !baseUrl) continue
    out.push({
      id,
      name: typeof name === 'string' && name ? name : baseUrl,
      baseUrl,
      ...(typeof model === 'string' && model ? { model } : {}),
      ...(typeof authToken === 'string' && authToken ? { authToken } : {})
    })
  }
  return out
}

/**
 * Read + parse. Never throws — a missing/corrupt file degrades to empty.
 * Migrates a v1 file (no `endpoints`) to v2 in memory; the next write persists
 * the bump. Anything with an unknown version is treated as empty (safe reset).
 */
export async function readBootFile(): Promise<ClaudeBootFile> {
  let raw: string
  try {
    raw = await fs.readFile(bootFilePath(), 'utf8')
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code !== 'ENOENT') console.warn('[claude-config] read failed:', err)
    return emptyFile()
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown> | null
    // v1 and v2 share the global/folders shape; v2 adds `endpoints`. Accept
    // both and normalize forward — an unrecognized version resets to empty.
    const version = parsed?.version
    if (!parsed || typeof parsed !== 'object' || (version !== 1 && version !== 2)) {
      return emptyFile()
    }
    return {
      version: 2,
      global:
        parsed.global && typeof parsed.global === 'object'
          ? (parsed.global as ClaudeBootConfig)
          : {},
      folders:
        parsed.folders && typeof parsed.folders === 'object'
          ? (parsed.folders as Record<string, ClaudeBootConfig>)
          : {},
      endpoints: sanitizeEndpoints(parsed.endpoints)
    }
  } catch (err) {
    console.warn('[claude-config] corrupt JSON:', err)
    return emptyFile()
  }
}

/** Atomic write (tmp + rename). */
async function writeBootFile(file: ClaudeBootFile): Promise<void> {
  const fp = bootFilePath()
  await fs.mkdir(path.dirname(fp), { recursive: true })
  const tmp = fp + TMP_SUFFIX
  // Endpoint auth tokens live in this file — write it 0600 (owner-only) so a
  // plaintext API key isn't world-readable in the user's data dir.
  await fs.writeFile(tmp, JSON.stringify(file, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 })
  await fs.rename(tmp, fp)
}

/** True when a config has no meaningful (non-empty) value — so we can prune it. */
function isEmptyConfig(cfg: ClaudeBootConfig): boolean {
  return Object.values(cfg).every(
    (v) =>
      v === undefined ||
      v === null ||
      (typeof v === 'string' && v.trim() === '') ||
      (Array.isArray(v) && v.length === 0)
  )
}

export async function getGlobalConfig(): Promise<ClaudeBootConfig> {
  return (await readBootFile()).global
}

export async function setGlobalConfig(cfg: ClaudeBootConfig): Promise<ClaudeBootConfig> {
  const file = await readBootFile()
  file.global = cfg ?? {}
  await writeBootFile(file)
  return file.global
}

export async function getFolderConfig(folderPath: string): Promise<ClaudeBootConfig> {
  const file = await readBootFile()
  return file.folders[folderKey(folderPath)] ?? {}
}

export async function setFolderConfig(
  folderPath: string,
  cfg: ClaudeBootConfig
): Promise<ClaudeBootConfig> {
  const file = await readBootFile()
  const key = folderKey(folderPath)
  if (!cfg || isEmptyConfig(cfg)) delete file.folders[key]
  else file.folders[key] = cfg
  await writeBootFile(file)
  return file.folders[key] ?? {}
}

/**
 * Resolve the full argv for a `claude` spawn in `cwd`: app-managed `base`
 * (`['--resume', uuid]`, `[]`, …) ⊕ global config ⊕ per-folder override ⊕ an
 * optional one-shot per-session override (from the New session dialog — not
 * persisted). Precedence: session beats folder beats global. Reads the config
 * file fresh so edits take effect on the next launch.
 */
function mergeFromFile(
  file: ClaudeBootFile,
  cwd: string | undefined,
  key: string | undefined,
  sessionOverride?: ClaudeBootConfig
): ClaudeBootConfig {
  let merged: ClaudeBootConfig = file.global ?? {}
  if (cwd && key) {
    const folder = file.folders[key]
    if (folder) merged = mergeBootConfig(merged, folder)
  }
  if (sessionOverride) merged = mergeBootConfig(merged, sessionOverride)
  return merged
}

async function resolveMergedConfig(
  cwd: string | undefined,
  sessionOverride?: ClaudeBootConfig
): Promise<ClaudeBootConfig> {
  const file = await readBootFile()
  // Use the deterministic, pure `folderKey()` everywhere (same key the save path
  // uses) so a per-folder override round-trips reliably — see folderKey() above.
  const key = cwd ? folderKey(cwd) : undefined
  return mergeFromFile(file, cwd, key, sessionOverride)
}

/**
 * Resolve a merged config's `provider` against the registry to the `ANTHROPIC_*`
 * env vars the spawn injects. No provider (or a dangling reference) → `{}`,
 * which leaves the session pointed at the hosted Anthropic API (the safe
 * default / outage-fallback semantics: a missing endpoint must never silently
 * break a launch). When the endpoint defines a `model` it wins, unless the
 * merged config carries an explicit free-text `model` (per-scope override, D5).
 */
function resolveProviderEnv(file: ClaudeBootFile, cfg: ClaudeBootConfig): Record<string, string> {
  const providerId = cfg.provider?.trim()
  if (!providerId) return {}
  const ep = file.endpoints.find((e) => e.id === providerId)
  if (!ep) {
    console.warn(`[claude-config] provider "${providerId}" not found in registry; using default`)
    return {}
  }
  const env: Record<string, string> = {}
  if (ep.baseUrl.trim()) env.ANTHROPIC_BASE_URL = ep.baseUrl.trim()
  const model = cfg.model?.trim() || ep.model?.trim()
  if (model) env.ANTHROPIC_MODEL = model
  const token = ep.authToken?.trim()
  if (token) {
    // Claude Code reads ANTHROPIC_AUTH_TOKEN for a custom base URL; set
    // ANTHROPIC_API_KEY too so keyless-vs-keyed servers both work (O-3).
    env.ANTHROPIC_AUTH_TOKEN = token
    env.ANTHROPIC_API_KEY = token
  }
  return env
}

/** The argv + env a `claude` spawn launches with, after the full cascade. */
export interface ClaudeBootSpawn {
  args: string[]
  /** `ANTHROPIC_*` overrides from the resolved provider. Empty for Anthropic default. */
  env: Record<string, string>
}

export async function resolveClaudeBootArgs(
  cwd: string | undefined,
  base: string[],
  sessionOverride?: ClaudeBootConfig,
  /** Optional Harnu self-awareness preamble (T55) prepended to append-system-prompt. */
  harnuPreamble?: string
): Promise<ClaudeBootSpawn> {
  const file = await readBootFile()
  const key = cwd ? folderKey(cwd) : undefined
  const merged = mergeFromFile(file, cwd, key, sessionOverride)
  return {
    args: buildClaudeArgs(base, merged, harnuPreamble),
    env: resolveProviderEnv(file, merged)
  }
}

/**
 * The resolved config a NEW session in `folderPath` would inherit — i.e.
 * global ⊕ folder (no session layer). Drives the "inherited" pre-fill in the
 * New session dialog so the user sees the effective values without storing them.
 */
export async function getResolvedConfig(folderPath: string | undefined): Promise<ClaudeBootConfig> {
  return resolveMergedConfig(folderPath)
}

// ── Endpoint registry CRUD (global; local-provider-endpoints spec) ──────────

/** List the saved custom endpoints (auth tokens included — main-side only). */
export async function listEndpoints(): Promise<EndpointProfile[]> {
  return (await readBootFile()).endpoints
}

/** Sanitize a draft into a stored profile. Returns null when invalid (no baseUrl). */
function normalizeDraft(draft: Partial<EndpointProfile>): EndpointProfile | null {
  const baseUrl = draft.baseUrl?.trim()
  if (!baseUrl) return null
  const name = draft.name?.trim()
  const model = draft.model?.trim()
  const authToken = draft.authToken?.trim()
  return {
    id: draft.id?.trim() || randomUUID(),
    name: name || baseUrl,
    baseUrl,
    ...(model ? { model } : {}),
    ...(authToken ? { authToken } : {})
  }
}

/**
 * Upsert an endpoint by `id` (generates one when absent). Persists and returns
 * the full list. A draft without a `baseUrl` is rejected (list unchanged).
 */
export async function saveEndpoint(draft: Partial<EndpointProfile>): Promise<EndpointProfile[]> {
  const profile = normalizeDraft(draft)
  if (!profile) return (await readBootFile()).endpoints
  const file = await readBootFile()
  const idx = file.endpoints.findIndex((e) => e.id === profile.id)
  if (idx >= 0) file.endpoints[idx] = profile
  else file.endpoints.push(profile)
  await writeBootFile(file)
  return file.endpoints
}

/** Remove an endpoint by id. Idempotent — returns the (possibly unchanged) list. */
export async function deleteEndpoint(id: string): Promise<EndpointProfile[]> {
  const file = await readBootFile()
  file.endpoints = file.endpoints.filter((e) => e.id !== id)
  await writeBootFile(file)
  return file.endpoints
}

export function registerClaudeConfigHandlers(): void {
  ipcMain.handle('claudeConfig:getGlobal', () => getGlobalConfig())
  ipcMain.handle('claudeConfig:setGlobal', (_e, cfg: ClaudeBootConfig) => setGlobalConfig(cfg))
  ipcMain.handle('claudeConfig:getFolder', (_e, folderPath: string) => getFolderConfig(folderPath))
  ipcMain.handle('claudeConfig:getResolved', (_e, folderPath: string | undefined) =>
    getResolvedConfig(folderPath)
  )
  ipcMain.handle('claudeConfig:setFolder', (_e, folderPath: string, cfg: ClaudeBootConfig) =>
    setFolderConfig(folderPath, cfg)
  )
  ipcMain.handle('claudeConfig:listEndpoints', () => listEndpoints())
  ipcMain.handle('claudeConfig:saveEndpoint', (_e, draft: Partial<EndpointProfile>) =>
    saveEndpoint(draft)
  )
  ipcMain.handle('claudeConfig:deleteEndpoint', (_e, id: string) => deleteEndpoint(id))
}
