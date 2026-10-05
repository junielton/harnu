/**
 * The per-repo data directory resolver — every main-process path into it is built
 * here, so the directory's name is changed by editing one constant
 * (`DATA_DIR` in `src/shared/data-dir.ts`).
 *
 * Two scopes, deliberately distinct:
 *  - **per-worktree** ({@link dataDir}) — `out/` scratch (canvas board, reports)
 *    belongs to the checkout it was written in;
 *  - **repo-level** ({@link repoDataDir}) — memory, roadmap, missions, goals and
 *    learning live in the repo's MAIN checkout, shared by every worktree.
 */

import { execFile } from 'node:child_process'
import { readFileSync, statSync } from 'node:fs'
import { appendFile, mkdir, readFile } from 'node:fs/promises'
import * as path from 'node:path'
import { DATA_DIR } from '../shared/data-dir'

export { DATA_DIR }

/**
 * Names the per-repo data dir used to carry, oldest first. The first-boot copy
 * (`migrations/data-dir.ts`) reads from these into {@link DATA_DIR}; it is inert
 * while `DATA_DIR` is itself one of them. Old names are recognized for that copy
 * and for {@link mapLegacyDataPath} only — nothing writes into them.
 */
export const LEGACY_DATA_DIRS: readonly string[] = ['.capy']

/**
 * Read-time mapping for a STORED repo-relative path (a mission `worktree` link, a
 * card reference): a path whose first segment is a legacy data-dir name resolves
 * under `target` instead, so links written before the flip keep resolving. Other
 * paths — absolute, nested (`docs/.harnu/…`), or merely sharing a prefix
 * (`.capybara/…`) — come back unchanged. The stored file is never rewritten.
 * `target` is a test seam; production callers rely on the default.
 */
export function mapLegacyDataPath(p: string, target: string = DATA_DIR): string {
  const m = /^([^/\\]+)(?=[/\\]|$)/.exec(p)
  if (!m || m[1] === target || !LEGACY_DATA_DIRS.includes(m[1])) return p
  return target + p.slice(m[1].length)
}

/**
 * The data directory directly under an already-resolved `root` (a worktree root,
 * or the main checkout a caller resolved itself). The primitive the helpers below
 * and every caller that owns its own root resolution build on.
 */
export function dataDirAt(root: string): string {
  // The first time a root's data dir is resolved, start bringing its legacy dir across
  // (single-flight, once per process). Async readers and every writer await
  // {@link dataDirReady} before they touch the directory.
  void dataDirReady(root)
  return path.join(root, DATA_DIR)
}

/** The PER-WORKTREE data dir of `folder` (`out/` scratch, canvas defaults, reports). */
export function dataDir(folder: string): string {
  return dataDirAt(path.resolve(folder))
}

/**
 * The main checkout root `folder` belongs to, or `null` outside a git repo.
 *
 * Missions are repo-scoped and shared by every worktree (design §9, decision 17), so a
 * session running in a linked worktree must read the MAIN checkout's `.harnu/missions/`.
 * Resolved synchronously from the `.git` layout — `runPolicy` is synchronous and runs on
 * every `pty:create`, so spawning `git rev-parse` here is not an option:
 * - `<dir>/.git` is a directory → `<dir>` is the main checkout;
 * - `<dir>/.git` is a file (`gitdir: <common>/worktrees/<name>`) → follow the gitdir's
 *   `commondir` back to `<common>`, whose parent is the main checkout.
 */
export function mainCheckoutRoot(folder: string): string | null {
  let dir = path.resolve(folder)
  for (;;) {
    const dotGit = path.join(dir, '.git')
    try {
      if (statSync(dotGit).isDirectory()) return dir
      const match = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotGit, 'utf8'))
      if (!match) return dir
      const gitDir = path.resolve(dir, match[1].trim())
      let commonDir: string
      try {
        commonDir = path.resolve(
          gitDir,
          readFileSync(path.join(gitDir, 'commondir'), 'utf8').trim()
        )
      } catch {
        return dir // a submodule-style gitdir with no `commondir`: this dir is the root
      }
      return path.basename(commonDir) === '.git' ? path.dirname(commonDir) : dir
    } catch {
      // No `.git` here — keep walking up.
    }
    const parent = path.dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

/** The repo root whose data dir holds `folder`'s repo-level state (main checkout, else `folder`). */
export function repoRoot(folder: string): string {
  return mainCheckoutRoot(folder) ?? path.resolve(folder)
}

/**
 * The REPO-LEVEL data dir of `folder`: the main checkout's, shared by every
 * worktree (memory, roadmap, missions, goals, learning).
 */
export function repoDataDir(folder: string): string {
  return dataDirAt(repoRoot(folder))
}

// ---- Copying a legacy data dir the first time a root is used --------------------

/**
 * Whether resolving a root's data dir may start the legacy copy. On in the app; off
 * under a test runner (a test that resolves the checkout it runs in must never copy
 * the developer's real `.capy/`) until a test opts in with {@link setLazyDataDirMigration}.
 */
let lazyMigration = process.env.VITEST === undefined
const ready = new Map<string, Promise<void>>()
let migrationAppVersion: string | undefined
const migratedListeners = new Set<(root: string) => void>()

/** Test seam: enable/disable the on-first-use copy (and forget which roots were handled). */
export function setLazyDataDirMigration(enabled: boolean): void {
  lazyMigration = enabled
  ready.clear()
}

/** The app version stamped into a copy's marker when the caller did not name one. */
export function setDataDirAppVersion(version: string | undefined): void {
  migrationAppVersion = version
}

export function dataDirAppVersion(): string | undefined {
  return migrationAppVersion
}

/**
 * Resolves once `root`'s legacy data dir (if any) has been copied into {@link DATA_DIR}
 * (or there was nothing to copy). Starts the copy the first time it is asked for a root;
 * the copy is single-flight with the boot pass and the lazy hook, so a call made while
 * one is running simply awaits it. Never rejects: a failed copy is reported where it
 * ran, and must not take a read or a write down with it.
 */
export function dataDirReady(root: string): Promise<void> {
  if (!lazyMigration) return Promise.resolve()
  const key = path.resolve(root)
  let p = ready.get(key)
  if (!p) {
    p = import('./migrations/data-dir')
      .then((m) => m.migrateDataDir(key))
      .then(
        () => undefined,
        () => undefined
      )
    ready.set(key, p)
  }
  return p
}

/** Be told (with the root) whenever a legacy data dir was copied — including a late, background copy. */
export function onDataDirMigrated(listener: (root: string) => void): () => void {
  migratedListeners.add(listener)
  return () => migratedListeners.delete(listener)
}

export function emitDataDirMigrated(root: string): void {
  for (const l of migratedListeners) {
    try {
      l(root)
    } catch {
      /* a listener must never break the copy */
    }
  }
}

// ---- Keeping the data dir out of git -----------------------------------------

/**
 * Every name the data dir has had or will have. Both are excluded in every repo
 * regardless of the current {@link DATA_DIR}, so the rename never leaves a window
 * where the new directory shows up as untracked.
 */
// `.capy` is the legacy alias: a pre-rename copy of the dir must stay excluded too.
const EXCLUDED_NAMES = [...new Set(['.capy', '.harnu', DATA_DIR])]

/** Git rules appended to the exclude file: every data-dir name, plus the copy's temp sibling. */
const EXCLUDE_RULE_NAMES = [...EXCLUDED_NAMES, `${DATA_DIR}.migrating`]

/**
 * Per-root work, in flight or done, so a hot write path spawns `git` once per root and
 * concurrent first writes await the same promise. A non-repo folder resolves to a
 * no-op and stays cached (its negative result lasts the process); an I/O failure is
 * dropped so a later write can retry.
 */
const excludeEnsured = new Map<string, Promise<void>>()
/** Tail of the append chain per common git dir, so worktrees of one repo never interleave. */
const excludeWrites = new Map<string, Promise<void>>()
let excludeWarned = false

/** Test seam: forget which roots were already handled. */
export function resetDataDirExcludeCache(): void {
  excludeEnsured.clear()
  excludeWrites.clear()
  excludeWarned = false
}

function gitCommonDir(folder: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      'git',
      ['rev-parse', '--git-common-dir'],
      { cwd: folder, timeout: 10_000 },
      (err, stdout) => {
        const out = String(stdout ?? '').trim()
        resolve(err || !out ? null : path.resolve(folder, out))
      }
    )
  })
}

/**
 * Keep the per-repo data dir out of git WITHOUT touching a tracked file: append
 * `/.capy/`, `/.harnu/` and the copy's `/.harnu.migrating/` to `<common git dir>/info/exclude`, which every linked
 * worktree shares and which is never committed. Only missing rules are appended,
 * existing content is preserved, and a repeat call changes nothing.
 *
 * A silent no-op outside a git repo or on any I/O error (logged at most once per
 * process): excluding is a courtesy and must never block a write to the data dir.
 */
export function ensureDataDirExcluded(folder: string): Promise<void> {
  const root = path.resolve(folder)
  const cached = excludeEnsured.get(root)
  if (cached) return cached
  const work = excludeRules(root).catch((err: unknown) => {
    excludeEnsured.delete(root)
    if (!excludeWarned) {
      excludeWarned = true
      console.warn('[data-dir] could not update .git/info/exclude:', (err as Error).message)
    }
  })
  excludeEnsured.set(root, work)
  return work
}

/** Append whichever rules are missing from the repo's exclude file; a no-op outside git. */
async function excludeRules(root: string): Promise<void> {
  const commonDir = await gitCommonDir(root)
  if (!commonDir) return
  const file = path.join(commonDir, 'info', 'exclude')
  const prior = excludeWrites.get(commonDir) ?? Promise.resolve()
  const run = prior.then(async () => {
    let existing = ''
    try {
      existing = await readFile(file, 'utf8')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
    }
    const present = new Set(existing.split(/\r?\n/).map((l) => l.trim()))
    const missing = EXCLUDE_RULE_NAMES.map((n) => `/${n}/`).filter((rule) => !present.has(rule))
    if (missing.length === 0) return
    await mkdir(path.dirname(file), { recursive: true })
    const lead = existing.length > 0 && !existing.endsWith('\n') ? '\n' : ''
    await appendFile(file, `${lead}${missing.join('\n')}\n`, 'utf8')
  })
  excludeWrites.set(
    commonDir,
    run.catch(() => undefined)
  )
  await run
}

/**
 * `mkdir -p` the data dir directly under `root`, then make sure git ignores it.
 * The one entry point for creating a per-repo data dir.
 */
export async function ensureDataDir(root: string): Promise<void> {
  // Never create the dir under a copy that is still filling it: the copy would then
  // find the target taken and discard itself.
  await dataDirReady(root)
  await mkdir(dataDirAt(root), { recursive: true })
  await ensureDataDirExcluded(root)
}

/**
 * `mkdir -p dir` for a directory that may live inside a repo's data dir (memory,
 * missions, canvas out/, card assets…). When `dir` is under a data dir, that data
 * dir is created and excluded through {@link ensureDataDir} first; otherwise (a
 * centrally-stored memory, say) it is a plain recursive mkdir.
 */
export async function mkdirDataDir(dir: string): Promise<void> {
  const abs = path.resolve(dir)
  const segments = abs.split(path.sep)
  const at = segments.findIndex((s) => EXCLUDED_NAMES.includes(s))
  if (at > 0) await ensureDataDir(segments.slice(0, at).join(path.sep) || path.sep)
  await mkdir(abs, { recursive: true })
}
