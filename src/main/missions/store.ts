/**
 * Missions v4 S-2 (R-25, AC-3) — the one reader of mission files.
 *
 * The verbs (`mcp/tool-handlers.ts`), the renderer IPC (`mission-ipc.ts`), the campaign
 * reader (`campaign-ipc.ts`) and hibernation (`hibernation.ts`) used to each walk
 * `.harnu/missions/` their own way. Two of them dedupe the copies of a mission that two clones
 * of one repo hold, the others did not, and each decided on its own who leads a mission. They
 * all read here now, so one repo gives the same answer to every caller.
 *
 * Nothing here writes. A file that cannot be read or parsed is reported (`unreadable`), never
 * thrown, and a repeated read is cheap: this module keeps no cache of its own.
 */
import { promises as fs, readdirSync, readFileSync, realpathSync } from 'node:fs'
import * as path from 'node:path'
import { dataDirReady, repoRoot } from '../data-dir'
import {
  MISSION_ID_RE,
  missionsDir,
  parseMissionFile,
  readMissionLog,
  type Mission
} from '../mission-core'

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
    return entriesOf(await fs.readdir(missionsDir(root)))
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw err
  }
}

/**
 * The synchronous twin of {@link listMissionEntries}, for the fleet snapshot hibernation feeds,
 * which is synchronous. It does not wait for a legacy data dir to be copied (see the note on
 * {@link readMissionsDedupedSync}) and fails open: an unreadable directory lists nothing.
 */
export function listMissionEntriesSync(root: string): MissionFileEntry[] {
  try {
    return entriesOf(readdirSync(missionsDir(root)))
  } catch {
    return []
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

/** Every readable mission under `root`, with its Log; corrupt files are reported, not thrown. */
export async function readAllMissions(root: string): Promise<{
  missions: MissionRead[]
  unreadable: string[]
}> {
  const missions: MissionRead[] = []
  const unreadable: string[] = []
  for (const entry of await listMissionEntries(root)) {
    const loaded = await loadMission(root, entry.id)
    if (loaded.ok) missions.push({ mission: loaded.mission, log: loaded.log, file: loaded.file })
    else unreadable.push(entry.name)
  }
  return { missions, unreadable }
}

/** The synchronous twin of {@link readAllMissions}; a file it cannot read counts as unreadable. */
function readAllMissionsSync(root: string): { missions: MissionRead[]; unreadable: string[] } {
  const missions: MissionRead[] = []
  const unreadable: string[] = []
  for (const entry of listMissionEntriesSync(root)) {
    try {
      const loaded = parseLoaded(
        root,
        entry,
        readFileSync(path.join(missionsDir(root), entry.name), 'utf8')
      )
      if (loaded.ok) missions.push({ mission: loaded.mission, log: loaded.log, file: loaded.file })
      else unreadable.push(entry.name)
    } catch {
      unreadable.push(entry.name)
    }
  }
  return { missions, unreadable }
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
  read: { missions: MissionRead[]; unreadable: string[] }
}

/**
 * Pick, per mission id, the copy that counts (BUG-173 S1). Shared by the async and the sync read,
 * so both give the same answer.
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
    if (!canonOf.has(canon)) canonOf.set(canon, root)
  }
  const reads = await Promise.all(
    [...canonOf].map(async ([canon, root]) => ({ canon, root, read: await readAllMissions(root) }))
  )
  return dedupe(reads, includeClosed)
}

/**
 * The synchronous twin of {@link readMissionsDeduped}, for hibernation: the fleet snapshot it
 * feeds is synchronous. Same files, same winner. A repo the boot pass never saw has its legacy
 * `.capy/` copied lazily, so the FIRST sweep over it can read no missions and park an owner
 * whose child is live. That self-heals on the next sweep, once the copy has landed — and a
 * parked session is intact on disk (selecting the row resumes it), so the miss costs a resume,
 * never work. Pinned by the AC-3e test in `tests/hibernation.test.ts`.
 */
export function readMissionsDedupedSync(
  roots: readonly string[],
  { includeClosed }: { includeClosed: boolean }
): DedupedMissions {
  const canonOf = new Map<string, string>()
  for (const root of roots) {
    let canon: string
    try {
      canon = realpathSync(root)
    } catch {
      canon = path.resolve(root)
    }
    if (!canonOf.has(canon)) canonOf.set(canon, root)
  }
  const reads = [...canonOf].map(([canon, root]) => ({
    canon,
    root,
    read: readAllMissionsSync(root)
  }))
  return dedupe(reads, includeClosed)
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
