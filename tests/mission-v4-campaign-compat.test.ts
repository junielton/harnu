/**
 * BUG-282 — Missions v4 reads a v3 campaign wrong. CC-1 to CC-5.
 *
 * The fixture is a neutral v3 campaign of the shape that exposed the defects (13 chapters, 11 required,
 * tokens, fixed ends, checks, a close request), written by `tests/fixtures/missions-v4-campaign-13/build.ts`
 * into a throwaway repo. Nothing here reads a real project.
 *
 * - CC-1  an old step id given with a chapter mission id means the same step, never another one
 * - CC-2  an unconverted campaign is listed under an id a read accepts; reads write nothing
 * - CC-3  a chapter that consumes an unfinished producer's token reads locked, as v3 derived it
 * - CC-4  each chapter's fixed end is a step; an unproven end is never counted done
 * - CC-5  the first write converts by copy without dropping a field; the v3 files stay byte-identical
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { parseMissionRecordFile, type MissionV4 } from '../src/main/missions/model'
import { parseV3CampaignFile, parseV3MissionFile } from '../src/main/missions/v3-read'
import { listMissionRecords, readMissionRecord } from '../src/main/missions/record-store'
import { writeMission } from '../src/main/missions/write'
import { resolveStepId } from '../src/main/missions/sessions'
import { deriveProgress } from '../src/main/missions/progress'
import { missionGet, missionList } from '../src/main/missions/verbs-read'
import {
  CAMPAIGN_ID,
  CHAPTERS,
  campaignFile,
  chapterMissionFile,
  missionIdOf,
  writeCampaign13,
  type ChapterSpec
} from './fixtures/missions-v4-campaign-13/build'

const sha = (b: Buffer): string => createHash('sha256').update(b).digest('hex')

/** Every file under `dir`: hash and mtime, keyed by relative path. */
function snapshot(dir: string): Record<string, { sha: string; mtimeNs: bigint }> {
  const out: Record<string, { sha: string; mtimeNs: bigint }> = {}
  const walk = (sub: string): void => {
    for (const e of readdirSync(path.join(dir, sub), { withFileTypes: true })) {
      const rel = path.join(sub, e.name)
      if (e.isDirectory()) walk(rel)
      else {
        const abs = path.join(dir, rel)
        out[rel] = { sha: sha(readFileSync(abs)), mtimeNs: statSync(abs, { bigint: true }).mtimeNs }
      }
    }
  }
  if (existsSync(dir)) walk('')
  return out
}

let root = ''
beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'harnu-campaign13-'))
  writeCampaign13(root)
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

async function viewOf(id: string = CAMPAIGN_ID): Promise<MissionV4> {
  const read = await readMissionRecord(root, id)
  if (!read.ok) throw new Error(read.error)
  return read.record
}

/** The first v4 write on the campaign: a no-op change that still stores the converted copy. */
async function firstWrite(): Promise<MissionV4> {
  const w = await writeMission(
    root,
    CAMPAIGN_ID,
    { kind: 'operator' },
    'operator',
    (record, log) => ({
      record,
      log: `${log}\n### 2026-11-09T09:00:00.000Z · note\nfirst write\n`
    })
  )
  if (!w.ok) throw new Error(JSON.stringify(w))
  const read = await readMissionRecord(root, CAMPAIGN_ID)
  if (!read.ok || read.source !== 'v4') throw new Error('the record was not stored')
  return read.record
}

const stepTitles = (c: ChapterSpec): string[] => (c.mission?.steps ?? []).map((s) => s.title)

// ---- CC-1 ----------------------------------------------------------------------------

describe('CC-1 · an old step id with a chapter mission id means the same step', () => {
  const chaptersWithMission = CHAPTERS.filter((c) => c.mission)

  for (const stage of ['read as a view', 'read back after the first write'] as const) {
    it(`${stage}: every old (chapter mission, step id) pair resolves to the step it named`, async () => {
      const record = stage === 'read as a view' ? await viewOf() : await firstWrite()
      for (const ch of chaptersWithMission) {
        stepTitles(ch).forEach((title, i) => {
          const found = resolveStepId(record, `stp-${i + 1}`, missionIdOf(ch.n))
          const step = record.steps.find((s) => s.id === found)
          expect(step?.title, `${missionIdOf(ch.n)} stp-${i + 1}`).toBe(title)
          expect(step?.milestone, `${missionIdOf(ch.n)} stp-${i + 1}`).toBe(`mls-${ch.n}`)
        })
      }
    })
  }

  it('refuses (null) an id the chapter mission never had and the record does not have', async () => {
    const record = await viewOf()
    expect(resolveStepId(record, 'stp-99', missionIdOf(5))).toBeNull()
    expect(resolveStepId(record, 'stp-99')).toBeNull()
  })

  it('keeps an id the record has when no chapter mission is named', async () => {
    const record = await viewOf()
    expect(resolveStepId(record, record.steps[4].id)).toBe(record.steps[4].id)
  })

  it('writes legacyV3.stepIds in one shape (a list of { mission, step, id } rows) that the resolver reads', async () => {
    const record = await firstWrite()
    const rows = (record.legacyV3 as { stepIds?: unknown }).stepIds
    expect(Array.isArray(rows)).toBe(true)
    for (const r of rows as Array<{ mission: string; step: string; id: string }>) {
      expect(typeof r.mission).toBe('string')
      expect(typeof r.step).toBe('string')
      expect(record.steps.some((s) => s.id === r.id)).toBe(true)
    }
  })
})

// ---- CC-2 ----------------------------------------------------------------------------

describe('CC-2 · an unconverted campaign is listed under an id a read accepts', () => {
  it('lists the campaign and reads it back by that very id, without writing', async () => {
    const before = snapshot(path.join(root, '.harnu'))
    const { records } = await listMissionRecords(root)
    expect(records).toHaveLength(1)
    const listedId = records[0].record.id
    const read = await readMissionRecord(root, listedId)
    expect(read.ok).toBe(true)
    if (read.ok) {
      expect(read.source).toBe('v3-campaign')
      expect(read.record.milestones).toHaveLength(13)
    }
    expect(snapshot(path.join(root, '.harnu'))).toEqual(before)
  })

  it('mission_list and mission_get agree on the id, and the read writes nothing', async () => {
    const before = snapshot(path.join(root, '.harnu'))
    const list = await missionList(root, { kind: 'operator' })
    expect(list.ok).toBe(true)
    if (!list.ok) return
    expect(list.missions).toHaveLength(1)
    const got = await missionGet(root, { kind: 'operator' }, { missionId: list.missions[0].id })
    expect(got.ok, JSON.stringify(got)).toBe(true)
    expect(snapshot(path.join(root, '.harnu'))).toEqual(before)
  })

  it('an id that is neither a record, a v3 file nor a campaign’s synthetic id is still not found', async () => {
    const read = await readMissionRecord(root, 'mnt-00000000')
    expect(read.ok).toBe(false)
  })
})

// ---- CC-3 ----------------------------------------------------------------------------

describe('CC-3 · tokens lock a not-started chapter behind an unfinished producer', () => {
  const waits = (record: MissionV4): Record<string, string[]> =>
    Object.fromEntries(
      record.milestones.map((m) => [
        m.id,
        (m.waitsFor ?? '')
          .split(',')
          .map((x) => x.trim())
          .filter(Boolean)
      ])
    )

  it('locks chapters 5, 7 to 12 the way v3 derived it', async () => {
    const w = waits(await viewOf())
    expect(w['mls-5']).toEqual(['mls-3']) // report is done; parser (chp-3) is only in review
    expect(w['mls-7']).toEqual(['mls-6'])
    expect(w['mls-8']).toEqual(['mls-7'])
    expect(w['mls-9']).toEqual(['mls-8'])
    expect(w['mls-10']).toEqual(['mls-9'])
    expect(w['mls-11']).toEqual(['mls-10'])
    expect(w['mls-12']).toEqual(['mls-11'])
  })

  it('does not lock a chapter whose producers are all finished, or one that already started', async () => {
    const w = waits(await viewOf())
    expect(w['mls-1']).toEqual([])
    expect(w['mls-2']).toEqual([]) // consumes import-core, produced by a closed-as-delivered chapter
    expect(w['mls-3']).toEqual([])
    expect(w['mls-4']).toEqual([])
    expect(w['mls-6']).toEqual([]) // consumes pages-a, but a step was claimed: v3 never locked it
  })

  it('keeps a chapter’s own unlocks', async () => {
    const w = waits(await viewOf())
    expect(w['mls-13']).toEqual(['mls-12'])
  })

  it('survives the first write', async () => {
    const w = waits(await firstWrite())
    expect(w['mls-5']).toEqual(['mls-3'])
    expect(w['mls-13']).toEqual(['mls-12'])
  })
})

// ---- CC-4 ----------------------------------------------------------------------------

describe('CC-4 · the fixed end of each chapter is visible and an unproven one is not done', () => {
  it('shows one "Delivered and verified" step per chapter that has a mission, in its milestone', async () => {
    const record = await viewOf()
    for (const ch of CHAPTERS) {
      const ends = record.steps.filter(
        (s) => s.milestone === `mls-${ch.n}` && s.title === 'Delivered and verified'
      )
      expect(ends, `chp-${ch.n}`).toHaveLength(ch.mission ? 1 : 0)
    }
  })

  it('resolves the old id of each chapter’s fixed end to that chapter’s end step', async () => {
    const record = await viewOf()
    for (const ch of CHAPTERS) {
      if (!ch.mission) continue
      const old = `stp-${ch.mission.steps.length + 1}`
      const step = record.steps.find((s) => s.id === resolveStepId(record, old, missionIdOf(ch.n)))
      expect(step?.title, `chp-${ch.n}`).toBe('Delivered and verified')
      expect(step?.milestone, `chp-${ch.n}`).toBe(`mls-${ch.n}`)
    }
  })

  it('counts exactly the chapters v3 counted: two done of eleven, and chapter 3 is not one of them', async () => {
    const record = await viewOf()
    const p = deriveProgress(record, {})
    expect(p.total).toBe(11)
    expect(p.done).toBe(2)
    const state = (id: string): string => p.milestones.find((m) => m.id === id)?.state ?? 'missing'
    expect(state('mls-1')).toBe('done')
    expect(state('mls-2')).toBe('done')
    // Every custom step is done, but the fixed end is not proven: v3 read it "in review", never done.
    expect(state('mls-3')).not.toBe('done')
    for (const n of [4, 5, 6, 7, 8, 12, 13]) expect(state(`mls-${n}`)).not.toBe('done')
  })

  it('an end that is verified shows its proof, yet the chapter is not done until it is delivered', async () => {
    const variant = CHAPTERS.map((c) =>
      c.n === 3 && c.mission
        ? { ...c, mission: { ...c.mission, endProof: 'verified' as const } }
        : c
    )
    rmSync(path.join(root, '.harnu'), { recursive: true, force: true })
    writeCampaign13(root, variant)
    const record = await viewOf()
    const end = record.steps.find(
      (s) => s.milestone === 'mls-3' && s.title === 'Delivered and verified'
    )
    const check = end?.acs.find((a) => a.by === 'session')
    expect(check?.settled?.by).toBe('c4e6a8b0-5d7f-4c9a-a1b3-6e8a0c2e4f60')
    const p = deriveProgress(record, {})
    expect(p.milestones.find((m) => m.id === 'mls-3')?.state).not.toBe('done')
    expect(p.done).toBe(2)
  })

  it('a delivered or closed-as-delivered chapter still reads done (end included)', async () => {
    const p = deriveProgress(await viewOf(), {})
    expect(p.milestones.find((m) => m.id === 'mls-1')?.state).toBe('done')
    expect(p.milestones.find((m) => m.id === 'mls-2')?.state).toBe('done')
  })
})

// ---- CC-5 ----------------------------------------------------------------------------

describe('CC-5 · the first write converts by copy without dropping a field', () => {
  type Obj = Record<string, unknown>
  const legacyChapters = (record: MissionV4): Obj[] =>
    (record.legacyV3 as { chapters: Obj[] }).chapters

  it('keeps every v3 step field (ordinal, kind, checks with id, source, createdAt) and the close request', async () => {
    const record = await firstWrite()
    const chapters = legacyChapters(record)
    expect(chapters).toHaveLength(13)

    for (const spec of CHAPTERS) {
      if (!spec.mission) continue
      const v3 = parseV3MissionFile(chapterMissionFile(spec).text)
      if ('error' in v3) throw new Error(v3.error)
      const kept = chapters.find((c) => c.missionId === v3.id)?.mission as Obj
      expect(kept, v3.id).toBeDefined()

      // Every v3 step, custom or fixed, with the fields v4 has no place for.
      const keptSteps = new Map<string, Obj>()
      for (const s of (kept.steps as Obj[]) ?? []) keptSteps.set(s.id as string, s)
      for (const key of ['fixedEnd', 'fixedStart'] as const) {
        const f = kept[key] as Obj | undefined
        if (f) keptSteps.set(f.id as string, f)
      }
      for (const step of v3.steps) {
        const copy = keptSteps.get(step.id)
        expect(copy, `${v3.id} ${step.id}`).toBeDefined()
        for (const field of [
          'id',
          'ordinal',
          'kind',
          'title',
          'verification',
          'proof',
          'addedAt'
        ] as const) {
          expect(copy?.[field], `${v3.id} ${step.id}.${field}`).toEqual(step[field])
        }
        if (step.verifiedBy) expect(copy?.verifiedBy).toEqual(step.verifiedBy)
        // Every check whole, with the id v3 gave it.
        expect(copy?.checks ?? undefined, `${v3.id} ${step.id}.checks`).toEqual(step.checks)
      }

      if (v3.pendingClose) expect(kept.pendingClose).toEqual(v3.pendingClose)
    }
  })

  it('leaves the v3 files byte-identical', async () => {
    const before = snapshot(path.join(root, '.harnu', 'campaigns'))
    const beforeMissions = snapshot(path.join(root, '.harnu', 'missions'))
    await firstWrite()
    expect(snapshot(path.join(root, '.harnu', 'campaigns'))).toEqual(before)
    expect(snapshot(path.join(root, '.harnu', 'missions'))).toEqual(beforeMissions)
    const dir = path.join(root, '.harnu', 'missions-v4')
    const files = readdirSync(dir).filter((n) => n.endsWith('.md'))
    expect(files).toHaveLength(1)
    expect(
      parseMissionRecordFile(readFileSync(path.join(dir, files[0]), 'utf8'))
    ).not.toHaveProperty('error')
    // The campaign file still parses with the v3 parser.
    expect(parseV3CampaignFile(campaignFile().text)).not.toHaveProperty('error')
  })
})
