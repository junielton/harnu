// Cleanup cleaning its own exhaust (unit C): the archive refs and the OS-trash items that Harnu's own
// removals leave behind. This is the env-bound wiring (git, the journal, the user data folder, the
// OS trash); every decision it makes is in the cores (`archives-core`, `trash-core`), and the git
// and trash work in the shells (`archives-shell`, `trash-shell`), all of them tested.
//
// Two rules hold here. Nothing runs `git gc` unless the operator asks for it with its own
// confirm. And the trash is only ever emptied of what the journal says Harnu moved there, on an
// explicit action: the autopilot never calls into this file's trash functions.

import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import { app } from 'electron'
import { journalPath, readJournal, type Tombstone } from '../reaper/journal'
import { lastSnapshot } from '../reaper/scanner-shell'
import { canonicalPathKey } from './bundle-core'
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
  defaultTrashEnv,
  emptyHarnuTrash,
  observeTrashEntries,
  trashCard,
  trashLocation,
  type TrashEnv
} from './trash-shell'

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/**
 * The journal parsed once per change: a gather asks for it three times (the repos, the archives'
 * folders, the trash), and it only ever grows by appending, so it is re-read only when it changed.
 */
let journalCache: { mtimeMs: number; size: number; lines: Tombstone[] } | null = null
async function readJournalCached(): Promise<Tombstone[]> {
  try {
    const st = await fs.stat(journalPath())
    if (journalCache && journalCache.mtimeMs === st.mtimeMs && journalCache.size === st.size) {
      return journalCache.lines
    }
    const lines = await readJournal(JOURNAL_LINES)
    journalCache = { mtimeMs: st.mtimeMs, size: st.size, lines }
    return lines
  } catch {
    return []
  }
}

/**
 * The never-clean list as a test of "is this path one of them, or under one", on real paths where they
 * can be read (a symlinked spelling of a protected repo is still protected) and as written otherwise.
 */
async function protectedPaths(
  neverClean: readonly string[]
): Promise<{ covers(p: string): Promise<boolean> }> {
  const real = async (p: string): Promise<string> => {
    try {
      return await fs.realpath(p)
    } catch {
      return p
    }
  }
  const platform = process.platform
  const keys = new Set<string>()
  for (const p of neverClean) {
    keys.add(canonicalPathKey(p, platform))
    keys.add(canonicalPathKey(await real(p), platform))
  }
  return {
    covers: async (p) => {
      const candidates = [canonicalPathKey(p, platform), canonicalPathKey(await real(p), platform)]
      return candidates.some((c) => [...keys].some((k) => c === k || c.startsWith(`${k}/`)))
    }
  }
}

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
  const journal = await readJournalCached()
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
    const [repos, journal] = await Promise.all([archiveRepos(), readJournalCached()])
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
  /** Archives deleted: a tip and its wip are one. This is the number to tell the operator. */
  archives: number
  /** Refs git refused to delete. */
  failed: number
  /** Archives that no longer match what the operator confirmed, left alone. */
  changed: string[]
  /** The repo is not one Cleanup knows. */
  unknownRepo?: boolean
  /** The repo is on the never-clean list: nothing in it was touched. */
  neverClean?: boolean
}

/**
 * Deletes the archives the operator confirmed, in one known repo, each only if it still has the
 * exact shas it had when listed. Never runs `git gc`.
 */
export async function deleteConfirmedArchives(
  req: ArchiveDeleteRequest,
  neverClean: readonly string[] = [],
  git: GitRunner = execGit
): Promise<ArchiveDeleteAck> {
  const known = await archiveRepos()
  if (!known.includes(req.repoPath)) {
    return { ok: false, deleted: 0, archives: 0, failed: 0, changed: [], unknownRepo: true }
  }
  // "Never clean" holds by hand too: a repo the operator listed is not touched at all.
  if (await (await protectedPaths(neverClean)).covers(req.repoPath)) {
    return { ok: false, deleted: 0, archives: 0, failed: 0, changed: [], neverClean: true }
  }
  const fresh = await listRepoArchives(git, req.repoPath)
  const { entries, changed } = confirmedArchives(fresh, req.archives)
  const result: DeleteArchivesResult = await deleteArchiveEntries(git, req.repoPath, entries)
  sizeCache.delete(req.repoPath)
  return {
    ok: result.failed.length === 0 && changed.length === 0,
    deleted: result.deleted.length,
    archives: result.archives,
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
  neverClean: readonly string[] = [],
  git: GitRunner = execGit
): Promise<{ deleted: number; failed: number }> {
  let deleted = 0
  let failed = 0
  const protectedBy = await protectedPaths(neverClean)
  const journal = await readJournalCached()
  for (const repo of await archiveRepos()) {
    // A repo on the never-clean list, or inside a path that is, is never touched.
    if (await protectedBy.covers(repo)) continue
    try {
      // An archive of a folder that stood under a never-clean path is protected as well, even in
      // a repo that is not.
      const old = expiredArchives(
        withFolders(await listRepoArchives(git, repo), journal),
        keepDays,
        now
      )
      const expired: ArchiveEntry[] = []
      for (const e of old) {
        if (e.folder === null || !(await protectedBy.covers(e.folder))) expired.push(e)
      }
      if (expired.length === 0) continue
      const r = await deleteArchiveEntries(git, repo, expired)
      deleted += r.archives
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
 * What Harnu moved to the trash, checked entry by entry against the exact record made when it moved
 * them. An entry the user emptied, restored or replaced stops counting (it is settled); one that
 * cannot be checked is reported apart and never counted as space in the trash. Never throws.
 */
export async function gatherTrash(
  env: TrashEnv = defaultTrashEnv(),
  opts: { persist?: boolean } = {}
): Promise<GcTrashCard> {
  try {
    const [journal, settled] = await Promise.all([readJournalCached(), readSettled()])
    const ledger = await observeTrashEntries(trashedEntries(journal, settled), env)
    // Tidying the ledger writes a file, so a read-only gather (an agent's `list_cleanup`) never does.
    if (opts.persist !== false && ledger.gone.length > 0) {
      const next = new Set(settled)
      for (const e of ledger.gone) next.add(e.key)
      await writeSettled(next).catch(() => undefined)
    }
    return trashCard(ledger, env)
  } catch (err) {
    console.warn('[gc] gathering the trash failed', messageOf(err))
    return { ...NO_TRASH, location: trashLocation(env.platform, env.homeTrash) }
  }
}

export interface EmptyTrashAck {
  unsupported: boolean
  emptiedBytes: number
  emptied: number
  /** Entries that were no longer in the trash. */
  missing: number
  /** Entries left alone, for any reason below. */
  skipped: number
  /** ...no longer exactly what Harnu moved. */
  changed: number
  /** ...no exact record of the move (a clean from before it was recorded). */
  unverifiable: number
  /** ...their trash cannot be read right now (a disk that is not mounted). */
  unreachable: number
  failed: number
  /** Where the OS keeps the trash (null on Windows): what to show when `unsupported`. */
  location: string | null
}

/**
 * Permanently removes the trash entries the operator confirmed by id and nothing else, each only
 * while it is still exactly the entry Harnu recorded. Anything trashed since the dialog opened is not
 * in `ids` and stays. The autopilot has no path here.
 */
export async function emptyHarnuTrashNow(
  ids: readonly string[],
  env: TrashEnv = defaultTrashEnv()
): Promise<EmptyTrashAck> {
  const [journal, settled] = await Promise.all([readJournalCached(), readSettled()])
  const result = await emptyHarnuTrash(trashedEntries(journal, settled), ids, env)
  const next = new Set(settled)
  // Removed, or no longer there: either way the ledger has nothing left to empty for them. An
  // entry that changed is no longer Harnu's either.
  for (const key of [...result.emptied, ...result.missing, ...result.changed]) next.add(key)
  if (next.size !== settled.size) await writeSettled(next).catch(() => undefined)
  return {
    unsupported: result.unsupported,
    emptiedBytes: result.emptiedBytes,
    emptied: result.emptied.length,
    missing: result.missing.length,
    skipped: result.changed.length + result.unverifiable.length + result.unreachable.length,
    changed: result.changed.length,
    unverifiable: result.unverifiable.length,
    unreachable: result.unreachable.length,
    failed: result.failed.length,
    location: trashLocation(env.platform, env.homeTrash)
  }
}
