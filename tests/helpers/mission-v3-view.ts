/**
 * Mission v3 S3 — turn an S1 progress fixture (`tests/fixtures/mission-v3/*.json`,
 * `{ name, mission, signals, expect }`) into the `MissionView` the renderer reads
 * over `mission:list`. `progress` is the SERVER's — `computeProgress` from
 * `src/main/mission-progress.ts`, the same call `deriveMissionSignals` makes — so
 * a renderer test that matches it proves the renderer shows the server's numbers
 * rather than recounting them. `closeWarnings` is the main process's too.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import type { MissionView } from '../../src/main/mission-ipc'
import { closeWarnings, type Mission, type MissionStep } from '../../src/main/mission-core'
import { computeProgress, type StepSignalsLite } from '../../src/main/mission-progress'
import type { MissionChildState } from '../../src/main/mcp/fleet-snapshot'

export const FIXTURE_NOW = Date.parse('2026-10-01T12:00:00Z')

export const FIXTURE_NAMES = [
  'added-mid-flight',
  'blocked-future',
  'blocked-like',
  'delivered',
  'faq-like',
  'hero-like',
  'needs-human',
  'nothing',
  'owner-only-working',
  'parallel',
  'proven-start',
  'self-verified-all',
  'tools-listing-like'
] as const

export type FixtureName = (typeof FIXTURE_NAMES)[number]

interface Fixture {
  name: string
  mission: Pick<Mission, 'owner' | 'steps'> & Partial<Mission>
  signals: StepSignalsLite[]
}

function loadFixture(name: string): Fixture {
  const file = path.join(__dirname, '..', 'fixtures', 'mission-v3', `${name}.json`)
  return JSON.parse(readFileSync(file, 'utf8')) as Fixture
}

function child(c: StepSignalsLite['children'][number]): MissionChildState {
  return {
    sessionId: c.sessionId,
    known: true,
    folderAlias: 'repo',
    taskState: c.taskState,
    pendingApprovals: 0
  }
}

/**
 * The view `mission:list` would return for a fixture. `over.mission` patches the
 * stored mission BEFORE progress is computed (so the server's numbers follow);
 * `over.view` patches the finished view (e.g. a `you` list).
 */
export function fixtureView(
  name: FixtureName,
  over: { mission?: Partial<Mission>; view?: Partial<MissionView> } = {}
): MissionView {
  const f = loadFixture(name)
  const steps: MissionStep[] = f.mission.steps.map((s, i) => ({
    ...s,
    ordinal: s.ordinal ?? i + 1,
    title: s.title ?? `Build ${s.id}`
  }))
  const mission = {
    id: `mnt-${(name.length * 0x1f1f1f).toString(16).padStart(8, '0').slice(0, 8)}`,
    slug: name,
    folder: '/repo',
    status: 'active',
    declaredEnd: { kind: 'code', target: `${name} shipped`, evidence: 'merged PRs' },
    blockers: [],
    openQuestions: [],
    createdAt: '2026-09-30T00:00:00.000Z',
    updatedAt: '2026-10-01T11:50:00.000Z',
    provenance: { author: 'agent', at: '2026-09-30T00:00:00.000Z' },
    ...f.mission,
    ...over.mission,
    steps: over.mission?.steps ?? steps
  } as Mission
  const progress = computeProgress(mission, f.signals, FIXTURE_NOW)
  return {
    root: '/repo',
    mission,
    title: `Mission ${name}`,
    derived: {
      live: true,
      computedAt: progress.computedAt,
      stale: false,
      stall: {
        stale: false,
        lastEvidenceAt: mission.updatedAt,
        thresholdMs: 3_600_000,
        workingSessions: []
      },
      gh: 'not-needed',
      pendingApprovals: 0,
      scope: { links: [], resolved: { proven: false } },
      steps: mission.steps.map((s) => {
        const sig = f.signals.find((x) => x.stepId === s.id)
        return {
          stepId: s.id,
          children: (sig?.children ?? []).map(child),
          links: [],
          existence: s.verification === 'existence' ? { proven: !!sig?.existenceProven } : null
        }
      }),
      progress
    },
    you: [],
    progress,
    closeWarnings: closeWarnings(mission, progress),
    ...over.view
  }
}
