/**
 * A neutral v3 campaign of the shape that exposed BUG-282, written as the v3 builders wrote it (plain
 * `.md` files with a YAML front matter under `.harnu/campaigns/` and `.harnu/missions/`).
 *
 * Thirteen chapters of "Acme": eleven required, two side quests. Every chapter produces a token and
 * chapters 5 to 12 consume the one before it, so most of the tail is locked behind an unfinished
 * chapter. Ten chapter missions exist and three chapters have none:
 *
 *   chp-1   Import core            closed as delivered              (done in v3)
 *   chp-2   Report                 delivered, close requested       (done in v3)
 *   chp-3   Fix the parser         active, EVERY custom step done, fixed end unproven (in review in v3)
 *   chp-4   Tidy the exports       SIDE QUEST, active, nothing done
 *   chp-5   Migrate pages A        active, not started, locked behind chp-3
 *   chp-6   Migrate pages B        active, STARTED (a step claimed), so v3 never locked it
 *   chp-7   Migrate pages C        active, nothing done, unticked check on its fixed end, locked
 *   chp-8   Migrate pages D        active, nothing done, locked
 *   chp-9   Migrate pages E        no mission, locked
 *   chp-10  Migrate pages F        no mission, locked
 *   chp-11  Migrate pages G        no mission, locked
 *   chp-12  Publish the notes      active, nothing done, locked
 *   chp-13  Announce               SIDE QUEST, active, `unlocks` chp-12
 *
 * Eight chapter missions (3 to 8, 12, 13) have an UNPROVEN fixed end. Every chapter mission numbers its
 * steps from `stp-1`, so an old step id means a different step in each chapter. Names, ids, paths and
 * sessions are made up.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import * as path from 'node:path'

export const OWNER = '3f1c9a52-7d4e-4b8a-9c21-5e6a0b7d8f10'
export const VERIFIER = 'c4e6a8b0-5d7f-4c9a-a1b3-6e8a0c2e4f60'
export const WORKER = '8a2d4c6e-1b3f-4a5c-9d7e-2f4a6c8e0b1d'
export const CAMPAIGN_ID = 'cmp-cc13aa01'
const FOLDER = '/home/user/Workspace/org/www'
const AT = '2026-11-02T09:00:00.000Z'

export interface Check {
  id: string
  label: string
  source: 'agent' | 'operator' | 'verifier'
  createdAt: string
  ticked?: string
}

export interface StepSpec {
  title: string
  verification: 'existence' | 'verifier' | 'human'
  proof: 'unproven' | 'claimed' | 'verified' | 'self-verified'
  links?: Array<{ kind: 'session' | 'worktree' | 'card' | 'pr'; ref: string }>
  checks?: Check[]
  required?: boolean
}

export interface ChapterSpec {
  n: number
  title: string
  required: boolean
  produces: string
  consumes?: string[]
  unlocks?: string
  mission?: {
    status: 'active' | 'delivered' | 'closed'
    closedAs?: 'delivered' | 'discarded'
    pendingClose?: boolean
    steps: StepSpec[]
    endChecks?: Check[]
    /** The fixed end's proof; `unproven` when absent. */
    endProof?: 'verified'
  }
}

const check = (id: string, label: string, source: Check['source'], ticked?: string): Check => ({
  id,
  label,
  source,
  createdAt: '2026-11-03T08:00:00.000Z',
  ...(ticked ? { ticked } : {})
})

export const CHAPTERS: ChapterSpec[] = [
  {
    n: 1,
    title: 'Import core',
    required: true,
    produces: 'import-core',
    mission: {
      status: 'closed',
      closedAs: 'delivered',
      steps: [
        {
          title: 'Parse the export',
          verification: 'existence',
          proof: 'unproven',
          links: [{ kind: 'session', ref: WORKER }]
        },
        { title: 'Check the parser', verification: 'verifier', proof: 'verified' }
      ]
    }
  },
  {
    n: 2,
    title: 'Report',
    required: true,
    produces: 'report',
    consumes: ['import-core'],
    mission: {
      status: 'delivered',
      pendingClose: true,
      steps: [
        {
          title: 'Render the report',
          verification: 'verifier',
          proof: 'verified',
          checks: [
            check('chk-1', 'Layout reviewed by design', 'operator', '2026-11-05T10:00:00.000Z')
          ]
        },
        { title: 'Approve the layout', verification: 'human', proof: 'verified' }
      ]
    }
  },
  {
    n: 3,
    title: 'Fix the parser',
    required: true,
    produces: 'parser',
    consumes: ['import-core'],
    mission: {
      status: 'active',
      steps: [
        { title: 'Handle quoted rows', verification: 'verifier', proof: 'verified' },
        { title: 'Handle empty rows', verification: 'verifier', proof: 'verified' },
        {
          title: 'Handle odd encodings',
          verification: 'verifier',
          proof: 'verified',
          checks: [check('chk-1', 'Sample files re-run', 'verifier', '2026-11-06T10:00:00.000Z')]
        }
      ]
    }
  },
  {
    n: 4,
    title: 'Tidy the exports',
    required: false,
    produces: 'tidy',
    mission: {
      status: 'active',
      steps: [{ title: 'Remove the old exports', verification: 'existence', proof: 'unproven' }]
    }
  },
  {
    n: 5,
    title: 'Migrate pages A',
    required: true,
    produces: 'pages-a',
    consumes: ['report', 'parser'],
    mission: {
      status: 'active',
      steps: [
        {
          title: 'Plan the pages',
          verification: 'existence',
          proof: 'unproven',
          links: [{ kind: 'worktree', ref: 'docs/plans/pages-a.md' }],
          checks: [check('chk-1', 'Plan read by the owner', 'agent')]
        },
        { title: 'Sign off the plan', verification: 'human', proof: 'unproven' }
      ]
    }
  },
  {
    n: 6,
    title: 'Migrate pages B',
    required: true,
    produces: 'pages-b',
    consumes: ['pages-a'],
    mission: {
      status: 'active',
      steps: [{ title: 'Move the B pages', verification: 'verifier', proof: 'claimed' }]
    }
  },
  {
    n: 7,
    title: 'Migrate pages C',
    required: true,
    produces: 'pages-c',
    consumes: ['pages-b'],
    mission: {
      status: 'active',
      steps: [{ title: 'Move the C pages', verification: 'existence', proof: 'unproven' }],
      endChecks: [check('chk-1', 'Redirects tested on staging', 'operator')]
    }
  },
  {
    n: 8,
    title: 'Migrate pages D',
    required: true,
    produces: 'pages-d',
    consumes: ['pages-c'],
    mission: {
      status: 'active',
      steps: [
        { title: 'Move the D pages', verification: 'verifier', proof: 'unproven' },
        { title: 'Check the D links', verification: 'verifier', proof: 'unproven' }
      ]
    }
  },
  { n: 9, title: 'Migrate pages E', required: true, produces: 'pages-e', consumes: ['pages-d'] },
  { n: 10, title: 'Migrate pages F', required: true, produces: 'pages-f', consumes: ['pages-e'] },
  { n: 11, title: 'Migrate pages G', required: true, produces: 'pages-g', consumes: ['pages-f'] },
  {
    n: 12,
    title: 'Publish the notes',
    required: true,
    produces: 'notes',
    consumes: ['pages-g'],
    mission: {
      status: 'active',
      steps: [{ title: 'Write the notes', verification: 'existence', proof: 'unproven' }]
    }
  },
  {
    n: 13,
    title: 'Announce',
    required: false,
    produces: 'announcement',
    unlocks: 'chp-12',
    mission: {
      status: 'active',
      steps: [{ title: 'Draft the announcement', verification: 'verifier', proof: 'unproven' }]
    }
  }
]

export const missionIdOf = (n: number): string => `mnt-cc13${String(n).padStart(4, '0')}`

function checkText(c: Check, indent: string): string {
  return (
    `${indent}- id: ${c.id}\n${indent}  label: ${c.label}\n${indent}  source: ${c.source}\n` +
    `${indent}  createdAt: '${c.createdAt}'\n` +
    (c.ticked ? `${indent}  ticked:\n${indent}    at: '${c.ticked}'\n` : '')
  )
}

function stepText(
  s: StepSpec,
  ordinal: number,
  kind: 'custom' | 'fixed-end',
  checks?: Check[]
): string {
  const verifiedBy =
    s.proof === 'verified'
      ? `    verifiedBy:\n      sessionId: ${VERIFIER}\n      at: '2026-11-04T15:00:00.000Z'\n      verdict: met\n`
      : ''
  const links = (s.links ?? []).length
    ? `    links:\n${(s.links ?? []).map((l) => `      - kind: ${l.kind}\n        ref: ${l.ref}\n`).join('')}`
    : '    links: []\n'
  const cs = [...(s.checks ?? []), ...(checks ?? [])]
  return (
    `  - id: stp-${ordinal}\n    ordinal: ${ordinal}\n    kind: ${kind}\n    title: ${s.title}\n` +
    `    verification: ${s.verification}\n    proof: ${s.proof}\n${verifiedBy}${links}    blockers: []\n` +
    (cs.length ? `    checks:\n${cs.map((c) => checkText(c, '      ')).join('')}` : '') +
    `    addedAt: '2026-11-02T09:05:00.000Z'\n` +
    (s.required === false ? '    required: false\n' : '')
  )
}

/** One chapter mission file. */
export function chapterMissionFile(ch: ChapterSpec): { name: string; text: string } {
  const m = ch.mission as NonNullable<ChapterSpec['mission']>
  const id = missionIdOf(ch.n)
  const steps =
    m.steps.map((s, i) => stepText(s, i + 1, 'custom')).join('') +
    stepText(
      {
        title: 'Delivered and verified',
        verification: 'verifier',
        proof: m.endProof ?? 'unproven'
      },
      m.steps.length + 1,
      'fixed-end',
      m.endChecks
    )
  const text =
    `---\nid: ${id}\nslug: chapter-${ch.n}\nfolder: ${FOLDER}\nowner:\n  sessionId: ${OWNER}\n  folder: ${FOLDER}\n` +
    `status: ${m.status}\n${m.closedAs ? `closedAs: ${m.closedAs}\n` : ''}` +
    `declaredEnd:\n  kind: code\n  target: Chapter ${ch.n} is done\n  evidence: The suite passes\n` +
    `steps:\n${steps}blockers: []\nopenQuestions: []\n` +
    (m.pendingClose
      ? `pendingClose:\n  at: '2026-11-07T12:00:00.000Z'\n  requestedBy: ${OWNER}\n`
      : '') +
    `createdAt: '2026-11-02T09:00:00.000Z'\nupdatedAt: '2026-11-08T10:00:00.000Z'\n` +
    `provenance:\n  author: agent\n  at: '${AT}'\n  branch: card/T800-example\n` +
    `campaignId: ${CAMPAIGN_ID}\nchapterId: chp-${ch.n}\n---\n# Chapter ${ch.n} · ${ch.title}\n\n## Log\n`
  return { name: `${id}-chapter-${ch.n}.md`, text }
}

/** The campaign file. */
export function campaignFile(chapterSpecs: ChapterSpec[] = CHAPTERS): {
  name: string
  text: string
} {
  const chapters = chapterSpecs
    .map(
      (c) =>
        `  - id: chp-${c.n}\n    ordinal: ${c.n}\n    title: ${c.title}\n` +
        (c.mission ? `    missionId: ${missionIdOf(c.n)}\n` : '') +
        `    required: ${c.required}\n    produces:\n      - ${c.produces}\n` +
        (c.consumes ? `    consumes:\n${c.consumes.map((t) => `      - ${t}\n`).join('')}` : '') +
        (c.unlocks ? `    unlocks:\n      kind: chapter\n      ref: ${c.unlocks}\n` : '')
    )
    .join('')
  const text =
    `---\nid: ${CAMPAIGN_ID}\nslug: acme-migration\nfolder: ${FOLDER}\nowner:\n  sessionId: ${OWNER}\n  folder: ${FOLDER}\n` +
    `title: Migrate the Acme site\ndeclaredEnd:\n  kind: code\n  target: The Acme site is migrated\n  evidence: Every page is served by the new stack\n` +
    `chapters:\n${chapters}status: active\ncreatedAt: '2026-11-01T08:00:00.000Z'\nupdatedAt: '2026-11-08T10:00:00.000Z'\n` +
    `provenance:\n  author: agent\n  at: '${AT}'\n  branch: card/T800-example\n---\n# Migrate the Acme site\n\n## Log\n`
  return { name: `${CAMPAIGN_ID}-acme-migration.md`, text }
}

/** Write the whole campaign under `<root>/.harnu/`. */
export function writeCampaign13(root: string, chapterSpecs: ChapterSpec[] = CHAPTERS): void {
  mkdirSync(path.join(root, '.harnu', 'campaigns'), { recursive: true })
  mkdirSync(path.join(root, '.harnu', 'missions'), { recursive: true })
  const c = campaignFile(chapterSpecs)
  writeFileSync(path.join(root, '.harnu', 'campaigns', c.name), c.text)
  for (const ch of chapterSpecs) {
    if (!ch.mission) continue
    const f = chapterMissionFile(ch)
    writeFileSync(path.join(root, '.harnu', 'missions', f.name), f.text)
  }
}
