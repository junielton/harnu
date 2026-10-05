/**
 * Mission behavior-eval scenarios, graded OFFLINE (T377 Mission v2 S4, extended to
 * every scenario by T385 Mission v3 S4).
 *
 * `npm run eval:mission` drives real `claude -p` sessions, so it runs once per
 * slice, not per edit. This suite is what keeps the graders honest in between:
 * for EVERY scenario it builds, by hand, the mission state a correct run leaves
 * on disk, and checks that
 *
 *  - the scenario's assertions PASS on it (the grader is satisfiable), and
 *  - every deliberately broken copy (`breaks`) FAILS (the grader is not vacuous),
 *
 * with the harness's own `gradeState` / `applyBreak` — the same code the live
 * run grades with. A checkpoint is graded the same way against its own state.
 *
 * The states are Mission v3 shaped (spec `docs/specs/2026-10-01-mission-v3/`):
 * born `active` with `declaredEndApproval.via: 'chat'`, no fixed start, scope as
 * an attachment, checks on steps. Only the stall scenario's seeded legacy draft
 * keeps the pre-v3 shape, because that is what it exercises.
 */
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, it, expect } from 'vitest'

import { applyBreak, gradeState } from '../scripts/eval/mission-behavior/grade.mjs'
import { MISSION_VERBS, replyAsks } from '../scripts/eval/mission-behavior/agent.mjs'
import { MCP_TOOLS } from '../src/main/mcp/tool-catalog'

const REPO_ROOT = path.resolve(import.meta.dirname, '..')
const SCENARIOS = path.join(REPO_ROOT, 'scripts', 'eval', 'mission-behavior', 'scenarios')

type Json = Record<string, unknown>
interface Scenario {
  name: string
  skip?: boolean
  phases: Json[]
  assert: Json[]
  breaks: { name: string }[]
}
interface Checkpoint {
  checkpoint: string
  assert: Json[]
  breaks: { name: string }[]
}
interface Graded {
  ok: boolean
  results: { ok: boolean; label: string; detail: string }[]
}

function loadScenario(name: string): Scenario {
  return JSON.parse(readFileSync(path.join(SCENARIOS, `${name}.json`), 'utf8'))
}

function checkpointOf(sc: Scenario, name: string): Checkpoint {
  const cp = sc.phases.find((p) => p.checkpoint === name)
  expect(cp, `checkpoint "${name}"`).toBeDefined()
  return cp as unknown as Checkpoint
}

const A = '11111111-1111-4111-8111-111111111111'
const B = '22222222-2222-4222-8222-222222222222'
const C = '33333333-3333-4333-8333-333333333333'
const D = '44444444-4444-4444-8444-444444444444'
const AT = '2026-09-29T12:00:00.000Z'
const OLD_AT = '2026-09-29T09:00:00.000Z'

const sha256 = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex')

function vars(slugs: string[], extra: Json = {}): Json {
  return {
    folder: '/tmp/eval',
    session: { A, B, C, D },
    m: Object.fromEntries(slugs.map((s, i) => [s, { id: `mnt-0000abc${i}` }])),
    seeded: {},
    legacy: {},
    ...extra
  }
}

interface StepSpec {
  kind: 'fixed-start' | 'custom' | 'fixed-end'
  title: string
  verification: string
  proof?: string
  links?: { kind: string; ref: string }[]
  blockers?: Json[]
  verifiedBy?: Json
  checks?: Json[]
  addedReason?: string
}

function step(n: number, s: StepSpec): Json {
  return {
    id: `stp-${n}`,
    ordinal: n,
    kind: s.kind,
    title: s.title,
    verification: s.verification,
    proof: s.proof ?? 'unproven',
    links: s.links ?? [],
    blockers: s.blockers ?? [],
    ...(s.verifiedBy ? { verifiedBy: s.verifiedBy } : {}),
    ...(s.checks ? { checks: s.checks } : {}),
    ...(s.addedReason ? { addedReason: s.addedReason } : {})
  }
}

interface MissionSpec {
  slug: string
  data?: Json
  steps: StepSpec[]
  log?: string
}

/** One v3 mission file: born active, the end agreed in chat. */
function missionFile(i: number, { slug, data = {}, steps, log = '' }: MissionSpec): Json {
  return {
    file: `mnt-0000abc${i}-${slug}.md`,
    data: {
      id: `mnt-0000abc${i}`,
      slug,
      status: 'active',
      owner: { sessionId: A, folder: '/tmp/eval' },
      declaredEnd: { kind: 'code', target: 'x', evidence: 'y' },
      declaredEndApproval: { at: AT, bodyHash: 'sha256:0', via: 'chat' },
      blockers: [],
      createdAt: AT,
      updatedAt: AT,
      ...data,
      steps: steps.map((s, k) => step(k + 1, s))
    },
    log: `# ${slug}\n\n## Log\n${log}`
  }
}

function stateOf(missions: MissionSpec[], files: Record<string, string | null> = {}): Json {
  return { missions: missions.map((m, i) => missionFile(i, m)), unreadable: [], files }
}

const end = (extra: Partial<StepSpec> = {}): StepSpec => ({
  kind: 'fixed-end',
  title: 'Delivered and verified',
  verification: 'verifier',
  ...extra
})
const unit = (title: string, extra: Partial<StepSpec> = {}): StepSpec => ({
  kind: 'custom',
  title,
  verification: 'verifier',
  ...extra
})

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

// ---- the suite as a whole ------------------------------------------------------

const ALL = readdirSync(SCENARIOS)
  .filter((n) => n.endsWith('.json'))
  .map((n) => n.slice(0, -'.json'.length))
  .sort()

/** The scenarios this file grades offline — every one in the directory. */
const COVERED = [
  'close-end-to-end',
  'concurrent-writes',
  'end-before-dispatch',
  'happy-path',
  'mcp-withholding',
  'migration-nonstandard',
  'operator-wait',
  'rescope-voids-proof',
  'rule-change',
  'self-verification',
  'signoff-as-check',
  'stall-detection'
]

describe('the scenario set (Mission v3 §3.11, AC-11)', () => {
  it('every scenario is graded offline here', () => {
    expect(ALL).toEqual(COVERED)
  })

  it.each(ALL)('%s carries no v2 draft / approval / fixed-start / shadow machinery', (name) => {
    const raw = readFileSync(path.join(SCENARIOS, `${name}.json`), 'utf8')
    expect(raw).not.toContain('approve-draft')
    expect(raw).not.toMatch(/"shadow"|goalOf|m\.[a-z-]+\.start\b/)
    expect(raw).not.toMatch(/clicked Approve|Approve in the Topbar/)
    // A fixed start survives only as a seeded LEGACY file (stall-detection) or as
    // what an import must NOT write (migration-nonstandard).
    if (!['stall-detection', 'migration-nonstandard', 'end-before-dispatch'].includes(name)) {
      expect(raw).not.toContain('fixed-start')
    }
  })

  it('an eval agent may call every mission_* verb the catalog ships', () => {
    // A verb missing here is refused by `claude` itself, so an owner turn that
    // picks it fails as a harness artifact, not as the model's choice.
    const catalog = MCP_TOOLS.map((t) => t.name).filter((n) => n.startsWith('mission_'))
    expect([...MISSION_VERBS].sort()).toEqual([...catalog].sort())
  })

  it('the shadow dual-write scenario is retired (closes T371)', () => {
    expect(ALL).not.toContain('shadow-dual-write')
  })
})

// ---- scripted-call scenarios ------------------------------------------------------

describe('happy-path — create, link, add a step once started, verify, request close', () => {
  const sc = loadScenario('happy-path')

  it('links the child BEFORE adding the step, so the reason is required and stored', () => {
    const second = sc.phases.filter((p) => p.agent === 'A')[1].prompt as string
    expect(second.indexOf('mission_link_child')).toBeLessThan(second.indexOf('mission_add_step'))
  })

  it('passes on the delivered state and catches every break', () => {
    const state = stateOf([
      {
        slug: 'happy-path',
        data: { status: 'delivered', pendingClose: { at: AT, requestedBy: A } },
        steps: [
          unit('Write the unit test', { addedReason: 'the declared end cites a unit test' }),
          end({
            proof: 'verified',
            links: [{ kind: 'session', ref: C }],
            verifiedBy: { sessionId: B, verdict: 'met', at: AT }
          })
        ],
        log: '\n### t · verify\nEVAL-HAPPY-EVIDENCE: ran the test, it passes\n'
      }
    ])
    expectGraderSound(state, sc.assert, sc.breaks, vars(['happy-path']))
  })
})

describe('self-verification — verified vs self-verified, never refused', () => {
  const sc = loadScenario('self-verification')

  it('passes on the labelled state and catches every break', () => {
    const state = stateOf([
      {
        slug: 'self-verification',
        data: { declaredEnd: { kind: 'research', target: 'a', evidence: 'b' } },
        steps: [
          unit('Unlinked check', {
            proof: 'self-verified',
            verifiedBy: { sessionId: B, verdict: 'met', at: AT }
          }),
          unit('Check built by C', {
            proof: 'verified',
            links: [{ kind: 'session', ref: C }],
            verifiedBy: { sessionId: B, verdict: 'met', at: AT }
          }),
          end({
            proof: 'self-verified',
            links: [{ kind: 'session', ref: A }],
            verifiedBy: { sessionId: A, verdict: 'met', at: AT }
          })
        ],
        log: '\nEVAL-SELF-END\nEVAL-SELF-UNLINKED\nEVAL-SELF-INDEPENDENT\n'
      }
    ])
    expectGraderSound(state, sc.assert, sc.breaks, vars(['self-verification']))
  })
})

describe('concurrent-writes — every overlapping write lands', () => {
  const sc = loadScenario('concurrent-writes')

  it('passes with all 15 links and 11 markers, and catches every break', () => {
    const cards = [
      ...['p', 'q', 'r'].flatMap((x) => [1, 2, 3].map((n) => `race-${x}-${n}`)),
      ...[1, 2, 3, 4, 5, 6].map((n) => `burst-${n}`)
    ]
    const log = [
      'EVAL-RACE-AGENT-P',
      'EVAL-RACE-AGENT-Q',
      'EVAL-RACE-AGENT-R',
      ...[1, 2, 3, 4, 5, 6, 7, 8].map((n) => `EVAL-RACE-BURST-${n}.`)
    ].join('\n')
    const state = stateOf([
      {
        slug: 'concurrent-writes',
        steps: [end({ links: cards.map((ref) => ({ kind: 'card', ref })) })],
        log: `\n${log}\n`
      }
    ])
    expectGraderSound(state, sc.assert, sc.breaks, vars(['concurrent-writes']))
  })
})

describe('mcp-withholding — an agentControlled child holds no mission verbs', () => {
  const sc = loadScenario('mcp-withholding')

  it('passes on the positive control only, and catches every break', () => {
    const state = stateOf([
      { slug: 'withholding', steps: [end()], log: '\nEVAL-MANIFEST-CHILD-WROTE\n' }
    ])
    expectGraderSound(state, sc.assert, sc.breaks, vars(['withholding']))
  })
})

describe('migration-nonstandard — imports land in the v3 shape and lose nothing', () => {
  const sc = loadScenario('migration-nonstandard')
  const unrecognized = 'Field notes, no recognized heading.\n\tkept as is'
  // ASCII on purpose: `{ file, sha256 }` hashes a file's latin1 bytes, `legacyRaw` its UTF-8.
  const partial = '# Wave 2 - ProjectAlpha importer\n\n## Objective\n...'
  const target =
    'Land the ProjectAlpha importer rewrite as two stacked PRs on org/proj/www, each with green CI, before the Acme demo.'
  const v = vars(['field-notes', 'wave-2-projectalpha-importer'], {
    legacy: {
      unrecognized: {
        sha256: sha256(unrecognized),
        abs: '/tmp/eval/.harnu/goals/c0ffee12-field-notes.md'
      },
      partial: { sha256: sha256(partial), abs: '/tmp/eval/.harnu/goals/wave-2.md' }
    }
  })

  it('passes on two active v3 imports and catches every break', () => {
    const state = stateOf(
      [
        {
          slug: 'field-notes',
          data: {
            declaredEnd: { kind: 'other', target: 'placeholder', evidence: 'placeholder' },
            legacy: {
              source: '/tmp/eval/.harnu/goals/c0ffee12-field-notes.md',
              sha256: `sha256:${sha256(unrecognized)}`,
              needsReview: ['declaredEnd']
            },
            legacyRaw: unrecognized
          },
          steps: [end()]
        },
        {
          slug: 'wave-2-projectalpha-importer',
          data: {
            declaredEnd: { kind: 'code', target, evidence: 'not stated in the legacy goal file' },
            legacy: {
              source: '/tmp/eval/.harnu/goals/wave-2.md',
              sha256: `sha256:${sha256(partial)}`,
              needsReview: ['declaredEnd']
            },
            legacyRaw: partial
          },
          steps: [
            unit('T401-importer-parser', {
              links: [{ kind: 'card', ref: 'T401-importer-parser' }]
            }),
            unit('T402-importer-writer', {
              links: [
                { kind: 'card', ref: 'T402-importer-writer' },
                { kind: 'pr', ref: 'owner/repo#91' },
                { kind: 'session', ref: '5d4c3b2a-1f0e-4d9c-8b7a-6e5f4d3c2b1a' }
              ]
            }),
            end()
          ]
        }
      ],
      {
        '.harnu/goals/c0ffee12-field-notes.md': unrecognized,
        '.harnu/goals/wave-2.md': partial
      }
    )
    expectGraderSound(state, sc.assert, sc.breaks, v)
  })
})

describe('rescope-voids-proof — staging never touches proof; approval voids it', () => {
  const sc = loadScenario('rescope-voids-proof')
  const v = vars(['rescope-verified', 'rescope-self'])
  const oldEnd = { kind: 'code', target: 'EVAL-OLD-TARGET', evidence: 'the old test passes' }
  const newEnd = { kind: 'code', target: 'EVAL-NEW-TARGET', evidence: 'the new test passes' }
  const linkA = [{ kind: 'session', ref: A }]

  it('checkpoint: staged, not applied — catches every break', () => {
    const cp = checkpointOf(sc, 'rescope-staged')
    const state = stateOf([
      {
        slug: 'rescope-verified',
        data: { declaredEnd: oldEnd, pendingRescope: newEnd },
        steps: [
          end({ proof: 'verified', links: linkA, verifiedBy: { sessionId: B, verdict: 'met' } })
        ]
      },
      {
        slug: 'rescope-self',
        data: { declaredEnd: oldEnd, pendingRescope: newEnd },
        steps: [
          end({
            proof: 'self-verified',
            links: linkA,
            verifiedBy: { sessionId: A, verdict: 'met' }
          })
        ]
      }
    ])
    expectGraderSound(state, cp.assert, cp.breaks, v)
  })

  it('final: both ends back to unproven under the new end — catches every break', () => {
    const approved = { declaredEnd: newEnd, declaredEndApproval: { at: AT, bodyHash: 'sha256:1' } }
    const state = stateOf([
      { slug: 'rescope-verified', data: approved, steps: [end({ links: linkA })] },
      { slug: 'rescope-self', data: approved, steps: [end({ links: linkA })] }
    ])
    expectGraderSound(state, sc.assert, sc.breaks, v)
  })
})

describe('stall-detection — stale is derived; a dead legacy draft reads active and stale', () => {
  const sc = loadScenario('stall-detection')

  it('seeds the draft as a LEGACY file and the ledger as active', () => {
    const seed = sc.phases.find((p) => p.seed)?.seed as Json[]
    expect(seed.find((s) => s.slug === 'stall-draft')).toMatchObject({
      status: 'draft',
      legacy: true
    })
    expect(seed.find((s) => s.slug === 'stall-ledger')).toMatchObject({ status: 'active' })
  })

  it('passes on the probed state and catches every break', () => {
    const probes = [
      'EVAL-PROBE[before] stall-recovers stale=true status=active',
      'EVAL-PROBE[after] stall-old stale=true status=active',
      'EVAL-PROBE[after] stall-fresh stale=false status=active',
      'EVAL-PROBE[after] stall-draft stale=true status=active',
      'EVAL-PROBE[after] stall-recovers stale=false status=active'
    ].join('\n')
    const legacyDraft: MissionSpec = {
      slug: 'stall-draft',
      data: { status: 'draft', declaredEndApproval: undefined, updatedAt: OLD_AT },
      steps: [{ kind: 'fixed-start', title: 'Scope confirmed', verification: 'existence' }, end()]
    }
    const state = stateOf([
      {
        slug: 'stall-old',
        data: { updatedAt: OLD_AT },
        steps: [end({ links: [{ kind: 'session', ref: C }] })]
      },
      { slug: 'stall-fresh', steps: [end({ links: [{ kind: 'session', ref: C }] })] },
      legacyDraft,
      { slug: 'stall-recovers', steps: [end()], log: '\nEVAL-STALL-RECOVERED: back on it\n' },
      { slug: 'stall-ledger', steps: [end()], log: `\n${probes}\n` }
    ])
    const v = vars(['stall-old', 'stall-fresh', 'stall-draft', 'stall-recovers', 'stall-ledger'], {
      seeded: { 'stall-old': { updatedAt: OLD_AT }, 'stall-draft': { updatedAt: OLD_AT } }
    })
    expectGraderSound(state, sc.assert, sc.breaks, v)
  })
})

// ---- owner-behavior scenarios ------------------------------------------------------

describe('operator-wait — an operator-owned blocker (v2 AC-9 1)', () => {
  const sc = loadScenario('operator-wait')

  it('lets the owner decide its own calls from the mission skill', () => {
    const owner = sc.phases.find((p) => p.role === 'owner')
    expect(owner?.prompt).toContain('.eval/mission-SKILL.md')
    expect(owner?.prompt).not.toContain('mission_set_blocker')
  })

  it.each([
    ['a mission-level blocker', true],
    ['a step-level blocker', false]
  ])('passes with %s and catches every break', (_, missionLevel) => {
    const blocker = {
      reason: 'PR #1 waits for the operator to merge it',
      unblocks: 'PR #1 is merged',
      owner: 'operator',
      raisedAt: AT
    }
    const state = stateOf([
      {
        slug: 'notes-export',
        data: missionLevel ? { blockers: [blocker] } : {},
        steps: [
          unit('Unit 1 — export command', {
            proof: 'verified',
            links: [{ kind: 'session', ref: C }],
            blockers: missionLevel ? [] : [blocker],
            verifiedBy: { sessionId: B, verdict: 'met', at: AT }
          }),
          end()
        ]
      }
    ])
    expectGraderSound(state, sc.assert, sc.breaks, vars(['notes-export']))
  })
})

describe('rule-change — the owner stages a re-scope (v2 AC-9 2)', () => {
  const sc = loadScenario('rule-change')
  const OLD = 'EVAL-OLD-END: one PR with the report builder, merged into main by the orchestrator'

  it('does not dictate the call', () => {
    const owner = sc.phases.find((p) => p.role === 'owner')
    expect(owner?.prompt).not.toContain('mission_set_end')
  })

  it('passes on a staged re-scope and catches every break', () => {
    const state = stateOf([
      {
        slug: 'report-builder',
        data: {
          declaredEnd: { kind: 'code', target: OLD, evidence: 'green CI and every AC verified' },
          pendingRescope: {
            kind: 'code',
            target: 'a stack of PRs, one per phase, open, green and verified; the operator merges',
            evidence: 'every PR in the stack green and every AC verified'
          }
        },
        steps: [unit('Unit 1 — report builder', { links: [{ kind: 'session', ref: C }] }), end()]
      }
    ])
    expectGraderSound(state, sc.assert, sc.breaks, vars(['report-builder']))
  })
})

describe('close-end-to-end — the owner verifies the end and requests the close (v2 AC-9 3)', () => {
  const sc = loadScenario('close-end-to-end')

  it('does not dictate the end verification or the close', () => {
    const owner = sc.phases.find((p) => p.role === 'owner')
    expect(owner?.prompt).not.toContain('mission_verify_step')
    expect(owner?.prompt).not.toContain('mission_request_close')
  })

  it('passes on delivered + pendingClose and catches every break', () => {
    const state = stateOf([
      {
        slug: 'search-box',
        data: { status: 'delivered', pendingClose: { at: AT, requestedBy: A } },
        steps: [
          unit('Unit 1 — search box', {
            proof: 'verified',
            links: [{ kind: 'session', ref: C }],
            verifiedBy: { sessionId: A, verdict: 'met', at: AT }
          }),
          end({ proof: 'verified', verifiedBy: { sessionId: A, verdict: 'met', at: AT } })
        ]
      }
    ])
    expectGraderSound(state, sc.assert, sc.breaks, vars(['search-box']))
  })
})

describe('end-before-dispatch — plan + scope + question before the first dispatch (v2 AC-9 4, v3)', () => {
  const sc = loadScenario('end-before-dispatch')
  const checkpoint = checkpointOf(sc, 'after-turn-1')
  const scope = [{ kind: 'worktree', ref: 'docs/notes-spec.md' }]
  const units = (linked: boolean): StepSpec[] => [
    unit('Unit 1 — Markdown export', { links: linked ? [{ kind: 'session', ref: C }] : [] }),
    unit('Unit 2 — JSON export', { links: linked ? [{ kind: 'session', ref: D }] : [] })
  ]
  const asked = '\nEVAL-TURN[ask-end] asked=true tools=Read,Read,mission_create\n'

  it('records the turn into whatever mission the owner named, without naming the calls', () => {
    const turn1 = sc.phases.find((p) => p.record)
    expect(turn1?.record).toEqual({ mission: '*', tag: 'ask-end' })
    expect(turn1?.prompt).not.toMatch(/AskUserQuestion|mission_create|scope/)
  })

  it('never tells the owner about an Approve click', () => {
    for (const p of sc.phases) expect(String(p.prompt ?? '')).not.toMatch(/Approve/)
  })

  it('checkpoint: passes when nothing was dispatched yet, catches every break', () => {
    const state = stateOf(
      [{ slug: 'notes-export', data: { scope }, steps: [...units(false), end()], log: asked }],
      { '.eval/dispatch/unit-1.md': null, '.eval/dispatch/unit-2.md': null }
    )
    expectGraderSound(state, checkpoint.assert, checkpoint.breaks, vars(['notes-export']))
  })

  it('final: passes once both units are dispatched and linked, catches every break', () => {
    const state = stateOf(
      [{ slug: 'notes-export', data: { scope }, steps: [...units(true), end()], log: asked }],
      { '.eval/dispatch/unit-1.md': 'packet 1', '.eval/dispatch/unit-2.md': 'packet 2' }
    )
    expectGraderSound(state, sc.assert, sc.breaks, vars(['notes-export']))
  })

  it('`*` never matches when the owner created two missions', () => {
    const one = stateOf([{ slug: 'a', steps: [end()] }]) as { missions: Json[] }
    const two = { ...one, missions: [...one.missions, { ...one.missions[0], file: 'dup.md' }] }
    const g = gradeState(
      two,
      [{ missionCount: 1 }, { mission: '*', path: 'status', equals: 'active' }],
      vars(['a'])
    ) as Graded
    expect(g.results.map((r) => r.ok)).toEqual([false, false])
  })
})

describe('signoff-as-check — a sign-off becomes a check, not a step (v3 AC-11)', () => {
  const sc = loadScenario('signoff-as-check')
  const hero = 'Unit 1 — landing hero section'

  it('declares the plan with mission_create { steps } in the scripted setup', () => {
    const setup = sc.phases.find((p) => p.agent === 'A' && !p.role)
    expect(setup?.prompt).toMatch(/mission_create .*steps=\[/)
  })

  it('never names the graded verb, or the word "check", in the owner prompt', () => {
    const owner = sc.phases.find((p) => p.role === 'owner')
    expect(owner?.prompt).toContain('.eval/mission-SKILL.md')
    expect(owner?.prompt).not.toMatch(/mission_add_check|mission_add_step|\bcheck\b/i)
    expect(owner?.prompt).toMatch(/designer must sign off the hero section/)
  })

  it('passes on an agent check on the unit step, and catches every break', () => {
    const state = stateOf([
      {
        slug: 'landing-hero',
        data: { declaredEnd: { kind: 'ui', target: 'PR #5', evidence: 'green CI' } },
        steps: [
          unit(hero, {
            links: [{ kind: 'session', ref: C }],
            checks: [
              {
                id: 'chk-1',
                label: 'Designer sign-off on the hero section',
                source: 'agent',
                createdAt: AT
              }
            ]
          }),
          end()
        ]
      }
    ])
    expectGraderSound(state, sc.assert, sc.breaks, vars(['landing-hero']))
  })
})

describe('Delta 1 — the tightened graders keep their broken copies', () => {
  const names = (sc: { breaks: { name: string }[] }): string[] => sc.breaks.map((b) => b.name)

  it('end-before-dispatch: unit count, mission_create, tool log — one break each', () => {
    const sc = loadScenario('end-before-dispatch')
    expect(names(checkpointOf(sc, 'after-turn-1'))).toEqual(
      expect.arrayContaining([
        'sub-phase-split-into-a-step',
        'plan-grown-by-add-step',
        'turn-1-called-add-step'
      ])
    )
    expect(names(sc)).toContain('step-added-at-dispatch')
  })

  it('signoff-as-check: the label names the sign-off, any truthy tick is a violation', () => {
    expect(names(loadScenario('signoff-as-check'))).toEqual(
      expect.arrayContaining([
        'check-label-names-nothing',
        'ticked-as-a-boolean',
        'ticked-as-a-date-string',
        'agent-ticked-the-check'
      ])
    )
  })
})

describe('grader value operators', () => {
  const one = (checks: Json[]): Json =>
    stateOf([{ slug: 's', steps: [unit('u', { checks }), end()] }])
  const grade = (state: Json, a: Json): boolean =>
    (gradeState(state, [a], vars(['s'])) as Graded).ok

  it('$truthy treats a boolean, a stamp and a date string alike; false and absent pass', () => {
    const notTicked = {
      mission: 's',
      step: 'custom:0',
      path: 'checks',
      excludes: { ticked: { $truthy: true } }
    }
    for (const ticked of [true, { at: AT }, AT])
      expect(grade(one([{ ticked }]), notTicked)).toBe(false)
    expect(grade(one([{ ticked: false }]), notTicked)).toBe(true)
    expect(grade(one([{ label: 'x' }]), notTicked)).toBe(true)
  })

  it('$match is a case-insensitive regex on strings only', () => {
    const named = {
      mission: 's',
      step: 'custom:0',
      path: 'checks',
      includes: { label: { $match: 'sign|design', $flags: 'i' } }
    }
    expect(grade(one([{ label: 'DESIGNER approves' }]), named)).toBe(true)
    expect(grade(one([{ label: 'Looks good' }]), named)).toBe(false)
    expect(grade(one([{ label: 42 }]), named)).toBe(false)
  })

  it('stepCount counts matching steps; logLine checks every line with the prefix', () => {
    const st = stateOf([
      {
        slug: 's',
        steps: [unit('a'), unit('b', { addedReason: 'r' }), end()],
        log: '\nT[x] tools=a,b\nT[x] tools=a\n'
      }
    ])
    expect(grade(st, { mission: 's', stepCount: { kind: 'custom' }, equals: 2 })).toBe(true)
    expect(
      grade(st, { mission: 's', stepCount: { addedReason: { $exists: true } }, equals: 1 })
    ).toBe(true)
    expect(grade(st, { mission: 's', logLine: 'T[x]', contains: 'a' })).toBe(true)
    expect(grade(st, { mission: 's', logLine: 'T[x]', notContains: 'b' })).toBe(false)
    expect(grade(st, { mission: 's', logLine: 'T[y]', contains: 'a' })).toBe(false)
  })
})

describe('replyAsks — how a headless owner asks the operator', () => {
  it('counts a question or a request to confirm', () => {
    expect(replyAsks('Is "PR merging feat/notes-export into main" the right end?')).toBe(true)
    expect(replyAsks('Please confirm the end before I dispatch.')).toBe(true)
    expect(replyAsks('Dispatched both units.')).toBe(false)
  })
})
