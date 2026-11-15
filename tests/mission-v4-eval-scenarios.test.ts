/**
 * Mission behavior-eval scenarios for Missions v4, graded OFFLINE (S-33, AC-81).
 *
 * `npm run eval:mission` drives real `claude -p` sessions, so it runs once per slice, not per edit. This
 * suite keeps the graders honest in between: for EVERY scenario it builds, by hand, the v4 record a
 * correct run leaves on disk, and checks that
 *
 *  - the scenario's assertions PASS on it (the grader is satisfiable), and
 *  - every deliberately broken copy (`breaks`) FAILS (the grader is not vacuous),
 *
 * with the harness's own `gradeState` / `applyBreak`, the same code the live run grades with.
 *
 * **What this suite proves, and what it cannot.** It proves the scenarios' SHAPE (which verbs they call,
 * which records they read), the graders (a good run passes, a planted fault fails) and the harness's
 * own seeding and framing. It proves nothing about what a model does: AC-71 and AC-73..76 are text pins,
 * and only the live runs (`npm run eval:mission -- cold-start proactive-creates proactive-none`) show
 * that a model follows the skills. The three live scenarios are NOT proved here.
 */
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'

import * as agent from '../scripts/eval/mission-behavior/agent.mjs'
import {
  applyBreak,
  evaluate,
  gradeFolder,
  gradeState,
  loadMissionState,
  missionsDirOf,
  v3MissionsDirOf
} from '../scripts/eval/mission-behavior/grade.mjs'
import { seedV4Record } from '../scripts/eval/mission-behavior/seed-v4.mjs'
import { MCP_TOOLS } from '../src/main/mcp/tool-catalog'
import {
  buildMissionRecordContent,
  parseMissionRecordFile,
  readMissionRecordLog,
  type MissionV4
} from '../src/main/missions/model'
import { buildMissionSummary } from '../src/main/missions/summary'

const { MISSION_VERBS, buildAgentArgs, coldFrame, replyAsks, sessionFrame, turnRecord } = agent

const REPO_ROOT = path.resolve(import.meta.dirname, '..')
const EVAL = path.join(REPO_ROOT, 'scripts', 'eval', 'mission-behavior')
const SCENARIOS = path.join(EVAL, 'scenarios')
const FIXTURES = path.join(EVAL, 'fixtures')

type Json = Record<string, unknown>
interface Scenario {
  name: string
  skip?: boolean
  agents?: string[]
  phases: Json[]
  assert: Json[]
  breaks: { name: string }[]
}
interface Graded {
  ok: boolean
  results: { ok: boolean; label: string; detail: string }[]
}

const rawScenario = (name: string): string =>
  readFileSync(path.join(SCENARIOS, `${name}.json`), 'utf8')
const loadScenario = (name: string): Scenario => JSON.parse(rawScenario(name))

const A = '11111111-1111-4111-8111-111111111111'
const B = '22222222-2222-4222-8222-222222222222'
const AT = '2026-11-14T10:00:00.000Z'

function vars(extra: Json = {}): Json {
  return { folder: '/tmp/eval', session: { A, B }, m: {}, seeded: {}, summary: {}, ...extra }
}

// ---- a v4 record, the way the product writes it ---------------------------------

interface StepSpec {
  title: string
  milestone?: string
  acs?: Json[]
  links?: Json[]
  blockers?: Json[]
  startedAt?: string
}

const ac = (n: number, text: string, extra: Json = {}): Json => ({
  id: `ac-${n}`,
  text,
  by: 'session',
  ...extra
})

function stepOf(n: number, s: StepSpec): Json {
  return {
    id: `stp-${n}`,
    ...(s.milestone ? { milestone: s.milestone } : {}),
    title: s.title,
    ...(s.startedAt ? { startedAt: s.startedAt } : {}),
    acs: s.acs ?? [ac(1, 'The step does what it says')],
    links: s.links ?? [],
    blockers: s.blockers ?? []
  }
}

interface RecordSpec {
  slug: string
  title?: string
  doneWhen?: string
  data?: Json
  milestones?: Json[]
  steps: StepSpec[]
  sessions?: Json[]
  links?: Json[]
  log?: string
}

function recordFile(i: number, s: RecordSpec): Json {
  const id = `mnt-0000abc${i}`
  return {
    file: `${id}-${s.slug}.md`,
    slug: s.slug,
    data: {
      schemaVersion: 4,
      id,
      title: s.title ?? s.slug,
      doneWhen: s.doneWhen ?? 'It is done',
      status: 'open',
      milestones: s.milestones ?? [],
      steps: s.steps.map((st, k) => stepOf(k + 1, st)),
      sessions: s.sessions ?? [{ id: A, role: 'leads', from: AT, to: null }],
      links: s.links ?? [],
      blockers: [],
      ...(s.data ?? {})
    },
    log: `# ${s.slug}\n\n## Log\n${s.log ?? ''}`
  }
}

function stateOf(
  records: RecordSpec[],
  files: Record<string, string | null> = {},
  v3Missions: { file: string }[] = []
): Json {
  return { missions: records.map((r, i) => recordFile(i, r)), v3Missions, unreadable: [], files }
}

/** Grade the good state, then every break against it. */
function expectGraderSound(
  state: Json,
  assertions: Json[],
  breaks: { name: string }[],
  v: Json
): void {
  const good = gradeState(state, assertions, v) as Graded
  const failed = good.results.filter((r) => !r.ok).map((r) => `${r.label} — ${r.detail}`)
  expect(failed, 'the good state passes every assertion').toEqual([])
  expect(breaks.length, 'the scenario carries broken copies').toBeGreaterThan(0)
  for (const brk of breaks) {
    const broken = gradeState(applyBreak(state, brk, v), assertions, v) as Graded
    expect(broken.ok, `break "${brk.name}" is caught`).toBe(false)
  }
}

// ---- the suite as a whole -------------------------------------------------------

const ALL = readdirSync(SCENARIOS)
  .filter((n) => n.endsWith('.json'))
  .map((n) => n.slice(0, -'.json'.length))
  .sort()

/** The scenarios this file grades offline: every one in the directory. */
const COVERED = [
  'attach',
  'cold-start',
  'create-milestones',
  'hand-off',
  'proactive-creates',
  'proactive-none',
  'settle'
]

/** The verbs the v4 fate table removes; no eval agent may call them. */
const REMOVED_VERBS = [
  'mission_link_child',
  'mission_set_end',
  'mission_verify_step',
  'mission_add_check',
  'mission_import_legacy',
  'mission_transfer_owner'
]

const RETIRED_WORDS =
  /campaign|chapter|steward|declaredEnd|fixed-end|fixed-start|stewardVerbs|gateCache|legacyFile|approve-rescope|"probe"|"seed"|"burst"|"spawn"/i

describe('scenarios are v4', () => {
  it('every scenario is graded offline here, and the set is the v4 one', () => {
    expect(ALL).toEqual(COVERED)
  })

  it.each(ALL)('%s says nothing of a campaign, a steward or a v3 door', (name) => {
    expect(rawScenario(name)).not.toMatch(RETIRED_WORDS)
  })

  it.each(ALL)('%s calls only verbs a v4 eval agent may call', (name) => {
    const verbs = new Set(rawScenario(name).match(/mission_[a-z]+(?:_[a-z]+)*/g) ?? [])
    for (const v of verbs) {
      expect(MISSION_VERBS, `${name} names ${v}`).toContain(v)
      expect(REMOVED_VERBS).not.toContain(v)
    }
  })

  it('an eval agent may call exactly the mission_* verbs the catalog ships, less the removed ones', () => {
    const catalog = MCP_TOOLS.map((t) => t.name).filter((n) => n.startsWith('mission_'))
    const expected = catalog.filter((n) => !REMOVED_VERBS.includes(n))
    expect([...MISSION_VERBS].sort()).toEqual([...expected].sort())
    for (const v of MISSION_VERBS) expect(catalog, `${v} is in the catalog`).toContain(v)
  })

  it('the agent module has no campaign or steward verb lists', () => {
    expect(agent).not.toHaveProperty('CAMPAIGN_VERBS')
    expect(agent).not.toHaveProperty('STEWARD_VERBS')
    expect(MISSION_VERBS.join(' ')).not.toMatch(/campaign|steward|rebase|create_session/)
  })

  it('create with milestones, attach, settle and hand-off each have a scenario that calls the verb', () => {
    expect(rawScenario('create-milestones')).toMatch(/mission_create[^"]*milestones/)
    expect(rawScenario('create-milestones')).toContain('mission_add_milestone')
    expect(rawScenario('attach')).toContain('mission_attach')
    expect(rawScenario('settle')).toContain('mission_settle_ac')
    const handOff = loadScenario('hand-off')
    expect(JSON.stringify(handOff.phases)).toContain('hand')
  })

  it('the three proof scenarios carry the names the spec gives them', () => {
    for (const name of ['cold-start', 'proactive-creates', 'proactive-none'])
      expect(ALL, name).toContain(name)
  })

  it('no scenario is skipped', () => {
    for (const name of ALL) expect(loadScenario(name).skip, name).not.toBe(true)
  })

  it('no scenario or grader reads the v3 mission directory for its state', () => {
    expect(missionsDirOf('/x')).toBe('/x/.harnu/missions-v4')
    expect(v3MissionsDirOf('/x')).toBe('/x/.harnu/missions')
  })
})

// ---- create-milestones ----------------------------------------------------------

describe('create-milestones: the plan lands as a v4 record with milestones', () => {
  const sc = loadScenario('create-milestones')
  const good = (): Json =>
    stateOf(
      [
        {
          slug: 'ship-the-notes-export',
          title: 'Ship the notes export',
          doneWhen: 'Notes export writes CSV for every board and the docs page names the flag',
          milestones: [
            { id: 'mls-1', title: 'Writer works', optional: false, waitsFor: null },
            { id: 'mls-2', title: 'Shipped with docs', optional: false, waitsFor: null },
            { id: 'mls-3', title: 'Announced', optional: true, waitsFor: null }
          ],
          steps: [
            { title: 'Write the CSV writer', milestone: 'mls-1' },
            {
              title: 'Add the export flag',
              milestone: 'mls-1',
              acs: [ac(1, 'The flag opens a pull request', { by: 'fact', fact: 'pr-opened' })]
            },
            {
              title: 'Write the docs page',
              milestone: 'mls-2',
              acs: [ac(1, 'The page names the flag', { by: 'operator' })]
            },
            { title: 'Announce the export', milestone: 'mls-3' }
          ],
          links: [{ kind: 'url', ref: 'https://example.com/notes-export' }],
          log: `### ${AT} · decision · stp-1\nUse CSV, not XLSX.\n`
        }
      ],
      {}
    )

  it('passes on the planned record and catches every break', () => {
    expectGraderSound(good(), sc.assert, sc.breaks, vars())
  })

  it('does not pass on a v3 mission (no schemaVersion, a fixed end)', () => {
    const state = good() as { missions: { data: Json }[] }
    state.missions[0].data.schemaVersion = 3
    delete state.missions[0].data.milestones
    expect((gradeState(state, sc.assert, vars()) as Graded).ok).toBe(false)
  })

  it('the scripted prompt makes the exact calls and never names a campaign', () => {
    const prompt = String((sc.phases.find((p) => p.agent) as Json).prompt)
    expect(prompt).toContain('mission_create')
    expect(prompt).toContain('mission_add_milestone')
    expect(prompt).toContain('mission_add_step')
    expect(prompt).toContain('mission_log')
    expect(prompt).toContain('mission_link')
  })
})

// ---- attach ---------------------------------------------------------------------

describe('attach: a session asks to join and is never attached by itself', () => {
  const sc = loadScenario('attach')
  const v = vars({ m: { 'notes-export': { id: 'mnt-0000abc0' } } })
  const good = (): Json =>
    stateOf([
      {
        slug: 'notes-export',
        title: 'Notes export',
        steps: [{ title: 'Write the CSV writer' }],
        data: {
          attachRequests: [
            {
              id: 'atr-1',
              missionId: 'mnt-0000abc0',
              sessionId: B,
              at: AT,
              decision: null
            }
          ]
        }
      }
    ])

  it('seeds one mission led by A, and runs agent B', () => {
    const seed = sc.phases.find((p) => p.seedV4) as Json
    expect(seed).toBeDefined()
    expect(sc.agents).toEqual(['A', 'B'])
    expect(sc.phases.some((p) => p.agent === 'B')).toBe(true)
  })

  it('passes on one pending request and catches every break', () => {
    expectGraderSound(good(), sc.assert, sc.breaks, v)
  })

  it('does not pass when the session was attached without the operator', () => {
    const state = good() as { missions: { data: { sessions: Json[] } }[] }
    state.missions[0].data.sessions.push({ id: B, role: 'worked', from: AT, to: null })
    expect((gradeState(state, sc.assert, v) as Graded).ok).toBe(false)
  })
})

// ---- settle ---------------------------------------------------------------------

describe('settle: another session settles, the builder only self-checks', () => {
  const sc = loadScenario('settle')
  const v = vars({ m: { 'notes-export': { id: 'mnt-0000abc0' } } })
  const good = (): Json =>
    stateOf([
      {
        slug: 'notes-export',
        title: 'Notes export',
        sessions: [
          { id: A, role: 'leads', from: AT, to: null },
          { id: B, role: 'worked', from: AT, to: null }
        ],
        steps: [
          {
            title: 'Write the CSV writer',
            startedAt: AT,
            links: [{ kind: 'session', ref: A }],
            acs: [
              ac(1, 'The writer emits one row per board', {
                settled: { at: AT, by: B, evidence: 'Ran it on two boards: two rows each.' }
              }),
              ac(2, 'The writer rejects an empty board', {
                selfCheck: { at: AT, by: A, evidence: 'Ran it: an empty board is rejected.' }
              }),
              ac(3, 'The flag text reads well', { by: 'operator' })
            ]
          }
        ]
      }
    ])

  it('seeds a step built by A with three criteria, and runs B then A', () => {
    const seed = JSON.stringify(sc.phases.find((p) => p.seedV4))
    expect(seed).toContain('"kind":"session"')
    const order = sc.phases.filter((p) => p.agent).map((p) => p.agent)
    expect(order).toEqual(['B', 'A'])
  })

  it('passes on settled / self-check / untouched and catches every break', () => {
    expectGraderSound(good(), sc.assert, sc.breaks, v)
  })

  it('does not pass when the builder settled its own criterion', () => {
    const state = good() as { missions: { data: { steps: { acs: Json[] }[] } }[] }
    state.missions[0].data.steps[0].acs[1] = ac(2, 'The writer rejects an empty board', {
      settled: { at: AT, by: A, evidence: 'mine' }
    })
    expect((gradeState(state, sc.assert, v) as Graded).ok).toBe(false)
  })
})

// ---- hand-off -------------------------------------------------------------------

describe('hand-off: the leader asks the operator and never switches itself', () => {
  const sc = loadScenario('hand-off')
  const v = vars({ m: { _only: { id: 'mnt-0000abc0' } } })
  const good = (): Json =>
    stateOf([
      {
        slug: 'notes-export',
        title: 'Notes export',
        steps: [{ title: 'Write the CSV writer' }, { title: 'Write the docs page' }],
        log: `### ${AT} · note\nThe leader is near its context limit and asked the operator for a hand-off.\n\n### ${AT} · note\nEVAL-TURN[handoff] asked=true tools=Read,mission_get,mission_log\n`
      }
    ])

  it('passes on a leader that asked and stayed, and catches every break', () => {
    expectGraderSound(good(), sc.assert, sc.breaks, v)
  })

  it('does not pass when the leader attached itself or created a second mission', () => {
    const state = good() as { missions: { data: Json; log: string }[] }
    state.missions[0].log += `\n### ${AT} · note\nEVAL-TURN[handoff] asked=true tools=Read,mission_attach\n`
    expect((gradeState(state, sc.assert, v) as Graded).ok).toBe(false)
  })

  it('never names the verbs it grades in the prompt', () => {
    const prompts = sc.phases.filter((p) => p.agent).map((p) => String(p.prompt))
    for (const p of prompts) expect(p).not.toMatch(/mission_(attach|log|create)/)
  })
})

// ---- proactive-creates ----------------------------------------------------------

describe('proactive-creates: multi-step work makes the session create the mission first', () => {
  const sc = loadScenario('proactive-creates')
  const v = vars()
  const good = (): Json =>
    stateOf(
      [
        {
          slug: 'notes-export',
          title: 'Notes export',
          steps: [
            { title: 'Write the CSV writer' },
            { title: 'Add the export flag' },
            { title: 'Write the docs page' }
          ],
          log: `### ${AT} · note\nEVAL-TURN[proactive] asked=false tools=Read,Read,mission_create,Write,Write\n`
        }
      ],
      {
        '.eval/turn-proactive.txt':
          'tools=Read,Read,mission_create,Write,Write\nasked=false\n---\nCreated the mission and started the CSV writer.\n'
      }
    )

  it('uses the neutral session role with the mission skill copied in, no orchestration frame', () => {
    const turn = sc.phases.find((p) => p.agent) as Json
    expect(turn.role).toBe('session')
    expect(JSON.stringify(sc.phases)).toContain('resources/skills/skills/mission/SKILL.md')
    expect(String(turn.prompt).replaceAll('.eval/mission/SKILL.md', '')).not.toMatch(
      /mission|milestone|criteri/i
    )
  })

  it('passes on a created mission, before any Write, with no question', () => {
    expectGraderSound(good(), sc.assert, sc.breaks, v)
  })

  it('does not pass when the work started before the mission', () => {
    const files = {
      '.eval/turn-proactive.txt': 'tools=Read,Write,mission_create\nasked=false\n---\nok\n'
    }
    const state = good() as { files: Json; missions: { log: string }[] }
    state.files = files
    state.missions[0].log = state.missions[0].log.replace(
      'Read,Read,mission_create,Write,Write',
      'Read,Write,mission_create'
    )
    expect((gradeState(state, sc.assert, v) as Graded).ok).toBe(false)
  })

  it('does not pass when the session asked first and created nothing', () => {
    const state = stateOf([], {
      '.eval/turn-proactive.txt': 'tools=Read,Read\nasked=true\n---\nShall I start?\n'
    })
    expect((gradeState(state, sc.assert, v) as Graded).ok).toBe(false)
  })

  it('a question after the mission exists is fine: AC-79 rules out asking FIRST', () => {
    const state = good() as { files: Json }
    state.files = {
      '.eval/turn-proactive.txt':
        'tools=Read,mission_list,mission_create,Write\nasked=true\n---\nStarted. Want tests too?\n'
    }
    expect((gradeState(state, sc.assert, v) as Graded).ok).toBe(true)
  })
})

// ---- proactive-none -------------------------------------------------------------

describe('proactive-none: a one-line question creates no mission', () => {
  const sc = loadScenario('proactive-none')
  const v = vars()
  const good = (): Json =>
    stateOf([], {
      '.eval/turn-question.txt': 'tools=Read,Read\nasked=false\n---\nThe codename is Kestrel-7.\n'
    })

  it('passes on an answered question with no mission, and catches every break', () => {
    expectGraderSound(good(), sc.assert, sc.breaks, v)
  })

  it('is not vacuous: a session that never answered does not pass', () => {
    const state = good() as { files: Json }
    state.files = { '.eval/turn-question.txt': 'tools=\nasked=false\n---\n(no result event)\n' }
    expect((gradeState(state, sc.assert, v) as Graded).ok).toBe(false)
  })

  it('does not pass when a v3 mission file appeared', () => {
    const state = good() as { v3Missions: Json[] }
    state.v3Missions = [{ file: 'mnt-0000abc0-x.md' }]
    expect((gradeState(state, sc.assert, v) as Graded).ok).toBe(false)
  })
})

// ---- cold-start -----------------------------------------------------------------

describe('cold-start: a fresh session answers five questions from the summary alone', () => {
  const sc = loadScenario('cold-start')
  const v = vars()
  const answers = [
    '1. Ship the Aurora export: a CSV export for every board, with a docs page naming the flag.',
    '2. Mark done the docs page criterion: the page names the flag.',
    '3. Add the export flag is blocked on the staging API key from Ops.',
    '4. Write the docs page waits for review.',
    '5. Use CSV, not XLSX, so no new dependency is needed.'
  ].join('\n')
  const good = (): Json =>
    stateOf([], {
      '.eval/turn-cold.txt': `tools=\nasked=false\n---\n${answers}\n`
    })

  it('passes on the five answers and catches every break', () => {
    expectGraderSound(good(), sc.assert, sc.breaks, v)
  })

  it('the cold agent has no Harnu verb and gets the summary in its prompt', () => {
    const turn = sc.phases.find((p) => p.agent) as Json
    expect(turn.role).toBe('cold')
    expect(String(turn.prompt)).toContain('{{summary.main}}')
    expect(sc.phases.some((p) => p.summary)).toBe(true)
  })

  it('does not pass when one line answers all five', () => {
    const state = good() as { files: Json }
    const one = '1. Aurora staging API key docs page names the flag CSV XLSX'
    state.files = {
      '.eval/turn-cold.txt': `tools=\nasked=false\n---\n${[1, 2, 3, 4, 5].map((n) => one.replace('1.', `${n}.`)).join('\n')}\n`
    }
    expect((gradeState(state, sc.assert, v) as Graded).ok).toBe(false)
  })

  it('the seeded record gives a summary that holds every answer, each in its own part', () => {
    const seedPhase = sc.phases.find((p) => p.seedV4) as { seedV4: Json }
    const dir = mkdtempSync(path.join(os.tmpdir(), 'v4-cold-'))
    tmpDirs.push(dir)
    const spec = JSON.parse(JSON.stringify(seedPhase.seedV4).replaceAll('{{session.A}}', A))
    const seeded = seedV4Record(dir, spec) as { file: string }
    const raw = readFileSync(seeded.file, 'utf8')
    const record = parseMissionRecordFile(raw)
    expect('error' in record, JSON.stringify(record)).toBe(false)
    const text = buildMissionSummary(record as MissionV4, readMissionRecordLog(raw)).text
    const part = (heading: string): string =>
      text.split(/^## /m).find((p) => p.startsWith(heading)) ?? ''
    expect(part('Goal')).toContain('Aurora')
    expect(part('Next step')).toMatch(/names the flag/)
    expect(part('Where it is')).toContain('staging API key')
    expect(part('Where it is')).toMatch(/Waiting for review:\n- "Write the docs page"/)
    expect(part('Decided')).toMatch(/CSV.*XLSX/)
    // The tokens that tell the answers apart sit in their own part, not in the others.
    expect(part('Goal')).not.toContain('staging')
    expect(part('Decided')).not.toContain('staging')
    expect(part('Next step')).not.toContain('XLSX')
  })
})

// ---- the grader reads v4 records ------------------------------------------------

const tmpDirs: string[] = []
afterAll(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true })
})

function sandbox(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'v4-eval-'))
  tmpDirs.push(dir)
  return dir
}

const FIXTURE_DIR = path.join(FIXTURES, 'v4')
/** Stored with a `.fixture` suffix so prettier leaves the bytes the product wrote alone. */
const FIXTURE_FILE = 'mnt-5a1c0de4-notes-export.md'

describe('the grader reads .harnu/missions-v4/, on a recorded v4 record', () => {
  const fixtureRaw = (): string =>
    readFileSync(path.join(FIXTURE_DIR, `${FIXTURE_FILE}.fixture`), 'utf8')

  /** A sandbox whose v4 directory holds the recorded fixture, as a run leaves it. */
  function withFixture(edit: (raw: string) => string = (r) => r): string {
    const dir = sandbox()
    mkdirSync(missionsDirOf(dir), { recursive: true })
    writeFileSync(path.join(missionsDirOf(dir), FIXTURE_FILE), edit(fixtureRaw()))
    return dir
  }

  const assertions: Json[] = [
    { missionCount: 1 },
    { legacyMissionCount: 0 },
    { mission: 'notes-export', path: 'schemaVersion', equals: 4 },
    { mission: 'notes-export', path: 'milestones', length: 2 },
    { mission: 'notes-export', step: 'id:stp-1', path: 'acs.0.settled.by', equals: B },
    { mission: 'notes-export', step: 'id:stp-1', path: 'acs.1.selfCheck.by', equals: A },
    { mission: 'notes-export', anyCriterion: { settled: { by: A } }, present: false },
    { mission: '*', logContains: '· decision · stp-1' }
  ]

  it('the fixture is what the product writes: it parses, and rebuilds byte for byte', () => {
    const raw = fixtureRaw()
    const record = parseMissionRecordFile(raw)
    expect('error' in record, JSON.stringify(record)).toBe(false)
    expect(buildMissionRecordContent(record as MissionV4, readMissionRecordLog(raw))).toBe(raw)
  })

  it('accepts the recorded good run', () => {
    const graded = gradeFolder(withFixture(), assertions, vars()) as Graded
    expect(graded.results.filter((r) => !r.ok)).toEqual([])
  })

  it('takes the slug from the file name, and keeps v3 files out of the missions', () => {
    const dir = withFixture()
    mkdirSync(v3MissionsDirOf(dir), { recursive: true })
    writeFileSync(path.join(v3MissionsDirOf(dir), 'mnt-0badc0de-old.md'), '---\nid: x\n---\n')
    const state = loadMissionState(dir) as {
      missions: { slug: string }[]
      v3Missions: { file: string }[]
    }
    expect(state.missions.map((m) => m.slug)).toEqual(['notes-export'])
    expect(state.v3Missions.map((m) => m.file)).toEqual(['mnt-0badc0de-old.md'])
  })

  it('rejects a planted fault: the builder settles its own criterion', () => {
    // Criterion 1 ends up settled by A, the session that built the step, instead of by B.
    const faulty = withFixture((raw) => raw.replaceAll(B, A))
    const graded = gradeFolder(faulty, assertions, vars()) as Graded
    expect(graded.ok).toBe(false)
    const failed = graded.results.filter((r) => !r.ok).map((r) => r.label)
    expect(failed.join('\n')).toContain('settled')
  })

  it('rejects a planted fault: the record lost its milestones', () => {
    const faulty = withFixture((raw) =>
      raw.replace(/milestones:\n(?: {2}.*\n)+/, 'milestones: []\n')
    )
    expect((gradeFolder(faulty, assertions, vars()) as Graded).ok).toBe(false)
  })

  it('a record with no frontmatter fails the grade on its own', () => {
    const faulty = withFixture(() => 'not a record\n')
    const graded = gradeFolder(faulty, [], vars()) as Graded
    expect(graded.ok).toBe(false)
    expect(graded.results[0].label).toBe('every mission file parses')
  })

  it('a v3-shaped file in the v4 directory is not a record the grader accepts as v4', () => {
    const dir = sandbox()
    mkdirSync(missionsDirOf(dir), { recursive: true })
    writeFileSync(
      path.join(missionsDirOf(dir), 'mnt-0badc0de-old.md'),
      '---\nid: mnt-0badc0de\nslug: old\nstatus: active\n---\n'
    )
    const graded = gradeFolder(
      dir,
      [{ mission: 'old', path: 'schemaVersion', equals: 4 }],
      vars()
    ) as Graded
    expect(graded.ok).toBe(false)
  })
})

// ---- the harness's own seeding, framing and records -----------------------------

describe('seedV4Record writes a record the product reads', () => {
  it('numbers criteria, defaults a session criterion, and writes the Log in the verbs’ format', () => {
    const dir = sandbox()
    const seeded = seedV4Record(dir, {
      slug: 'notes-export',
      title: 'Notes export',
      doneWhen: 'It exports',
      milestones: [{ title: 'Writer works' }],
      steps: [
        {
          title: 'Write the CSV writer',
          milestone: 'mls-1',
          acs: [{ text: 'It writes rows' }, { text: 'It rejects empty', by: 'operator' }]
        }
      ],
      sessions: [{ id: A, role: 'leads' }],
      log: [{ kind: 'decision', stepId: 'stp-1', note: 'Use CSV.' }]
    }) as { id: string; file: string }
    expect(seeded.id).toMatch(/^mnt-[0-9a-f]{8}$/)
    expect(path.basename(seeded.file)).toBe(`${seeded.id}-notes-export.md`)
    const raw = readFileSync(seeded.file, 'utf8')
    const record = parseMissionRecordFile(raw) as MissionV4
    expect(record.steps[0].acs.map((c) => [c.id, c.by])).toEqual([
      ['ac-1', 'session'],
      ['ac-2', 'operator']
    ])
    expect(record.milestones[0]).toMatchObject({ id: 'mls-1', title: 'Writer works' })
    expect(record.sessions[0]).toMatchObject({ id: A, role: 'leads', to: null })
    expect(readMissionRecordLog(raw)).toMatch(/### \S+ · decision · stp-1\nUse CSV\./)
    const state = loadMissionState(dir) as { missions: { slug: string }[]; unreadable: string[] }
    expect(state.unreadable).toEqual([])
    expect(state.missions.map((m) => m.slug)).toEqual(['notes-export'])
  })

  it('two seeds never collide on an id', () => {
    const dir = sandbox()
    const ids = new Set<string>()
    for (let i = 0; i < 20; i++)
      ids.add(
        (
          seedV4Record(dir, { slug: `m${i}`, title: 't', doneWhen: 'd', steps: [] }) as {
            id: string
          }
        ).id
      )
    expect(ids.size).toBe(20)
  })
})

describe('the agent turn: framing, arguments and the turn record', () => {
  const base = {
    sessionId: A,
    folder: '/tmp/eval',
    prompt: 'Do the thing.',
    mcpConfigPath: '/tmp/harnu.mcp.json',
    model: 'sonnet'
  }
  const flag = (args: string[], name: string): string | undefined => args[args.indexOf(name) + 1]

  it('a cold turn has no MCP server, no verb allowance, no built-in tool and a short cap', () => {
    const args = buildAgentArgs({ ...base, role: 'cold' }) as string[]
    expect(args).not.toContain('--mcp-config')
    expect(args).toContain('--strict-mcp-config')
    expect(args).not.toContain('--allowedTools')
    expect(flag(args, '--tools')).toBe('')
    expect(Number(flag(args, '--max-turns'))).toBeLessThanOrEqual(4)
    expect(args.join(' ')).not.toContain('mcp__harnu__')
    expect(args[args.length - 1]).toContain('Do the thing.')
  })

  it('a session turn lists every v4 verb and never the removed ones', () => {
    const args = buildAgentArgs({ ...base, role: 'session', tools: ['Read'] }) as string[]
    const allowed = String(flag(args, '--allowedTools')).split(',')
    expect(allowed).toContain('Read')
    expect(allowed).toContain('mcp__harnu__mission_settle_ac')
    for (const v of REMOVED_VERBS) expect(allowed).not.toContain(`mcp__harnu__${v}`)
    expect(flag(args, '--tools')).toBe('Read')
  })

  it('a scripted turn keeps its frame, and an owner turn the longer cap', () => {
    const scripted = buildAgentArgs({ ...base, role: 'scripted' }) as string[]
    expect(scripted[scripted.length - 1]).toContain('scripted test agent')
    const owner = buildAgentArgs({ ...base, role: 'owner' }) as string[]
    expect(Number(flag(owner, '--max-turns'))).toBeGreaterThan(
      Number(flag(scripted, '--max-turns'))
    )
  })

  it('the frames never mention a campaign, a steward or an orchestration the session did not start', () => {
    const session = sessionFrame(A, '/tmp/eval', 'body', ['Read']) as string
    const cold = coldFrame('body') as string
    for (const f of [session, cold]) expect(f).not.toMatch(/campaign|steward|orchestrat/i)
    expect(session).toContain(A)
    expect(session).toContain('folder="/tmp/eval"')
    expect(cold).toMatch(/no memory/i)
  })

  it('records the turn as tools, asked and the reply, one block per file', () => {
    const text = turnRecord({
      toolCalls: ['Read', 'mission_create'],
      result: 'Created it. Shall I start?'
    }) as string
    expect(text).toBe('tools=Read,mission_create\nasked=true\n---\nCreated it. Shall I start?\n')
    expect(turnRecord({ toolCalls: [], result: 'Fine.' })).toBe('tools=\nasked=false\n---\nFine.\n')
    expect(replyAsks('What?')).toBe(true)
  })
})

describe('grader operators added for v4', () => {
  const state = {
    missions: [
      {
        file: 'mnt-0000abc0-m.md',
        slug: 'm',
        data: {
          steps: [
            {
              id: 'stp-1',
              title: 'One',
              acs: [{ id: 'ac-1', settled: { by: B } }, { id: 'ac-2' }]
            },
            { id: 'stp-2', title: 'Two', acs: [{ id: 'ac-1' }] }
          ]
        },
        log: '### t\nEVAL-TURN[x] asked=false tools=Read,mission_create,Write\n'
      }
    ],
    v3Missions: [],
    unreadable: [],
    files: { 'a.txt': 'tools=Read\nasked=false\n---\nHello World\n' }
  }
  const ok = (a: Json): boolean => (evaluate(state, a) as { ok: boolean }).ok

  it('step selectors: id, index and title', () => {
    expect(ok({ mission: 'm', step: 'id:stp-2', path: 'title', equals: 'Two' })).toBe(true)
    expect(ok({ mission: 'm', step: 'index:0', path: 'title', equals: 'One' })).toBe(true)
    expect(ok({ mission: 'm', step: 'title:Two', path: 'id', equals: 'stp-2' })).toBe(true)
    expect(ok({ mission: 'm', step: 'id:stp-9', path: 'id', exists: true })).toBe(false)
  })

  it('criterion assertions count across steps', () => {
    expect(ok({ mission: 'm', anyCriterion: { settled: { by: B } } })).toBe(true)
    expect(ok({ mission: 'm', anyCriterion: { settled: { by: A } } })).toBe(false)
    expect(ok({ mission: 'm', criterionCount: { settled: { $exists: true } }, equals: 1 })).toBe(
      true
    )
  })

  it('logLine matches and notMatches take a regex', () => {
    const line = 'EVAL-TURN[x]'
    expect(ok({ mission: 'm', logLine: line, matches: 'tools=(Read,)*mission_create' })).toBe(true)
    expect(ok({ mission: 'm', logLine: line, matches: 'tools=(Read,)*Write' })).toBe(false)
    expect(ok({ mission: 'm', logLine: line, notMatches: 'tools=.*mission_attach' })).toBe(true)
    expect(ok({ mission: 'm', logLine: line, notMatches: 'Write$' })).toBe(false)
  })

  it('file contains, notContains and matches (with flags)', () => {
    expect(ok({ file: 'a.txt', contains: 'Hello World' })).toBe(true)
    expect(ok({ file: 'a.txt', notContains: 'mission_' })).toBe(true)
    expect(ok({ file: 'a.txt', matches: '^tools=Read$', flags: 'm' })).toBe(true)
    expect(ok({ file: 'a.txt', matches: 'hello world' })).toBe(false)
    expect(ok({ file: 'a.txt', matches: 'hello world', flags: 'i' })).toBe(true)
  })

  it('legacyMissionCount counts v3 files and missionCount only v4 ones', () => {
    expect(ok({ missionCount: 1 })).toBe(true)
    expect(ok({ legacyMissionCount: 0 })).toBe(true)
    expect(
      (
        evaluate({ ...state, v3Missions: [{ file: 'x' }] }, { legacyMissionCount: 0 }) as {
          ok: boolean
        }
      ).ok
    ).toBe(false)
  })
})
