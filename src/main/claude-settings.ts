import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { mkdir, readFile, writeFile, rename, rm } from 'node:fs/promises'

/**
 * Hardened read-modify-write layer for the user's GLOBAL Claude Code settings at
 * `~/.claude/settings.json`.
 *
 * This file is owned by the user AND by Claude Code itself, so every write MUST
 * be a non-destructive merge that preserves unknown keys. The original
 * `writeClaudeSettings` was a naive whole-file overwrite and the RMW callers did
 * an unlocked read-modify-write with no empty-read guard — the exact pattern that
 * once wiped this file (9 KB → 162 B; `settings-json-clobber-regression`
 * post-mortem). This layer fixes that class of bug rather than re-creating it:
 *
 *   - **atomic** — write a `*.tmp` sibling then `rename()` over the target, so an
 *     interrupted write never leaves a half-written (or empty) settings.json.
 *   - **single-writer lock per path** — `withSettingsLock` serializes concurrent
 *     RMWs so two writers can't both read the old value and lose an update.
 *   - **empty-read guard** — a file that exists and is non-empty but fails to
 *     parse ABORTS the write instead of clobbering it with `{}`.
 *   - **pre-write backup** — the prior bytes are copied to `<path>.backup`.
 *   - **surgical patch** — {@link patchClaudeSettings} touches only the keys in
 *     the patch, preserving unknown keys and key order (never reserializes the
 *     whole object from editor state).
 *
 * Kept framework-free (node fs only, no electron) so it's unit-testable in the
 * `node` vitest env (`tests/claude-settings-write.test.ts`).
 */

export function claudeSettingsPath(): string {
  return join(homedir(), '.claude', 'settings.json')
}

export type ClaudeSettings = Record<string, unknown>

/**
 * Sentinel meaning "delete this key" in a {@link SettingsPatch}. Distinct from
 * `undefined` (which JSON drops anyway) so an explicit unset is unambiguous.
 */
export const UNSET = Symbol('claude-settings-unset')

/** A surgical patch: dot-path → new value, or {@link UNSET} to remove the key. */
export type SettingsPatch = Record<string, unknown | typeof UNSET>

// --- write allowlist -------------------------------------------------------

/**
 * The exact dot-paths the GUI is allowed to write through the patch layer. This
 * is the security boundary for `claudeSettings:patch`: the renderer is sandboxed
 * but untrusted, and `~/.claude/settings.json` holds command-executing subtrees
 * (`hooks.*`, `statusLine.command`) and permission subtrees (`permissions.allow`)
 * that — if writable from the renderer — would let a compromised/buggy UI install
 * arbitrary shell commands that Claude Code runs. The hardened RMW in this file
 * protects the file's *integrity*; this allowlist protects its *contents*.
 *
 * The set MUST stay in sync with the renderer's field catalog
 * (`src/renderer/src/components/claude-config-catalog.ts` — `SETTINGS_CATALOG`),
 * the only legitimate source of writes. It is hardcoded here (not imported) so
 * the main-side guard never depends on renderer code. Matching is by EXACT
 * dot-path: `permissions.defaultMode` is allowed but `permissions.allow`,
 * `hooks.PreToolUse`, and `statusLine.command` are not.
 */
export const ALLOWED_SETTINGS_PATHS: ReadonlySet<string> = new Set([
  'model',
  'cleanupPeriodDays',
  'includeCoAuthoredBy',
  'permissions.defaultMode',
  'tui'
])

/**
 * True when `dotPath` is a field the GUI may set/unset. Exact-match against
 * {@link ALLOWED_SETTINGS_PATHS} — no prefix matching, so a command-bearing child
 * (`hooks.PreToolUse`, `statusLine.command`) of a non-listed subtree is rejected,
 * and a sibling of an allowed nested field (`permissions.allow`) is rejected too.
 */
export function isAllowedSettingsPath(dotPath: string): boolean {
  return ALLOWED_SETTINGS_PATHS.has(dotPath)
}

/**
 * Parse the settings file. Missing or invalid JSON → `{}` (never throws). Used by
 * read-only consumers (e.g. the hook bridge) that must degrade gracefully; the
 * RMW path uses the stricter guarded read inside {@link updateClaudeSettings}.
 */
export async function readClaudeSettings(path: string): Promise<ClaudeSettings> {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8'))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as ClaudeSettings)
      : {}
  } catch {
    return {}
  }
}

// --- single-writer lock ----------------------------------------------------

/** Per-path promise chain. Each write waits for the prior one on the same path. */
const locks = new Map<string, Promise<unknown>>()

/**
 * Serialize `fn` against every other `withSettingsLock` call for the same `path`.
 * The stored tail swallows rejections so one failed write never poisons the
 * queue, but the returned promise still surfaces `fn`'s real result/error.
 */
export function withSettingsLock<T>(path: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(path) ?? Promise.resolve()
  const run = prev.then(fn, fn)
  locks.set(
    path,
    run.then(
      () => {},
      () => {}
    )
  )
  return run
}

// --- atomic write ----------------------------------------------------------

/** Serialize with Claude Code's own style: 2-space indent + trailing newline. */
function serialize(data: ClaudeSettings): string {
  return JSON.stringify(data, null, 2) + '\n'
}

/** Write `content` to `path` via a tmp sibling + `rename` (atomic on POSIX/NTFS). */
async function atomicWrite(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`
  await writeFile(tmp, content, 'utf8')
  try {
    await rename(tmp, path)
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => {})
    throw err
  }
}

/**
 * Whole-file write, now atomic + locked. Kept for callers that already produce a
 * complete next-state object via a pure merge (hook/statusline installers). For
 * field-level edits prefer {@link patchClaudeSettings}.
 */
export async function writeClaudeSettings(path: string, data: ClaudeSettings): Promise<void> {
  await withSettingsLock(path, () => atomicWrite(path, serialize(data)))
}

// --- guarded read-modify-write --------------------------------------------

/** Thrown when the on-disk file is non-empty but unparseable — abort, don't clobber. */
export class ClaudeSettingsCorruptError extends Error {
  constructor(public readonly path: string) {
    super(`refusing to overwrite unparseable settings at ${path}`)
    this.name = 'ClaudeSettingsCorruptError'
  }
}

/** Read raw bytes; `null` means the file does not exist (ENOENT). Other errors
 *  (EIO, EACCES, …) propagate so a transient read failure aborts the RMW. */
async function readRaw(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }
}

/**
 * Read → `mutate` → write, atomically and under the per-path lock.
 *
 * The empty-read guard lives here: if the file exists and is non-empty but does
 * not parse to a plain object, we throw {@link ClaudeSettingsCorruptError} and
 * write nothing — the clobber regression's root cause. A missing or whitespace-
 * only file is treated as `{}` (safe). `mutate` receives the freshly-parsed
 * current state and returns the next state (it may mutate-and-return it).
 */
export async function updateClaudeSettings(
  path: string,
  mutate: (current: ClaudeSettings) => ClaudeSettings
): Promise<ClaudeSettings> {
  return withSettingsLock(path, async () => {
    const raw = await readRaw(path)
    const existed = raw !== null
    let current: ClaudeSettings = {}
    if (existed && raw!.trim() !== '') {
      let parsed: unknown
      try {
        parsed = JSON.parse(raw!)
      } catch {
        throw new ClaudeSettingsCorruptError(path)
      }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new ClaudeSettingsCorruptError(path)
      }
      current = parsed as ClaudeSettings
    }
    const next = mutate(current)
    if (existed) await writeFile(`${path}.backup`, raw!, 'utf8').catch(() => {})
    await atomicWrite(path, serialize(next))
    return next
  })
}

// --- surgical patch --------------------------------------------------------

/** Set `obj` at a dot-path, creating intermediate plain objects as needed. */
function setDotPath(obj: ClaudeSettings, dotPath: string, value: unknown): void {
  const keys = dotPath.split('.')
  let node = obj
  for (let i = 0; i < keys.length - 1; i++) {
    const k = keys[i]
    const child = node[k]
    if (!child || typeof child !== 'object' || Array.isArray(child)) {
      node[k] = {}
    }
    node = node[k] as ClaudeSettings
  }
  node[keys[keys.length - 1]] = value
}

/** Delete `obj` at a dot-path; intermediate objects left in place (no pruning). */
function deleteDotPath(obj: ClaudeSettings, dotPath: string): void {
  const keys = dotPath.split('.')
  let node = obj
  for (let i = 0; i < keys.length - 1; i++) {
    const child = node[keys[i]]
    if (!child || typeof child !== 'object' || Array.isArray(child)) return
    node = child as ClaudeSettings
  }
  delete node[keys[keys.length - 1]]
}

/**
 * Apply a {@link SettingsPatch} to `obj` IN PLACE and return it. Only the keys in
 * the patch are touched; every other key — including unknown ones and the
 * `hooks`/`statusLine` subtrees — keeps its value and insertion order (existing
 * keys are updated in place; new keys are appended). Pure given a fresh `obj`.
 */
export function applyPatch(obj: ClaudeSettings, patch: SettingsPatch): ClaudeSettings {
  for (const [dotPath, value] of Object.entries(patch)) {
    if (value === UNSET) deleteDotPath(obj, dotPath)
    else setDotPath(obj, dotPath, value)
  }
  return obj
}

/**
 * Apply a surgical patch to the settings file on disk, through the full hardened
 * RMW (lock + guard + backup + atomic). A single toggle produces a one-key diff;
 * unknown keys and ordering survive byte-stable.
 */
export async function patchClaudeSettings(
  path: string,
  patch: SettingsPatch
): Promise<ClaudeSettings> {
  return updateClaudeSettings(path, (current) => applyPatch(current, patch))
}
