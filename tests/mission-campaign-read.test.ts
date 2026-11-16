/**
 * Missions v4 · S-39 delta 2 — an existing campaign reads true in the Mission pane.
 *
 * With the campaign code gone, the compatibility reader is the ONLY way a campaign is seen: it reads
 * `.harnu/campaigns/*.md` and its chapter missions as ONE mission whose milestones are the chapters.
 * Each milestone's state must follow its chapter's mission the way the removed campaign code derived
 * it: a chapter whose mission is delivered, or closed as delivered, is a done milestone; one closed as
 * discarded is dropped from the count; one with steps done shows them; a side quest stays outside.
 *
 * The spec is silent on how a discarded chapter shows, so it reads as an optional milestone: it is
 * listed in plan order and never counted toward the total (the closed model has no other mark).
 *
 * Run for real on a throwaway repo (`.harnu/` written under `$TMPDIR`, fixtures only): the read goes
 * through `readMissionRecord` and `deriveProgress`, the two calls the pane's view is built from, and
 * nothing on disk may change, byte or mtime.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { readMissionRecord } from '../src/main/missions/record-store'
import { deriveProgress } from '../src/main/missions/progress'

const OWNER = '3f1c9a52-7d4e-4b8a-9c21-5e6a0b7d8f10'
const VERIFIER = 'c4e6a8b0-5d7f-4c9a-a1b3-6e8a0c2e4f60'
const CAMPAIGN = 'cmp-cb0001aa'

type Step = { id: string; verification: 'existence' | 'verifier'; proof: string; title: string }

/** A v3 chapter mission file (plain text, the shape the removed builder wrote). */
function chapterMission(opts: {
  n: number
  chapter: string
  status: 'active' | 'delivered' | 'closed'
  closedAs?: 'delivered' | 'discarded'
  steps: Step[]
}): { name: string; text: string } {
  const id = `mnt-cb00000${opts.n}`
  const steps = opts.steps
    .map((s, i) => {
      const verified =
        s.proof === 'verified'
          ? `    verifiedBy:\n      sessionId: ${VERIFIER}\n      at: '2026-10-19T15:00:00.000Z'\n      verdict: met\n`
          : ''
      return (
        `  - id: ${s.id}\n    ordinal: ${i + 1}\n    kind: custom\n    title: ${s.title}\n` +
        `    verification: ${s.verification}\n    proof: ${s.proof}\n${verified}` +
        `    links: []\n    blockers: []\n    addedAt: '2026-10-20T09:05:00.000Z'\n`
      )
    })
    .join('')
  const text =
    `---\nid: ${id}\nslug: chapter-${opts.n}\nfolder: /home/user/Workspace/org/www\n` +
    `owner:\n  sessionId: ${OWNER}\n  folder: /home/user/Workspace/org/www\n` +
    `status: ${opts.status}\n${opts.closedAs ? `closedAs: ${opts.closedAs}\n` : ''}` +
    `declaredEnd:\n  kind: code\n  target: Chapter ${opts.n} is done\n  evidence: The suite passes\n` +
    `steps:\n${steps}` +
    `  - id: stp-${opts.steps.length + 1}\n    ordinal: ${opts.steps.length + 1}\n    kind: fixed-end\n` +
    `    title: Delivered and verified\n    verification: verifier\n    proof: unproven\n` +
    `    links: []\n    blockers: []\n    addedAt: '2026-10-20T09:05:00.000Z'\n` +
    `blockers: []\nopenQuestions: []\ncreatedAt: '2026-10-20T09:00:00.000Z'\n` +
    `updatedAt: '2026-10-21T10:00:00.000Z'\nprovenance:\n  author: agent\n  at: '2026-10-20T09:00:00.000Z'\n` +
    `  branch: card/T700-example\ncampaignId: ${CAMPAIGN}\nchapterId: ${opts.chapter}\n---\n` +
    `# Chapter ${opts.n}\n\n## Log\n`
  return { name: `${id}-chapter-${opts.n}.md`, text }
}

const ONE_UNPROVEN: Step[] = [
  { id: 'stp-1', verification: 'existence', proof: 'unproven', title: 'Build it' }
]

/** The fixture: six chapters, one per case the operator's own campaign mixes. */
function fixture(): { campaign: string; missions: Array<{ name: string; text: string }> } {
  const missions = [
    // chp-1: closed as delivered, its only step an unproven existence step.
    chapterMission({
      n: 1,
      chapter: 'chp-1',
      status: 'closed',
      closedAs: 'delivered',
      steps: ONE_UNPROVEN
    }),
    // chp-2: delivered, waiting for the operator's close.
    chapterMission({
      n: 2,
      chapter: 'chp-2',
      status: 'delivered',
      steps: [{ id: 'stp-1', verification: 'verifier', proof: 'unproven', title: 'Report it' }]
    }),
    // chp-3: closed as discarded.
    chapterMission({
      n: 3,
      chapter: 'chp-3',
      status: 'closed',
      closedAs: 'discarded',
      steps: [{ id: 'stp-1', verification: 'verifier', proof: 'unproven', title: 'First try' }]
    }),
    // chp-4: in progress, one step verified and one still to do.
    chapterMission({
      n: 4,
      chapter: 'chp-4',
      status: 'active',
      steps: [
        { id: 'stp-1', verification: 'verifier', proof: 'verified', title: 'Parse it' },
        { id: 'stp-2', verification: 'verifier', proof: 'unproven', title: 'Publish it' }
      ]
    })
  ]
  const chapters = [
    { id: 'chp-1', title: 'Import core', required: true, mission: 'mnt-cb000001' },
    { id: 'chp-2', title: 'Report', required: true, mission: 'mnt-cb000002' },
    { id: 'chp-3', title: 'Dropped try', required: true, mission: 'mnt-cb000003' },
    { id: 'chp-4', title: 'Migrate the pages', required: true, mission: 'mnt-cb000004' },
    { id: 'chp-5', title: 'Publish the notes', required: true },
    { id: 'chp-6', title: 'Side quest', required: false }
  ]
  const campaign =
    `---\nid: ${CAMPAIGN}\nslug: delivery\nfolder: /home/user/Workspace/org/www\n` +
    `owner:\n  sessionId: ${OWNER}\n  folder: /home/user/Workspace/org/www\ntitle: Deliver it\n` +
    `declaredEnd:\n  kind: code\n  target: It is delivered\n  evidence: It runs\nchapters:\n` +
    chapters
      .map(
        (c, i) =>
          `  - id: ${c.id}\n    ordinal: ${i + 1}\n    title: ${c.title}\n` +
          `${c.mission ? `    missionId: ${c.mission}\n` : ''}    required: ${c.required}\n`
      )
      .join('') +
    `status: active\ncreatedAt: '2026-10-18T08:00:00.000Z'\nupdatedAt: '2026-10-21T10:00:00.000Z'\n` +
    `provenance:\n  author: agent\n  at: '2026-10-20T09:00:00.000Z'\n  branch: card/T700-example\n---\n` +
    `# Deliver it\n\n## Log\n`
  return { campaign, missions }
}

const sha = (b: Buffer): string => createHash('sha256').update(b).digest('hex')

/** Every file under `dir`, keyed by relative path, with its hash and mtime. */
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
  root = mkdtempSync(path.join(os.tmpdir(), 'harnu-campaign-read-'))
  const f = fixture()
  mkdirSync(path.join(root, '.harnu', 'campaigns'), { recursive: true })
  mkdirSync(path.join(root, '.harnu', 'missions'), { recursive: true })
  writeFileSync(path.join(root, '.harnu', 'campaigns', `${CAMPAIGN}-delivery.md`), f.campaign)
  for (const m of f.missions) writeFileSync(path.join(root, '.harnu', 'missions', m.name), m.text)
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

async function progressOfCampaign(): Promise<ReturnType<typeof deriveProgress>> {
  const read = await readMissionRecord(root, CAMPAIGN)
  if (!read.ok) throw new Error(read.error)
  // No live facts: a delivered chapter must read done without any (its link may be long gone).
  return deriveProgress(read.record, {})
}

describe('a campaign read as one mission counts its chapters like the campaign did', () => {
  it('counts a delivered and a closed-as-delivered chapter as done milestones', async () => {
    const p = await progressOfCampaign()
    const state = (id: string): string => p.milestones.find((m) => m.id === id)?.state ?? 'missing'
    expect(state('mls-1')).toBe('done')
    expect(state('mls-2')).toBe('done')
  })

  it('shows a chapter with steps done as in progress, and a chapter with no mission as not started', async () => {
    const p = await progressOfCampaign()
    const state = (id: string): string => p.milestones.find((m) => m.id === id)?.state ?? 'missing'
    expect(state('mls-4')).toBe('in-progress')
    expect(state('mls-5')).toBe('not-started')
    const done = p.steps.filter((s) => s.state === 'done').map((s) => s.milestone)
    expect(done).toContain('mls-4')
  })

  it('lists a discarded chapter in order, outside the count, and not done', async () => {
    const p = await progressOfCampaign()
    const dropped = p.milestones.find((m) => m.id === 'mls-3')
    expect(dropped?.optional).toBe(true)
    expect(dropped?.state).not.toBe('done')
    expect(p.milestones.map((m) => m.id)).toEqual([
      'mls-1',
      'mls-2',
      'mls-3',
      'mls-4',
      'mls-5',
      'mls-6'
    ])
  })

  it('keeps a side-quest chapter outside the headline count', async () => {
    const p = await progressOfCampaign()
    expect(p.milestones.find((m) => m.id === 'mls-6')?.optional).toBe(true)
  })

  it('reads "2 of 4 milestones done": delivered twice, discarded and side quest left out', async () => {
    const p = await progressOfCampaign()
    expect(p.unit).toBe('milestones')
    expect(p.total).toBe(4)
    expect(p.done).toBe(2)
    expect(p.current?.id).toBe('mls-4')
    expect(p.allDone).toBe(false)
  })

  it('writes nothing: the campaign file and every chapter mission keep their bytes and mtimes', async () => {
    const before = snapshot(root)
    expect(Object.keys(before)).toHaveLength(5)
    await progressOfCampaign()
    // Read by the chapter mission's id too: it resolves to the same campaign.
    const byChapter = await readMissionRecord(root, 'mnt-cb000001')
    expect(byChapter.ok).toBe(true)
    expect(snapshot(root)).toEqual(before)
  })

  it('reads the frozen fixture campaign with its closed-as-delivered chapter 1 done', async () => {
    const frozen = path.join(__dirname, 'fixtures', 'missions-v4-compat')
    rmSync(path.join(root, '.harnu'), { recursive: true, force: true })
    cpSync(path.join(frozen, 'campaigns'), path.join(root, '.harnu', 'campaigns'), {
      recursive: true
    })
    cpSync(path.join(frozen, 'missions'), path.join(root, '.harnu', 'missions'), {
      recursive: true
    })
    const read = await readMissionRecord(root, 'cmp-ca0001aa')
    if (!read.ok) throw new Error(read.error)
    const p = deriveProgress(read.record, {})
    expect(p.milestones.map((m) => [m.title, m.state])).toContainEqual(['Import core', 'done'])
    expect(p.done).toBeGreaterThanOrEqual(1)
  })
})
