import { ipcMain } from 'electron'
import { readFile } from 'node:fs/promises'
import {
  claudeSettingsPath,
  isAllowedSettingsPath,
  patchClaudeSettings,
  type ClaudeSettings,
  type SettingsPatch,
  UNSET
} from './claude-settings'

/**
 * IPC bridge for the "Claude config" Settings tab (issue #16, Phases 1–2). The
 * renderer reads the GLOBAL `~/.claude/settings.json` and writes field-level
 * edits through the hardened patch layer in `claude-settings.ts` — never a
 * whole-file reserialize from editor state.
 *
 * The wire patch is `{ set, unset }` (plain JSON) because the `UNSET` Symbol used
 * in-process can't cross the context bridge; we reconstitute it here.
 */

export interface ClaudeSettingsRead {
  /** Absolute path of the settings file (shown in the UI). */
  path: string
  /** Parsed settings, or `{}` when missing/empty/corrupt. */
  settings: ClaudeSettings
  /** True when the file exists on disk. */
  exists: boolean
  /** True when the file exists and is non-empty but does not parse to an object. */
  corrupt: boolean
}

/** Read + classify the global settings file for the viewer (never throws). */
async function readForUi(): Promise<ClaudeSettingsRead> {
  const path = claudeSettingsPath()
  let raw: string | null = null
  try {
    raw = await readFile(path, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      // A transient/permission read error — surface as "corrupt" so the UI stays
      // read-only rather than offering edits against an unknown state.
      return { path, settings: {}, exists: true, corrupt: true }
    }
    return { path, settings: {}, exists: false, corrupt: false }
  }
  if (raw.trim() === '') return { path, settings: {}, exists: true, corrupt: false }
  try {
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { path, settings: {}, exists: true, corrupt: true }
    }
    return { path, settings: parsed as ClaudeSettings, exists: true, corrupt: false }
  } catch {
    return { path, settings: {}, exists: true, corrupt: true }
  }
}

export interface ClaudeSettingsWire {
  /** dot-path → new value */
  set?: Record<string, unknown>
  /** dot-paths to delete */
  unset?: string[]
}

export interface ClaudeSettingsPatchResult {
  ok: boolean
  settings?: ClaudeSettings
  error?: string
}

/** Apply a `{ set, unset }` wire patch through the hardened RMW.
 *
 * Every dot-path is screened against the write allowlist
 * ({@link isAllowedSettingsPath}) BEFORE it reaches the patch layer. The renderer
 * is sandboxed but untrusted, and the settings file holds command-executing
 * (`hooks.*`, `statusLine.command`) and permission subtrees; a rogue/buggy patch
 * targeting those is dropped (and logged) rather than written. Only fields the
 * GUI's own catalog manages survive the filter. */
async function applyWirePatch(wire: ClaudeSettingsWire): Promise<ClaudeSettingsPatchResult> {
  const patch: SettingsPatch = {}
  const rejected: string[] = []
  for (const [dotPath, value] of Object.entries(wire.set ?? {})) {
    if (isAllowedSettingsPath(dotPath)) patch[dotPath] = value
    else rejected.push(dotPath)
  }
  for (const dotPath of wire.unset ?? []) {
    if (isAllowedSettingsPath(dotPath)) patch[dotPath] = UNSET
    else rejected.push(dotPath)
  }
  if (rejected.length > 0) {
    console.warn(
      `[claudeSettings:patch] dropped ${rejected.length} disallowed path(s): ${rejected.join(', ')}`
    )
  }
  try {
    const settings = await patchClaudeSettings(claudeSettingsPath(), patch)
    return { ok: true, settings }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

export function registerClaudeSettingsHandlers(): void {
  ipcMain.handle('claudeSettings:read', () => readForUi())
  ipcMain.handle('claudeSettings:patch', (_e, wire: ClaudeSettingsWire) => applyWirePatch(wire))
}
