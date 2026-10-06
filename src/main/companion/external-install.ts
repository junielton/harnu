/**
 * The shell of "Harnu mod outside Harnu" (T389 P4W3 §7.3): reads and writes the user's Claude
 * settings through `writeClaudeSettings` (settings lock, temp file, rename), keeps the install
 * record that is the undo, runs the post-install check and re-points the entry at boot.
 *
 * Every decision (what changes, what is refused) is in `external-install-core.ts`. Every path is
 * injected: the real app resolves `~/.claude/settings.json` in `host.ts`, a test or a live-verify
 * recipe points all of them at a throwaway directory.
 */

import { promises as fs } from 'node:fs'
import { dirname, join } from 'node:path'
import type { PolicyProbeClass } from '../claude-policy-probe-core'
import { writeClaudeSettings } from '../claude-settings'
import {
  listHasEntry,
  namesManagedSettings,
  planInstall,
  planUninstall,
  type ExternalInstallRecord,
  type ExternalInstallResult,
  type InstallRefusal
} from './external-install-core'

export interface ExternalInstallDeps {
  /** `~/.claude/settings.json` (or the isolated one of a recipe). */
  settingsPath(): string
  /** `<userData>/companion/external-install.json` */
  recordPath(): string
  /** The managed-settings locations of this platform; any one existing is `policy`. */
  managedPaths(): string[]
  /** P1W2 `ensureStaged()`. */
  ensureStaged(): Promise<string | null>
  /** The shared policy probe (P1W4), already bounded by the caller. `null`: it did not answer. */
  ensureProbe(): Promise<PolicyProbeClass | null>
  /** `claude plugin list --json`, 10 s. `null`: the check could not run. */
  postInstallCheck(): Promise<{ exitCode: number; output: string } | null>
  modVersion(): string
  delimiter?: string
  now(): number
  log?(line: string): void
}

export interface ExternalStatus {
  installed: boolean
  /** The directory Harnu added, or null while off. */
  entry: string | null
  /** The file Harnu edits (shown in the pane). */
  path: string
}

export type ExternalActionResult = (
  ExternalInstallResult | { ok: false; reason: 'unparseable'; manualPath: string }
) & { manualPath?: string }

export interface ExternalInstall {
  status(): Promise<ExternalStatus>
  install(): Promise<ExternalActionResult>
  uninstall(): Promise<ExternalActionResult>
  /** Boot: the installed entry follows a new staged directory. */
  repoint(): Promise<void>
  /** The directories staging must keep: the record's entry and any entry still running sessions. */
  pinned(): string[]
}

const exists = (p: string): Promise<boolean> =>
  fs.access(p).then(
    () => true,
    () => false
  )

async function readText(path: string): Promise<{ text: string | null; isSymlink: boolean }> {
  let isSymlink = false
  try {
    isSymlink = (await fs.lstat(path)).isSymbolicLink()
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { text: null, isSymlink: false }
    throw err
  }
  try {
    return { text: await fs.readFile(path, 'utf8'), isSymlink }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { text: null, isSymlink }
    throw err
  }
}

export function createExternalInstall(deps: ExternalInstallDeps): ExternalInstall {
  const delimiter = deps.delimiter ?? (process.platform === 'win32' ? ';' : ':')
  const log = deps.log ?? ((): void => undefined)
  /** Entries a re-point replaced: sessions that started with them keep running from them. */
  const retired = new Set<string>()
  let pinnedEntry: string | null = null
  // One action at a time: a double click must not interleave two read-modify-writes.
  let chain: Promise<unknown> = Promise.resolve()
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = chain.then(fn, fn)
    chain = run.then(
      () => undefined,
      () => undefined
    )
    return run
  }

  async function readRecord(): Promise<ExternalInstallRecord | null> {
    try {
      const raw = JSON.parse(await fs.readFile(deps.recordPath(), 'utf8')) as unknown
      const r = raw as Partial<ExternalInstallRecord> | null
      if (
        r &&
        r.v === 1 &&
        typeof r.entry === 'string' &&
        typeof r.settingsPath === 'string' &&
        typeof r.installed === 'boolean'
      ) {
        return r as ExternalInstallRecord
      }
    } catch {
      // missing or unreadable: no install on record
    }
    return null
  }

  async function writeRecord(rec: ExternalInstallRecord): Promise<void> {
    const path = deps.recordPath()
    await fs.mkdir(dirname(path), { recursive: true })
    const tmp = join(dirname(path), `.external-install.${process.pid}.tmp`)
    await fs.writeFile(tmp, JSON.stringify(rec, null, 2) + '\n', { mode: 0o600 })
    await fs.rename(tmp, path)
  }

  const clearRecord = (): Promise<void> => fs.rm(deps.recordPath(), { force: true })

  async function managedPresent(): Promise<boolean> {
    for (const p of deps.managedPaths()) if (await exists(p)) return true
    return false
  }

  /** Writes the plan's settings. The caller has already refused symlinks. */
  const writeSettings = (path: string, settings: Record<string, unknown>): Promise<void> =>
    writeClaudeSettings(path, settings)

  async function doUninstall(): Promise<ExternalActionResult> {
    const rec = await readRecord()
    if (!rec || !rec.installed) return { ok: true, installed: false }
    // The undo uses the path the record names: it is what Harnu wrote to.
    const { text, isSymlink } = await readText(rec.settingsPath)
    if (isSymlink) return { ok: false, reason: 'symlink', manualPath: rec.entry }
    const plan = planUninstall({ settingsText: text, record: rec, delimiter })
    if (!plan.ok) return { ok: false, reason: 'unparseable', manualPath: plan.manualPath }
    if (plan.changed) await writeSettings(rec.settingsPath, plan.settings)
    await clearRecord()
    pinnedEntry = null
    return { ok: true, installed: false }
  }

  async function doInstall(): Promise<ExternalActionResult> {
    const path = deps.settingsPath()
    let dir: string | null
    try {
      dir = await deps.ensureStaged()
    } catch {
      dir = null
    }
    let probe: PolicyProbeClass | null = null
    try {
      probe = await deps.ensureProbe()
    } catch {
      probe = null
    }
    let file: { text: string | null; isSymlink: boolean }
    try {
      file = await readText(path)
    } catch {
      return { ok: false, reason: 'failed' }
    }
    const prior = await readRecord()
    const plan = planInstall({
      settingsText: file.text,
      isSymlink: file.isSymlink,
      dir,
      record: prior,
      delimiter,
      managedPresent: await managedPresent(),
      probe,
      modVersion: deps.modVersion(),
      settingsPath: path,
      now: deps.now()
    })
    if (!plan.ok) return { ok: false, reason: plan.reason }

    try {
      await writeSettings(path, plan.settings)
      await writeRecord(plan.record)
    } catch {
      // The record is the undo: without it the entry could never be removed exactly.
      const back = planUninstall({
        settingsText: JSON.stringify(plan.settings),
        record: plan.record,
        delimiter
      })
      if (back.ok && back.changed) await writeSettings(path, back.settings).catch(() => undefined)
      await clearRecord().catch(() => undefined)
      return { ok: false, reason: 'failed' }
    }
    pinnedEntry = plan.record.entry

    // The second net (OD-5): a managed cause that is not a file on this machine.
    let check: { exitCode: number; output: string } | null = null
    try {
      check = await deps.postInstallCheck()
    } catch {
      check = null
    }
    if (check && check.exitCode !== 0 && namesManagedSettings(check.output)) {
      log('post-install check named managed settings; rolled the entry back')
      const undone = await doUninstall()
      if (!undone.ok) log('rollback after the post-install check failed; the record is kept')
      return { ok: false, reason: 'policy' }
    }
    return { ok: true, installed: true }
  }

  async function doStatus(): Promise<ExternalStatus> {
    const path = deps.settingsPath()
    const rec = await readRecord()
    if (!rec || !rec.installed) return { installed: false, entry: null, path }
    let text: string | null = null
    try {
      text = (await readText(rec.settingsPath)).text
    } catch {
      // unreadable right now: keep the record, show it as installed
      return { installed: true, entry: rec.entry, path: rec.settingsPath }
    }
    // The user removed the path by hand: the record is cleared and the switch reads off.
    if (text !== null && !listHasEntry(text, rec.entry, delimiter) && isParseable(text)) {
      await clearRecord().catch(() => undefined)
      pinnedEntry = null
      return { installed: false, entry: null, path }
    }
    if (text === null) {
      await clearRecord().catch(() => undefined)
      pinnedEntry = null
      return { installed: false, entry: null, path }
    }
    pinnedEntry = rec.entry
    return { installed: true, entry: rec.entry, path: rec.settingsPath }
  }

  async function doRepoint(): Promise<void> {
    const rec = await readRecord()
    if (!rec || !rec.installed) return
    pinnedEntry = rec.entry
    let dir: string | null
    try {
      dir = await deps.ensureStaged()
    } catch {
      return
    }
    if (dir === null || dir === rec.entry) return
    const { text, isSymlink } = await readText(rec.settingsPath).catch(() => ({
      text: null as string | null,
      isSymlink: true
    }))
    if (isSymlink || text === null) return
    const plan = planInstall({
      settingsText: text,
      isSymlink: false,
      dir,
      record: rec,
      delimiter,
      managedPresent: false, // a re-point only moves an entry that is already there
      probe: null,
      modVersion: deps.modVersion(),
      settingsPath: rec.settingsPath,
      now: deps.now()
    })
    if (!plan.ok) return
    await writeSettings(rec.settingsPath, plan.settings)
    await writeRecord(plan.record)
    retired.add(rec.entry)
    pinnedEntry = plan.record.entry
  }

  return {
    status: () => serial(doStatus),
    install: () => serial(doInstall),
    uninstall: () => serial(doUninstall),
    repoint: () => serial(doRepoint),
    pinned: () => [...(pinnedEntry ? [pinnedEntry] : []), ...retired]
  }
}

function isParseable(text: string): boolean {
  if (text.trim() === '') return true
  try {
    JSON.parse(text)
    return true
  } catch {
    return false
  }
}

export type { InstallRefusal }
