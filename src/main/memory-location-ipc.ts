/**
 * Renderer IPC for the configurable memory location (T89): the Settings → Memory
 * pane (global default) and the folder-menu "Store this project's memory in…"
 * dialog (per-project override), plus the assisted migration ("move existing
 * memory now").
 *
 * The GLOBAL config (`memoryLocation:getGlobal` / `setGlobal`) is a plain user
 * setting — not folder-scoped, no gate. The FOLDER-scoped verbs (`getForFolder`,
 * `setOverride`, `migrateFolder`) confine `folder` to the SAME known Harnu roots
 * as the memory reader (`memory-ipc.ts`) so a compromised renderer can't point an
 * override at, or move memory for, an arbitrary path off disk. A `central` root is
 * validated (absolute + existing directory) before it is ever persisted.
 */

import { ipcMain } from 'electron'
import { promises as fs } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import { isPathAllowed } from './settings'
import {
  readUserProjects,
  setUserProjectMemoryOverride,
  getUserProjectMemoryOverride
} from './user-projects'
import { scanFolders } from './claude-reader'
import { readGlobalMemoryConfig, writeGlobalMemoryConfig } from './memory-location'
import {
  resolveMemoryLocation,
  migrateMemory,
  type MemoryLocation,
  type MemoryMigrationReport
} from './mcp/memory-store'
import {
  resolveMemoryCheckout,
  type MemoryLocationConfig,
  type MemoryStorageMode
} from './mcp/memory-core'
import { probeGitMeta } from './git-probe'

/** Machine-readable denial reasons — the renderer maps each to a localized steer. */
export type MemoryLocationDenyCode = 'invalid-path' | 'outside-roots' | 'invalid-root'

/** The effective memory-location + resolved dirs for a folder (dialog state). */
export interface FolderMemoryLocation {
  ok: true
  /** The config actually in effect for this repo (override ?? global). */
  effective: MemoryLocationConfig
  /** The per-project override, or null when the repo follows the global default. */
  override: MemoryLocationConfig | null
  /** The current global default. */
  globalDefault: MemoryLocationConfig
  /** Absolute memory dir currently serving the folder. */
  memoryDir: string
  /** Where {@link memoryDir} lives relative to the repo. */
  mode: MemoryStorageMode
  /** The repo's MAIN checkout path (the override key + migration source anchor). */
  checkout: string
  /** Whether any memory content exists at the CURRENT location. */
  exists: boolean
}

export type FolderMemoryLocationResult =
  FolderMemoryLocation | { ok: false; code: MemoryLocationDenyCode }

export type SetGlobalResult =
  { ok: true; config: MemoryLocationConfig } | { ok: false; code: MemoryLocationDenyCode }

export type SetOverrideResult = FolderMemoryLocationResult

export type MigrateFolderResult =
  { ok: true; report: MemoryMigrationReport } | { ok: false; code: MemoryLocationDenyCode }

/** Batch migration summary for a global-default change. */
export interface MigrateKnownResult {
  ok: true
  reports: MemoryMigrationReport[]
}

/** The live known-folder roots: pinned user folders + scanned `~/.claude` roots. */
async function knownRoots(): Promise<string[]> {
  const [projectsFile, folders] = await Promise.all([readUserProjects(), scanFolders()])
  return [...projectsFile.projects.map((p) => p.path), ...folders.map((f) => f.path)]
}

/** Resolve + confine a renderer-supplied folder to the known roots. */
async function confineFolder(
  rawFolder: unknown
): Promise<{ ok: true; folder: string } | { ok: false; code: MemoryLocationDenyCode }> {
  if (typeof rawFolder !== 'string' || rawFolder.length === 0) {
    return { ok: false, code: 'invalid-path' }
  }
  const folder = resolve(rawFolder)
  if (!isPathAllowed(folder, await knownRoots())) return { ok: false, code: 'outside-roots' }
  return { ok: true, folder }
}

/**
 * Validate + normalize a renderer-supplied {@link MemoryLocationConfig}. A
 * `central` config must carry an ABSOLUTE path to an EXISTING directory (the
 * native picker guarantees this; a typed path is verified here). Anything else
 * collapses to `in-project`.
 */
async function validateConfig(
  raw: unknown
): Promise<
  { ok: true; config: MemoryLocationConfig } | { ok: false; code: MemoryLocationDenyCode }
> {
  if (raw && typeof raw === 'object') {
    const obj = raw as Record<string, unknown>
    if (obj.mode === 'in-project') return { ok: true, config: { mode: 'in-project' } }
    if (obj.mode === 'central') {
      const root = typeof obj.root === 'string' ? obj.root.trim() : ''
      if (!root || !isAbsolute(root)) return { ok: false, code: 'invalid-root' }
      try {
        const st = await fs.stat(root)
        if (!st.isDirectory()) return { ok: false, code: 'invalid-root' }
      } catch {
        return { ok: false, code: 'invalid-root' }
      }
      return { ok: true, config: { mode: 'central', root } }
    }
  }
  return { ok: false, code: 'invalid-root' }
}

/** Build the folder-location envelope from a resolved {@link MemoryLocation}. */
async function toFolderLocation(
  loc: MemoryLocation,
  exists: boolean
): Promise<FolderMemoryLocation> {
  const [override, globalDefault] = await Promise.all([
    getUserProjectMemoryOverride(loc.checkout),
    readGlobalMemoryConfig()
  ])
  return {
    ok: true,
    effective: override ?? globalDefault,
    override: override ?? null,
    globalDefault,
    memoryDir: loc.memoryDir,
    mode: loc.mode,
    checkout: loc.checkout,
    exists
  }
}

/** Whether a memory dir currently has any content (for the "move now" offer). */
async function memoryDirHasContent(dir: string): Promise<boolean> {
  try {
    return (await fs.readdir(dir)).length > 0
  } catch {
    return false
  }
}

export function registerMemoryLocationHandlers(): void {
  // --- Global default (Settings → Memory) -----------------------------------
  ipcMain.handle('memoryLocation:getGlobal', (): Promise<MemoryLocationConfig> =>
    readGlobalMemoryConfig()
  )

  ipcMain.handle(
    'memoryLocation:setGlobal',
    async (_e, args: { config: unknown }): Promise<SetGlobalResult> => {
      const valid = await validateConfig(args?.config)
      if (!valid.ok) return valid
      await writeGlobalMemoryConfig(valid.config)
      return { ok: true, config: valid.config }
    }
  )

  // --- Per-folder override (folder menu dialog) -----------------------------
  ipcMain.handle(
    'memoryLocation:getForFolder',
    async (_e, args: { folder: string }): Promise<FolderMemoryLocationResult> => {
      const gate = await confineFolder(args?.folder)
      if (!gate.ok) return gate
      const loc = await resolveMemoryLocation(gate.folder)
      return toFolderLocation(loc, await memoryDirHasContent(loc.memoryDir))
    }
  )

  ipcMain.handle(
    'memoryLocation:setOverride',
    async (_e, args: { folder: string; override: unknown }): Promise<SetOverrideResult> => {
      const gate = await confineFolder(args?.folder)
      if (!gate.ok) return gate
      // Resolve the folder to its MAIN checkout — the override is keyed there so
      // every worktree of the repo shares it.
      const meta = await probeGitMeta(gate.folder)
      const checkout = resolveMemoryCheckout(gate.folder, meta.repoId)
      let override: MemoryLocationConfig | null
      if (args?.override == null) {
        override = null // clear → fall back to global default
      } else {
        const valid = await validateConfig(args.override)
        if (!valid.ok) return valid
        override = valid.config
      }
      await setUserProjectMemoryOverride(checkout, override)
      const loc = await resolveMemoryLocation(gate.folder)
      return toFolderLocation(loc, await memoryDirHasContent(loc.memoryDir))
    }
  )

  // --- Assisted migration ----------------------------------------------------
  ipcMain.handle(
    'memoryLocation:migrateFolder',
    async (
      _e,
      args: { folder: string; from: unknown; to: unknown }
    ): Promise<MigrateFolderResult> => {
      const gate = await confineFolder(args?.folder)
      if (!gate.ok) return gate
      const from = await validateConfig(args?.from)
      const to = await validateConfig(args?.to)
      if (!from.ok) return from
      if (!to.ok) return to
      const report = await migrateMemory({ folder: gate.folder, from: from.config, to: to.config })
      return { ok: true, report }
    }
  )

  // Move every KNOWN repo's memory when the global default changes. Repos with
  // their OWN override are unaffected by a global change and are skipped. Dedup by
  // main checkout so worktrees of one repo migrate once.
  ipcMain.handle(
    'memoryLocation:migrateKnown',
    async (_e, args: { from: unknown; to: unknown }): Promise<MigrateKnownResult> => {
      const from = await validateConfig(args?.from)
      const to = await validateConfig(args?.to)
      if (!from.ok || !to.ok) return { ok: true, reports: [] }
      const roots = await knownRoots()
      const seen = new Set<string>()
      const reports: MemoryMigrationReport[] = []
      for (const folder of roots) {
        const meta = await probeGitMeta(folder)
        const checkout = resolveMemoryCheckout(folder, meta.repoId)
        if (seen.has(checkout)) continue
        seen.add(checkout)
        // A repo with its own override is not governed by the global default.
        if (await getUserProjectMemoryOverride(checkout)) continue
        reports.push(await migrateMemory({ folder: checkout, from: from.config, to: to.config }))
      }
      return { ok: true, reports }
    }
  )
}
