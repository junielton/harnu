/**
 * Missions v4 S-9 (AC-21, AC-22, AC-25, AC-27) — the v4 store: where v4 records live, how a v3
 * record is read as one, and the copy on first write.
 *
 * v4 records live in `.harnu/missions-v4/` (spec "Design · Compatibility with records written by
 * v3"). The v3 directories, `.harnu/missions/` and `.harnu/campaigns/`, are only ever READ here:
 *
 * 1. **A read is a view, never a write.** {@link readMissionRecord} looks for a v4 record first; with
 *    none it parses the v3 file with the frozen reader and converts it in memory with the same pure
 *    function the copy uses. It changes no byte and no mtime and creates no directory.
 * 2. **A write creates a v4 record by copy.** {@link updateMissionRecord} is the one write: the first
 *    write for a mission born in v3 stores the converted record as
 *    `.harnu/missions-v4/<same id>-<same slug>.md`, with the change already applied. The v3 file stays
 *    byte-identical, so an installed v3 build never sees a v4 file and never fails on one.
 * 3. **A campaign converts into one new mission**, id `mnt-` plus the hash of its source ids (see
 *    `compat.ts`), and a sidecar `.harnu/missions-v4/.migrated/<old id>.json` per old id says
 *    "superseded by `mnt-…`", so the campaign id and every chapter mission id resolve to it.
 * 4. **One format at a time.** Once a v4 record exists for an id, it is the mission and the v3 file is
 *    a snapshot: reads, lists and writes all go to the v4 record.
 *
 * **Callers pass the REPO ROOT** (the main checkout, `repoRoot(folder)` of `data-dir.ts`), never a
 * worktree folder: records are shared by every worktree, and a worktree folder would create records
 * of its own in that worktree's `.harnu/`.
 *
 * Idempotent and safe under concurrency. The whole read-modify-write of one mission runs under a lock
 * keyed by its v4 id: in this process a promise chain, across processes a lock file
 * (`.harnu/missions-v4/.<id>.lock`, created exclusively, taken over when stale). Inside the lock the
 * write is also a compare-and-swap: it remembers the bytes it read and, just before the rename,
 * confirms the file is unchanged; if something else changed it (a writer that takes no lock), it
 * re-reads and applies `change` again, a bounded number of times, then refuses `WRITE_CONFLICT`. The
 * copy is created with a hard link, which fails with `EEXIST` if another process created the record
 * first. A record is never half-written or empty after a power loss: it is built in a temporary file,
 * flushed (`fsync`) and only then linked or renamed into place, and the directory is flushed after.
 *

 * Reads v3 only through `v3-read.ts` and `compat.ts` (AC-26). Dot-directories (`.migrated`) are never
 * listed as records.
 */

import { createHash, randomBytes } from 'node:crypto'
import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import { dataDirAt, dataDirReady, mkdirDataDir } from '../data-dir'
import { campaignMissionId, convertV3Campaign, convertV3Mission } from './compat'
import {
  buildMissionRecordContent,
  parseMissionRecordFile,
  readMissionRecordLog,
  type MissionV4
} from './model'
import {
  parseV3CampaignFile,
  parseV3MissionFile,
  readV3CampaignLog,
  readV3MissionLog,
  type V3Campaign,
  type V3Mission
} from './v3-read'

// ---- Paths ---------------------------------------------------------------------

/** `.harnu/missions-v4/` of `root`: the v4 records. */
export function v4RecordsDir(root: string): string {
  return path.join(dataDirAt(root), 'missions-v4')
}
/** `.harnu/missions-v4/.migrated/`: one sidecar per v3 id a converted campaign superseded. */
export function migratedDir(root: string): string {
  return path.join(v4RecordsDir(root), '.migrated')
}
const v3MissionsDir = (root: string): string => path.join(dataDirAt(root), 'missions')
const v3CampaignsDir = (root: string): string => path.join(dataDirAt(root), 'campaigns')

const ID_RE = /^(?:mnt|cmp)-[0-9a-f]{8}$/
const MISSION_FILE_RE = /^(mnt-[0-9a-f]{8})-(.+)\.md$/
const CAMPAIGN_FILE_RE = /^(cmp-[0-9a-f]{8})-(.+)\.md$/

interface FileEntry {
  id: string
  slug: string
  name: string
}

/** The `<id>-<slug>.md` files of `dir` that match `re`; `[]` when the directory does not exist. */
async function entriesOf(dir: string, re: RegExp): Promise<FileEntry[]> {
  let names: string[]
  try {
    names = await fs.readdir(dir)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw err
  }
  const out: FileEntry[] = []
  for (const name of names.sort()) {
    const m = re.exec(name) // a dot-name never matches: ids start with `mnt-` or `cmp-`
    if (m) out.push({ id: m[1], slug: m[2], name })
  }
  return out
}

// ---- Results -------------------------------------------------------------------

/** Where a record was read from. */
export type RecordSource = 'v4' | 'v3-mission' | 'v3-campaign'

/** A mission as v4 sees it, and the file it came from. */
export interface MissionRecordView {
  record: MissionV4
  /** The Log body. */
  log: string
  source: RecordSource
  /** The file the view was read from: the v4 record, or the v3 file (read only). */
  file: string
  /** The file-name slug of the v4 record this mission has, or would get on its first write. */
  slug: string
  /** The v3 ids a converted campaign supersedes; `[]` for anything else. */
  sourceIds: string[]
  /** For a v4 record: a hash of the bytes read, what a compare-and-swap checks before it writes. */
  fingerprint?: string
}

/** A refusal: `code` is the typed reason, `error` the sentence that names it and the way out. */
export interface Refusal {
  ok: false
  code: string
  error: string
}

export type MissionRecordRead = ({ ok: true } & MissionRecordView) | Refusal

const refuse = (code: string, message: string): Refusal => ({
  ok: false,
  code,
  error: `${code}: ${message}`
})
const notFound = (id: string): Refusal =>
  refuse(
    'MISSION_NOT_FOUND',
    `no mission ${id} in this repo — mission_list shows the ones that exist.`
  )
const unreadable = (name: string, why: string, remove?: string): Refusal =>
  refuse(
    'MISSION_UNREADABLE',
    `${name === why.split(' — ')[0] ? why : `${name} — ${why}`}${
      remove
        ? `. Remove ${remove} to fall back to the v3 record this mission was converted from, if it still exists.`
        : ''
    }`
  )

/** What a compare-and-swap compares: a hash of the file's bytes. */
const fingerprintOf = (raw: string): string => createHash('sha256').update(raw).digest('hex')

// ---- Reading v4 ----------------------------------------------------------------

async function readV4(root: string, entry: FileEntry): Promise<MissionRecordRead> {
  const file = path.join(v4RecordsDir(root), entry.name)
  const raw = await fs.readFile(file, 'utf8')
  const parsed = parseMissionRecordFile(raw)
  if (!('schemaVersion' in parsed)) return unreadable(entry.name, parsed.error, file)
  return {
    ok: true,
    record: parsed,
    log: readMissionRecordLog(raw),
    source: 'v4',
    file,
    slug: entry.slug,
    sourceIds: [],
    fingerprint: fingerprintOf(raw)
  }
}

async function findV4(root: string, id: string): Promise<MissionRecordRead | null> {
  const entry = (await entriesOf(v4RecordsDir(root), MISSION_FILE_RE)).find((e) => e.id === id)
  return entry ? readV4(root, entry) : null
}

/** The id a sidecar says `oldId` was superseded by, or null. */
async function supersededBy(root: string, oldId: string): Promise<string | null> {
  try {
    const data = JSON.parse(
      await fs.readFile(path.join(migratedDir(root), `${oldId}.json`), 'utf8')
    )
    return typeof data?.supersededBy === 'string' ? data.supersededBy : null
  } catch {
    return null
  }
}

// ---- Reading v3 ----------------------------------------------------------------

interface V3MissionRead {
  mission: V3Mission
  log: string
  file: string
  slug: string
}

async function readV3Mission(
  root: string,
  id: string
): Promise<V3MissionRead | { error: string } | null> {
  const entry = (await entriesOf(v3MissionsDir(root), MISSION_FILE_RE)).find((e) => e.id === id)
  if (!entry) return null
  const file = path.join(v3MissionsDir(root), entry.name)
  const raw = await fs.readFile(file, 'utf8')
  const mission = parseV3MissionFile(raw)
  if ('error' in mission) return { error: `${entry.name} — ${mission.error}` }
  return { mission, log: readV3MissionLog(raw), file, slug: entry.slug }
}

interface V3CampaignRead {
  campaign: V3Campaign
  log: string
  file: string
}

async function readV3Campaign(
  root: string,
  id: string
): Promise<V3CampaignRead | { error: string } | null> {
  const entry = (await entriesOf(v3CampaignsDir(root), CAMPAIGN_FILE_RE)).find((e) => e.id === id)
  if (!entry) return null
  const file = path.join(v3CampaignsDir(root), entry.name)
  const raw = await fs.readFile(file, 'utf8')
  const campaign = parseV3CampaignFile(raw)
  if ('error' in campaign) return { error: `${entry.name} — ${campaign.error}` }
  return { campaign, log: readV3CampaignLog(raw), file }
}

/** A campaign as one mission: the campaign and every chapter mission that can be read. */
async function campaignView(root: string, read: V3CampaignRead): Promise<MissionRecordRead> {
  const chapters: Array<{ mission: V3Mission; log: string }> = []
  for (const chapter of read.campaign.chapters) {
    if (!chapter.missionId) continue
    const m = await readV3Mission(root, chapter.missionId)
    if (m && !('error' in m)) chapters.push({ mission: m.mission, log: m.log })
  }
  const converted = convertV3Campaign(read.campaign, read.log, chapters)
  return {
    ok: true,
    record: converted.record,
    log: converted.log,
    source: 'v3-campaign',
    file: read.file,
    slug: converted.slug,
    sourceIds: converted.sourceIds
  }
}

function missionView(read: V3MissionRead): MissionRecordRead {
  const converted = convertV3Mission(read.mission, read.log)
  return {
    ok: true,
    record: converted.record,
    log: converted.log,
    source: 'v3-mission',
    file: read.file,
    slug: converted.slug,
    sourceIds: []
  }
}

// ---- Reading: one mission ------------------------------------------------------

/**
 * Read one mission by id as a v4 record, whatever it was born as. Accepts a v4 id, a v3 mission id, a
 * v3 campaign id and the id of a chapter mission (which reads as the campaign it belongs to). Never
 * throws and never writes. See the module comment for the order.
 */
export async function readMissionRecord(root: string, id: string): Promise<MissionRecordRead> {
  if (!ID_RE.test(id)) {
    return refuse('BAD_ARGS', `missionId "${id}" is not a mission id (mnt-<8 hex>).`)
  }
  await dataDirReady(root)

  // 1. A v4 record under this id, or the one a sidecar says superseded it.
  const own = await findV4(root, id)
  if (own) return own
  const target = await supersededBy(root, id)
  if (target) {
    const moved = await findV4(root, target)
    if (moved) return moved
  }

  // 2. A v3 mission; a chapter of a campaign reads as the campaign.
  if (id.startsWith('mnt-')) {
    const m = await readV3Mission(root, id)
    if (!m) return notFound(id)
    if ('error' in m) return unreadable(id, m.error)
    const campaignId = m.mission.campaignId
    if (campaignId) {
      const c = await readV3Campaign(root, campaignId)
      if (c && !('error' in c) && c.campaign.chapters.some((ch) => ch.missionId === id)) {
        return viewOrMoved(root, c)
      }
    }
    return missionView(m)
  }

  // 3. A v3 campaign.
  const c = await readV3Campaign(root, id)
  if (!c) return notFound(id)
  if ('error' in c) return unreadable(id, c.error)
  return viewOrMoved(root, c)
}

/**
 * The campaign as one mission, or the v4 record already written for it. A record that exists is found
 * through the campaign's sidecar FIRST: the installed v3 build can bind a new chapter after the copy,
 * which changes the source ids and so the id a fresh conversion would compute, and a second record
 * must never be created for a campaign that already has one. The id computed from the source ids is
 * the fallback for a lost sidecar.
 */
async function viewOrMoved(root: string, read: V3CampaignRead): Promise<MissionRecordRead> {
  const target = await supersededBy(root, read.campaign.id)
  const moved = target ? await findV4(root, target) : null
  if (moved) return moved
  const sourceIds = [
    read.campaign.id,
    ...read.campaign.chapters.flatMap((ch) => (ch.missionId ? [ch.missionId] : []))
  ]
  const written = await findV4(root, campaignMissionId(sourceIds))
  return written ?? campaignView(root, read)
}

// ---- Reading: the list ---------------------------------------------------------

/**
 * Every mission of the repo as v4: the v4 records, then each v3 mission and campaign that has not been
 * converted yet. A chapter mission is not listed on its own (it is a milestone of its campaign), and
 * nothing is listed twice. Never writes. A file that cannot be read is reported in `unreadable`.
 */
export async function listMissionRecords(
  root: string
): Promise<{ records: MissionRecordView[]; unreadable: string[] }> {
  await dataDirReady(root)
  const records: MissionRecordView[] = []
  const bad: string[] = []
  const take = (r: MissionRecordRead, name: string): void => {
    if (r.ok) records.push(r)
    else bad.push(name)
  }

  const v4 = await entriesOf(v4RecordsDir(root), MISSION_FILE_RE)
  for (const entry of v4) take(await readV4(root, entry), entry.name)
  const v4Ids = new Set(v4.map((e) => e.id))

  // A v3 id is superseded only when the record its sidecar names exists: a sidecar left by a write that
  // stopped before the record was linked points at nothing, and a read ignores it, so the list must too.
  const migrated = new Set<string>()
  try {
    for (const n of await fs.readdir(migratedDir(root))) {
      if (!n.endsWith('.json')) continue
      const oldId = n.slice(0, -5)
      const target = await supersededBy(root, oldId)
      if (target && v4Ids.has(target)) migrated.add(oldId)
    }
  } catch {
    /* no sidecars yet */
  }

  const campaigns: V3CampaignRead[] = []
  for (const entry of await entriesOf(v3CampaignsDir(root), CAMPAIGN_FILE_RE)) {
    const c = await readV3Campaign(root, entry.id)
    if (c && !('error' in c)) campaigns.push(c)
    else bad.push(entry.name)
  }
  const chapterMissions = new Set(
    campaigns.flatMap((c) =>
      c.campaign.chapters.flatMap((ch) => (ch.missionId ? [ch.missionId] : []))
    )
  )

  for (const entry of await entriesOf(v3MissionsDir(root), MISSION_FILE_RE)) {
    if (v4Ids.has(entry.id) || migrated.has(entry.id) || chapterMissions.has(entry.id)) continue
    const m = await readV3Mission(root, entry.id)
    if (m && !('error' in m)) records.push(missionView(m) as MissionRecordView & { ok: true })
    else bad.push(entry.name)
  }
  for (const c of campaigns) {
    if (migrated.has(c.campaign.id)) continue
    const view = await viewOrMoved(root, c)
    if (view.ok && view.source === 'v4' && v4Ids.has(view.record.id)) continue
    take(view, path.basename(c.file))
  }

  records.sort((a, b) => a.record.id.localeCompare(b.record.id))
  return { records, unreadable: bad }
}

// ---- Writing -------------------------------------------------------------------

/** In-process lock per v4 mission id: one read-modify-write at a time. */
const locks = new Map<string, Promise<unknown>>()

function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(key) ?? Promise.resolve()
  const run = prev.then(fn, fn)
  const tail = run.then(
    () => undefined,
    () => undefined
  )
  locks.set(key, tail)
  void tail.then(() => {
    if (locks.get(key) === tail) locks.delete(key)
  })
  return run
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** A lock file older than this is a crashed writer's, and is taken over. */
const STALE_LOCK_MS = 30_000
/** How long a writer waits for another process's lock before it refuses. */
const LOCK_WAIT_MS = 15_000

/**
 * Hold the cross-process lock of one v4 mission while `fn` runs: `.harnu/missions-v4/.<id>.lock`,
 * created exclusively and removed after. A dot-name, so it is never listed as a record.
 */
async function withFileLock<T>(
  root: string,
  id: string,
  fn: () => Promise<T>
): Promise<T | Refusal> {
  await mkdirDataDir(v4RecordsDir(root))
  const lock = path.join(v4RecordsDir(root), `.${id}.lock`)
  const deadline = Date.now() + LOCK_WAIT_MS
  for (;;) {
    try {
      const handle = await fs.open(lock, 'wx')
      await handle.close()
      break
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
      const age = await fs.stat(lock).then(
        (st) => Date.now() - st.mtimeMs,
        () => 0
      )
      if (age > STALE_LOCK_MS) {
        await fs.unlink(lock).catch(() => undefined)
        continue
      }
      if (Date.now() > deadline) {
        return refuse('WRITE_CONFLICT', `${id} is locked by another writer; try again.`)
      }
      await sleep(5 + Math.floor(Math.random() * 15))
    }
  }
  try {
    return await fn()
  } finally {
    await fs.unlink(lock).catch(() => undefined)
  }
}

/** Flush a directory's entries to disk where the platform allows it; never an error. */
async function syncDir(dir: string): Promise<void> {
  try {
    const handle = await fs.open(dir, 'r')
    try {
      await handle.sync()
    } finally {
      await handle.close()
    }
  } catch {
    /* Windows cannot open a directory; the file itself was flushed. */
  }
}

/** Write `content` to a temporary file beside `file`, flushed to disk, and return its path. */
async function writeTemp(file: string, content: string): Promise<string> {
  const tmp = path.join(
    path.dirname(file),
    `.${path.basename(file)}.${randomBytes(4).toString('hex')}.tmp`
  )
  const handle = await fs.open(tmp, 'w')
  try {
    await handle.writeFile(content, 'utf8')
    await handle.sync() // the bytes are on disk before the name points at them
  } finally {
    await handle.close()
  }
  return tmp
}

/** Replace `file` with `content`; a reader sees the old file or the new one, never half of it. */
async function writeAtomic(file: string, content: string): Promise<void> {
  const tmp = await writeTemp(file, content)
  try {
    await fs.rename(tmp, file)
  } catch (err) {
    await fs.unlink(tmp).catch(() => undefined)
    throw err
  }
  await syncDir(path.dirname(file))
}

/** Create `file` with `content` only if it does not exist: `false` when another writer was first. */
async function createExclusive(file: string, content: string): Promise<boolean> {
  const tmp = await writeTemp(file, content)
  try {
    await fs.link(tmp, file)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false
    throw err
  } finally {
    await fs.unlink(tmp).catch(() => undefined)
  }
  await syncDir(path.dirname(file))
  return true
}

/** The sidecar of one superseded v3 id: deterministic bytes, so writing it twice changes nothing. */
function sidecarOf(oldId: string, newId: string, campaignId: string): string {
  const from = oldId === campaignId ? 'campaign' : 'chapter'
  return `${JSON.stringify({ supersededBy: newId, from, campaign: campaignId }, null, 2)}\n`
}

export type MissionRecordWrite =
  { ok: true; record: MissionV4; log: string; file: string; created: boolean } | Refusal

/** What a write receives and returns: the record and its Log body. */
export type RecordChange = { record: MissionV4; log: string }

/** How many times a write re-reads and re-applies its change when the record changed under it. */
const MAX_ATTEMPTS = 5

/** The typed refusal an error thrown inside a `change` becomes: its own `code` when it carries one. */
function refusalOf(e: unknown): Refusal {
  const message = e instanceof Error ? e.message : String(e)
  const code = (e as { code?: unknown } | null)?.code
  if (typeof code === 'string' && /^[A-Z][A-Z0-9_]+$/.test(code)) {
    return {
      ok: false,
      code,
      error: message.startsWith(`${code}:`) ? message : `${code}: ${message}`
    }
  }
  return refuse('WRITE_REFUSED', message)
}

/**
 * The v4 write: read the mission as v4 (converting a v3 one in memory), apply `change`, store the
 * result in `.harnu/missions-v4/`. The first write for a mission born in v3 creates its v4 record by
 * copy (`created: true`) and every v3 file stays byte-identical; later writes replace the v4 record
 * in place. `id` may be any id the mission has had (a v3 chapter id included); the record's own id
 * must not change. `root` is the REPO ROOT, never a worktree folder.
 *
 * A `change` that throws, or that returns a record the v4 schema rejects, writes nothing (a v3 file is
 * never touched either way) and comes back as a refusal: an error carrying a `code` keeps it, any
 * other is `WRITE_REFUSED`. Serialized per mission, across processes too: writers aimed at one
 * mission, through any of its old ids, run one after the other and every change lands on a single
 * record. `change` may run more than once when the record changed under it, so it must be a pure
 * function of what it is given.
 */
export async function updateMissionRecord(
  root: string,
  id: string,
  change: (record: MissionV4, log: string) => RecordChange | Promise<RecordChange>
): Promise<MissionRecordWrite> {
  const first = await readMissionRecord(root, id)
  if (!first.ok) return first

  return withLock(first.record.id, () =>
    withFileLock(root, first.record.id, async (): Promise<MissionRecordWrite> => {
      // Another writer may change the record between our read and our swap: then read again and
      // apply the change again, a bounded number of times.
      for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
        const view = await readMissionRecord(root, id)
        if (!view.ok) return view

        let next: RecordChange
        let content: string
        try {
          next = await change(view.record, view.log)
        } catch (e) {
          return refusalOf(e)
        }
        if (next.record.id !== view.record.id) {
          return refuse('BAD_ARGS', `a write cannot change the mission id ${view.record.id}.`)
        }
        try {
          content = buildMissionRecordContent(next.record, next.log)
        } catch (e) {
          return refuse('WRITE_REFUSED', (e as Error).message)
        }

        if (view.source === 'v4') {
          // Compare and swap: the file must still be the bytes this attempt read.
          const now = await fs.readFile(view.file, 'utf8').catch(() => null)
          if (now === null || fingerprintOf(now) !== view.fingerprint) continue
          await writeAtomic(view.file, content)
          return { ok: true, record: next.record, log: next.log, file: view.file, created: false }
        }

        // The copy: sidecars first (a campaign's old ids), the record last, so a crash in between
        // leaves a sidecar that points at nothing yet, which a read ignores.
        const campaignId = view.sourceIds.find((s) => s.startsWith('cmp-'))
        await mkdirDataDir(campaignId ? migratedDir(root) : v4RecordsDir(root))
        const file = path.join(v4RecordsDir(root), `${view.record.id}-${view.slug}.md`)
        if (campaignId) {
          for (const old of view.sourceIds) {
            await writeAtomic(
              path.join(migratedDir(root), `${old}.json`),
              sidecarOf(old, view.record.id, campaignId)
            )
          }
        }
        if (await createExclusive(file, content)) {
          return { ok: true, record: next.record, log: next.log, file, created: true }
        }
      }
      return refuse('WRITE_CONFLICT', `${id} keeps changing under this write; try again.`)
    })
  )
}

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/**
 * Create a brand-new v4 mission: `.harnu/missions-v4/<id>-<slug>.md`, written the same atomic way,
 * created exclusively. Refused `MISSION_EXISTS` when the id is already a v4 record under any slug, a
 * v3 mission, or an id a campaign conversion superseded (so a minted id can never shadow a record), and
 * when another writer created it first. `root` is the REPO ROOT, never a worktree folder.
 */
export async function createMissionRecord(
  root: string,
  record: MissionV4,
  log: string,
  slug: string
): Promise<MissionRecordWrite> {
  if (!SLUG_RE.test(slug)) return refuse('BAD_ARGS', `slug "${slug}" is not a kebab-case slug.`)
  let content: string
  try {
    content = buildMissionRecordContent(record, log)
  } catch (e) {
    return refuse('WRITE_REFUSED', (e as Error).message)
  }
  await dataDirReady(root)
  return withLock(record.id, () =>
    withFileLock(root, record.id, async (): Promise<MissionRecordWrite> => {
      const taken =
        (await entriesOf(v4RecordsDir(root), MISSION_FILE_RE)).some((e) => e.id === record.id) ||
        (await entriesOf(v3MissionsDir(root), MISSION_FILE_RE)).some((e) => e.id === record.id) ||
        (await supersededBy(root, record.id)) !== null
      const exists = refuse('MISSION_EXISTS', `a mission ${record.id} already exists in this repo.`)
      if (taken) return exists
      const file = path.join(v4RecordsDir(root), `${record.id}-${slug}.md`)
      if (!(await createExclusive(file, content))) return exists
      return { ok: true, record, log, file, created: true }
    })
  )
}
