/**
 * Global memory-location config (T89): the app-wide default for WHERE project
 * memory is stored — `in-project` (default, `<repo>/.harnu/memory/`) or `central`
 * (a user-picked root: Google Drive, an Obsidian vault, an external disk).
 *
 * This is Harnu's OWN config (a tiny `memory-location.json` under `userData`),
 * never anything in a client repo — the whole privacy point. The per-project
 * override lives on the `UserProject` record (`user-projects.ts`); this module
 * composes the two (override → global default) into the EFFECTIVE config the
 * memory seam (`resolveMemoryLocation`) consults.
 *
 * Read/written by the main process only; the renderer touches it through the
 * `memoryLocation:*` IPC (`memory-location-ipc.ts`).
 */

import { app } from 'electron'
import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import { getUserProjectMemoryOverride } from './user-projects'
import {
  DEFAULT_MEMORY_CONFIG,
  effectiveMemoryConfig,
  type MemoryLocationConfig
} from './mcp/memory-core'

const FILE_NAME = 'memory-location.json'

/** Absolute path of the global memory-location config file. */
export function memoryLocationConfigPath(): string {
  return path.join(app.getPath('userData'), FILE_NAME)
}

/**
 * Coerce arbitrary parsed JSON into a valid {@link MemoryLocationConfig}. A
 * `central` config REQUIRES a non-blank `root`; anything else (missing/blank
 * root, unknown mode, garbage) collapses to the safe `in-project` default so a
 * corrupt or hand-edited file can never point memory at a relative/empty path.
 */
export function sanitizeMemoryConfig(value: unknown): MemoryLocationConfig {
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>
    if (obj.mode === 'central' && typeof obj.root === 'string' && obj.root.trim().length > 0) {
      return { mode: 'central', root: obj.root }
    }
  }
  return { mode: 'in-project' }
}

/** Read the global default config. Absent/corrupt ⇒ the in-project default. */
export async function readGlobalMemoryConfig(): Promise<MemoryLocationConfig> {
  try {
    const raw = await fs.readFile(memoryLocationConfigPath(), 'utf8')
    return sanitizeMemoryConfig(JSON.parse(raw))
  } catch {
    return { ...DEFAULT_MEMORY_CONFIG }
  }
}

/** Atomically persist the global default config (sanitized). */
export async function writeGlobalMemoryConfig(config: MemoryLocationConfig): Promise<void> {
  const clean = sanitizeMemoryConfig(config)
  const filePath = memoryLocationConfigPath()
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  const tmp = filePath + '.tmp'
  await fs.writeFile(tmp, JSON.stringify(clean, null, 2) + '\n', 'utf8')
  await fs.rename(tmp, filePath)
}

/**
 * The EFFECTIVE config for a repo (T89): the per-project override (keyed by the
 * repo's MAIN checkout path) if any, else the global default. This is the one
 * lookup the memory seam does before resolving the dir — deterministic + cheap
 * (two small JSON reads), no per-call git/fs probing beyond what the seam already
 * does.
 */
export async function resolveEffectiveMemoryConfig(
  checkout: string
): Promise<MemoryLocationConfig> {
  const [override, globalDefault] = await Promise.all([
    getUserProjectMemoryOverride(checkout),
    readGlobalMemoryConfig()
  ])
  return effectiveMemoryConfig(override, globalDefault)
}
