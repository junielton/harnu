/**
 * Missions v4 S-2 (R-25, AC-3) — the one reader of mission files.
 *
 * The verbs (`mcp/tool-handlers.ts`), the renderer IPC (`mission-ipc.ts`), the campaign
 * reader (since removed) and hibernation (`hibernation.ts`) used to each walk
 * `.harnu/missions/` their own way. Two of them dedupe the copies of a mission that two clones
 * of one repo hold, the others did not, and each decided on its own who leads a mission. They
 * all read here now, so one repo gives the same answer to every caller.
 *
 * Nothing here writes. A file that cannot be read or parsed is reported (`unreadable`), never
 * thrown.
 *
 * A repeated read is cheap (BUG-278): a mission file is parsed once and served from `file-cache.ts`
 * until its stamp (mtime, size, inode) moves, so a poll lists the directory once and `stat`s each
 * file, and reads nothing that did not change. The last result of every root is also kept as a
 * snapshot, which the synchronous fleet snapshot of hibernation reads instead of touching the disk:
 * see {@link readMissionsDedupedSnapshot}.
 */
import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import { dataDirAt, dataDirReady, repoRoot } from '../data-dir'
import { pruneMissionDir, readParsedCached, singleFlight } from './file-cache'
import {
  V3_MISSION_ID_RE as MISSION_ID_RE,
  parseV3MissionFile as parseMissionFile,
  readV3MissionLog as readMissionLog,
  type V3Mission as Mission
} from './v3-read'

/** `<root>/.harnu/missions`: where a v3 build stored its mission files (a v4 build never writes there). */
const missionsDir = (root: string): string => path.join(dataDirAt(root), 'missions')

/** The repo root whose `.harnu/missions/` holds `folder`'s missions. */
export function missionRoot(folder: string): string {
  return repoRoot(folder)
}

export interface MissionFileEntry {
  id: string
  slug: string
  name: string
}

/** The entry a mission file name describes, or null for any other file. */
function entryOf(name: string): MissionFileEntry | null {
  const m = /^(mnt-[0-9a-f]{8})-(.+)\.md$/.exec(name)
  return m ? { id: m[1], slug: m[2], name } : null
}

function entriesOf(names: readonly string[]): MissionFileEntry[] {
  const out: MissionFileEntry[] = []
  for (const name of [...names].sort()) {
    const entry = entryOf(name)
    if (entry) out.push(entry)
  }
  return out
}

/** Every `<id>-<slug>.md` in `root`'s missions dir; `[]` when there is none yet. */
export async function listMissionEntries(root: string): Promise<MissionFileEntry[]> {
  await dataDirReady(root)
  try {
    const names = await fs.readdir(missionsDir(root))
    pruneMissionDir(missionsDir(root), new Set(names))
    return entriesOf(names)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      pruneMissionDir(missionsDir(root), new Set())
      return []
    }
    throw err
  }
}

export type LoadedMission =
  | { ok: true; file: string; raw: string; mission: Mission; log: string }
  | { ok: false; error: string }

function parseLoaded(root: string, entry: MissionFileEntry, raw: string): LoadedMission {
  const parsed = parseMissionFile(raw)
  if ('error' in parsed) {
    return { ok: false, error: `MISSION_UNREADABLE: ${entry.name} — ${parsed.error}` }
  }
  return {
    ok: true,
    file: path.join(missionsDir(root), entry.name),
    raw,
    mission: parsed,
    log: readMissionLog(raw)
  }
}

/** Read + parse one mission by id; a steerable error when absent or corrupt. */
export async function loadMission(root: string, id: string): Promise<LoadedMission> {
  if (!MISSION_ID_RE.test(id)) {
    return { ok: false, error: `BAD_ARGS: missionId "${id}" is not a mission id (mnt-<8 hex>).` }
  }
  const entry = (await listMissionEntries(root)).find((e) => e.id === id)
  if (!entry) {
    return {
      ok: false,
      error: `MISSION_NOT_FOUND: no mission ${id} in this repo — mission_list shows the ones that exist.`
    }
  }
  return parseLoaded(
    root,
    entry,
    await fs.readFile(path.join(missionsDir(root), entry.name), 'utf8')
  )
}

/** One readable mission file: the record, its Log body and where it lives. */
export interface MissionRead {
  mission: Mission
  log: string
  file: string
}

type ReadResult = { missions: MissionRead[]; unreadable: string[] }

/** What one mission file parses to, as the list reader keeps it: the record, or why it is unreadable. */
type ParsedMission = { ok: true; read: MissionRead } | { ok: false }

/** The last result of {@link readAllMissions} per root: what the synchronous readers serve. */
const snapshots = new Map<string, ReadResult>()
/** `root` → its `realpath`, as the last async read resolved it. */
const canonMemo = new Map<string, string>()
/** Reads of one root already under way: a second caller waits for the first. */
const sharedRead = singleFlight<ReadResult>()

async function readRoot(root: string): Promise<ReadResult> {
  const dir = missionsDir(root)
  const entries = await listMissionEntries(root)
  const parsed = await Promise.all(
    entries.map(async (entry): Promise<ParsedMission> => {
      const file = path.join(dir, entry.name)
      try {
        return await readParsedCached('v3-list', file, (raw): ParsedMission => {
          const mission = parseMissionFile(raw)
          if ('error' in mission) return { ok: false }
          return { ok: true, read: { mission, log: readMissionLog(raw), file } }
        })
      } catch {
        return { ok: false }
      }
    })
  )
  const missions: MissionRead[] = []
  const unreadable: string[] = []
  parsed.forEach((p, i) => {
    if (p.ok) missions.push(p.read)
    else unreadable.push(entries[i].name)
  })
  const result = { missions, unreadable }
  snapshots.set(root, result)
  return result
}

/**
 * Every readable mission under `root`, with its Log; corrupt files are reported, not thrown. One
 * `readdir`, then a `stat` per file: a file whose stamp is unchanged is served from the cache (never
 * re-read or re-parsed). Concurrent reads of one root share one run.
 */
export function readAllMissions(root: string): Promise<ReadResult> {
  return sharedRead(root, () => readRoot(root))
}

/** One readable mission copy with the repo root it was read from. */
export interface RootedMission extends MissionRead {
  root: string
}

export interface DedupedMissions {
  missions: RootedMission[]
  unreadable: Array<{ root: string; name: string }>
  shadowed: Array<{ missionId: string; root: string }>
}

/** `(id, root)` pairs already warned about, so a 20 s poll logs each shadowed copy once. */
const warnedShadowed = new Set<string>()

interface RootRead {
  canon: string
  root: string
  read: ReadResult
}

/**
 * Pick, per mission id, the copy that counts (BUG-173 S1). Shared by the async read and the snapshot
 * read, so both give the same answer.
 *
 * - The winner of an id is the copy with the newest `updatedAt`; a tie goes to the root that
 *   sorts first by path, so the answer never depends on poll order.
 * - The status rule runs on the WINNER: with `includeClosed: false` a closed winner drops the id
 *   even when an older twin elsewhere still says `active`.
 * - Losing copies in another root come back as `shadowed` (one `console.warn` per process per
 *   pair). Nothing is deleted or rewritten.
 */
function dedupe(reads: readonly RootRead[], includeClosed: boolean): DedupedMissions {
  const unreadable = reads.flatMap(({ root, read }) =>
    read.unreadable.map((name) => ({ root, name }))
  )
  const all = reads.flatMap(({ canon, root, read }) =>
    read.missions.map((m) => ({ canon, copy: { root, ...m } }))
  )
  const winners = new Map<string, (typeof all)[number]>()
  for (const entry of all) {
    const best = winners.get(entry.copy.mission.id)
    if (!best) {
      winners.set(entry.copy.mission.id, entry)
      continue
    }
    const a = entry.copy.mission.updatedAt
    const b = best.copy.mission.updatedAt
    if (a > b || (a === b && entry.canon < best.canon)) winners.set(entry.copy.mission.id, entry)
  }

  const shadowed: DedupedMissions['shadowed'] = []
  const missions: RootedMission[] = []
  for (const entry of all) {
    const winner = winners.get(entry.copy.mission.id)!
    if (winner === entry) {
      if (includeClosed || entry.copy.mission.status !== 'closed') missions.push(entry.copy)
      continue
    }
    // A repeated id inside ONE root is the same mission twice, not a second clone.
    if (winner.canon === entry.canon) continue
    const { id } = entry.copy.mission
    shadowed.push({ missionId: id, root: entry.copy.root })
    const key = `${id}\u0000${entry.canon}`
    if (!warnedShadowed.has(key)) {
      warnedShadowed.add(key)
      console.warn(
        `[missions] ${id} in ${entry.copy.root} is shadowed by a newer copy in ${winner.copy.root}`
      )
    }
  }
  return { missions, unreadable, shadowed }
}

/**
 * Every readable mission across `roots`, at most ONE per `mission.id` (BUG-173 S1). Two clones of
 * one repo can hold the same mission files; every caller reads through here so none lists a
 * mission twice. Roots are canonicalised with `realpath` (the resolved string when that fails),
 * so one directory reached through two spellings is read once; the root reported back is the
 * first spelling given.
 */
export async function readMissionsDeduped(
  roots: readonly string[],
  { includeClosed }: { includeClosed: boolean }
): Promise<DedupedMissions> {
  const canonOf = new Map<string, string>() // canonical path → first spelling given
  for (const root of roots) {
    const canon = await fs.realpath(root).catch(() => path.resolve(root))
    canonMemo.set(root, canon)
    if (!canonOf.has(canon)) canonOf.set(canon, root)
  }
  const reads = await Promise.all(
    [...canonOf].map(async ([canon, root]) => ({ canon, root, read: await readAllMissions(root) }))
  )
  return dedupe(reads, includeClosed)
}

/**
 * The same answer as {@link readMissionsDeduped}, from the snapshots the async reads left, with no
 * I/O at all: the synchronous fleet snapshot of hibernation reads through here. A root nobody has
 * read yet reads as empty (it is listed in `unread`), so the FIRST sweep over a repo can find no
 * missions and park an owner whose child is live. The caller starts {@link warmMissionSnapshots} for
 * that, and the next sweep sees the missions. A parked session is intact on disk (selecting the row
 * resumes it), so the miss costs a resume, never work.
 */
export function readMissionsDedupedSnapshot(
  roots: readonly string[],
  { includeClosed }: { includeClosed: boolean }
): DedupedMissions & { unread: string[] } {
  const canonOf = new Map<string, string>()
  for (const root of roots) {
    const canon = canonMemo.get(root) ?? path.resolve(root)
    if (!canonOf.has(canon)) canonOf.set(canon, root)
  }
  const unread: string[] = []
  const reads = [...canonOf].map(([canon, root]) => {
    const read = snapshots.get(root)
    if (!read) unread.push(root)
    return { canon, root, read: read ?? { missions: [], unreadable: [] } }
  })
  return { ...dedupe(reads, includeClosed), unread }
}

interface WarmState {
  running: Promise<void>
  trailing: Promise<void> | null
}
const warming = new Map<string, WarmState>()

function startWarm(key: string, roots: readonly string[]): Promise<void> {
  const state: WarmState = { running: Promise.resolve(), trailing: null }
  warming.set(key, state)
  state.running = readMissionsDeduped(roots, { includeClosed: true })
    .then(() => undefined)
    .catch(() => undefined)
    .finally(() => {
      if (warming.get(key) === state) warming.delete(key)
    })
  return state.running
}

/**
 * Refresh the snapshots of `roots`, through the same cached read as everyone else: a poll with nothing
 * changed costs a `readdir` and a `stat` per file. Never rejects. The promise settles once a run that
 * STARTED after this call has finished: a call that arrives while a run is under way waits for one
 * follow-up run (all callers of that moment share it), never for the older run, whose view of the
 * files may pre-date what the caller knows changed.
 */
export function warmMissionSnapshots(roots: readonly string[]): Promise<void> {
  const key = [...new Set(roots)].sort().join('\u0000')
  const state = warming.get(key)
  if (!state) return startWarm(key, roots)
  state.trailing ??= state.running.then(() => startWarm(key, roots))
  return state.trailing
}

/**
 * Who leads `mission`: the session that owns it, for as long as it is not closed. A delivered
 * mission is waiting for the operator to close it, so it still has its leader. Every caller asks
 * here instead of reading `owner.sessionId` and checking the status itself.
 */
export function leaderOf(mission: Mission): string | null {
  return mission.status === 'closed' ? null : mission.owner.sessionId
}

/** The missions `sessionId` leads (see {@link leaderOf}), the most recently updated first. */
export function missionsLedBy<T extends { mission: Mission }>(
  missions: readonly T[],
  sessionId: string
): T[] {
  return missions
    .filter((m) => leaderOf(m.mission) === sessionId)
    .sort((a, b) => b.mission.updatedAt.localeCompare(a.mission.updatedAt))
}

// ---- Mission files nobody could read (Missions v4 S-40, Decision 12) ----------------------------------

/**
 * The files each reader found it could not parse, by reader (`hibernation`, `companion`, `your-move`).
 * A reader that skips an unreadable mission file hides a mission, and a mission that is hidden from the
 * hibernation exemption can have its leader parked mid-delivery. So every such skip is reported here, by
 * file name, and `mission:list` (the poll the app's Activity notice is raised from) merges the union into
 * its `unreadable` list: one notice that names the file, raised once while the same set stays unreadable,
 * never once per tick. A reader reports its whole set on every read, so a file that reads again leaves
 * the list and a later failure of it is news again.
 */
const unreadableBySource = new Map<string, ReadonlySet<string>>()

/**
 * Record the files `source` could not read, replacing what it reported before. Returns the names that are
 * new to this source (the ones that were not already reported by it), so a caller can log a failure once.
 */
export function reportUnreadableMissionFiles(source: string, files: readonly string[]): string[] {
  const before = unreadableBySource.get(source) ?? new Set<string>()
  const next = new Set(files.filter((f) => f !== ''))
  if (next.size === 0) unreadableBySource.delete(source)
  else unreadableBySource.set(source, next)
  return [...next].filter((f) => !before.has(f)).sort()
}

/** Every file some reader reported as unreadable and has not read since, each once, sorted. */
export function reportedUnreadableMissionFiles(): string[] {
  return [...new Set([...unreadableBySource.values()].flatMap((s) => [...s]))].sort()
}

/** Test seam: forget every report. */
export function resetUnreadableMissionFiles(): void {
  unreadableBySource.clear()
}
