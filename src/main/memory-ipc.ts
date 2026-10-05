import { ipcMain } from 'electron'
import { resolve } from 'node:path'
import { isPathAllowed } from './settings'
import { readUserProjects } from './user-projects'
import { scanFolders } from './claude-reader'
import { readMemoryForFolder, type MemoryPaneData } from './mcp/memory-store'

/**
 * Confined project-memory reader for the renderer (T79 S3). The memory UI (the
 * folder-hover cue + the Memory pane, §4.2) hands us a folder path; we resolve it
 * to the repo's shared `.harnu/memory/` (`readMemoryForFolder` — §3.1) and return
 * the hot/decisions/timeline bundle ONLY when the folder is one of Harnu's *known
 * folders* (the pinned folders + the scanned `~/.claude` roots — the SAME policy
 * source the MCP gate uses in `server.ts` and the T74 markdown reader uses in
 * `markdown-read.ts`).
 *
 * This is the renderer's read-only twin of the `memory_read` MCP verb: the verb
 * is gated by the agent allowlist (an agent discloses project content), this is
 * gated by known-folder containment (a compromised renderer can't read an
 * arbitrary `.harnu/memory/` off disk). Reads never scaffold, so a repo with no
 * memory yet returns `{ ok:true, data:{ exists:false, … } }` — an honest empty
 * state, never an error.
 */

/** Machine-readable denial reasons — the renderer maps each to a localized steer. */
export type MemoryDenyCode = 'invalid-path' | 'outside-roots'

export type MemoryReadResult =
  { ok: true; data: MemoryPaneData } | { ok: false; code: MemoryDenyCode }

/**
 * The live known-folder roots: pinned user folders + scanned roots. Same policy
 * source as the MCP gate and the markdown reader, so a folder the operator can
 * see in the sidebar is exactly one the memory UI can read from.
 */
async function knownRoots(): Promise<string[]> {
  const [projectsFile, folders] = await Promise.all([readUserProjects(), scanFolders()])
  return [...projectsFile.projects.map((p) => p.path), ...folders.map((f) => f.path)]
}

/**
 * Resolve + confine `rawFolder`, then read its repo memory. A relative input is
 * resolved with `path.resolve`; the FINAL absolute path is confined against the
 * known roots (a folder is contained by itself — `rel === ''` — so a sidebar
 * root passes).
 */
export async function readMemory(rawFolder: string): Promise<MemoryReadResult> {
  if (typeof rawFolder !== 'string' || rawFolder.length === 0) {
    return { ok: false, code: 'invalid-path' }
  }
  const folder = resolve(rawFolder)
  if (!isPathAllowed(folder, await knownRoots())) return { ok: false, code: 'outside-roots' }
  const data = await readMemoryForFolder(folder)
  return { ok: true, data }
}

export function registerMemoryReadHandlers(): void {
  ipcMain.handle('memory:read', (_e, args: { folder: string }): Promise<MemoryReadResult> => {
    const folder = args?.folder ?? ''
    return readMemory(folder)
  })
}
