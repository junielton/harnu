import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  orphanExpectedOf,
  orphanTranscriptId,
  type OrphanTranscriptItem
} from '../src/main/gc/gc-orphan-transcripts'
import { trashTranscriptsRecorded } from '../src/main/gc/gc-orphan-trash'
import { trashedEntries } from '../src/main/gc/trash-core'
import { emptyHarnuTrash, observeTrashEntries, type TrashEnv } from '../src/main/gc/trash-shell'
import { parseOptions } from '../src/main/gc/gc-options'
import { submitManualClean, type ManualCleanDeps } from '../src/main/gc/gc-manual'
import { createCycleState } from '../src/main/gc/gc-cycle'
import { createJobQueue } from '../src/main/gc/gc-jobs-core'
import { defaultGcPrefs } from '../src/main/gc/gc-prefs'
import { freedSplit } from '../src/main/gc/gc-cycle'
import { parseJournal, serializeTombstone, type Tombstone } from '../src/main/reaper/journal'
import { NOW } from './gc-fixtures'

/**
 * AC-E1 (unit E): moving an orphaned transcripts folder to the trash is as honest as removing a
 * worktree. The result says "0 B freed now · X in the trash", and the move is recorded as an
 * exact trash entry, so the in-the-trash strip counts it and "Empty what Harnu moved" can empty it.
 */

const GONE = '/nonexistent/unit-e/org/proj/worktrees/PROJ-1-gone'

function item(over: Partial<OrphanTranscriptItem> = {}): OrphanTranscriptItem {
  return {
    id: orphanTranscriptId('slug-a'),
    slug: 'slug-a',
    folder: GONE,
    repoLabel: 'proj',
    bytes: 4_096,
    sessionCount: 2,
    newestAt: NOW - 3 * 86_400_000,
    hasMemory: false,
    proof: 'proven',
    ...over
  }
}

// ---- the manual clean's result ---------------------------------------------------------------------

function rig(it1: OrphanTranscriptItem) {
  const done: Array<{ results: Array<Record<string, unknown>> }> = []
  const calls: Array<{ slug: string; facts: unknown }> = []
  let n = 0
  const deps: ManualCleanDeps = {
    prefs: () => defaultGcPrefs(),
    gather: async () => ({
      bundles: [],
      orphanVolumes: [],
      orphanTranscripts: structuredClone([it1])
    }),
    opsFor: () => {
      throw new Error('no worktree ops expected')
    },
    freshOrphans: async () => [],
    freshOrphanTranscripts: async () => [it1],
    trashTranscripts: async (slug, facts) => void calls.push({ slug, facts }),
    reconcileFolder: async () => undefined,
    workStampOf: async () => null,
    removeOrphanVolumes: async () => ({
      buildCacheBytes: 0,
      imageBytes: 0,
      volumeBytes: 0,
      errors: []
    }),
    queue: createJobQueue({
      newId: () => `job-${++n}`,
      emitProgress: () => undefined,
      emitDone: (d) => done.push(d as never)
    }),
    state: createCycleState(),
    now: () => NOW
  }
  return { deps, done, calls }
}

describe('AC-E1: the manual clean of orphan transcripts is honest about the trash', () => {
  it("reports 0 B freed now and the folder's bytes as in the trash", async () => {
    const it1 = item()
    const r = rig(it1)
    const opts = parseOptions(
      structuredClone({ confirmed: [it1.id], expected: { [it1.id]: orphanExpectedOf(it1) } })
    )
    submitManualClean(r.deps, [it1.id], opts)
    await r.deps.queue.idle()
    const [res] = r.done[0]!.results
    expect(res).toMatchObject({ id: it1.id, ok: true, freedBytes: 0, trashedBytes: 4_096 })
    // The wire's own split says it the way the toast does.
    expect(freedSplit(0, 4_096)).toBe('0 B freed now · 4 KB in the trash')
    // The trash step is told how big the folder is, so it can record it.
    expect(r.calls).toEqual([{ slug: 'slug-a', facts: { bytes: 4_096, folder: GONE } }])
  })

  it('a trash that fails still reports nothing trashed', async () => {
    const it1 = item()
    const r = rig(it1)
    r.deps.trashTranscripts = async () => {
      throw new Error('EBUSY')
    }
    const opts = parseOptions(
      structuredClone({ confirmed: [it1.id], expected: { [it1.id]: orphanExpectedOf(it1) } })
    )
    submitManualClean(r.deps, [it1.id], opts)
    await r.deps.queue.idle()
    const [res] = r.done[0]!.results
    expect(res).toMatchObject({ ok: false, haltedAt: 'trash', freedBytes: 0 })
    expect(res).not.toHaveProperty('trashedBytes')
  })
})

// ---- the trash record, against a fake trash -----------------------------------------------------------

let root: string
let trash: string
let projects: string
let env: TrashEnv

const localStamp = (ms: number): string => {
  const d = new Date(ms)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(
    d.getMinutes()
  )}:${p(d.getSeconds())}`
}

/** What the OS does: renames the folder into `files/` and writes a fresh `.trashinfo`. */
function osTrash(folder: string, at: number): void {
  let name = path.basename(folder)
  for (let n = 2; existsSync(path.join(trash, 'info', `${name}.trashinfo`)); n++) {
    name = `${path.basename(folder)}.${n}`
  }
  renameSync(folder, path.join(trash, 'files', name))
  writeFileSync(
    path.join(trash, 'info', `${name}.trashinfo`),
    `[Trash Info]\nPath=${folder}\nDeletionDate=${localStamp(at)}\n`
  )
}

function makeProject(slug: string): string {
  const dir = path.join(projects, slug)
  mkdirSync(dir, { recursive: true })
  writeFileSync(path.join(dir, 'a.jsonl'), '{"cwd":"/gone"}\n')
  return dir
}

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'harnu-e1-'))
  trash = path.join(root, 'home', '.local', 'share', 'Trash')
  projects = path.join(root, 'home', '.claude', 'projects')
  mkdirSync(path.join(trash, 'files'), { recursive: true })
  mkdirSync(path.join(trash, 'info'), { recursive: true })
  mkdirSync(projects, { recursive: true })
  env = { platform: 'linux', homeTrash: trash, uid: 1000, isMountPoint: async () => false }
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

describe('AC-E1: the move is recorded as an exact trash entry', () => {
  async function trashIt(slug: string, bytes: number, journal: Tombstone[]): Promise<string> {
    const dir = makeProject(slug)
    await trashTranscriptsRecorded({
      root: projects,
      slug,
      facts: { bytes, folder: GONE },
      env,
      trash: async (p) => osTrash(p, NOW),
      appendTombstone: async (t) => void journal.push(structuredClone(t)),
      now: () => NOW
    })
    return dir
  }

  it('writes a journal line that the in-the-trash strip counts, and "Empty" can empty', async () => {
    const journal: Tombstone[] = []
    const dir = await trashIt('slug-a', 4_096, journal)
    expect(existsSync(dir)).toBe(false)
    expect(journal).toHaveLength(1)
    expect(journal[0]).toMatchObject({
      trashedPath: dir,
      trashedBytes: 4_096,
      trashedAt: NOW,
      archiveTipRef: null,
      archiveWipRef: null
    })
    expect(journal[0]!.trashEntry).toMatchObject({ kind: 'freedesktop', name: 'slug-a' })

    // The line survives the journal's own parse (it is a valid tombstone), then the ledger.
    const parsed = parseJournal(journal.map(serializeTombstone).join(''), 100)
    expect(parsed).toHaveLength(1)
    const ledger = await observeTrashEntries(trashedEntries(parsed, new Set()), env)
    expect(ledger.present).toHaveLength(1)
    expect(ledger.present[0]).toMatchObject({ path: dir, bytes: 4_096 })

    const result = await emptyHarnuTrash(
      trashedEntries(parsed, new Set()),
      [ledger.present[0]!.key],
      env
    )
    expect(result.emptied).toEqual([ledger.present[0]!.key])
    expect(result.emptiedBytes).toBe(4_096)
    expect(existsSync(path.join(trash, 'files', 'slug-a'))).toBe(false)
    expect(existsSync(path.join(trash, 'info', 'slug-a.trashinfo'))).toBe(false)
  })

  it("keeps the exact-identification rule: a folder restored and trashed again is the user's", async () => {
    const journal: Tombstone[] = []
    const dir = await trashIt('slug-a', 4_096, journal)
    // The user restores it and trashes it again: the same path and name, a new entry.
    renameSync(path.join(trash, 'files', 'slug-a'), dir)
    rmSync(path.join(trash, 'info', 'slug-a.trashinfo'))
    osTrash(dir, NOW + 60_000)
    const entries = trashedEntries(
      parseJournal(journal.map(serializeTombstone).join(''), 100),
      new Set()
    )
    const result = await emptyHarnuTrash(entries, [entries[0]!.key], env)
    expect(result.emptied).toEqual([])
    expect(result.changed).toEqual([entries[0]!.key])
    expect(readFileSync(path.join(trash, 'files', 'slug-a', 'a.jsonl'), 'utf8')).toContain('cwd')
  })

  it('records nothing it cannot name, but never fails the clean for it', async () => {
    const dir = makeProject('slug-a')
    const journal: Tombstone[] = []
    // Two entries appear at once (something else was trashed meanwhile): Harnu records no exact entry.
    await trashTranscriptsRecorded({
      root: projects,
      slug: 'slug-a',
      facts: { bytes: 10, folder: GONE },
      env,
      trash: async (p) => {
        const other = path.join(root, 'other')
        mkdirSync(other)
        osTrash(other, NOW)
        osTrash(p, NOW)
      },
      appendTombstone: async (t) => void journal.push(t),
      now: () => NOW
    })
    expect(existsSync(dir)).toBe(false)
    expect(journal[0]).toMatchObject({ trashedPath: dir, trashedBytes: 10, trashEntry: null })
  })

  it('a journal that cannot be written does not turn the trashed folder into a failure', async () => {
    makeProject('slug-a')
    await expect(
      trashTranscriptsRecorded({
        root: projects,
        slug: 'slug-a',
        facts: { bytes: 10, folder: GONE },
        env,
        trash: async (p) => osTrash(p, NOW),
        appendTombstone: async () => {
          throw new Error('EROFS')
        },
        now: () => NOW
      })
    ).resolves.toBeUndefined()
  })

  it('still refuses a slug that is not a plain project folder, before trashing anything', async () => {
    let trashed = false
    await expect(
      trashTranscriptsRecorded({
        root: projects,
        slug: '../escape',
        facts: { bytes: 1, folder: GONE },
        env,
        trash: async () => void (trashed = true),
        appendTombstone: async () => undefined,
        now: () => NOW
      })
    ).rejects.toThrow('bad-slug')
    expect(trashed).toBe(false)
  })
})
