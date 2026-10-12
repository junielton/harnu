// Cleanup cleaning its own exhaust (unit C): the archive refs and the OS-trash items that Harnu's own
// removals leave behind. This is the env-bound wiring (git, the journal, the user data folder, the
// OS trash); every decision it makes is in the cores (`archives-core`, `trash-core`), and the git
// and trash work in the shells (`archives-shell`, `trash-shell`), all of them tested.
//
// Two rules hold here. Nothing runs `git gc` unless the operator asks for it with its own
// confirm. And the trash is only ever emptied of what the journal says Harnu moved there, on an
// explicit action: the autopilot never calls into this file's trash functions.

import { promises as fs } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { app } from 'electron'
import { readJournal } from '../reaper/journal'
import { lastSnapshot } from '../reaper/scanner-shell'
import {
  NO_ARCHIVES,
  buildArchivesCard,
  confirmedArchives,
  expiredArchives,
  withFolders,
  type ArchiveEntry,
  type ConfirmedArchive,
  type GcArchivesCard
} from './archives-core'
import {
  archiveBytes,
  deleteArchiveEntries,
  execGit,
  listRepoArchives,
  runGitGc,
  type DeleteArchivesResult,
  type GitRunner
} from './archives-shell'
import type { GcPrefs } from './gc-prefs'
import { NO_TRASH, trashedEntries, type GcTrashCard } from './trash-core'
import {
  canEmptySelectively,
  emptyHarnuTrash,
  presentInTrash,
  trashCard,
  trashLocation,
  type EmptyResult,
  type TrashEnv
} from './trash-shell'

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/** How many journal lines the ledger reads: every clean writes one, so this is years of use. */
const JOURNAL_LINES = 20_000

// ---- repos ------------------------------------------------------------------------------------

async function isGitRepo(p: string): Promise<boolean> {
  try {
    await fs.stat(path.join(p, '.git'))
    return true
  } catch {
    return false
  }
}

/**
 * The repos whose archive refs Cleanup lists: those the last scan covers, plus every repo the
 * journal wrote an archive ref in (a repo can drop out of the scan and still hold its archives).
 * Only a folder that still has a `.git` counts.
 */
export async function archiveRepos(): Promise<string[]> {
  const scanned = lastSnapshot()?.repos.map((r) => r.repoPath) ?? []
  const journal = await readJournal(JOURNAL_LINES)
  const journaled = journal.filter((t) => t.archiveTipRef || t.archiveWipRef).map((t) => t.repoPath)
  const all = [...new Set([...scanned, ...journaled])]
  const alive = await Promise.all(all.map(async (p) => ((await isGitRepo(p)) ? p : null)))
  return alive.filter((p): p is string => p !== null)
}

// ---- archives ---------------------------------------------------------------------------------

/**
 * Sizing a repo walks its history, which can take seconds on a big one: the figure is cached
 * against the archive refs it was computed for, for a few minutes.
 */
const SIZE_TTL_MS = 10 * 60_000
const sizeCache = new Map<string, { sig: string; at: number; bytes: number | null }>()

async function sizedArchives(
  git: GitRunner,
  repo: string,
  now: number
): Promise<{ entries: ArchiveEntry[]; bytes: number | null }> {
  const entries = await listRepoArchives(git, repo)
  if (entries.length === 0) return { entries, bytes: 0 }
  const sig = entries.map((e) => `${e.tipSha}:${e.wipSha}`).join(',')
  const hit = sizeCache.get(repo)
  if (hit && hit.sig === sig && now - hit.at < SIZE_TTL_MS) return { entries, bytes: hit.bytes }
  const bytes = await archiveBytes(git, repo)
  sizeCache.set(repo, { sig, at: now, bytes })
  return { entries, bytes }
}

/** The Archives card: never throws, so a git hiccup in one repo cannot fail the whole gather. */
export async function gatherArchives(
  prefs: Pick<GcPrefs, 'archiveKeepDays' | 'archiveAutoExpire'>,
  now: number,
  git: GitRunner = execGit
): Promise<GcArchivesCard> {
  const policy = { keepDays: prefs.archiveKeepDays, autoExpire: prefs.archiveAutoExpire }
  try {
    const [repos, journal] = await Promise.all([archiveRepos(), readJournal(JOURNAL_LINES)])
    const perRepo = await Promise.all(
      repos.map(async (repoPath) => {
        try {
          const { entries, bytes } = await sizedArchives(git, repoPath, now)
          return { repoPath, entries: withFolders(entries, journal), bytes }
        } catch (err) {
          console.warn('[gc] listing archives failed', repoPath, messageOf(err))
          return { repoPath, entries: [] as ArchiveEntry[], bytes: null }
        }
      })
    )
    return buildArchivesCard(perRepo, policy, now)
  } catch (err) {
    console.warn('[gc] gathering archives failed', messageOf(err))
    return { ...NO_ARCHIVES, ...policy }
  }
}

export interface ArchiveDeleteRequest {
  repoPath: string
  archives: ConfirmedArchive[]
}

export interface ArchiveDeleteAck {
  ok: boolean
  /** Refs deleted. */
  deleted: number
  /** Refs git refused to delete. */
  failed: number
  /** Archives that no longer match what the operator confirmed, left alone. */
  changed: string[]
  /** The repo is not one Cleanup knows. */
  unknownRepo?: boolean
}

/**
 * Deletes the archives the operator confirmed, in one known repo, each only if it still has the
 * exact shas it had when listed. Never runs `git gc`.
 */
export async function deleteConfirmedArchives(
  req: ArchiveDeleteRequest,
  git: GitRunner = execGit
): Promise<ArchiveDeleteAck> {
  const known = await archiveRepos()
  if (!known.includes(req.repoPath)) {
    return { ok: false, deleted: 0, failed: 0, changed: [], unknownRepo: true }
  }
  const fresh = await listRepoArchives(git, req.repoPath)
  const { entries, changed } = confirmedArchives(fresh, req.archives)
  const result: DeleteArchivesResult = await deleteArchiveEntries(git, req.repoPath, entries)
  sizeCache.delete(req.repoPath)
  return {
    ok: result.failed.length === 0 && changed.length === 0,
    deleted: result.deleted.length,
    failed: result.failed.length,
    changed
  }
}

/**
 * The autopilot's expiry (only reached when "Expire archives automatically" is on): every archive
 * older than `keepDays` in every known repo. Deletes refs only, never runs `git gc`.
 */
export async function expireArchivesNow(
  keepDays: number,
  now: number,
  git: GitRunner = execGit
): Promise<{ deleted: number; failed: number }> {
  let deleted = 0
  let failed = 0
  for (const repo of await archiveRepos()) {
    try {
      const expired = expiredArchives(await listRepoArchives(git, repo), keepDays, now)
      if (expired.length === 0) continue
      const r = await deleteArchiveEntries(git, repo, expired)
      deleted += r.deleted.length
      failed += r.failed.length
      sizeCache.delete(repo)
    } catch (err) {
      failed++
      console.warn('[gc] archive expiry failed', repo, messageOf(err))
    }
  }
  return { deleted, failed }
}

/** "Run git gc now": one known repo, after its own confirm. */
export async function runGcInRepo(
  repoPath: string,
  git: GitRunner = execGit
): Promise<{ ok: boolean; error?: string }> {
  if (!(await archiveRepos()).includes(repoPath)) return { ok: false, error: 'unknown-repo' }
  try {
    await runGitGc(git, repoPath)
    sizeCache.delete(repoPath)
    return { ok: true }
  } catch (err) {
    return { ok: false, error: messageOf(err) }
  }
}

// ---- trash ------------------------------------------------------------------------------------

const SETTLED_FILE = 'gc-trash-settled.json'
const SETTLED_MAX = 20_000

function trashEnv(): TrashEnv {
  const dataHome = process.env.XDG_DATA_HOME
  return {
    platform: process.platform,
    homeTrash: path.join(
      dataHome && path.isAbsolute(dataHome) ? dataHome : path.join(os.homedir(), '.local', 'share'),
      'Trash'
    ),
    uid: typeof process.getuid === 'function' ? process.getuid() : null
  }
}

async function readSettled(): Promise<Set<string>> {
  try {
    const raw = JSON.parse(
      await fs.readFile(path.join(app.getPath('userData'), SETTLED_FILE), 'utf8')
    )
    return new Set(
      Array.isArray(raw?.settled) ? raw.settled.filter((k: unknown) => typeof k === 'string') : []
    )
  } catch {
    return new Set()
  }
}

async function writeSettled(settled: ReadonlySet<string>): Promise<void> {
  const file = path.join(app.getPath('userData'), SETTLED_FILE)
  // Newest are last in insertion order; keep the tail so the file stays bounded.
  const keep = [...settled].slice(-SETTLED_MAX)
  const tmp = `${file}.tmp`
  await fs.writeFile(tmp, JSON.stringify({ settled: keep }) + '\n', 'utf8')
  await fs.rename(tmp, file)
}

/**
 * What Harnu moved to the trash and that is still there. An item the user emptied or restored
 * themselves is remembered as settled, so it stops counting. Never throws.
 */
export async function gatherTrash(): Promise<GcTrashCard> {
  const env = trashEnv()
  try {
    const [journal, settled] = await Promise.all([readJournal(JOURNAL_LINES), readSettled()])
    const entries = trashedEntries(journal, settled)
    if (entries.length === 0) {
      return {
        ...NO_TRASH,
        canEmpty: canEmptySelectively(env.platform),
        location: trashLocation(env.platform, env.homeTrash)
      }
    }
    const { present, gone, unsupported } = await presentInTrash(entries, env)
    if (gone.length > 0) {
      const next = new Set(settled)
      for (const e of gone) next.add(e.key)
      await writeSettled(next).catch(() => undefined)
    }
    return trashCard(present, unsupported, env)
  } catch (err) {
    console.warn('[gc] gathering the trash failed', messageOf(err))
    return { ...NO_TRASH, location: trashLocation(env.platform, env.homeTrash) }
  }
}

export interface EmptyTrashAck extends Omit<EmptyResult, 'emptied' | 'missing' | 'failed'> {
  emptied: number
  missing: number
  failed: number
  /** Where the OS keeps the trash: what to show when `unsupported`. */
  location: string
}

/**
 * Permanently removes what Harnu moved to the trash and nothing else, on an explicit operator
 * action (the UI confirms first). The autopilot has no path here.
 */
export async function emptyHarnuTrashNow(): Promise<EmptyTrashAck> {
  const env = trashEnv()
  const [journal, settled] = await Promise.all([readJournal(JOURNAL_LINES), readSettled()])
  const result = await emptyHarnuTrash(trashedEntries(journal, settled), env)
  const next = new Set(settled)
  // Removed, or no longer there: either way the ledger has nothing left to empty for them.
  for (const key of [...result.emptied, ...result.missing]) next.add(key)
  if (next.size !== settled.size) await writeSettled(next).catch(() => undefined)
  return {
    unsupported: result.unsupported,
    emptiedBytes: result.emptiedBytes,
    emptied: result.emptied.length,
    missing: result.missing.length,
    failed: result.failed.length,
    location: trashLocation(env.platform, env.homeTrash)
  }
}
