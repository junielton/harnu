import { app } from 'electron'
import { promises as fs } from 'node:fs'
import * as path from 'node:path'

/**
 * One persisted helper pane (a single cell in the right-side vertical
 * stack of the split layout). `'shell'`, `'claude'`, `'markdown'` (T74) and
 * `'memory'` (T79) are persisted; the transient `'claude-fork-pending'`
 * state lives in the renderer `useHelpersStore` only and is dropped
 * on quit. A markdown pane is non-PTY — reproducible from its `filePath` — so it
 * persists like an editor tab and reopens on boot; a memory pane is likewise
 * non-PTY and reproducible from its `folder` (the repo whose `.harnu/memory/` it
 * shows).
 */
export type HelperPaneType = 'shell' | 'claude' | 'markdown' | 'memory' | 'explorer' | 'canvas'

export interface HelperPane {
  /** Stable id; format: `h-<random>`. Used as the PTY identifier too. */
  id: string
  type: HelperPaneType
  /** Required for all types — captured at creation to avoid hydration race */
  cwd: string
  /** 0..1; siblings sum to 1.0 */
  ratio: number
  /** Present iff `type === 'claude'`. The session uuid to resume. */
  sessionId?: string
  /**
   * Present iff `type === 'markdown'` or `type === 'canvas'`. Absolute path to
   * the file the pane renders — a `.md`/text/image file for markdown, a
   * `*.capycanvas.json` document for canvas (T218 U2).
   */
  filePath?: string
  /**
   * Optional for `type === 'markdown'`. Open straight in EDIT mode on first mount
   * instead of view (T87 — a scaffolded WORKTREE.md proposal opens ready to
   * review-and-save; today a non-blank file would default to view).
   */
  initialMode?: 'edit'
  /** Present iff `type === 'memory'`. Folder whose repo `.harnu/memory/` to show (T79). */
  folder?: string
  /** Present iff `type === 'explorer'`. Project root the file tree is confined to (Cluster D). */
  root?: string
  /**
   * Additive free-form state bag (T121). Not read or interpreted by main —
   * it exists so a future pane type can carry its own state without a new
   * top-level field on this interface. Optional and unused by every type
   * shipped today; old `helpers.json` files (with no `payload` on any pane)
   * load unchanged.
   */
  payload?: Record<string, unknown>
}

export interface WorktreeHelperState {
  /** Whether the stack is rendered. Closing the last pane sets this false */
  splitVisible: boolean
  /** Main-pane share of horizontal space; 0.4..0.8 by user contract */
  splitRatio: number
  /** Vertical stack contents, top to bottom */
  panes: HelperPane[]
}

export interface HelpersFile {
  version: 1
  byWorktree: Record<string, WorktreeHelperState>
}

const EMPTY_FILE: HelpersFile = { version: 1, byWorktree: {} }
const FILE_NAME = 'helpers.json'
const TMP_SUFFIX = '.tmp'

export function helpersPath(): string {
  return path.join(app.getPath('userData'), FILE_NAME)
}

function isHelpersFile(value: unknown): value is HelpersFile {
  if (typeof value !== 'object' || value === null) return false
  const obj = value as Record<string, unknown>
  if (obj.version !== 1) return false
  if (typeof obj.byWorktree !== 'object' || obj.byWorktree === null) return false
  return true
}

/**
 * Read. Returns the empty default on missing file, corrupt JSON, or
 * unsupported version. On version mismatch the on-disk file is preserved
 * (never overwritten) — this guards against a v1 binary nuking v2 data.
 */
export async function readHelpers(): Promise<HelpersFile> {
  const filePath = helpersPath()
  let raw: string
  try {
    raw = await fs.readFile(filePath, 'utf8')
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code !== 'ENOENT') {
      console.warn(`[helpers] failed to read ${filePath}:`, err)
    }
    return { ...EMPTY_FILE, byWorktree: {} }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    console.warn(`[helpers] corrupt JSON at ${filePath}:`, err)
    return { ...EMPTY_FILE, byWorktree: {} }
  }

  if (!isHelpersFile(parsed)) {
    const version = (parsed as { version?: unknown })?.version
    console.warn(
      `[helpers] unsupported schema (version=${String(version)}) at ${filePath}; treating as empty (preserving file on disk)`
    )
    return { ...EMPTY_FILE, byWorktree: {} }
  }

  return parsed
}

/**
 * Atomic write via tmp + rename. Creates the userData dir if missing.
 */
export async function writeHelpers(file: HelpersFile): Promise<void> {
  const filePath = helpersPath()
  const dir = path.dirname(filePath)
  const tmpPath = filePath + TMP_SUFFIX

  await fs.mkdir(dir, { recursive: true })
  const body = JSON.stringify(file, null, 2) + '\n'
  await fs.writeFile(tmpPath, body, 'utf8')
  await fs.rename(tmpPath, filePath)
}

/**
 * Get the state for a single worktree. Returns `null` when:
 *  - no entry exists in the file (worktree never used helpers)
 *  - the worktree path no longer exists on disk (stale entry preserved
 *    but treated as absent)
 *
 * The stale-path check uses `fs.stat` — cheap enough at IPC frequency.
 */
export async function getHelpersForWorktree(
  worktreePath: string
): Promise<WorktreeHelperState | null> {
  const file = await readHelpers()
  const entry = file.byWorktree[worktreePath]
  if (!entry) return null

  try {
    const stat = await fs.stat(worktreePath)
    if (!stat.isDirectory()) return null
  } catch {
    return null
  }

  return entry
}

/**
 * Replace the state for a worktree. The full state object is written
 * in one IPC roundtrip — no partial updates. The renderer debounces
 * before calling this so we don't write on every drag pixel.
 */
export async function setHelpersForWorktree(
  worktreePath: string,
  state: WorktreeHelperState
): Promise<void> {
  const file = await readHelpers()
  file.byWorktree[worktreePath] = state
  await writeHelpers(file)
}

/**
 * Remove a worktree's entry. Idempotent. Called both from the explicit
 * UI close-last-helper (renderer flips splitVisible:false; this is a
 * pure delete for cleanliness) and from the user-projects cascade
 * (project removed → drop all its worktrees' helper state).
 */
export async function removeHelpersForWorktree(worktreePath: string): Promise<void> {
  const file = await readHelpers()
  if (!(worktreePath in file.byWorktree)) return
  delete file.byWorktree[worktreePath]
  await writeHelpers(file)
}
