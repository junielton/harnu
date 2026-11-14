/**
 * Missions v4 · S-9 · AC-21 … AC-27 — the compatibility reader, the v4 store and copy on first write.
 *
 * Records written by v3 live in `.harnu/missions/` and `.harnu/campaigns/` and an installed v3 build
 * reads only those, so a v4 build never modifies one (spec "Design · Compatibility with records
 * written by v3"). A read is an in-memory view; the first v4 write creates a record by copy in
 * `.harnu/missions-v4/`. Every proof runs against the frozen fixtures of S-1
 * (`tests/fixtures/missions-v4-compat/`), copied under a temporary `.harnu/` because the fixtures
 * carry no `.harnu/` prefix and name a folder that does not exist.
 *
 * What `v3-read.ts` keeps and drops is the report's business; this file only pins what the readers
 * and the store do. AC-22 covers the write paths that exist at this slice (the store's own write and
 * the copy on first write); the verbs and doors of S-12 to S-15 extend `no v4 write path touches a
 * v3 file` with their own writes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  promises as fsp,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { parseMissionFile } from '../src/main/mission-core'
import { parseCampaignFile } from '../src/main/campaign-core'
import {
  buildMissionRecordContent,
  parseMissionRecordFile,
  type MissionV4
} from '../src/main/missions/model'
import {
  parseV3CampaignFile,
  parseV3MissionFile,
  readV3CampaignLog,
  readV3MissionLog
} from '../src/main/missions/v3-read'
import { campaignMissionId, convertV3Campaign, convertV3Mission } from '../src/main/missions/compat'
import {
  createMissionRecord,
  listMissionRecords,
  readMissionRecord,
  updateMissionRecord
} from '../src/main/missions/record-store'
import { writeMission } from '../src/main/missions/write'

const FIXTURES = path.join(__dirname, 'fixtures', 'missions-v4-compat')

const LEADER = '3f1c9a52-7d4e-4b8a-9c21-5e6a0b7d8f10'
const VERIFIER = 'c4e6a8b0-5d7f-4c9a-a1b3-6e8a0c2e4f60'
const BUILDER = '8a2d4c6e-1b3f-4a5c-9d7e-2f4a6c8e0b1d'
const CHECKER = '6b8d0f2a-3c5e-4e7a-8b9c-1d3f5a7c9e2b'

const CAMPAIGN_ID = 'cmp-ca0001aa'
const CHAPTER_1 = 'mnt-ca000001'
const CHAPTER_2 = 'mnt-ca000002'

const sha = (bytes: Buffer | string): string => createHash('sha256').update(bytes).digest('hex')
const readFixture = (rel: string): string => readFileSync(path.join(FIXTURES, rel), 'utf8')

/** Every file under `dir` (recursive, dot-directories included), keyed by relative path. */
function snapshot(dir: string): Record<string, { sha: string; mtimeMs: number }> {
  const out: Record<string, { sha: string; mtimeMs: number }> = {}
  const walk = (sub: string): void => {
    for (const e of readdirSync(path.join(dir, sub), { withFileTypes: true })) {
      const rel = path.join(sub, e.name)
      if (e.isDirectory()) walk(rel)
      else {
        const abs = path.join(dir, rel)
        out[rel] = { sha: sha(readFileSync(abs)), mtimeMs: statSync(abs).mtimeMs }
      }
    }
  }
  if (existsSync(dir)) walk('')
  return out
}

const v3MissionFiles = (root: string): string[] =>
  readdirSync(path.join(root, '.harnu', 'missions')).sort()
const v3CampaignFiles = (root: string): string[] =>
  readdirSync(path.join(root, '.harnu', 'campaigns')).sort()
const v4Dir = (root: string): string => path.join(root, '.harnu', 'missions-v4')
const v4RecordFiles = (root: string): string[] =>
  existsSync(v4Dir(root))
    ? readdirSync(v4Dir(root))
        .filter((n) => n.endsWith('.md'))
        .sort()
    : []

/** Every mission and campaign id the fixtures hold. */
const ALL_V3_IDS = (root: string): string[] => [
  ...v3MissionFiles(root).map((n) => n.slice(0, 12)),
  ...v3CampaignFiles(root).map((n) => n.slice(0, 12))
]

let root = ''
beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'harnu-v4-compat-'))
  cpSync(path.join(FIXTURES, 'missions'), path.join(root, '.harnu', 'missions'), {
    recursive: true
  })
  cpSync(path.join(FIXTURES, 'campaigns'), path.join(root, '.harnu', 'campaigns'), {
    recursive: true
  })
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

/** Convert one fixture mission through the pure function. */
function convertFixture(name: string): { record: MissionV4; log: string } {
  const raw = readFixture(`missions/${name}.md`)
  const mission = parseV3MissionFile(raw)
  if ('error' in mission) throw new Error(mission.error)
  const { record, log } = convertV3Mission(mission, readV3MissionLog(raw))
  return { record, log }
}

/** Convert the sample campaign (five chapters, two with a mission) through the pure function. */
function convertSampleCampaign(): { record: MissionV4; log: string; sourceIds: string[] } {
  const raw = readFixture('campaigns/cmp-ca0001aa-sample-import-campaign.md')
  const campaign = parseV3CampaignFile(raw)
  if ('error' in campaign) throw new Error(campaign.error)
  const chapters = [['mnt-ca000001-chapter-1-import-core'], ['mnt-ca000002-chapter-2-report']].map(
    ([name]) => {
      const text = readFixture(`missions/${name}.md`)
      const mission = parseV3MissionFile(text)
      if ('error' in mission) throw new Error(mission.error)
      return { mission, log: readV3MissionLog(text) }
    }
  )
  return convertV3Campaign(campaign, readV3CampaignLog(raw), chapters)
}

const V3_MISSION_NAMES = [
  'mnt-5c0de001-modern-active',
  'mnt-5c0de002-legacy-fixed-start',
  'mnt-5c0de003-delivered-pending-close',
  'mnt-5c0de004-closed-delivered',
  'mnt-5c0de005-closed-discarded',
  'mnt-5c0de006-legacy-import',
  'mnt-5c0de007-stored-stale',
  'mnt-ca000001-chapter-1-import-core',
  'mnt-ca000002-chapter-2-report'
]
const V3_CAMPAIGN_NAMES = [
  'cmp-ca0001aa-sample-import-campaign',
  'cmp-ca0002bb-finished-campaign',
  'cmp-ca0003cc-dropped-campaign'
]

describe('the frozen v3 reader agrees with the v3 parser', () => {
  it('parses every fixture to exactly what mission-core and campaign-core parse', () => {
    for (const name of V3_MISSION_NAMES) {
      const raw = readFixture(`missions/${name}.md`)
      expect(parseV3MissionFile(raw), name).toEqual(parseMissionFile(raw))
    }
    for (const name of V3_CAMPAIGN_NAMES) {
      const raw = readFixture(`campaigns/${name}.md`)
      expect(parseV3CampaignFile(raw), name).toEqual(parseCampaignFile(raw))
    }
  })

  it('reads a legacy draft as active, as the v3 parser does, and reports a bad file as an error', () => {
    const draft = parseV3MissionFile(readFixture('missions/mnt-5c0de006-legacy-import.md'))
    expect('error' in draft ? null : draft.status).toBe('active')
    expect(parseV3MissionFile('not a mission')).toEqual({ error: 'no frontmatter block' })
    expect(parseV3CampaignFile('---\nid: x\n---\n')).toHaveProperty('error')
  })
})

// AC-21 ----------------------------------------------------------------------------------------

describe('reading leaves the file untouched', () => {
  it('changes no byte, no mtime and no directory when every v3 mission and campaign is read', async () => {
    const before = snapshot(path.join(root, '.harnu'))
    const dirsBefore = readdirSync(path.join(root, '.harnu')).sort()

    for (const id of ALL_V3_IDS(root)) {
      const read = await readMissionRecord(root, id)
      expect(read.ok, id).toBe(true)
    }
    const listed = await listMissionRecords(root)
    expect(listed.records.length).toBeGreaterThan(0)

    expect(snapshot(path.join(root, '.harnu'))).toEqual(before)
    expect(readdirSync(path.join(root, '.harnu')).sort()).toEqual(dirsBefore)
    expect(existsSync(v4Dir(root))).toBe(false)
  })

  it('serves a v3 mission as a v4 view marked with where it came from', async () => {
    const read = await readMissionRecord(root, 'mnt-5c0de001')
    if (!read.ok) throw new Error(read.error)
    expect(read.source).toBe('v3-mission')
    expect(read.record.schemaVersion).toBe(4)
    expect(read.record.id).toBe('mnt-5c0de001')
    expect(read.log).toContain('Dispatched the write step.')
  })

  it('says why a mission cannot be read instead of throwing', async () => {
    const missing = await readMissionRecord(root, 'mnt-00000000')
    expect(missing.ok).toBe(false)
    expect(!missing.ok && missing.error).toMatch(/MISSION_NOT_FOUND/)
    const bad = await readMissionRecord(root, 'not-an-id')
    expect(!bad.ok && bad.error).toMatch(/BAD_ARGS/)
  })
})

// AC-22 ----------------------------------------------------------------------------------------

describe('no v4 write path touches a v3 file', () => {
  it('leaves every v3 byte unchanged after the store has written every mission and campaign', async () => {
    const v3Before = {
      missions: snapshot(path.join(root, '.harnu', 'missions')),
      campaigns: snapshot(path.join(root, '.harnu', 'campaigns'))
    }

    for (const id of ALL_V3_IDS(root)) {
      // The first write copies; the second is the store's own write on an existing v4 record.
      const first = await updateMissionRecord(root, id, (record, log) => ({
        record: { ...record, closeRequested: { at: '2026-11-14T10:00:00Z' } },
        log: `${log}\n### 2026-11-14T10:00:00Z\n\nfirst write on ${id}\n`
      }))
      expect(first.ok, id).toBe(true)
      const second = await updateMissionRecord(root, id, (record, log) => ({
        record,
        log: `${log}\nsecond write on ${id}\n`
      }))
      expect(second.ok, id).toBe(true)
    }

    expect({
      missions: snapshot(path.join(root, '.harnu', 'missions')),
      campaigns: snapshot(path.join(root, '.harnu', 'campaigns'))
    }).toEqual(v3Before)
  })

  it('creates each v4 record by copy in its own directory, and the frozen v3 reader finds only v3 files in the v3 directories', async () => {
    for (const id of ALL_V3_IDS(root)) {
      await updateMissionRecord(root, id, (record, log) => ({ record, log: `${log}\nx\n` }))
    }

    // The v3 directories: every file still parses as v3 and none is a v4 record.
    for (const n of v3MissionFiles(root)) {
      const raw = readFileSync(path.join(root, '.harnu', 'missions', n), 'utf8')
      expect(parseV3MissionFile(raw), n).not.toHaveProperty('error')
      expect(raw, n).not.toMatch(/^schemaVersion: 4$/m)
    }
    for (const n of v3CampaignFiles(root)) {
      const raw = readFileSync(path.join(root, '.harnu', 'campaigns', n), 'utf8')
      expect(parseV3CampaignFile(raw), n).not.toHaveProperty('error')
      expect(raw, n).not.toMatch(/^schemaVersion: 4$/m)
    }
    expect(v3MissionFiles(root)).toEqual(V3_MISSION_NAMES.map((n) => `${n}.md`))
    expect(v3CampaignFiles(root)).toEqual(V3_CAMPAIGN_NAMES.map((n) => `${n}.md`))

    // The v4 directory: only v4 records, and a plain mission keeps its id and slug.
    const files = v4RecordFiles(root)
    expect(files.length).toBeGreaterThan(0)
    for (const n of files) {
      const parsed = parseMissionRecordFile(readFileSync(path.join(v4Dir(root), n), 'utf8'))
      expect(parsed, n).not.toHaveProperty('error')
    }
    expect(files).toContain('mnt-5c0de001-modern-active.md')
  })

  it('leaves every v3 byte unchanged after the guarded write path (S-11) has written every mission and campaign, and after it refused a session', async () => {
    const v3Before = {
      missions: snapshot(path.join(root, '.harnu', 'missions')),
      campaigns: snapshot(path.join(root, '.harnu', 'campaigns'))
    }
    for (const id of ALL_V3_IDS(root)) {
      const refused = await writeMission(
        root,
        id,
        { kind: 'session', sessionId: 'e0e0e0e0-0000-4000-8000-0000000000ff' },
        'write',
        (record, log) => ({ record, log: `${log}\nnope\n` })
      )
      expect(refused.ok, id).toBe(false)
      const written = await writeMission(
        root,
        id,
        { kind: 'operator' },
        'operator',
        (record, log) => ({
          record,
          log: `${log}\nwritten through the guarded path on ${id}\n`
        })
      )
      expect(written.ok, id).toBe(true)
    }
    expect({
      missions: snapshot(path.join(root, '.harnu', 'missions')),
      campaigns: snapshot(path.join(root, '.harnu', 'campaigns'))
    }).toEqual(v3Before)
  })

  it('keeps the v3 file whole when the first write fails', async () => {
    const before = snapshot(path.join(root, '.harnu', 'missions'))
    const result = await updateMissionRecord(root, 'mnt-5c0de001', () => {
      throw new Error('the verb refused')
    })
    expect(result.ok).toBe(false)
    expect(snapshot(path.join(root, '.harnu', 'missions'))).toEqual(before)
    expect(v4RecordFiles(root)).toEqual([])
  })
})

// AC-23 ----------------------------------------------------------------------------------------

describe('v3 concepts map to v4', () => {
  it('maps a modern active mission: title, Done when, status, steps, scope and the kept rows', () => {
    const { record, log } = convertFixture('mnt-5c0de001-modern-active')
    const v3 = parseMissionFile(readFixture('missions/mnt-5c0de001-modern-active.md'))
    if ('error' in v3) throw new Error(v3.error)

    expect(record.schemaVersion).toBe(4)
    expect(record.id).toBe('mnt-5c0de001')
    expect(record.title).toBe('Import the sample export') // the Log's first heading
    expect(record.doneWhen).toBe(
      'The importer reads every row of the sample export and reports the count. ' +
        'Proof: The suite passes and the sample export imports 120 rows'
    )
    expect(record.status).toBe('open')
    expect(record.closeRequested).toBeUndefined()
    expect(record.milestones).toEqual([])
    expect(log).toContain('Dispatched the write step.')

    // The fixed end is gone from the steps; this one was not verified, so nothing records it.
    expect(record.steps.map((s) => s.id)).toEqual([
      'stp-1',
      'stp-2',
      'stp-3',
      'stp-4',
      'stp-5',
      'stp-6',
      'stp-7',
      'stp-8',
      'stp-9',
      'stp-10',
      'stp-11'
    ])
    expect(record.steps.map((s) => s.title)).not.toContain('Delivered and verified')
    expect(record.doneWhenVerified).toBeUndefined()

    // Scope documents become mission links of kind doc.
    expect(record.links).toEqual([
      { kind: 'doc', ref: 'docs/specs/2026-10-20-sample-import/spec.md' },
      { kind: 'doc', ref: 'docs/adr/0001-sample-import.md' }
    ])

    // stewardPause, legacy, legacyRaw and openQuestions are kept under legacyV3, not shown. So are the
    // ledger, the outcome and the memory drafts: v3 values the closed v4 model does not hold.
    const legacy = record.legacyV3 as Record<string, unknown>
    expect(legacy.ledger).toEqual(v3.ledger)
    expect(record).not.toHaveProperty('ledger')
    expect(record).not.toHaveProperty('outcome')
    expect(record).not.toHaveProperty('memoryDrafts')
    expect(legacy.openQuestions).toEqual(['Should the importer keep the original row order?'])
    expect(legacy.stewardPause).toEqual(v3.stewardPause)
    expect(legacy.slug).toBe('modern-active')
    expect(record).not.toHaveProperty('openQuestions')
    expect(record).not.toHaveProperty('stewardPause')
  })

  it('maps verification levels and proofs to criteria, and checks to operator criteria', () => {
    const { record } = convertFixture('mnt-5c0de001-modern-active')
    const step = (id: string): MissionV4['steps'][number] =>
      record.steps.find((s) => s.id === id) as MissionV4['steps'][number]

    // existence → a criterion by the fact link-exists; an existing card link stays as `card`.
    const s1 = step('stp-1')
    expect(s1.card).toBe('import-sample-export')
    expect(s1.acs.map((a) => [a.by, a.fact])).toContainEqual(['fact', 'link-exists'])
    expect(s1.links).toEqual([{ kind: 'worktree', ref: 'src/importer/parse.ts' }])

    // A pr link → a criterion by the fact pr-merged; the session link becomes a `worked` session.
    const s2 = step('stp-2')
    expect(s2.acs.map((a) => a.fact)).toContain('pr-merged')
    expect(s2.links).toContainEqual({ kind: 'pr', ref: '412' })
    expect(s2.links.map((l) => l.kind)).not.toContain('session')
    expect(record.sessions).toContainEqual(
      expect.objectContaining({ id: BUILDER, role: 'worked', to: null })
    )

    // verifier + verified → a settled second-session criterion, settled by verifiedBy at its time.
    const s3 = step('stp-3')
    const second = s3.acs.find((a) => a.by === 'session')
    expect(second?.settled).toMatchObject({ at: '2026-10-21T09:30:00.000Z', by: VERIFIER })
    // checks → criteria by operator: the text is the label, ticked means settled.
    const ticked = s3.acs.find((a) => a.text === 'Count matches the sample export')
    const open = s3.acs.find((a) => a.text === 'Validated visually')
    expect(ticked).toMatchObject({ by: 'operator', settled: { at: '2026-10-21T09:40:00.000Z' } })
    expect(open?.by).toBe('operator')
    expect(open?.settled).toBeUndefined()

    // self-verified and claimed leave the criterion open and note the self-check in the model's
    // shape { at, by, evidence }: the v3 word stays under legacyV3.steps[].proof.
    const selfVerified = step('stp-4').acs.find((a) => a.by === 'session')
    expect(selfVerified?.settled).toBeUndefined()
    expect(selfVerified?.selfCheck).toEqual({
      at: '2026-10-21T09:50:00.000Z',
      by: BUILDER,
      evidence: 'Self-verified in v3 (verdict met)'
    })
    const claimed = step('stp-5').acs.find((a) => a.by === 'session')
    expect(claimed?.settled).toBeUndefined()
    expect(claimed?.selfCheck).toEqual({
      at: '2026-10-21T10:00:00.000Z', // the mission's updatedAt
      by: CHECKER, // the step's first session link
      evidence: 'Claimed done in v3, never checked'
    })
    const legacySteps = (record.legacyV3 as { steps: Array<{ id: string; proof: string }> }).steps
    expect(legacySteps.find((s) => s.id === 'stp-4')?.proof).toBe('self-verified')
    expect(legacySteps.find((s) => s.id === 'stp-5')?.proof).toBe('claimed')

    // human + verified → an operator criterion, settled; human + unproven → open.
    expect(step('stp-6').acs.find((a) => a.by === 'operator')?.settled).toMatchObject({
      at: '2026-10-21T09:58:00.000Z',
      by: 'operator'
    })
    expect(step('stp-7').acs.find((a) => a.by === 'operator')?.settled).toBeUndefined()

    // ids are ac-1 and up within a step, in order.
    expect(s3.acs.map((a) => a.id)).toEqual(['ac-1', 'ac-2', 'ac-3'])
  })

  it('maps blockers (ids from blk-1, mission level first), decision nodes and edges', () => {
    const { record } = convertFixture('mnt-5c0de001-modern-active')
    const step = (id: string): MissionV4['steps'][number] =>
      record.steps.find((s) => s.id === id) as MissionV4['steps'][number]

    // The mission blocker comes first; the step blockers follow in step order.
    expect(record.blockers).toEqual([
      expect.objectContaining({
        id: 'blk-1',
        reason: 'The sample export is not on the shared drive yet',
        owner: 'operator'
      })
    ])
    expect(step('stp-5').blockers).toEqual([
      expect.objectContaining({
        id: 'blk-2',
        reason: 'CI is red on the parser branch',
        owner: 'agent'
      })
    ])

    // An undecided decision node becomes an operator blocker "Choose: title, options" on its step;
    // the steps it blocks wait for it.
    const choose = step('stp-8').blockers
    expect(choose).toHaveLength(1)
    expect(choose[0]).toMatchObject({ owner: 'operator' })
    expect(choose[0].reason).toBe('Choose: Storage format (One file per row / One file per import)')
    expect(step('stp-9').waitsFor).toBe('stp-8')

    // A decided decision node shows nothing: no blocker, and what it blocked no longer waits.
    expect(step('stp-10').blockers).toEqual([])
    expect(step('stp-11').waitsFor ?? null).toBeNull()

    // An edge of kind blocks becomes waitsFor on its target; validates and related are dropped.
    expect(step('stp-3').waitsFor).toBe('stp-2')
    expect(step('stp-1').waitsFor ?? null).toBeNull()
    expect(step('stp-5').waitsFor ?? null).toBeNull()

    // A side step (required: false) becomes optional.
    expect(step('stp-11').optional).toBe(true)
    expect(step('stp-11').card).toBe('report-strings')
    expect(step('stp-2').optional).toBeUndefined()
  })

  it('maps the owner and the step session links to the session history', () => {
    const { record } = convertFixture('mnt-5c0de001-modern-active')
    expect(record.sessions[0]).toMatchObject({
      id: LEADER,
      role: 'leads',
      from: '2026-10-20T09:00:00.000Z',
      to: null
    })
    expect(record.sessions.filter((s) => s.role === 'leads')).toHaveLength(1)
    // Session links of every step, once each, none of them the leader.
    expect(
      record.sessions
        .filter((s) => s.role === 'worked')
        .map((s) => s.id)
        .sort()
    ).toEqual([BUILDER, CHECKER].sort())
  })

  it('maps the fixed end, scope and the closing statuses', () => {
    // delivered + pendingClose → open + closeRequested; the verified fixed end is recorded.
    const delivered = convertFixture('mnt-5c0de003-delivered-pending-close').record
    expect(delivered.status).toBe('open')
    expect(delivered.closeRequested).toEqual({ at: '2026-10-22T12:00:00.000Z' })
    expect(delivered.doneWhenVerified).toEqual({ by: VERIFIER, at: '2026-10-22T11:50:00.000Z' })
    const v3 = parseMissionFile(readFixture('missions/mnt-5c0de003-delivered-pending-close.md'))
    if ('error' in v3) throw new Error(v3.error)
    const deliveredLegacy = delivered.legacyV3 as Record<string, unknown>
    expect(deliveredLegacy.outcome).toEqual(v3.outcome)
    expect(deliveredLegacy.memoryDrafts).toEqual(v3.memoryDrafts)
    expect(delivered).not.toHaveProperty('outcome')
    expect(delivered).not.toHaveProperty('memoryDrafts')
    expect(delivered.steps.map((s) => s.title)).toEqual(['Build the parser'])

    // closed keeps closedAs and closeReason.
    const closed = convertFixture('mnt-5c0de004-closed-delivered').record
    expect(closed).toMatchObject({
      status: 'closed',
      closedAs: 'delivered',
      closeReason: 'Merged and checked by hand'
    })
    const discarded = convertFixture('mnt-5c0de005-closed-discarded').record
    expect(discarded).toMatchObject({ status: 'closed', closedAs: 'discarded' })
    expect(discarded.closeReason).toBeTruthy()

    // draft, active and stale all read as open.
    for (const name of [
      'mnt-5c0de002-legacy-fixed-start',
      'mnt-5c0de006-legacy-import',
      'mnt-5c0de007-stored-stale'
    ]) {
      expect(convertFixture(name).record.status, name).toBe('open')
    }

    // The fixed start's links join the scope as mission links of kind doc; the fixed start is no step.
    const legacyStart = convertFixture('mnt-5c0de002-legacy-fixed-start').record
    expect(legacyStart.links).toContainEqual({
      kind: 'doc',
      ref: 'docs/specs/2026-10-18-sample-import/spec.md'
    })
    expect(legacyStart.steps.map((s) => s.title)).toEqual(['Build the parser'])
    expect(legacyStart.steps[0].acs[0]).toMatchObject({ by: 'session' })

    // A legacy import keeps its raw goal file under legacyV3.
    const imported = convertFixture('mnt-5c0de006-legacy-import').record
    const legacy = imported.legacyV3 as Record<string, unknown>
    expect(legacy.legacyRaw).toContain('# Sample goal')
    expect(legacy.legacy).toMatchObject({ needsReview: ['declaredEnd'] })
  })

  it('maps a delivered mission without pendingClose to open, and a needs-human verdict to a settled criterion', () => {
    const raw = readFixture('missions/mnt-5c0de003-delivered-pending-close.md')
    const v3 = parseV3MissionFile(raw)
    if ('error' in v3) throw new Error(v3.error)
    const { pendingClose: _dropped, ...rest } = v3
    const { record } = convertV3Mission(rest as typeof v3, readV3MissionLog(raw))
    expect(record.status).toBe('open')
    expect(record.closeRequested).toBeUndefined()

    const modern = parseV3MissionFile(readFixture('missions/mnt-5c0de001-modern-active.md'))
    if ('error' in modern) throw new Error(modern.error)
    const withVerdict = {
      ...modern,
      steps: modern.steps.map((s) =>
        s.id === 'stp-3' && s.verifiedBy
          ? { ...s, verifiedBy: { ...s.verifiedBy, verdict: 'needs-human' as const } }
          : s
      )
    }
    const converted = convertV3Mission(withVerdict, '').record
    const second = converted.steps
      .find((s) => s.id === 'stp-3')
      ?.acs.find((a) => a.by === 'session')
    expect(second?.settled).toMatchObject({ by: VERIFIER })
  })

  it('writes a record every later read accepts: build, parse, equal', () => {
    for (const name of V3_MISSION_NAMES) {
      const { record } = convertFixture(name)
      const parsed = parseMissionRecordFile(buildMissionRecordContent(record, ''))
      expect(parsed, name).toEqual(record)
    }
  })

  it('is a pure function: converting the same input twice gives the same record', () => {
    for (const name of V3_MISSION_NAMES) {
      expect(convertFixture(name), name).toEqual(convertFixture(name))
    }
  })
})

// AC-24 ----------------------------------------------------------------------------------------

describe('a campaign reads as one mission', () => {
  it('turns the chapters into milestones in order, with optional, waitsFor and no-mission chapters', () => {
    const { record } = convertSampleCampaign()

    expect(record.title).toBe('Deliver the sample import')
    expect(record.doneWhen).toBe(
      'The sample import is delivered end to end. Proof: The import runs on the sample export and the report matches'
    )
    expect(record.milestones.map((m) => [m.id, m.title, m.optional, m.waitsFor])).toEqual([
      ['mls-1', 'Import core', false, null],
      ['mls-2', 'Report', false, null],
      ['mls-3', 'Migrate the pages', false, 'mls-2'], // unlocks a chapter → waitsFor its milestone
      ['mls-4', 'Fix the parser edge cases', true, 'mls-1'], // an optional chapter is optional
      ['mls-5', 'Publish the notes', false, 'pr:390'] // unlocks a pr
    ])
    // consumes, produces, radiant and discoveredFrom are kept under legacyV3, not shown.
    const legacy = record.legacyV3 as { chapters: Array<Record<string, unknown>> }
    expect(legacy.chapters.map((c) => c.id)).toEqual(['chp-1', 'chp-2', 'chp-3', 'chp-4', 'chp-5'])
    expect(legacy.chapters[2]).toMatchObject({
      consumes: ['report'],
      radiant: { template: 'migrate page {slug}', total: 88 }
    })
    expect(legacy.chapters[3]).toMatchObject({ discoveredFrom: { chapterId: 'chp-2' } })
    expect(legacy.chapters[1]).toMatchObject({ produces: ['report'], missionId: CHAPTER_2 })
    expect(record.milestones[0]).not.toHaveProperty('produces')
  })

  it("makes the chapter missions' steps its steps, and a chapter with no mission a milestone with no steps", () => {
    const { record } = convertSampleCampaign()
    // Chapter 1 has one custom step; chapter 2 has two. Ids are renumbered across the whole mission.
    expect(record.steps.map((s) => [s.id, s.milestone, s.title])).toEqual([
      ['stp-1', 'mls-1', 'Build the import core'],
      ['stp-2', 'mls-2', 'Render the report'],
      ['stp-3', 'mls-2', 'Verify the report']
    ])
    for (const m of ['mls-3', 'mls-4', 'mls-5']) {
      expect(record.steps.filter((s) => s.milestone === m)).toEqual([])
    }
    // Chapter 2 is still running: its session links carry over; its ledger sits under its chapter's
    // legacy entry, with the v3 step ids the rows were written with.
    expect(record.sessions.map((s) => s.id)).toEqual(
      expect.arrayContaining([LEADER, BUILDER, CHECKER])
    )
    expect(record).not.toHaveProperty('ledger')
    const chapters = (record.legacyV3 as { chapters: Array<{ id: string; mission?: unknown }> })
      .chapters
    const ch2 = chapters.find((c) => c.id === 'chp-2')?.mission as {
      ledger: Array<{ stepId: string }>
    }
    expect(ch2.ledger.map((r) => r.stepId)).toEqual(['stp-1'])
    // The map from the old step ids is kept so a caller can still find a step by its old id.
    const legacy = record.legacyV3 as { stepIds: Array<Record<string, unknown>> }
    expect(legacy.stepIds).toContainEqual({ mission: CHAPTER_2, step: 'stp-1', id: 'stp-2' })
  })

  it('reads a chapter mission closed as delivered as a done milestone: only facts are left to derive', () => {
    const { record } = convertSampleCampaign()
    const done = record.steps.filter((s) => s.milestone === 'mls-1')
    expect(done.length).toBeGreaterThan(0)
    for (const step of done) {
      for (const ac of step.acs) {
        expect(ac.by === 'fact' || ac.settled !== undefined, `${step.id}/${ac.id}`).toBe(true)
      }
    }
    // The running chapter keeps its open criteria.
    const running = record.steps.filter((s) => s.milestone === 'mls-2')
    expect(running.flatMap((s) => s.acs).some((a) => a.by === 'session' && !a.settled)).toBe(true)
  })

  it('has the id of the first 8 hex of the sha256 of the sorted source ids, and keeps the owner as leader', () => {
    const { record, sourceIds } = convertSampleCampaign()
    expect(sourceIds).toEqual([CAMPAIGN_ID, CHAPTER_1, CHAPTER_2])
    const expected = `mnt-${sha([CAMPAIGN_ID, CHAPTER_1, CHAPTER_2].sort().join('\n')).slice(0, 8)}`
    expect(record.id).toBe(expected)
    expect(campaignMissionId([CHAPTER_2, CAMPAIGN_ID, CHAPTER_1])).toBe(expected)
    expect(record.sessions[0]).toMatchObject({ id: LEADER, role: 'leads', to: null })
    // The campaign's scope documents are mission links of kind doc.
    expect(record.links).toEqual([
      { kind: 'doc', ref: 'docs/specs/2026-10-20-sample-import/spec.md' }
    ])
  })

  it('maps a finished and a dropped campaign like a mission', () => {
    const finishedRaw = readFixture('campaigns/cmp-ca0002bb-finished-campaign.md')
    const finished = parseV3CampaignFile(finishedRaw)
    if ('error' in finished) throw new Error(finished.error)
    const f = convertV3Campaign(finished, readV3CampaignLog(finishedRaw), []).record
    expect(f.status).toBe('open')
    expect(f.closeRequested).toEqual({ at: '2026-10-22T12:00:00.000Z' })
    expect(f.milestones).toHaveLength(1)
    expect(f.steps).toEqual([])

    const droppedRaw = readFixture('campaigns/cmp-ca0003cc-dropped-campaign.md')
    const dropped = parseV3CampaignFile(droppedRaw)
    if ('error' in dropped) throw new Error(dropped.error)
    const d = convertV3Campaign(dropped, readV3CampaignLog(droppedRaw), []).record
    expect(d).toMatchObject({
      status: 'closed',
      closedAs: 'discarded',
      closeReason: 'Not needed any more'
    })
  })

  it('serves the campaign as ONE mission through the store, and hides its chapter missions from the list', async () => {
    const read = await readMissionRecord(root, CAMPAIGN_ID)
    if (!read.ok) throw new Error(read.error)
    expect(read.source).toBe('v3-campaign')
    expect(read.record.milestones).toHaveLength(5)

    // An old chapter id reads the same mission.
    const viaChapter = await readMissionRecord(root, CHAPTER_2)
    if (!viaChapter.ok) throw new Error(viaChapter.error)
    expect(viaChapter.record.id).toBe(read.record.id)

    const listed = await listMissionRecords(root)
    const ids = listed.records.map((r) => r.record.id)
    expect(ids).toContain(read.record.id)
    expect(ids).not.toContain(CHAPTER_1)
    expect(ids).not.toContain(CHAPTER_2)
    expect(ids).toContain('mnt-5c0de001')
    expect(new Set(ids).size).toBe(ids.length)
  })
})

// AC-25 ----------------------------------------------------------------------------------------

describe('a mid-flight campaign converts by copy', () => {
  it('writes one new mission on the first v4 write to any of its files, and no v3 file moves', async () => {
    const hashes = (): Record<string, string> => {
      const out: Record<string, string> = {}
      for (const [k, v] of Object.entries(snapshot(path.join(root, '.harnu', 'campaigns')))) {
        out[`campaigns/${k}`] = v.sha
      }
      for (const [k, v] of Object.entries(snapshot(path.join(root, '.harnu', 'missions')))) {
        out[`missions/${k}`] = v.sha
      }
      return out
    }
    const before = hashes()
    const { record: expected } = convertSampleCampaign()

    // The first write is aimed at a CHAPTER mission, not at the campaign.
    const result = await updateMissionRecord(root, CHAPTER_2, (record, log) => ({
      record: { ...record, closeRequested: { at: '2026-11-14T10:00:00Z' } },
      log: `${log}\n### 2026-11-14T10:00:00Z\n\nthe leader says ready\n`
    }))
    if (!result.ok) throw new Error(result.error)
    expect(result.created).toBe(true)
    expect(result.record.id).toBe(expected.id)

    expect(hashes()).toEqual(before) // the campaign and chapter files are never modified

    const files = v4RecordFiles(root)
    expect(files).toEqual([`${expected.id}-sample-import-campaign.md`])
    const stored = parseMissionRecordFile(readFileSync(path.join(v4Dir(root), files[0]), 'utf8'))
    if ('error' in stored) throw new Error(stored.error)
    expect(stored.closeRequested).toEqual({ at: '2026-11-14T10:00:00Z' })
    expect(stored.milestones).toHaveLength(5)

    // Every old id resolves to the new mission, through the sidecar that says "superseded by".
    const migrated = path.join(v4Dir(root), '.migrated')
    expect(readdirSync(migrated).sort()).toEqual([
      `${CAMPAIGN_ID}.json`,
      `${CHAPTER_1}.json`,
      `${CHAPTER_2}.json`
    ])
    expect(
      JSON.parse(readFileSync(path.join(migrated, `${CAMPAIGN_ID}.json`), 'utf8'))
    ).toMatchObject({
      supersededBy: expected.id
    })
    for (const old of [CAMPAIGN_ID, CHAPTER_1, CHAPTER_2]) {
      const read = await readMissionRecord(root, old)
      if (!read.ok) throw new Error(read.error)
      expect(read.source, old).toBe('v4')
      expect(read.record.id, old).toBe(expected.id)
      expect(read.record.closeRequested, old).toEqual({ at: '2026-11-14T10:00:00Z' })
      expect(read.log, old).toContain('the leader says ready')
    }

    // The list shows it once, and not the chapter missions or the campaign beside it.
    const ids = (await listMissionRecords(root)).records.map((r) => r.record.id)
    expect(ids.filter((id) => id === expected.id)).toHaveLength(1)
    expect(ids).not.toContain(CHAPTER_1)
    expect(ids).not.toContain(CHAPTER_2)
  })

  it('keeps the chapter logs in the new mission and keeps a plain mission under its own id and slug', async () => {
    const plain = await updateMissionRecord(root, 'mnt-5c0de001', (record, log) => ({
      record,
      log
    }))
    if (!plain.ok) throw new Error(plain.error)
    expect(path.basename(plain.file)).toBe('mnt-5c0de001-modern-active.md')
    expect(readdirSync(v4Dir(root)).filter((n) => n === '.migrated')).toEqual([]) // same id: no sidecar

    const camp = await updateMissionRecord(root, CAMPAIGN_ID, (record, log) => ({ record, log }))
    if (!camp.ok) throw new Error(camp.error)
    expect(camp.log).toContain('Chapter 1 · Import core')
    expect(camp.log).toContain('Chapter 2 · Report')
  })
})

// AC-26 ----------------------------------------------------------------------------------------

/** Every module specifier a TypeScript source imports or re-exports, static or dynamic. */
function importSpecifiers(source: string): string[] {
  const out: string[] = []
  const re =
    /(?:^|[\s;])(?:import|export)\s+(?:type\s+)?(?:[^'";]*?\sfrom\s+)?['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)|require\(\s*['"]([^'"]+)['"]\s*\)/g
  for (const m of source.matchAll(re)) out.push(m[1] ?? m[2] ?? m[3])
  return out
}

/** The v3 modules a v4 module must not import (spec AC-26), by resolved base name. */
const FORBIDDEN_V3 = new Set([
  'mission-core',
  'mission-gates',
  'mission-progress',
  'mission-migration',
  'campaign-core',
  'campaign-progress'
])

/** Which v3 modules `source`, living in `dir`, imports by a relative path. */
function v3Imports(source: string, dir: string): string[] {
  return importSpecifiers(source)
    .filter((s) => s.startsWith('.'))
    .map((s) => path.resolve(dir, s))
    .filter((abs) => {
      const base = path.basename(abs).replace(/\.(ts|js)$/, '')
      const inMain = path.dirname(abs) === path.resolve(__dirname, '..', 'src', 'main')
      return inMain && (FORBIDDEN_V3.has(base) || base.startsWith('steward'))
    })
    .map((abs) => path.basename(abs))
}

describe('v4 modules import v3 code only through v3-read', () => {
  const dir = path.resolve(__dirname, '..', 'src', 'main', 'missions')

  /**
   * The chapter 2 modules are the listed exception: they are repointed by the slice that deletes the
   * v3 modules (S-40). `waiting.ts` is one of them: chapter 2 created it (S-5) and S-8 rewrites it.
   */
  const CHAPTER_2_EXCEPTION = new Set([
    'store.ts',
    'derive.ts',
    'observer.ts',
    'ledger-store.ts',
    'waiting.ts'
  ])

  it('the scanner sees a forbidden import (a proof that fails against the code it replaces)', () => {
    const bad = [
      "import { parseMissionFile } from '../mission-core'",
      "import type { Mission } from '../mission-core'",
      "export { campaignFilePath } from '../campaign-core'",
      "const m = await import('../mission-gates')",
      "import { x } from '../steward-core'"
    ]
    for (const line of bad) expect(v3Imports(line, dir), line).toHaveLength(1)
    const fine = [
      "import { parseV3MissionFile } from './v3-read'",
      "import { MissionRecordSchema } from './model'",
      "import { repoRoot } from '../data-dir'",
      "import type { MissionV4 } from './model'"
    ]
    for (const line of fine) expect(v3Imports(line, dir), line).toEqual([])
  })

  it('no module outside the chapter 2 exception imports a v3 core, a gate, a progress, the migration, a campaign module or a steward file', () => {
    const offenders: string[] = []
    for (const name of readdirSync(dir).filter((n) => n.endsWith('.ts'))) {
      if (CHAPTER_2_EXCEPTION.has(name)) continue
      const found = v3Imports(readFileSync(path.join(dir, name), 'utf8'), dir)
      if (found.length > 0) offenders.push(`${name} → ${found.join(', ')}`)
    }
    expect(offenders).toEqual([])
  })

  it('the compatibility modules exist and reach v3 only through v3-read.ts, which imports nothing of the app', () => {
    const read = (n: string): string => readFileSync(path.join(dir, n), 'utf8')
    const relative = (n: string): string[] =>
      importSpecifiers(read(n)).filter((s) => s.startsWith('.'))

    // v3-read.ts is a frozen copy: it depends on no other file of the app.
    expect(relative('v3-read.ts')).toEqual([])
    // compat.ts is pure: the v3 shapes come from v3-read, the v4 ones from model.
    expect(relative('compat.ts').sort()).toEqual(['./model', './v3-read'])
    // record-store.ts reaches the v3 parser through v3-read, never a v3 core.
    expect(relative('record-store.ts')).toContain('./v3-read')
    expect(relative('record-store.ts')).toContain('./compat')
    expect(relative('record-store.ts')).toContain('./model')
    for (const spec of relative('record-store.ts')) {
      expect(['./v3-read', './compat', './model', '../data-dir']).toContain(spec)
    }
  })
})

// AC-27 ----------------------------------------------------------------------------------------

describe('conversion is idempotent', () => {
  it('converting twice leaves one record whose bytes do not change', async () => {
    const first = await updateMissionRecord(root, CAMPAIGN_ID, (record, log) => ({ record, log }))
    if (!first.ok) throw new Error(first.error)
    expect(first.created).toBe(true)
    const bytes = readFileSync(first.file)

    const second = await updateMissionRecord(root, CAMPAIGN_ID, (record, log) => ({ record, log }))
    if (!second.ok) throw new Error(second.error)
    expect(second.created).toBe(false)
    expect(second.file).toBe(first.file)
    expect(readFileSync(second.file).equals(bytes)).toBe(true)
    expect(v4RecordFiles(root)).toHaveLength(1)
  })

  it('is deterministic: two repos holding the same v3 files get byte-identical v4 records', async () => {
    const other = mkdtempSync(path.join(os.tmpdir(), 'harnu-v4-compat-'))
    try {
      cpSync(path.join(root, '.harnu'), path.join(other, '.harnu'), { recursive: true })
      const a = await updateMissionRecord(root, CHAPTER_1, (record, log) => ({ record, log }))
      const b = await updateMissionRecord(other, CAMPAIGN_ID, (record, log) => ({ record, log }))
      if (!a.ok || !b.ok) throw new Error('write failed')
      expect(path.basename(a.file)).toBe(path.basename(b.file))
      expect(readFileSync(a.file).equals(readFileSync(b.file))).toBe(true)
    } finally {
      rmSync(other, { recursive: true, force: true })
    }
  })

  it('two sessions converting at once leave one v4 record, and both of their writes land', async () => {
    const results = await Promise.all(
      [CAMPAIGN_ID, CHAPTER_1, CHAPTER_2, CAMPAIGN_ID].map((old, n) =>
        updateMissionRecord(root, old, (record, log) => ({
          record,
          log: `${log}\nwriter ${n}\n`
        }))
      )
    )
    for (const r of results) expect(r.ok).toBe(true)
    expect(results.filter((r) => r.ok && r.created)).toHaveLength(1)

    const files = v4RecordFiles(root)
    expect(files).toHaveLength(1)
    const log = readFileSync(path.join(v4Dir(root), files[0]), 'utf8')
    for (const n of [0, 1, 2, 3]) expect(log).toContain(`writer ${n}`)

    // The same for a mission born in v3 with its own id.
    const plain = await Promise.all(
      [0, 1, 2].map((n) =>
        updateMissionRecord(root, 'mnt-5c0de001', (record, l) => ({ record, log: `${l}\nw${n}\n` }))
      )
    )
    expect(plain.filter((r) => r.ok && r.created)).toHaveLength(1)
    expect(v4RecordFiles(root).filter((n) => n.startsWith('mnt-5c0de001-'))).toHaveLength(1)
  })

  it('never overwrites a v4 record that is already there with a fresh copy of the v3 file', async () => {
    await updateMissionRecord(root, 'mnt-5c0de001', (record, log) => ({
      record,
      log: `${log}\nkept\n`
    }))
    mkdirSync(v4Dir(root), { recursive: true })
    const again = await updateMissionRecord(root, 'mnt-5c0de001', (record, log) => ({
      record,
      log
    }))
    if (!again.ok) throw new Error(again.error)
    expect(again.created).toBe(false)
    expect(again.log).toContain('kept')
  })

  it('lists a campaign whose sidecars point at a record that was never written', async () => {
    // A crash (or a failed link) between the sidecars and the record leaves sidecars that point at
    // nothing: a read ignores them, so the list must too, or the campaign vanishes from it.
    const migrated = path.join(v4Dir(root), '.migrated')
    mkdirSync(migrated, { recursive: true })
    for (const old of [CAMPAIGN_ID, CHAPTER_1, CHAPTER_2]) {
      writeFileSync(
        path.join(migrated, `${old}.json`),
        `${JSON.stringify({ supersededBy: 'mnt-deadbeef', from: 'chapter', campaign: CAMPAIGN_ID })}\n`
      )
    }
    const read = await readMissionRecord(root, CAMPAIGN_ID)
    if (!read.ok) throw new Error(read.error)
    expect(read.source).toBe('v3-campaign')
    const { records } = await listMissionRecords(root)
    expect(records.filter((r) => r.record.id === read.record.id)).toHaveLength(1)
    expect(records.some((r) => r.record.id === CHAPTER_1)).toBe(false)
  })
})

// Delta 1 · item 2 — the fixed end keeps what it held ----------------------------------------------

describe('the fixed end keeps what it held', () => {
  /** The delivered fixture with checks and more links on its fixed end, which no fixture carries. */
  function withFixedEnd(): { record: MissionV4 } {
    const raw = readFixture('missions/mnt-5c0de003-delivered-pending-close.md')
    const v3 = parseV3MissionFile(raw)
    if ('error' in v3) throw new Error(v3.error)
    const steps = v3.steps.map((s) =>
      s.kind !== 'fixed-end'
        ? s
        : {
            ...s,
            links: [
              ...s.links,
              { kind: 'pr' as const, ref: '399' },
              { kind: 'card' as const, ref: 'evidence-card' }
            ],
            checks: [
              {
                id: 'chk-1',
                label: 'The designer has read the release note',
                source: 'operator' as const,
                createdAt: '2026-10-22T11:55:00.000Z'
              },
              {
                id: 'chk-2',
                label: 'Layout signed off',
                source: 'verifier' as const,
                createdAt: '2026-10-22T11:56:00.000Z',
                ticked: { at: '2026-10-22T11:57:00.000Z' }
              }
            ]
          }
    )
    return convertV3Mission({ ...v3, steps }, readV3MissionLog(raw))
  }

  it('turns an unticked check into a mission-level blocker the operator owns', () => {
    const { record } = withFixedEnd()
    const blocker = record.blockers.find(
      (b) => b.reason === 'The designer has read the release note'
    )
    expect(blocker).toMatchObject({
      ask: 'The designer has read the release note',
      unblocks: 'Closing the mission',
      owner: 'operator'
    })
    expect(blocker?.clearsWhen).toBeUndefined()
    // The ticked check is not owed, so it is not a blocker.
    expect(record.blockers.map((b) => b.reason)).not.toContain('Layout signed off')
    expect(record.blockers.map((b) => b.id)).toEqual(['blk-1'])
  })

  it('keeps every check, with its id, source, creation time and tick, under legacyV3.fixedEnd', () => {
    const { record } = withFixedEnd()
    const fixedEnd = (record.legacyV3 as { fixedEnd: Record<string, unknown> }).fixedEnd
    expect(fixedEnd.checks).toEqual([
      {
        id: 'chk-1',
        label: 'The designer has read the release note',
        source: 'operator',
        createdAt: '2026-10-22T11:55:00.000Z'
      },
      {
        id: 'chk-2',
        label: 'Layout signed off',
        source: 'verifier',
        createdAt: '2026-10-22T11:56:00.000Z',
        ticked: { at: '2026-10-22T11:57:00.000Z' }
      }
    ])
    // Its proof is still there, as before.
    expect(fixedEnd).toMatchObject({ id: 'stp-2', proof: 'verified' })
  })

  it('joins the pr and worktree links of the fixed end to the mission links, and keeps a card link under legacyV3', () => {
    const { record } = withFixedEnd()
    expect(record.links).toContainEqual({ kind: 'pr', ref: '399' })
    expect(record.links).toContainEqual({
      kind: 'worktree',
      ref: '.harnu/evidence/mnt-5c0de003/stp-2'
    })
    expect(record.links.map((l) => l.kind)).not.toContain('card')
    const fixedEnd = (record.legacyV3 as { fixedEnd: { links: unknown[] } }).fixedEnd
    expect(fixedEnd.links).toEqual([{ kind: 'card', ref: 'evidence-card' }])
    // The documents keep coming first.
    expect(record.links[0]).toEqual({
      kind: 'doc',
      ref: 'docs/specs/2026-10-20-sample-import/spec.md'
    })
  })

  it('does the same for the fixed end of every chapter mission of a campaign, under that chapter', () => {
    const raw = readFixture('campaigns/cmp-ca0001aa-sample-import-campaign.md')
    const campaign = parseV3CampaignFile(raw)
    if ('error' in campaign) throw new Error(campaign.error)
    const chapterRaw = readFixture('missions/mnt-ca000002-chapter-2-report.md')
    const chapter = parseV3MissionFile(chapterRaw)
    if ('error' in chapter) throw new Error(chapter.error)
    const steps = chapter.steps.map((s) =>
      s.kind !== 'fixed-end'
        ? s
        : {
            ...s,
            links: [{ kind: 'pr' as const, ref: '401' }],
            checks: [
              {
                id: 'chk-1',
                label: 'Report reviewed by a person',
                source: 'agent' as const,
                createdAt: '2026-10-21T09:00:00.000Z'
              }
            ]
          }
    )
    const { record } = convertV3Campaign(campaign, readV3CampaignLog(raw), [
      { mission: { ...chapter, steps }, log: readV3MissionLog(chapterRaw) }
    ])
    expect(record.blockers).toEqual([
      expect.objectContaining({
        id: 'blk-1',
        reason: 'Report reviewed by a person',
        owner: 'operator',
        unblocks: 'Closing the mission'
      })
    ])
    expect(record.links).toContainEqual({ kind: 'pr', ref: '401' })
    const legacy = record.legacyV3 as {
      chapters: Array<{ id: string; mission?: { fixedEnd: { checks: unknown[] } } }>
    }
    expect(legacy.chapters.find((c) => c.id === 'chp-2')?.mission?.fixedEnd.checks).toHaveLength(1)
  })
})

// Delta 1 · item 3 — a campaign never gets a second record ------------------------------------------

describe('a campaign never gets a second v4 record', () => {
  /** What the installed v3 build does after the copy: bind a NEW chapter mission to the campaign. */
  function bindNewChapter(): string {
    const NEW_CHAPTER = 'mnt-ca000009'
    const chapter = readFixture('missions/mnt-ca000002-chapter-2-report.md')
      .replace(/mnt-ca000002/g, NEW_CHAPTER)
      .replace('chp-2', 'chp-3')
      .replace('slug: chapter-2-report', 'slug: chapter-3-migrate')
    writeFileSync(
      path.join(root, '.harnu', 'missions', `${NEW_CHAPTER}-chapter-3-migrate.md`),
      chapter
    )
    const campaignFile = path.join(
      root,
      '.harnu',
      'campaigns',
      'cmp-ca0001aa-sample-import-campaign.md'
    )
    const text = readFileSync(campaignFile, 'utf8')
    writeFileSync(
      campaignFile,
      text.replace(
        '    title: Migrate the pages\n',
        `    title: Migrate the pages\n    missionId: ${NEW_CHAPTER}\n`
      )
    )
    return NEW_CHAPTER
  }

  it('resolves a chapter bound after the copy to the record that already exists, on read and on write', async () => {
    const first = await updateMissionRecord(root, CAMPAIGN_ID, (record, log) => ({
      record,
      log: `${log}\nbefore\n`
    }))
    if (!first.ok) throw new Error(first.error)
    const sidecars = readdirSync(path.join(v4Dir(root), '.migrated')).sort()
    const sidecarBytes = sidecars.map((n) =>
      readFileSync(path.join(v4Dir(root), '.migrated', n), 'utf8')
    )

    const added = bindNewChapter()

    // A read through the new chapter id, and through the campaign id, serve the same record.
    const viaChapter = await readMissionRecord(root, added)
    if (!viaChapter.ok) throw new Error(viaChapter.error)
    expect(viaChapter.source).toBe('v4')
    expect(viaChapter.record.id).toBe(first.record.id)
    const viaCampaign = await readMissionRecord(root, CAMPAIGN_ID)
    if (!viaCampaign.ok) throw new Error(viaCampaign.error)
    expect(viaCampaign.record.id).toBe(first.record.id)

    // A write through the new chapter id lands on that record: no second one, no sidecar repointed.
    const second = await updateMissionRecord(root, added, (record, log) => ({
      record,
      log: `${log}\nafter\n`
    }))
    if (!second.ok) throw new Error(second.error)
    expect(second.created).toBe(false)
    expect(second.record.id).toBe(first.record.id)
    expect(v4RecordFiles(root)).toHaveLength(1)
    expect(readFileSync(second.file, 'utf8')).toContain('before')
    expect(readFileSync(second.file, 'utf8')).toContain('after')
    expect(readdirSync(path.join(v4Dir(root), '.migrated')).sort()).toEqual(sidecars)
    for (const [n, name] of sidecars.entries()) {
      expect(readFileSync(path.join(v4Dir(root), '.migrated', name), 'utf8')).toBe(sidecarBytes[n])
    }

    // The list shows the one record, and not the new chapter mission on its own.
    const ids = (await listMissionRecords(root)).records.map((r) => r.record.id)
    expect(ids.filter((id) => id === first.record.id)).toHaveLength(1)
    expect(ids).not.toContain(added)
  })

  it('does not convert the campaign again when the first write is aimed at the new chapter', async () => {
    const first = await updateMissionRecord(root, CAMPAIGN_ID, (record, log) => ({ record, log }))
    if (!first.ok) throw new Error(first.error)
    const added = bindNewChapter()
    const results = await Promise.all(
      [added, CAMPAIGN_ID, CHAPTER_1].map((id) =>
        updateMissionRecord(root, id, (record, log) => ({ record, log: `${log}\nvia ${id}\n` }))
      )
    )
    for (const r of results) expect(r.ok).toBe(true)
    expect(v4RecordFiles(root)).toHaveLength(1)
  })
})

// Delta 1 · item 4 — the store's writes -----------------------------------------------------------------

describe('the store never loses an update and never leaves a half-written record', () => {
  it('re-reads and re-applies the change when the record changed under it (compare and swap)', async () => {
    await updateMissionRecord(root, 'mnt-5c0de001', (record, log) => ({ record, log }))
    const file = path.join(v4Dir(root), 'mnt-5c0de001-modern-active.md')
    let calls = 0
    const result = await updateMissionRecord(root, 'mnt-5c0de001', (record, log) => {
      calls++
      if (calls === 1) {
        // Another process appends a line after we read, before we swap.
        writeFileSync(file, `${readFileSync(file, 'utf8')}\nfrom the other writer\n`)
      }
      return { record, log: `${log}\nmine ${calls}\n` }
    })
    if (!result.ok) throw new Error(result.error)
    expect(calls).toBe(2)
    const text = readFileSync(file, 'utf8')
    expect(text).toContain('from the other writer')
    expect(text).toContain('mine 2')
    expect(text).not.toContain('mine 1')
  })

  it('gives up with a typed refusal when the record keeps changing', async () => {
    await updateMissionRecord(root, 'mnt-5c0de001', (record, log) => ({ record, log }))
    const file = path.join(v4Dir(root), 'mnt-5c0de001-modern-active.md')
    let n = 0
    const result = await updateMissionRecord(root, 'mnt-5c0de001', (record, log) => {
      writeFileSync(file, `${readFileSync(file, 'utf8')}\nchurn ${++n}\n`)
      return { record, log }
    })
    expect(result.ok).toBe(false)
    expect(!result.ok && result.code).toBe('WRITE_CONFLICT')
  })

  it('keeps every line when two processes write one record at the same time', async () => {
    await updateMissionRecord(root, 'mnt-5c0de001', (record, log) => ({ record, log }))
    const script = path.join(root, 'writer.mts')
    const COUNT = 25
    writeFileSync(
      script,
      `import { existsSync, writeFileSync } from 'node:fs'
import { updateMissionRecord } from ${JSON.stringify(
        path.resolve(__dirname, '..', 'src', 'main', 'missions', 'record-store')
      )}
const [root, tag, count] = process.argv.slice(2)
// Both processes are up before either writes: they start together, so their writes overlap.
writeFileSync(root + '/ready-' + tag, '')
while (!existsSync(root + '/go')) await new Promise((r) => setTimeout(r, 2))
for (let i = 0; i < Number(count); i++) {
  const r = await updateMissionRecord(root, 'mnt-5c0de001', (record, log) => ({ record, log: log + '\\n' + tag + ' ' + i + '\\n' }))
  if (!r.ok) { console.error(r.error); process.exit(1) }
}
`
    )
    const viteNode = path.resolve(__dirname, '..', 'node_modules', 'vite-node', 'vite-node.mjs')
    const run = (tag: string): Promise<void> =>
      new Promise((resolve, reject) => {
        execFile(
          process.execPath,
          [viteNode, script, root, tag, String(COUNT)],
          (err, _o, errOut) =>
            err ? reject(new Error(`${tag}: ${errOut || err.message}`)) : resolve()
        )
      })
    const both = Promise.all([run('alpha'), run('beta')])
    while (
      !existsSync(path.join(root, 'ready-alpha')) ||
      !existsSync(path.join(root, 'ready-beta'))
    ) {
      await new Promise((r) => setTimeout(r, 5))
    }
    writeFileSync(path.join(root, 'go'), '')
    await both

    const text = readFileSync(path.join(v4Dir(root), 'mnt-5c0de001-modern-active.md'), 'utf8')
    for (const tag of ['alpha', 'beta']) {
      for (let i = 0; i < COUNT; i++) expect(text, `${tag} ${i}`).toContain(`\n${tag} ${i}\n`)
    }
    expect(readdirSync(v4Dir(root)).filter((n) => n.endsWith('.lock'))).toEqual([])
  }, 60_000)

  it('flushes the temporary file to disk before it renames it into place', async () => {
    const handle = await fsp.open(path.join(root, 'probe'), 'w')
    const proto = Object.getPrototypeOf(handle) as { sync: () => Promise<void> }
    await handle.close()
    const sync = vi.spyOn(proto, 'sync')
    const rename = vi.spyOn(fsp, 'rename')
    try {
      const copy = await updateMissionRecord(root, 'mnt-5c0de001', (record, log) => ({
        record,
        log
      }))
      // The copy is linked into place: its temporary file is flushed first too.
      expect(copy.ok && copy.created).toBe(true)
      expect(sync.mock.calls.length).toBeGreaterThanOrEqual(1)
      sync.mockClear()
      rename.mockClear()

      // The overwrite renames: a flush of the temporary file must come before that rename.
      await updateMissionRecord(root, 'mnt-5c0de001', (record, log) => ({
        record,
        log: `${log}\nx\n`
      }))
      expect(rename).toHaveBeenCalledTimes(1)
      const renamedAt = rename.mock.invocationCallOrder[0]
      expect(
        sync.mock.invocationCallOrder.filter((n) => n < renamedAt).length
      ).toBeGreaterThanOrEqual(1)
      // And the directory is flushed after it, where the platform allows.
      expect(
        sync.mock.invocationCallOrder.filter((n) => n > renamedAt).length
      ).toBeGreaterThanOrEqual(1)
    } finally {
      sync.mockRestore()
      rename.mockRestore()
    }
  })

  it('does not let an empty or unparsable v4 file hide a good v3 one silently', async () => {
    mkdirSync(v4Dir(root), { recursive: true })
    const broken = path.join(v4Dir(root), 'mnt-5c0de001-modern-active.md')
    writeFileSync(broken, '')
    const read = await readMissionRecord(root, 'mnt-5c0de001')
    expect(read.ok).toBe(false)
    expect(!read.ok && read.code).toBe('MISSION_UNREADABLE')
    expect(!read.ok && read.error).toContain(broken) // which file to remove
    expect(!read.ok && read.error).toMatch(/remove/i)
    // A write refuses the same way and leaves both files as they were.
    const write = await updateMissionRecord(root, 'mnt-5c0de001', (record, log) => ({
      record,
      log
    }))
    expect(!write.ok && write.code).toBe('MISSION_UNREADABLE')
    expect(readFileSync(broken, 'utf8')).toBe('')
    // The list reports it, never silently serves the v3 twin as if nothing happened.
    const listed = await listMissionRecords(root)
    expect(listed.unreadable).toContain('mnt-5c0de001-modern-active.md')
    expect(listed.records.map((r) => r.record.id)).not.toContain('mnt-5c0de001')
  })

  it('passes a typed refusal thrown inside the change back with its code intact', async () => {
    const coded = await updateMissionRecord(root, 'mnt-5c0de001', () => {
      throw Object.assign(new Error('this verb is not allowed here'), { code: 'NOT_ATTACHED' })
    })
    expect(coded.ok).toBe(false)
    expect(!coded.ok && coded.code).toBe('NOT_ATTACHED')
    expect(!coded.ok && coded.error).toContain('this verb is not allowed here')

    const plain = await updateMissionRecord(root, 'mnt-5c0de001', () => {
      throw new Error('plain')
    })
    expect(!plain.ok && plain.code).toBe('WRITE_REFUSED')

    const missing = await updateMissionRecord(root, 'mnt-00000000', (record, log) => ({
      record,
      log
    }))
    expect(!missing.ok && missing.code).toBe('MISSION_NOT_FOUND')
    expect(v4RecordFiles(root)).toEqual([])
  })

  it('exports an exclusive create for a brand-new v4 mission, written the same atomic way', async () => {
    const { record } = convertFixture('mnt-5c0de001-modern-active')
    const fresh: MissionV4 = { ...record, id: 'mnt-0badc0de', title: 'A fresh one' }
    const made = await createMissionRecord(root, fresh, '# A fresh one\n', 'a-fresh-one')
    if (!made.ok) throw new Error(made.error)
    expect(path.basename(made.file)).toBe('mnt-0badc0de-a-fresh-one.md')
    const read = await readMissionRecord(root, 'mnt-0badc0de')
    expect(read.ok && read.source).toBe('v4')

    // The same id twice, under any slug, is refused; so is an id a v3 file already holds.
    const again = await createMissionRecord(root, fresh, '', 'another-slug')
    expect(!again.ok && again.code).toBe('MISSION_EXISTS')
    const taken = await createMissionRecord(root, { ...fresh, id: 'mnt-5c0de002' }, '', 'x')
    expect(!taken.ok && taken.code).toBe('MISSION_EXISTS')
    expect(v4RecordFiles(root)).toEqual(['mnt-0badc0de-a-fresh-one.md'])

    // Two creates at once: exactly one wins.
    const race = await Promise.all(
      [1, 2, 3].map(() => createMissionRecord(root, { ...fresh, id: 'mnt-0badc0df' }, '', 'race'))
    )
    expect(race.filter((r) => r.ok)).toHaveLength(1)
    expect(race.filter((r) => !r.ok).every((r) => !r.ok && r.code === 'MISSION_EXISTS')).toBe(true)

    // A record the v4 schema refuses is refused before any file exists.
    const bad = await createMissionRecord(root, { ...fresh, id: 'nope' }, '', 'bad')
    expect(bad.ok).toBe(false)
    expect(v4RecordFiles(root)).not.toContain('nope-bad.md')
  })
})
