/**
 * The reference fleet for the perf suite (T697, performance contract P8).
 *
 * Built in a temp dir, never committed: a generated `$HOME` with `~/.claude/projects/<slug>/<id>.jsonl`
 * transcripts, a main checkout with linked worktrees and open mission files, and the id lists a
 * periodic job needs (the known sessions, the live ones). Everything is deterministic, so two runs
 * at the same scale build the same tree and a regression is a code change, not a different fixture.
 *
 * Reference scale (what the real fleet measured on 2026-11-11, see the input-lag investigation):
 * 1,000 slugs, 10,000 transcripts, 2,000 known sessions, 60 worktrees, 50 open missions, 15 live
 * sessions. `scaled(spec, 0.25)` is the small size of the super-linear check.
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  buildMissionFileContent,
  missionFilePath,
  type Mission
} from '../../../src/main/mission-core'

export interface ScaleSpec {
  slugs: number
  transcripts: number
  knownSessions: number
  worktrees: number
  missions: number
  liveSessions: number
}

export const REFERENCE_SCALE: ScaleSpec = {
  slugs: 1_000,
  transcripts: 10_000,
  knownSessions: 2_000,
  worktrees: 60,
  missions: 50,
  liveSessions: 15
}

/** The spec at `factor` of the reference scale; every dimension keeps at least 1 (live sessions at least 3). */
export function scaled(spec: ScaleSpec, factor: number): ScaleSpec {
  const f = (n: number, min = 1): number => Math.max(min, Math.round(n * factor))
  return {
    slugs: f(spec.slugs),
    transcripts: f(spec.transcripts),
    knownSessions: f(spec.knownSessions),
    worktrees: f(spec.worktrees),
    missions: f(spec.missions),
    liveSessions: f(spec.liveSessions, 3)
  }
}

export interface FixtureWorktree {
  path: string
  branch: string
}

export interface ScaleFixture {
  spec: ScaleSpec
  /** The generated `$HOME`. Point `process.env.HOME` here to run code that reads `os.homedir()`. */
  home: string
  projectsRoot: string
  slugs: string[]
  /** Every session the app knows about; roughly 15% of them have no transcript on disk any more. */
  knownSessionIds: string[]
  /** The sessions with a running process. A few of them are brand new and have no transcript yet. */
  liveSessionIds: string[]
  /** The repo's main checkout (holds `.harnu/missions`). */
  repoRoot: string
  worktrees: FixtureWorktree[]
  missionFiles: string[]
  cleanup(): Promise<void>
}

const hex = (n: number, width: number): string => n.toString(16).padStart(width, '0')

/** A valid uuid-shaped id, deterministic in `n`. */
export const sessionIdOf = (n: number): string =>
  `${hex(n, 8)}-0000-4000-8000-${hex(n * 7919 + 1, 12)}`

const slugOf = (i: number): string => `-home-dev-Workspace-org-proj${hex(i, 4)}-www`

/** Writes `count` empty-ish transcripts in bounded parallel batches. */
async function writeAll(files: string[], body: string): Promise<void> {
  const BATCH = 64
  for (let i = 0; i < files.length; i += BATCH) {
    await Promise.all(files.slice(i, i + BATCH).map((f) => writeFile(f, body)))
  }
}

export async function buildScaleFixture(spec: ScaleSpec): Promise<ScaleFixture> {
  const root = await mkdtemp(join(tmpdir(), 'harnu-perf-'))
  const home = join(root, 'home')
  const projectsRoot = join(home, '.claude', 'projects')
  const slugs = Array.from({ length: spec.slugs }, (_, i) => slugOf(i))
  await Promise.all(slugs.map((s) => mkdir(join(projectsRoot, s), { recursive: true })))

  // Transcripts: slug 0 is the home directory's own and holds 30% (the real one held 77%, mostly
  // headless `claude -p` runs); the rest spread evenly. Ids are 0..transcripts-1.
  const heavy = Math.floor(spec.transcripts * 0.3)
  const transcriptFiles: string[] = []
  const line = JSON.stringify({ type: 'user', cwd: '/home/dev/Workspace/org/proj/www' }) + '\n'
  for (let n = 0; n < spec.transcripts; n++) {
    const slug = n < heavy ? slugs[0] : slugs[1 + ((n - heavy) % Math.max(1, spec.slugs - 1))]
    transcriptFiles.push(join(projectsRoot, slug, `${sessionIdOf(n)}.jsonl`))
  }
  await writeAll(transcriptFiles, line)

  // Known sessions: spread over the transcripts, plus ~15% that no longer have one.
  const withTranscript = Math.round(spec.knownSessions * 0.85)
  const stride = Math.max(1, Math.floor(spec.transcripts / withTranscript))
  const knownSessionIds: string[] = []
  for (let k = 0; k < withTranscript; k++)
    knownSessionIds.push(sessionIdOf((k * stride) % spec.transcripts))
  for (let k = 0; k < spec.knownSessions - withTranscript; k++) {
    knownSessionIds.push(sessionIdOf(spec.transcripts + 1000 + k))
  }
  // Live: the newest known ones with a transcript, plus 3 that were just started (no transcript yet).
  const fresh = 3
  const liveSessionIds = [
    ...knownSessionIds.slice(withTranscript - (spec.liveSessions - fresh), withTranscript),
    ...Array.from({ length: fresh }, (_, k) => sessionIdOf(spec.transcripts + 5000 + k))
  ]

  // Repo with linked worktrees and open missions.
  const repoRoot = join(root, 'repos', 'main')
  await mkdir(join(repoRoot, '.git'), { recursive: true })
  const worktrees: FixtureWorktree[] = []
  for (let w = 0; w < spec.worktrees; w++) {
    const wtGit = join(repoRoot, '.git', 'worktrees', `wt-${w}`)
    await mkdir(wtGit, { recursive: true })
    await writeFile(join(wtGit, 'commondir'), '../..\n')
    const wt = join(root, 'repos', `wt-${w}`)
    await mkdir(join(wt, 'src', 'deep', 'nest'), { recursive: true })
    await writeFile(join(wt, '.git'), `gitdir: ${wtGit}\n`)
    worktrees.push({ path: wt, branch: `card/T${100 + w}-slice` })
  }

  const missionFiles: string[] = []
  await mkdir(join(repoRoot, '.harnu', 'missions'), { recursive: true })
  for (let m = 0; m < spec.missions; m++) {
    const id = `mnt-${hex(0x10000000 + m, 8)}`
    const slug = `delivery-${m}`
    const owner = liveSessionIds[m % liveSessionIds.length]
    const mission = missionOf(id, slug, repoRoot, owner, [
      liveSessionIds[(m + 1) % liveSessionIds.length]
    ])
    const file = missionFilePath(repoRoot, id, slug)
    await writeFile(file, buildMissionFileContent(mission))
    missionFiles.push(file)
  }

  return {
    spec,
    home,
    projectsRoot,
    slugs,
    knownSessionIds,
    liveSessionIds,
    repoRoot,
    worktrees,
    missionFiles,
    cleanup: () => rm(root, { recursive: true, force: true })
  }
}

function missionOf(
  id: string,
  slug: string,
  folder: string,
  ownerSessionId: string,
  childSessionIds: string[]
): Mission {
  const at = '2026-11-01T09:00:00.000Z'
  return {
    id,
    slug,
    folder,
    owner: { sessionId: ownerSessionId, folder },
    status: 'active',
    declaredEnd: { kind: 'code', target: 'the slice is merged', evidence: 'green gates' },
    steps: [
      ...Array.from({ length: 4 }, (_, s): Mission['steps'][number] => ({
        id: `stp-${s + 1}`,
        ordinal: s + 1,
        kind: 'custom',
        title: `Step ${s + 1}`,
        verification: 'verifier',
        proof: 'unproven',
        links: s === 1 ? childSessionIds.map((ref) => ({ kind: 'session' as const, ref })) : [],
        blockers: []
      })),
      {
        id: 'stp-5',
        ordinal: 5,
        kind: 'fixed-end',
        title: 'Delivered and verified',
        verification: 'verifier',
        proof: 'unproven',
        links: [],
        blockers: []
      }
    ],
    blockers: [],
    openQuestions: [],
    createdAt: at,
    updatedAt: at,
    provenance: { author: 'agent', at }
  }
}
