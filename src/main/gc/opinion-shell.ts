// The env-bound half of "Ask for an opinion": it reads git, the fleet and the routing table to
// build each item's dossier, and runs the headless `claude -p` session. Every decision (what the
// prompt says, what the argv allows, how the answer is read, what is cached) is in opinion-core.ts
// and is unit-tested there. This file only gathers facts and spawns, so per ADR-0001 it has no
// test of its own beyond the source-level contract in tests/gc-opinion-wiring.test.ts.
//
// Read-only on every side: the git calls are `status`, `diff --stat` and `rev-parse`, and the
// session it spawns is the Scheduler's `observe` argv with no MCP server (see `opinionArgv`).

import { getFleetFolders } from '../fleet-model'
import { resolveClaudePath } from '../claude-cli'
import { sanitizeSpawnEnv } from '../appimage-env'
import { runSupervised } from './opinion-run'
import { lastFateInputs } from '../reaper/scanner-shell'
import { resolveFolderRouting } from '../routing-policy'
import type { WorktreeBundle } from './bundle-core'
import type { OrphanVolumeItem } from './gc-housekeeping-input'
import {
  OPINION_ROUTING_KIND,
  type OpinionDossier,
  type OpinionKeyFacts,
  type OpinionLookup,
  type OpinionServiceDeps
} from './opinion-core'

/** One headless process may think for a while, but never indefinitely. */
const RUN_TIMEOUT_MS = 180_000

/** The part of a gather the advisor reads. */
export interface OpinionSource {
  bundles: readonly WorktreeBundle[]
  orphanVolumes: readonly OrphanVolumeItem[]
}

export interface OpinionShellOptions {
  /** The freshest gather; the shell never triggers a scan by itself beyond what this does. */
  current(): Promise<OpinionSource>
  /** `git -C <path> <args>` in a worktree; rejects on a non-zero exit. */
  git(path: string, args: string[]): Promise<string>
}

type ShellDeps = Pick<OpinionServiceDeps, 'classify' | 'dossier' | 'keyFacts' | 'route' | 'run'>

async function attempt(work: () => Promise<string>): Promise<string> {
  try {
    return await work()
  } catch {
    return ''
  }
}

/** `origin/<default>` as the remote reports it, or `origin/main` when it cannot be read. */
async function defaultRef(opts: OpinionShellOptions, repoPath: string): Promise<string> {
  const out = (
    await attempt(() => opts.git(repoPath, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']))
  ).trim()
  return out || 'origin/main'
}

/** The most recent chat held in exactly this folder: its summary, else its first prompt. */
async function lastSummaryIn(path: string): Promise<string | null> {
  try {
    const folder = (await getFleetFolders()).find((f) => f.path === path)
    const latest = [...(folder?.sessions ?? [])]
      .filter((s) => !s.isSidechain)
      .sort((a, b) => (a.modified < b.modified ? 1 : -1))[0]
    return latest ? latest.summary || latest.firstPrompt || null : null
  } catch {
    return null
  }
}

/**
 * What the cache key reads, and nothing heavier: the fate and pull request from the last scan, the
 * live head and the live dirty set (two cheap git calls). The ask and the peek both go through it,
 * so the same item always has the same key.
 */
async function worktreeKeyFacts(
  opts: OpinionShellOptions,
  b: WorktreeBundle
): Promise<OpinionKeyFacts> {
  const { item } = b
  const path = item.path ?? null
  const facts = lastFateInputs().get(item.id)?.facts
  let head: string | null = b.localTip ?? null
  let dirtyFiles: string[] = []
  if (path) {
    const [status, tip] = await Promise.all([
      attempt(() => opts.git(path, ['status', '--porcelain'])),
      attempt(() => opts.git(path, ['rev-parse', 'HEAD']))
    ])
    dirtyFiles = status.split('\n').filter((l) => l.trim().length > 0)
    head = tip.trim() || head
  }
  return {
    reasonCode: b.reason?.code ?? 'unknown-fate',
    fate: b.fate.fate,
    prState: facts?.pr?.state ?? null,
    head,
    dirtyFiles
  }
}

async function worktreeDossier(
  opts: OpinionShellOptions,
  b: WorktreeBundle
): Promise<{ dossier: OpinionDossier; group: string }> {
  const { item } = b
  const path = item.path ?? null
  const key = await worktreeKeyFacts(opts, b)
  let diffStat = ''
  let lastSessionSummary: string | null = null
  if (path) {
    const base = await defaultRef(opts, item.repoPath)
    ;[diffStat, lastSessionSummary] = await Promise.all([
      attempt(() => opts.git(path, ['diff', '--stat', '--stat-width=120', `${base}...HEAD`])),
      lastSummaryIn(path)
    ])
  }
  return {
    group: item.repoPath,
    dossier: {
      id: item.id,
      path,
      branch: item.branch ?? null,
      reasonCode: key.reasonCode,
      reasonDetail: b.reason?.detail ?? '',
      fate: key.fate,
      prState: key.prState,
      head: key.head,
      diffStat,
      dirtyFiles: key.dirtyFiles,
      lastSessionSummary
    }
  }
}

function volumeDossier(v: OrphanVolumeItem): { dossier: OpinionDossier; group: string } {
  return {
    group: '',
    dossier: {
      id: v.id,
      path: null,
      branch: null,
      reasonCode: v.reason.code,
      reasonDetail: v.reason.detail,
      fate: null,
      prState: null,
      head: null,
      diffStat: '',
      dirtyFiles: [],
      lastSessionSummary: null,
      volume: { name: v.name, project: v.project, sizeBytes: v.sizeBytes }
    }
  }
}

/** Resolves `claude` and runs it with the advisor's argv; the prompt goes in on stdin. */
async function runClaude(a: {
  cwd: string | null
  argv: string[]
  stdin: string
}): Promise<string | null> {
  const bin = await resolveClaudePath()
  if (!bin) return null
  return runSupervised(bin, a.argv, {
    cwd: a.cwd,
    env: sanitizeSpawnEnv(process.env, { execPath: process.execPath }),
    stdin: a.stdin,
    timeoutMs: RUN_TIMEOUT_MS
  })
}

/** The shell half of {@link OpinionServiceDeps}: which ids exist, their facts, their model, the spawn. */
export function createOpinionShell(opts: OpinionShellOptions): ShellDeps {
  return {
    classify: async () => {
      const g = await opts.current()
      const kinds = new Map<string, OpinionLookup>()
      for (const b of g.bundles) kinds.set(b.item.id, b.bucket === 'review' ? 'review' : 'other')
      for (const v of g.orphanVolumes) kinds.set(v.id, 'orphan-volume')
      return (id) => kinds.get(id)
    },
    dossier: async (id) => {
      const g = await opts.current()
      const bundle = g.bundles.find((b) => b.item.id === id)
      if (bundle) return worktreeDossier(opts, bundle)
      const volume = g.orphanVolumes.find((v) => v.id === id)
      return volume ? volumeDossier(volume) : null
    },
    keyFacts: async (id) => {
      const g = await opts.current()
      const bundle = g.bundles.find((b) => b.item.id === id)
      if (bundle) return worktreeKeyFacts(opts, bundle)
      const volume = g.orphanVolumes.find((v) => v.id === id)
      return volume ? volumeDossier(volume).dossier : null
    },
    // The operator's routing table, per repo (design.md: "Model follows the operator's routing
    // table"), as kind `scout`. The table is read, never written.
    route: (group) => resolveFolderRouting(group, OPINION_ROUTING_KIND),
    run: runClaude
  }
}
