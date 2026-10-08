/**
 * Pure core of the Containers feature (T320): docker output parsing, the
 * attribution ladder (PRD §3.2), the "unused for" clock and the verdicts (PRD
 * §3.3), and the snapshot builder (PRD §5).
 *
 * No I/O and no Electron. Every fact — what docker reported, which folders Harnu
 * knows, which paths exist, which containers Harnu itself stopped — is handed in
 * by `containers-shell.ts`, the same `scanner-shell` → `scan-core` split the
 * Reaper uses (ADR-0014 §2).
 */

import {
  NEEDS_YOU_VERDICTS,
  VERDICTS,
  type Attribution,
  type ContainerRow,
  type ContainersSnapshotAvailable,
  type ContainersSnapshotUnavailable,
  type ContainersTotals,
  type FolderKind,
  type StackRow,
  type Tombstone,
  type Verdict,
  type VolumeRow
} from './containers-wire'

export const COMPOSE_PROJECT_LABEL = 'com.docker.compose.project'
export const COMPOSE_WORKING_DIR_LABEL = 'com.docker.compose.project.working_dir'
export const COMPOSE_SERVICE_LABEL = 'com.docker.compose.service'

const DAY_MS = 86_400_000

/** States in which a container still holds RAM and ports, and `docker rm` refuses it. */
const HOLDING_STATES = new Set(['running', 'paused', 'restarting'])

// ---- docker output parsing ----------------------------------------------------

export interface MountFact {
  type: string
  /** Host path for a bind mount; the volume's data dir for a volume. */
  source: string
  /** Volume name, or null for a bind mount. */
  name: string | null
}

/** One container as `docker inspect` reports it, reduced to what the core reads. */
export interface InspectedContainer {
  id: string
  name: string
  image: string
  labels: Record<string, string>
  state: string
  startedAt: number | null
  finishedAt: number | null
  createdAt: number | null
  ports: number[]
  mounts: MountFact[]
}

/** Facts about a volume from `docker system df -v`. */
export interface VolumeFact {
  sizeBytes: number | null
  /** The volume's own `com.docker.compose.project` label, when it has one. */
  project: string | null
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

/**
 * Epoch ms of a docker RFC 3339 timestamp, or null for docker's zero time
 * (`0001-01-01T00:00:00Z`, "never") and anything unparseable. Instants are
 * compared, never wall-clock strings (PRD §9).
 */
export function parseDockerTime(v: unknown): number | null {
  if (typeof v !== 'string' || !v) return null
  // Trim sub-millisecond digits: Date.parse only promises millisecond precision.
  const trimmed = v.replace(/(\.\d{3})\d+/, '$1')
  const ms = Date.parse(trimmed)
  if (!Number.isFinite(ms) || ms <= 0) return null
  return ms
}

const SIZE_UNITS: Record<string, number> = {
  b: 1,
  kb: 1e3,
  mb: 1e6,
  gb: 1e9,
  tb: 1e12,
  kib: 1024,
  mib: 1024 ** 2,
  gib: 1024 ** 3,
  tib: 1024 ** 4
}

/**
 * Bytes from a docker human size. `docker system df` prints decimal units
 * (`219.9MB`, `12.3kB`); `docker stats` prints binary ones (`612MiB`).
 */
export function parseDockerSize(v: unknown): number | null {
  if (typeof v !== 'string') return null
  const m = /^\s*([\d.]+)\s*([a-zA-Z]+)\s*$/.exec(v)
  if (!m) return null
  const n = Number.parseFloat(m[1] ?? '')
  const unit = SIZE_UNITS[(m[2] ?? '').toLowerCase()]
  if (!Number.isFinite(n) || unit === undefined) return null
  return Math.round(n * unit)
}

function parsePorts(networkSettings: unknown): number[] {
  const ports = asRecord(asRecord(networkSettings)?.Ports)
  if (!ports) return []
  const out = new Set<number>()
  for (const bindings of Object.values(ports)) {
    if (!Array.isArray(bindings)) continue
    for (const b of bindings) {
      const port = Number.parseInt(asString(asRecord(b)?.HostPort), 10)
      if (Number.isFinite(port) && port > 0) out.add(port)
    }
  }
  return [...out].sort((a, b) => a - b)
}

function parseMounts(mounts: unknown): MountFact[] {
  if (!Array.isArray(mounts)) return []
  const out: MountFact[] = []
  for (const raw of mounts) {
    const m = asRecord(raw)
    if (!m) continue
    const type = asString(m.Type)
    const name = asString(m.Name)
    out.push({ type, source: asString(m.Source), name: type === 'volume' && name ? name : null })
  }
  return out
}

function parseLabels(v: unknown): Record<string, string> {
  const rec = asRecord(v)
  const out: Record<string, string> = {}
  if (!rec) return out
  for (const [k, val] of Object.entries(rec)) if (typeof val === 'string') out[k] = val
  return out
}

/** Parses `docker inspect <ids…>` output (a JSON array). Malformed input yields `[]`. */
export function parseInspect(stdout: string): InspectedContainer[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout)
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []
  const out: InspectedContainer[] = []
  for (const raw of parsed) {
    const c = asRecord(raw)
    const id = asString(c?.Id)
    if (!c || !id) continue
    const state = asRecord(c.State)
    const config = asRecord(c.Config)
    out.push({
      id,
      name: asString(c.Name).replace(/^\//, '') || id.slice(0, 12),
      image: asString(config?.Image),
      labels: parseLabels(config?.Labels),
      state: asString(state?.Status) || 'unknown',
      startedAt: parseDockerTime(state?.StartedAt),
      finishedAt: parseDockerTime(state?.FinishedAt),
      createdAt: parseDockerTime(c.Created),
      ports: parsePorts(c.NetworkSettings),
      mounts: parseMounts(c.Mounts)
    })
  }
  return out
}

/**
 * Parses `docker stats --no-stream --no-trunc --format '{{json .}}'` (one JSON
 * object per line) into container id → resident bytes (the left half of
 * `MemUsage`, e.g. `612MiB / 15.5GiB`).
 */
export function parseStats(stdout: string): Map<string, number> {
  const out = new Map<string, number>()
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue
    let row: Record<string, unknown> | null
    try {
      row = asRecord(JSON.parse(line))
    } catch {
      continue
    }
    const id = asString(row?.ID) || asString(row?.Container)
    const used = parseDockerSize(asString(row?.MemUsage).split('/')[0])
    if (id && used !== null) out.set(id, used)
  }
  return out
}

/** Parses `docker system df -v --format '{{json .Volumes}}'` into name → facts. */
export function parseDfVolumes(stdout: string): Map<string, VolumeFact> {
  const out = new Map<string, VolumeFact>()
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout.trim() || 'null')
  } catch {
    return out
  }
  if (!Array.isArray(parsed)) return out
  for (const raw of parsed) {
    const v = asRecord(raw)
    const name = asString(v?.Name)
    if (!v || !name) continue
    // `Labels` is a comma-joined `k=v` string in the CLI's JSON template output.
    let project: string | null = null
    for (const pair of asString(v.Labels).split(',')) {
      const eq = pair.indexOf('=')
      if (eq > 0 && pair.slice(0, eq) === COMPOSE_PROJECT_LABEL) project = pair.slice(eq + 1)
    }
    out.set(name, { sizeBytes: parseDockerSize(v.Size), project })
  }
  return out
}

/**
 * Which of `requested` a multi-argument `docker stop|start|rm|volume rm`
 * reports as done. Docker echoes each argument it handled, one per line, and
 * writes failures to stderr — so a non-zero exit still tells us which ones
 * went through.
 */
export function parseEchoedIds(stdout: string, requested: readonly string[]): string[] {
  const echoed = new Set(
    stdout
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
  )
  return requested.filter((r) => echoed.has(r))
}

/** Container id → latest time Harnu itself stopped it, from the journal. */
export function harnuStopTimes(tombstones: readonly Tombstone[]): Map<string, number> {
  const out = new Map<string, number>()
  for (const t of tombstones) {
    if (t.verb !== 'stop') continue
    for (const s of t.stacks) {
      for (const id of s.containerIds) {
        const prev = out.get(id)
        if (prev === undefined || t.at > prev) out.set(id, t.at)
      }
    }
  }
  return out
}

// ---- paths --------------------------------------------------------------------

/**
 * A path in the form used for comparison: forward slashes, no trailing slash,
 * no duplicate separators, and case-folded on Windows (PRD §9).
 */
export function normalizePath(p: string, platform: string): string {
  let out = platform === 'win32' ? p.replace(/\\/g, '/') : p
  out = out.replace(/\/{2,}/g, '/')
  if (out.length > 1 && out.endsWith('/')) out = out.slice(0, -1)
  return platform === 'win32' ? out.toLowerCase() : out
}

/** True when `child` is `parent` or lies beneath it (both already normalized). */
export function isInside(child: string, parent: string): boolean {
  if (child === parent) return true
  return child.startsWith(parent.endsWith('/') ? parent : `${parent}/`)
}

// ---- attribution (PRD §3.2) ------------------------------------------------------

/**
 * A folder Harnu knows, with the facts the verdicts need. Deliberately no git
 * metadata: whether a stack runs from a main checkout or a worktree is decided
 * from the attributed path itself ({@link GitCheckout}), never from the Harnu
 * folder that contains it.
 */
export interface KnownFolder {
  path: string
  /** Epoch ms of the last activity of any Harnu session in this folder. */
  lastActivityAt: number | null
  /** A session here that is working/needs-input with a live PTY, or null. */
  liveSessionId: string | null
}

/** The deepest known folder containing `target`, or null. */
function containingFolder(
  target: string,
  folders: readonly KnownFolder[],
  platform: string
): KnownFolder | null {
  const t = normalizePath(target, platform)
  let best: KnownFolder | null = null
  let bestLen = -1
  for (const f of folders) {
    const fp = normalizePath(f.path, platform)
    if (isInside(t, fp) && fp.length > bestLen) {
      best = f
      bestLen = fp.length
    }
  }
  return best
}

export interface LadderResult {
  rung: Attribution['rung']
  path: string | null
}

/**
 * The first rung that matches wins: the compose `working_dir` label, then the
 * source of a bind mount that lies inside a folder Harnu knows, then nothing.
 */
export function attributionRung(
  containers: readonly InspectedContainer[],
  folders: readonly KnownFolder[],
  platform: string
): LadderResult {
  for (const c of containers) {
    const dir = c.labels[COMPOSE_WORKING_DIR_LABEL]
    if (dir) return { rung: 'compose-label', path: dir }
  }
  for (const c of containers) {
    for (const m of c.mounts) {
      if (m.type !== 'bind' || !m.source) continue
      const folder = containingFolder(m.source, folders, platform)
      if (folder) return { rung: 'bind-mount', path: folder.path }
    }
  }
  return { rung: 'none', path: null }
}

/** Every path the ladder attributes a stack to: exactly what the shell asks git about. */
export function attributedPaths(
  containers: readonly InspectedContainer[],
  folders: readonly KnownFolder[],
  platform: string
): string[] {
  const out = new Set<string>()
  for (const g of groupStacks(containers)) {
    const { path } = attributionRung(g.containers, folders, platform)
    if (path) out.add(path)
  }
  return [...out]
}

/**
 * Whether a failed `stat` proves the path is gone. Only a missing entry does
 * (`ENOENT`, `ENOTDIR`); any other error (`EACCES`, `EIO`, …) leaves the path
 * unproven, so it falls through to the git probe and ends up protected rather
 * than an orphan the bulk stop would reach.
 */
export function statProvesGone(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code
  return code === 'ENOENT' || code === 'ENOTDIR'
}

/**
 * What git itself says about an existing path: it lies in a repo's main
 * checkout (`main`), or in a linked worktree (`linked`). A linked worktree's
 * git dir (`<repo>/.git/worktrees/<name>`) differs from the repo's common dir;
 * the main checkout — and every subfolder of it, pinned in Harnu or not —
 * shares one.
 */
export type GitCheckout = 'main' | 'linked'

const ABSOLUTE_PATH = /^(\/|[A-Za-z]:[\\/])/

/**
 * Parses `git rev-parse --path-format=absolute --git-dir --git-common-dir`.
 * Anything but two absolute paths — an older git echoing the unknown flag
 * back, a relative path, an error — is unproven, and yields null.
 */
export function parseGitDirs(stdout: string): GitCheckout | null {
  const lines = stdout
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
  if (lines.length !== 2 || !lines.every((l) => ABSOLUTE_PATH.test(l))) return null
  const [gitDir, commonDir] = lines.map((l) => normalizePath(l.replace(/\\/g, '/'), 'linux'))
  return gitDir === commonDir ? 'main' : 'linked'
}

/**
 * Resolves an attributed path against Harnu's folders, the disk and git.
 *
 * Only a path git proves to lie in a linked worktree resolves as `worktree`,
 * so only it can ever become a zombie. The main checkout and anything inside
 * it resolve as `main-checkout`, and a path git can't vouch for (no repo, or
 * the probe failed) as `plain`: both are protected, so "Stop N running" can
 * never reach the operator's main dev environment.
 */
export function resolveAttribution(
  ladder: LadderResult,
  folders: readonly KnownFolder[],
  pathExists: (p: string) => boolean,
  gitCheckout: (p: string) => GitCheckout | null,
  platform: string
): { attribution: Attribution; folder: KnownFolder | null } {
  if (ladder.rung === 'none' || !ladder.path) {
    return {
      attribution: { rung: 'none', path: null, folderPath: null, folderKind: null },
      folder: null
    }
  }
  const folder = containingFolder(ladder.path, folders, platform)
  let folderKind: FolderKind
  // Outside every Harnu folder is checked first: a vanished path Harnu never
  // knew (a moved client repo, a WSL path seen from Windows) is not an orphan.
  if (!folder) folderKind = 'untracked'
  else if (!pathExists(ladder.path)) folderKind = 'gone'
  else {
    const checkout = gitCheckout(ladder.path)
    folderKind =
      checkout === 'linked' ? 'worktree' : checkout === 'main' ? 'main-checkout' : 'plain'
  }
  return {
    attribution: {
      rung: ladder.rung,
      path: ladder.path,
      folderPath: folder?.path ?? null,
      folderKind
    },
    folder
  }
}

// ---- the clock and the verdicts (PRD §3.3) -----------------------------------------

/**
 * Epoch ms of the latest container start or stop that counts toward "unused
 * for". A stop Harnu performed does not count — "stopping a stack does not
 * reset the clock": when the journal shows Harnu stopped a container at or after
 * its last start, that container's `FinishedAt` is Harnu's own doing and is
 * ignored. A container with no start or stop at all falls back to its creation.
 */
export function lastContainerEvent(
  containers: readonly InspectedContainer[],
  harnuStoppedAt: ReadonlyMap<string, number>
): number | null {
  let latest: number | null = null
  const bump = (t: number | null): void => {
    if (t !== null && (latest === null || t > latest)) latest = t
  }
  for (const c of containers) {
    bump(c.startedAt)
    const stoppedByHarnu = harnuStoppedAt.get(c.id)
    const harnuOwnsFinish =
      stoppedByHarnu !== undefined && (c.startedAt === null || stoppedByHarnu >= c.startedAt)
    if (!harnuOwnsFinish) bump(c.finishedAt)
    if (c.startedAt === null && c.finishedAt === null) bump(c.createdAt)
  }
  return latest
}

/** "Unused for": time since the later of the last session activity and the last container event. */
export function unusedFor(
  now: number,
  lastSessionActivityAt: number | null,
  lastEventAt: number | null
): number | null {
  const candidates = [lastSessionActivityAt, lastEventAt].filter((t): t is number => t !== null)
  if (candidates.length === 0) return null
  return Math.max(0, now - Math.max(...candidates))
}

export interface VerdictFacts {
  attribution: Attribution
  /** A live Harnu session in the attributed folder. */
  liveSession: boolean
  unusedForMs: number | null
  zombieAfterDays: number
  /**
   * The attributed worktree's workspace-GC bucket. Applies to `worktree` folders
   * only: it replaces the idle clock, which stays in charge of every other stack.
   */
  inheritedBucket?: 'ready' | 'review' | 'in-use'
}

/**
 * PRD §3.3, evaluated in order; the first verdict that applies wins. A stack
 * with no measurable clock stays `pending`: an unproven zombie is left alone.
 * A worktree stack with an `inheritedBucket` takes its verdict from that bucket
 * instead of the idle clock.
 */
export function classifyStack(f: VerdictFacts): Verdict {
  const kind = f.attribution.folderKind
  if (f.attribution.rung === 'none' || kind === null || kind === 'untracked') return 'unknown'
  if (kind === 'gone') return 'orphan'
  if (f.liveSession) return 'active'
  if (kind === 'main-checkout' || kind === 'plain') return 'protected'
  if (kind === 'worktree' && f.inheritedBucket !== undefined) {
    if (f.inheritedBucket === 'in-use') return 'active'
    return f.inheritedBucket === 'ready' ? 'zombie' : 'pending'
  }
  if (f.unusedForMs === null || f.unusedForMs < f.zombieAfterDays * DAY_MS) return 'pending'
  return 'zombie'
}

// ---- stacks ---------------------------------------------------------------------

export interface StackGroup {
  id: string
  name: string
  kind: 'compose' | 'container'
  project: string | null
  containers: InspectedContainer[]
}

/**
 * One stack per compose project, and one per container that belongs to none
 * (PRD §3.1). A standalone container whose name collides with a compose
 * project's is keyed `container:<name>` so every id stays unique.
 */
export function groupStacks(containers: readonly InspectedContainer[]): StackGroup[] {
  const byProject = new Map<string, InspectedContainer[]>()
  const standalone: InspectedContainer[] = []
  for (const c of containers) {
    const project = c.labels[COMPOSE_PROJECT_LABEL]
    if (project) {
      const list = byProject.get(project)
      if (list) list.push(c)
      else byProject.set(project, [c])
    } else {
      standalone.push(c)
    }
  }
  const groups: StackGroup[] = [...byProject].map(([project, list]) => ({
    id: project,
    name: project,
    kind: 'compose',
    project,
    containers: list
  }))
  const taken = new Set(groups.map((g) => g.id))
  for (const c of standalone) {
    const id = taken.has(c.name) ? `container:${c.name}` : c.name
    taken.add(id)
    groups.push({ id, name: c.name, kind: 'container', project: null, containers: [c] })
  }
  return groups
}

export function isHolding(state: string): boolean {
  return HOLDING_STATES.has(state)
}

export interface ScanInput {
  containers: readonly InspectedContainer[]
  /** Container id → resident bytes; keys may be full ids or 12-char prefixes. */
  memById: ReadonlyMap<string, number>
  volumes: ReadonlyMap<string, VolumeFact>
  folders: readonly KnownFolder[]
  pathExists: (p: string) => boolean
  /** Git's answer for an attributed path ({@link parseGitDirs}); null when unproven. */
  gitCheckout: (p: string) => GitCheckout | null
  /** Container id → latest time Harnu stopped it ({@link harnuStopTimes}). */
  harnuStoppedAt: ReadonlyMap<string, number>
  now: number
  zombieAfterDays: number
  recent: Tombstone[]
  platform: string
}

function memFor(id: string, memById: ReadonlyMap<string, number>): number | null {
  return memById.get(id) ?? memById.get(id.slice(0, 12)) ?? null
}

function toContainerRow(c: InspectedContainer, memById: ReadonlyMap<string, number>): ContainerRow {
  const running = isHolding(c.state)
  return {
    id: c.id,
    name: c.name,
    service: c.labels[COMPOSE_SERVICE_LABEL] ?? null,
    image: c.image,
    state: c.state,
    running,
    startedAt: c.startedAt,
    finishedAt: c.finishedAt,
    memBytes: running ? memFor(c.id, memById) : null,
    ports: running ? [...c.ports] : [],
    volumes: c.mounts.flatMap((m) => (m.name ? [m.name] : []))
  }
}

const SORT_RANK: Record<Verdict, number> = {
  zombie: 0,
  orphan: 1,
  active: 2,
  protected: 3,
  pending: 4,
  unknown: 5
}

function emptyRamByVerdict(): Record<Verdict, number> {
  const out = {} as Record<Verdict, number>
  for (const v of VERDICTS) out[v] = 0
  return out
}

export function computeTotals(stacks: readonly StackRow[]): ContainersTotals {
  const ramByVerdict = emptyRamByVerdict()
  let zombieRamBytes = 0
  let volumeBytesAtStake = 0
  let needsYou = 0
  let stoppable = 0
  const zombiePorts = new Set<number>()
  for (const s of stacks) {
    ramByVerdict[s.verdict] += s.ramBytes
    if (!NEEDS_YOU_VERDICTS.includes(s.verdict)) continue
    needsYou += 1
    volumeBytesAtStake += s.volumeBytes
    if (!s.running) continue
    stoppable += 1
    zombieRamBytes += s.ramBytes
    for (const p of s.ports) zombiePorts.add(p)
  }
  return {
    zombieRamBytes,
    zombiePorts: zombiePorts.size,
    volumeBytesAtStake,
    ramByVerdict,
    needsYou,
    stoppable
  }
}

/** Assembles the snapshot the view and the MCP read verb consume unchanged. */
export function buildSnapshot(input: ScanInput): ContainersSnapshotAvailable {
  const groups = groupStacks(input.containers)

  // Which stacks mount each volume, to flag volumes a removal must not take.
  const volumeOwners = new Map<string, Set<string>>()
  for (const g of groups) {
    for (const c of g.containers) {
      for (const m of c.mounts) {
        if (!m.name) continue
        const owners = volumeOwners.get(m.name) ?? new Set<string>()
        owners.add(g.id)
        volumeOwners.set(m.name, owners)
      }
    }
  }

  const stacks: StackRow[] = groups.map((g) => {
    const containers = g.containers.map((c) => toContainerRow(c, input.memById))
    const running = containers.some((c) => c.running)
    const ramBytes = containers.reduce((sum, c) => sum + (c.memBytes ?? 0), 0)
    const ports = [...new Set(containers.flatMap((c) => c.ports))].sort((a, b) => a - b)

    const volumeNames = [...new Set(containers.flatMap((c) => c.volumes))].sort()
    const volumes: VolumeRow[] = volumeNames.map((name) => {
      const fact = input.volumes.get(name)
      const otherStack = (volumeOwners.get(name)?.size ?? 0) > 1
      const otherProject = fact?.project != null && fact.project !== g.project
      return { name, sizeBytes: fact?.sizeBytes ?? null, shared: otherStack || otherProject }
    })
    const volumeBytes = volumes.reduce((sum, v) => sum + (v.shared ? 0 : (v.sizeBytes ?? 0)), 0)

    const ladder = attributionRung(g.containers, input.folders, input.platform)
    const { attribution, folder } = resolveAttribution(
      ladder,
      input.folders,
      input.pathExists,
      input.gitCheckout,
      input.platform
    )
    const lastSessionActivityAt = folder?.lastActivityAt ?? null
    const lastContainerEventAt = lastContainerEvent(g.containers, input.harnuStoppedAt)
    const clock = unusedFor(input.now, lastSessionActivityAt, lastContainerEventAt)
    const liveSessionId = attribution.folderKind === 'gone' ? null : (folder?.liveSessionId ?? null)
    const verdict = classifyStack({
      attribution,
      liveSession: liveSessionId !== null,
      unusedForMs: clock,
      zombieAfterDays: input.zombieAfterDays
    })
    const usesClock = verdict === 'pending' || verdict === 'zombie'
    const zombieInMs =
      verdict === 'pending' && clock !== null ? input.zombieAfterDays * DAY_MS - clock : null

    return {
      id: g.id,
      name: g.name,
      kind: g.kind,
      project: g.project,
      attribution,
      verdict,
      running,
      containers,
      ramBytes,
      ports,
      volumes,
      volumeBytes,
      lastSessionActivityAt,
      lastContainerEventAt,
      unusedForMs: usesClock ? clock : null,
      zombieInMs,
      liveSessionId
    }
  })

  stacks.sort(
    (a, b) =>
      SORT_RANK[a.verdict] - SORT_RANK[b.verdict] ||
      b.ramBytes - a.ramBytes ||
      a.name.localeCompare(b.name)
  )

  return {
    scannedAt: input.now,
    dockerAvailable: true,
    zombieAfterDays: input.zombieAfterDays,
    totals: computeTotals(stacks),
    stacks,
    recent: input.recent
  }
}

/** Docker is missing or its daemon is down: say so, never report an empty machine. */
export function unavailableSnapshot(
  dockerError: string,
  now: number,
  zombieAfterDays: number,
  recent: Tombstone[]
): ContainersSnapshotUnavailable {
  return {
    scannedAt: now,
    dockerAvailable: false,
    dockerError: dockerError.trim() || 'docker is unavailable',
    zombieAfterDays,
    recent
  }
}

/** First meaningful line of a docker failure, for `dockerError`. */
export function summarizeDockerError(err: unknown): string {
  const e = err as { code?: unknown; stderr?: unknown; message?: unknown } | null
  if (e?.code === 'ENOENT') return 'docker CLI not found on PATH'
  const text = [e?.stderr, e?.message].find((t) => typeof t === 'string' && t.trim()) as
    string | undefined
  const line = text
    ?.split('\n')
    .map((l) => l.trim())
    .find(Boolean)
  return line ?? String(err)
}
