/**
 * The pure half of "Harnu mod outside Harnu" (T389 P4W3 §7.3): what is written into the user's
 * `~/.claude/settings.json`, and the exact undo. Nothing here touches I/O: the shell
 * (`external-install.ts`) reads the file, runs the checks and writes what this module plans.
 *
 * The one thing Harnu edits is one list item in one key: `env.CLAUDE_CODE_PLUGIN_DIRS`. Every
 * other key and every other list item is returned as it was, key order included, and the plan
 * refuses (rather than repairs) a file it does not understand.
 */

import type { PolicyProbeClass } from '../claude-policy-probe-core'

export const PLUGIN_DIRS_KEY = 'CLAUDE_CODE_PLUGIN_DIRS'

export interface ExternalInstallRecord {
  v: 1
  installed: boolean
  /** The absolute directory Harnu added to the list. */
  entry: string
  settingsPath: string
  /** Harnu created the `env` object. */
  createdEnv: boolean
  /** Harnu created the `CLAUDE_CODE_PLUGIN_DIRS` key. */
  createdKey: boolean
  modVersion: string
  at: number
}

export type InstallRefusal =
  | 'unparseable'
  | 'occupied'
  | 'symlink'
  /** A managed cause was positively identified. */
  | 'policy'
  /** The probe shows mods are off; the cause was not observed. */
  | 'mods-off'
  | 'no-companion'
  | 'failed'

export type ExternalInstallResult =
  { ok: true; installed: boolean } | { ok: false; reason: InstallRefusal }

type Settings = Record<string, unknown>

export interface InstallInput {
  /** The raw file, or `null` when it does not exist. */
  settingsText: string | null
  /** `lstat` says the settings file is a symlink. */
  isSymlink: boolean
  /** `await ensureStaged()`; `null` means there is no companion to load. */
  dir: string | null
  /** The record of a previous install, for a re-point. */
  record: ExternalInstallRecord | null
  delimiter: string
  /** A managed settings file exists on this machine. */
  managedPresent: boolean
  /** The shared policy probe (P1W4), or `null` while it has not run. */
  probe: PolicyProbeClass | null
  modVersion: string
  settingsPath: string
  now: number
}

export type InstallPlan =
  | { ok: true; settings: Settings; record: ExternalInstallRecord }
  | { ok: false; reason: InstallRefusal }

type Parsed = { ok: true; settings: Settings } | { ok: false }

/** A missing or blank file is `{}`; anything that is not a JSON object is a refusal. */
function parseSettings(text: string | null): Parsed {
  if (text === null || text.trim() === '') return { ok: true, settings: {} }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { ok: false }
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return { ok: false }
  return { ok: true, settings: parsed as Settings }
}

const isPlainObject = (v: unknown): v is Settings =>
  v !== null && typeof v === 'object' && !Array.isArray(v)

const splitList = (value: string, delimiter: string): string[] =>
  value.split(delimiter).filter((item) => item !== '')

/**
 * The install plan, in the order of spec §7.3: no companion, policy, symlink, parse, shape, then
 * the list edit. Nothing is written for any refusal.
 */
export function planInstall(i: InstallInput): InstallPlan {
  if (i.dir === null || i.dir === '') return { ok: false, reason: 'no-companion' }
  // OD-5, R23: a managed cause refuses before anything else is read.
  if (i.managedPresent) return { ok: false, reason: 'policy' }
  if (i.probe === 'off-here' || i.probe === 'off-remote') return { ok: false, reason: 'mods-off' }
  // A temp-file-plus-rename would replace the link with a regular file and detach the dotfiles.
  if (i.isSymlink) return { ok: false, reason: 'symlink' }
  const parsed = parseSettings(i.settingsText)
  if (!parsed.ok) return { ok: false, reason: 'unparseable' }

  const base = parsed.settings
  const hadEnv = 'env' in base
  if (hadEnv && !isPlainObject(base.env)) return { ok: false, reason: 'occupied' }
  const env: Settings = hadEnv ? (base.env as Settings) : {}
  const hadKey = PLUGIN_DIRS_KEY in env
  if (hadKey && typeof env[PLUGIN_DIRS_KEY] !== 'string') return { ok: false, reason: 'occupied' }

  const previous = i.record?.installed ? i.record.entry : null
  const kept = splitList(hadKey ? (env[PLUGIN_DIRS_KEY] as string) : '', i.delimiter).filter(
    (item) => item !== previous && item !== i.dir
  )
  const nextList = [...kept, i.dir].join(i.delimiter)

  // Rebuild in place so every other key keeps its position; a new key goes last.
  const nextEnv: Settings = {}
  for (const k of Object.keys(env)) nextEnv[k] = k === PLUGIN_DIRS_KEY ? nextList : env[k]
  if (!hadKey) nextEnv[PLUGIN_DIRS_KEY] = nextList
  const settings: Settings = {}
  for (const k of Object.keys(base)) settings[k] = k === 'env' ? nextEnv : base[k]
  if (!hadEnv) settings.env = nextEnv

  // A re-point keeps the flags: they describe the file as it was before Harnu first wrote.
  const reuse = i.record?.installed ? i.record : null
  return {
    ok: true,
    settings,
    record: {
      v: 1,
      installed: true,
      entry: i.dir,
      settingsPath: i.settingsPath,
      createdEnv: reuse ? reuse.createdEnv : !hadEnv,
      createdKey: reuse ? reuse.createdKey : !hadKey,
      modVersion: i.modVersion,
      at: i.now
    }
  }
}

export interface UninstallInput {
  settingsText: string | null
  record: ExternalInstallRecord
  delimiter: string
}

export type UninstallPlan =
  /** `changed: false`: nothing to write (the entry is gone); the record is cleared all the same. */
  | { ok: true; changed: false; settings: null }
  | { ok: true; changed: true; settings: Settings }
  /** The file no longer parses: the toast names the one path to remove by hand. */
  | { ok: false; reason: 'unparseable'; manualPath: string }

/** Removes exactly `record.entry`, and the key and `env` only when Harnu created them. */
export function planUninstall(i: UninstallInput): UninstallPlan {
  const parsed = parseSettings(i.settingsText)
  if (!parsed.ok) return { ok: false, reason: 'unparseable', manualPath: i.record.entry }
  const base = parsed.settings
  const env = base.env
  if (!isPlainObject(env) || typeof env[PLUGIN_DIRS_KEY] !== 'string') {
    return { ok: true, changed: false, settings: null }
  }
  const list = splitList(env[PLUGIN_DIRS_KEY], i.delimiter)
  if (!list.includes(i.record.entry)) return { ok: true, changed: false, settings: null }

  const rest = list.filter((item) => item !== i.record.entry)
  const nextEnv: Settings = {}
  for (const k of Object.keys(env)) {
    if (k === PLUGIN_DIRS_KEY) {
      if (rest.length === 0 && i.record.createdKey) continue
      nextEnv[k] = rest.join(i.delimiter)
    } else {
      nextEnv[k] = env[k]
    }
  }
  const settings: Settings = {}
  for (const k of Object.keys(base)) {
    if (k !== 'env') settings[k] = base[k]
    else if (!(Object.keys(nextEnv).length === 0 && i.record.createdEnv)) settings[k] = nextEnv
  }
  return { ok: true, changed: true, settings }
}

/** True when the list of `settings` currently holds `entry` (the "user removed it by hand" read). */
export function listHasEntry(
  settingsText: string | null,
  entry: string,
  delimiter: string
): boolean {
  const parsed = parseSettings(settingsText)
  if (!parsed.ok) return false
  const env = parsed.settings.env
  if (!isPlainObject(env) || typeof env[PLUGIN_DIRS_KEY] !== 'string') return false
  return splitList(env[PLUGIN_DIRS_KEY], delimiter).includes(entry)
}

// ---- managed settings (OD-5) ----------------------------------------------------------------

/**
 * Where the CLI reads organisation-managed settings from a FILE. Confirmed at implementation
 * (Q-P4W3-c) from the CLI's own strings and debug log on 2.1.290: `/etc/claude-code` on Linux,
 * `/Library/Application Support/ClaudeCode` on macOS, `C:\Program Files\ClaudeCode` on Windows,
 * each holding `managed-settings.json` and a `managed-settings.d` directory of drop-ins. NOT
 * confirmed on a managed machine: no run has happened on one. A policy delivered as a Windows
 * registry key (`HKLM\SOFTWARE\Policies\ClaudeCode`), a macOS MDM profile or a remote
 * managed-settings fetch is not a file here, so only the post-install check can catch it.
 */
export function managedSettingsPaths(platform: NodeJS.Platform): string[] {
  switch (platform) {
    case 'darwin':
      return [
        '/Library/Application Support/ClaudeCode/managed-settings.json',
        '/Library/Application Support/ClaudeCode/managed-settings.d'
      ]
    case 'win32':
      return [
        'C:\\Program Files\\ClaudeCode\\managed-settings.json',
        'C:\\Program Files\\ClaudeCode\\managed-settings.d'
      ]
    default:
      return ['/etc/claude-code/managed-settings.json', '/etc/claude-code/managed-settings.d']
  }
}

/**
 * The post-install check's second net: a failing `claude plugin list` that blames managed
 * settings. The CLI's own refusal reads "disabled by your organization's managed settings
 * (disableSideloadFlags)" (2.1.290 strings; not observed from a managed machine).
 */
export function namesManagedSettings(output: string): boolean {
  return /managed[\s-]+(settings?|polic)/i.test(output) || /disableSideloadFlags/i.test(output)
}
