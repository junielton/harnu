import { ipcMain } from 'electron'
import { promises as fs } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { readSessionTail, type SessionTurn } from './claude-reader'

/**
 * Session-level write operations on Claude's `~/.claude/projects/` tree. v1
 * ships only `session:delete`; future additions (rename via custom-title line
 * injection, archive flag in sessions-index.json, etc.) live here.
 *
 * Scope discipline: this module never imports from the renderer and never
 * touches BrowserWindow. The watcher (`claude-watcher.ts`) picks up `unlink`
 * events and notifies the renderer — we don't emit our own
 * `claude:session:removed` from here.
 */

interface DeleteArgs {
  sessionId: string
  /** Absolute path to the JSONL transcript on disk (from `Session#fullPath`). */
  fullPath: string
}

export interface DeleteResult {
  ok: boolean
  /** Present when `ok === false`. Short human-readable reason, surfaced as a toast. */
  error?: string
}

interface DigestArgs {
  /** Absolute path to the JSONL transcript on disk (from `Session#fullPath`). */
  fullPath: string
  /** How many trailing turns to include (default 6, capped at 40). */
  turns?: number
}

export interface DigestResult {
  ok: boolean
  /** The transcript tail (present when `ok`). */
  turns?: SessionTurn[]
  /** Present when `ok === false`. */
  error?: string
}

const PROJECTS_ROOT = join(homedir(), '.claude', 'projects')

/**
 * Defense-in-depth: only allow deletions of files that resolve under the
 * `~/.claude/projects/` tree. Without this, a renderer compromise could pass
 * `fullPath: '/etc/passwd'` and we would `fs.unlink` it.
 *
 * Uses `path.resolve` to collapse `..` segments. `startsWith` with the
 * trailing separator avoids the `/home/user/.claude/projects-other/` false
 * positive that a naive prefix check would allow.
 */
function isUnderProjectsRoot(absPath: string): boolean {
  const normalized = resolve(absPath)
  const sep = '/'
  return normalized === PROJECTS_ROOT || normalized.startsWith(PROJECTS_ROOT + sep)
}

export function registerSessionOpHandlers(): void {
  ipcMain.handle('session:delete', async (_e, args: DeleteArgs): Promise<DeleteResult> => {
    const { sessionId, fullPath } = args ?? ({} as DeleteArgs)
    if (typeof sessionId !== 'string' || !sessionId) {
      return { ok: false, error: 'invalid sessionId' }
    }
    if (typeof fullPath !== 'string' || !fullPath) {
      return { ok: false, error: 'invalid fullPath' }
    }
    if (!isUnderProjectsRoot(fullPath)) {
      return {
        ok: false,
        error: `refusing to delete outside ~/.claude/projects/: ${fullPath}`
      }
    }
    if (!fullPath.endsWith('.jsonl')) {
      return { ok: false, error: 'refusing to delete a non-.jsonl file' }
    }

    // 1. Unlink the JSONL. ENOENT means the file already disappeared (race
    // with watcher, manual rm, …) — treat as success so the user's intent
    // ("make this session go away") is honored.
    try {
      await fs.unlink(fullPath)
    } catch (e) {
      const err = e as NodeJS.ErrnoException
      if (err.code !== 'ENOENT') {
        return {
          ok: false,
          error: `unlink failed: ${err.message ?? String(e)}`
        }
      }
    }

    // 2. Best-effort: remove the entry from the parent project's
    // `sessions-index.json` if it exists. Failure here doesn't fail the
    // operation — the watcher's `unlink` event already notifies the renderer
    // and the next `scanFolders()` would skip the missing file anyway.
    try {
      const slugDir = dirname(fullPath)
      const indexPath = join(slugDir, 'sessions-index.json')
      let raw: string
      try {
        raw = await fs.readFile(indexPath, 'utf8')
      } catch {
        // No index file (Claude 2.1.152+, or this is a brand-new slug).
        return { ok: true }
      }
      const parsed = JSON.parse(raw) as {
        version?: number
        originalPath?: string
        entries?: Array<{ sessionId?: string } & Record<string, unknown>>
      }
      if (parsed && Array.isArray(parsed.entries)) {
        const before = parsed.entries.length
        parsed.entries = parsed.entries.filter((e) => e?.sessionId !== sessionId)
        if (parsed.entries.length !== before) {
          await fs.writeFile(indexPath, JSON.stringify(parsed, null, 2), 'utf8')
        }
      }
    } catch (e) {
      console.warn(
        '[session-ops] failed to update sessions-index.json (non-fatal):',
        (e as Error)?.message ?? e
      )
    }

    return { ok: true }
  })

  // T38: read the transcript tail for the "Copy context digest" action. Same
  // projects-root guard as delete — a renderer compromise can't read /etc/passwd.
  ipcMain.handle('session:digest', async (_e, args: DigestArgs): Promise<DigestResult> => {
    const { fullPath, turns } = args ?? ({} as DigestArgs)
    if (typeof fullPath !== 'string' || !fullPath) {
      return { ok: false, error: 'invalid fullPath' }
    }
    if (!isUnderProjectsRoot(fullPath) || !fullPath.endsWith('.jsonl')) {
      return { ok: false, error: 'refusing to read outside ~/.claude/projects/' }
    }
    const n = typeof turns === 'number' && turns > 0 ? Math.min(Math.floor(turns), 40) : 6
    return { ok: true, turns: await readSessionTail(fullPath, n) }
  })
}
