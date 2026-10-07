/**
 * The Containers shell against a FAKE `docker` binary (a POSIX sh script on a
 * throwaway PATH) — never the machine's real daemon, whose stacks belong to
 * the operator (PRD §7.5). Harnu's fleet/session modules are mocked; the
 * folders the fake containers point at are real temp dirs, so the existence
 * checks run for real.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import { promises as fs } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

const h = vi.hoisted(() => ({
  env: {} as Record<string, string>,
  fleet: [] as unknown[],
  pinned: [] as Array<{ path: string }>,
  taskStates: new Map<string, string>(),
  live: new Set<string>()
}))

vi.mock('../src/main/appimage-env', () => ({
  spawnEnvOnce: async (): Promise<Record<string, string>> => h.env
}))
vi.mock('../src/main/fleet-model', () => ({
  getFleetFolders: async (): Promise<unknown[]> => h.fleet
}))
vi.mock('../src/main/user-projects', () => ({
  readUserProjects: async (): Promise<unknown> => ({ version: 1, projects: h.pinned })
}))
vi.mock('../src/main/hook-bridge', () => ({
  getTaskStates: (): Map<string, string> => h.taskStates
}))
vi.mock('../src/main/pty', () => ({
  liveSessionKeys: (): Set<string> => h.live
}))

import { dockerActions, inspectAll, scanContainers } from '../src/main/containers/containers-shell'
import type { ContainersSnapshotAvailable } from '../src/main/containers/containers-wire'
import { DAY, HOUR, NOW } from './containers-fixtures'

const FAKE_DOCKER = `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_DOCKER_LOG"
if [ "$FAKE_DOCKER_MODE" = down ]; then
  echo "Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?" >&2
  exit 1
fi
echo_args() {
  fail=0
  for a in "$@"; do
    case "$a" in
      missing*) echo "Error response from daemon: No such container: $a" >&2; fail=1 ;;
      *) echo "$a" ;;
    esac
  done
  exit $fail
}
cmd="$1"; shift
case "$cmd" in
  version) echo "29.0.0" ;;
  ps) cat "$FAKE_DOCKER_DIR/ps.txt" ;;
  inspect)
    cat "$FAKE_DOCKER_DIR/inspect.json"
    [ "$FAKE_DOCKER_MODE" = inspect-partial ] && { echo "Error: No such object: gone" >&2; exit 1; }
    exit 0 ;;
  stats)
    [ "$FAKE_DOCKER_MODE" = no-stats ] && exit 1
    cat "$FAKE_DOCKER_DIR/stats.txt" ;;
  system) cat "$FAKE_DOCKER_DIR/df.json" ;;
  volume) shift; echo_args "$@" ;;
  stop|start|rm) echo_args "$@" ;;
  *) echo "unexpected: $cmd" >&2; exit 2 ;;
esac
`

let root = ''
let binDir = ''
let dataDir = ''
let logFile = ''
let main = ''
let wt = ''
let wt2 = ''
let dock = ''
let plainDir = ''

/** Real git, isolated from the machine's config: no global/system config, no hooks. */
function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, {
    cwd,
    stdio: 'ignore',
    env: {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      HOME: root,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_AUTHOR_NAME: 'harnu',
      GIT_AUTHOR_EMAIL: 'harnu@example.invalid',
      GIT_COMMITTER_NAME: 'harnu',
      GIT_COMMITTER_EMAIL: 'harnu@example.invalid'
    }
  })
}

const id = (n: number): string => n.toString(16).padStart(4, '0') + 'd'.repeat(60)
const iso = (ms: number): string => new Date(ms).toISOString()

function inspectRow(
  n: number,
  name: string,
  opts: {
    project?: string
    workingDir?: string
    running?: boolean
    startedAt?: number
    ports?: string[]
    volume?: string
  } = {}
): unknown {
  const labels: Record<string, string> = {}
  if (opts.project) {
    labels['com.docker.compose.project'] = opts.project
    labels['com.docker.compose.service'] = 'app'
  }
  if (opts.workingDir) labels['com.docker.compose.project.working_dir'] = opts.workingDir
  const running = opts.running ?? true
  return {
    Id: id(n),
    Name: `/${name}`,
    Created: iso(NOW - 20 * DAY),
    State: {
      Status: running ? 'running' : 'exited',
      StartedAt: iso(opts.startedAt ?? NOW - 10 * DAY),
      FinishedAt: running ? '0001-01-01T00:00:00Z' : iso(NOW - 9 * DAY)
    },
    Config: { Image: 'busybox', Labels: labels },
    Mounts: opts.volume
      ? [{ Type: 'volume', Name: opts.volume, Source: `/var/lib/docker/volumes/${opts.volume}` }]
      : [],
    NetworkSettings: {
      Ports: Object.fromEntries(
        (opts.ports ?? []).map((p) => [`${p}/tcp`, [{ HostIp: '0.0.0.0', HostPort: p }]])
      )
    }
  }
}

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'harnu-containers-shell-'))
  binDir = path.join(root, 'bin')
  dataDir = path.join(root, 'data')
  logFile = path.join(root, 'docker.log')
  main = path.join(root, 'org', 'proj', 'www')
  wt = path.join(main, '.claude', 'worktrees', 'PROJ-231-wave-1')
  wt2 = path.join(main, '.claude', 'worktrees', 'PROJ-347-wave-2')
  dock = path.join(main, 'docker')
  plainDir = path.join(root, 'plain')
  await Promise.all([binDir, dataDir, main, plainDir].map((d) => fs.mkdir(d, { recursive: true })))
  await fs.writeFile(path.join(binDir, 'docker'), FAKE_DOCKER, { mode: 0o755 })
  // A real repo: `main` is the main checkout, `wt`/`wt2` linked worktrees of it.
  git(main, 'init', '-q')
  git(main, 'commit', '-q', '--allow-empty', '-m', 'init')
  git(main, 'worktree', 'add', '-q', '-b', 'wave-1', wt)
  git(main, 'worktree', 'add', '-q', '-b', 'wave-2', wt2)
  await fs.mkdir(dock)

  const rows = [
    inspectRow(1, 'proj-231-app-1', { project: 'proj-231', workingDir: wt, ports: ['8082'] }),
    inspectRow(2, 'proj-20-app-1', { project: 'proj-20', workingDir: main }),
    inspectRow(3, 'proj-27-app-1', {
      project: 'proj-27',
      workingDir: path.join(main, '.claude', 'worktrees', 'deleted'),
      running: false,
      volume: 'proj-27_mysql'
    }),
    inspectRow(4, 'postgres-scratch'),
    inspectRow(5, 'proj-347-app-1', { project: 'proj-347', workingDir: wt2, ports: ['8347'] }),
    // Idle for 10 days inside the main checkout: must stay protected, never a zombie.
    inspectRow(6, 'proj-dock-app-1', { project: 'proj-dock', workingDir: dock }),
    // A pinned folder that is not a git repo: unproven, so protected.
    inspectRow(7, 'plain-app-1', { project: 'plain', workingDir: plainDir })
  ]
  await fs.writeFile(path.join(dataDir, 'inspect.json'), JSON.stringify(rows))
  await fs.writeFile(path.join(dataDir, 'ps.txt'), [1, 2, 3, 4, 5, 6, 7].map(id).join('\n') + '\n')
  await fs.writeFile(
    path.join(dataDir, 'stats.txt'),
    [1, 2, 4, 5, 6, 7]
      .map((n) => JSON.stringify({ ID: id(n), MemUsage: `${n * 100}MiB / 15.5GiB` }))
      .join('\n')
  )
  await fs.writeFile(
    path.join(dataDir, 'df.json'),
    JSON.stringify([
      { Name: 'proj-27_mysql', Size: '657.9MB', Labels: 'com.docker.compose.project=proj-27' }
    ])
  )
})

afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

beforeEach(async () => {
  await fs.rm(logFile, { force: true })
  h.env = {
    PATH: `${binDir}:/usr/bin:/bin`,
    FAKE_DOCKER_LOG: logFile,
    FAKE_DOCKER_DIR: dataDir,
    FAKE_DOCKER_MODE: ''
  }
  h.fleet = [
    { path: main, sessions: [] },
    { path: wt, sessions: [{ sessionId: 's-live', fileMtime: NOW - HOUR, modified: '' }] }
  ]
  h.pinned = [{ path: wt2 }, { path: plainDir }]
  h.taskStates = new Map([['s-live', 'working']])
  h.live = new Set(['s-live'])
})

async function dockerLog(): Promise<string[]> {
  try {
    return (await fs.readFile(logFile, 'utf8')).trim().split('\n')
  } catch {
    return []
  }
}

describe.skipIf(process.platform === 'win32')('containers-shell (fake docker)', () => {
  it('scans docker and Harnu folders into classified stacks', async () => {
    const snap = (await scanContainers({
      zombieAfterDays: 2,
      journal: [],
      now: NOW
    })) as ContainersSnapshotAvailable
    expect(snap.dockerAvailable).toBe(true)
    const byId = Object.fromEntries(snap.stacks.map((s) => [s.id, s]))
    expect(Object.fromEntries(snap.stacks.map((s) => [s.id, s.verdict]))).toEqual({
      'proj-231': 'active',
      'proj-20': 'protected',
      'proj-27': 'orphan',
      'postgres-scratch': 'unknown',
      'proj-347': 'zombie',
      'proj-dock': 'protected',
      plain: 'protected'
    })
    // (a) <main>/docker, where only <main> is a Harnu folder: git says main checkout.
    expect(byId['proj-dock']!.attribution).toEqual({
      rung: 'compose-label',
      path: dock,
      folderPath: main,
      folderKind: 'main-checkout'
    })
    expect(byId['plain']!.attribution.folderKind).toBe('plain')
    expect(byId['proj-231']).toMatchObject({
      liveSessionId: 's-live',
      lastSessionActivityAt: NOW - HOUR,
      ports: [8082],
      ramBytes: 100 * 1024 ** 2
    })
    expect(byId['proj-27']!.volumes).toEqual([
      { name: 'proj-27_mysql', sizeBytes: 657_900_000, shared: false }
    ])
    expect(byId['proj-347']!.attribution).toEqual({
      rung: 'compose-label',
      path: wt2,
      folderPath: wt2,
      folderKind: 'worktree'
    })
    expect(snap.totals).toMatchObject({ needsYou: 2, stoppable: 1, zombiePorts: 1 })

    const log = await dockerLog()
    expect(log).toEqual([
      'version --format {{.Server.Version}}',
      'ps -aq --no-trunc',
      `inspect ${[1, 2, 3, 4, 5, 6, 7].map(id).join(' ')}`,
      expect.stringMatching(/^(stats|system)/),
      expect.stringMatching(/^(stats|system)/)
    ])
    expect(log).toContain('stats --no-stream --no-trunc --format {{json .}}')
    expect(log).toContain('system df -v --format {{json .Volumes}}')
  })

  it('(b) a pinned subfolder of the main checkout is still protected, never a worktree', async () => {
    h.pinned = [...h.pinned, { path: dock }]
    const snap = (await scanContainers({
      zombieAfterDays: 2,
      journal: [],
      now: NOW
    })) as ContainersSnapshotAvailable
    const s = snap.stacks.find((x) => x.id === 'proj-dock')!
    expect(s.verdict).toBe('protected')
    expect(s.attribution).toEqual({
      rung: 'compose-label',
      path: dock,
      folderPath: dock,
      folderKind: 'main-checkout'
    })
    // The bulk stop still reaches only the linked worktree's zombie.
    expect(snap.totals.stoppable).toBe(1)
  })

  it('keeps the recent tombstones and honors Harnu’s own stops', async () => {
    const tomb = {
      at: NOW - HOUR,
      actor: 'operator' as const,
      verb: 'stop' as const,
      stacks: [
        {
          stack: 'proj-27',
          name: 'proj-27',
          path: null,
          containerIds: [id(3)],
          freed: { ramBytes: 0, ports: [], volumes: [], volumeBytes: 0 }
        }
      ],
      restoreHint: null
    }
    const snap = await scanContainers({ zombieAfterDays: 2, journal: [tomb], now: NOW })
    expect(snap.recent).toEqual([tomb])
  })

  it('reports a missing docker CLI as unavailable, not as an empty machine', async () => {
    h.env = { ...h.env, PATH: path.join(root, 'empty-bin') }
    const snap = await scanContainers({ zombieAfterDays: 2, journal: [], now: NOW })
    expect(snap).toMatchObject({
      dockerAvailable: false,
      dockerError: 'docker CLI not found on PATH'
    })
    expect('stacks' in snap).toBe(false)
  })

  it('reports a daemon that is down as unavailable, with docker’s own reason', async () => {
    h.env = { ...h.env, FAKE_DOCKER_MODE: 'down' }
    const snap = await scanContainers({ zombieAfterDays: 2, journal: [], now: NOW })
    expect(snap).toEqual({
      scannedAt: NOW,
      dockerAvailable: false,
      dockerError:
        'Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?',
      zombieAfterDays: 2,
      recent: []
    })
  })

  it('keeps what inspect found when a container vanished mid-scan', async () => {
    h.env = { ...h.env, FAKE_DOCKER_MODE: 'inspect-partial' }
    const snap = (await scanContainers({
      zombieAfterDays: 2,
      journal: [],
      now: NOW
    })) as ContainersSnapshotAvailable
    expect(snap.stacks).toHaveLength(7)
  })

  it('inspectAll() tolerates a failed inspect chunk and returns the survivors', async () => {
    h.env = { ...h.env, FAKE_DOCKER_MODE: 'inspect-partial' }
    expect(await inspectAll()).toHaveLength(7)
  })

  it('inspectAll({ strict: true }) rethrows a failed inspect chunk, since the listing is incomplete', async () => {
    h.env = { ...h.env, FAKE_DOCKER_MODE: 'inspect-partial' }
    await expect(inspectAll({ strict: true })).rejects.toThrow()
  })

  it('inspectAll({ strict: true }) still returns everything when no chunk fails', async () => {
    expect(await inspectAll({ strict: true })).toHaveLength(7)
  })

  it('shows no RAM figure rather than a wrong one when stats fails', async () => {
    h.env = { ...h.env, FAKE_DOCKER_MODE: 'no-stats' }
    const snap = (await scanContainers({
      zombieAfterDays: 2,
      journal: [],
      now: NOW
    })) as ContainersSnapshotAvailable
    expect(snap.stacks.every((s) => s.ramBytes === 0)).toBe(true)
    expect(snap.stacks.flatMap((s) => s.containers).every((c) => c.memBytes === null)).toBe(true)
  })

  it('runs stop / start / rm / volume rm with plain ids — never --force', async () => {
    expect(await dockerActions.stop(['a', 'b'])).toEqual({ done: ['a', 'b'], error: null })
    expect(await dockerActions.start(['a'])).toEqual({ done: ['a'], error: null })
    expect(await dockerActions.removeContainers(['a', 'missing-b'])).toEqual({
      done: ['a'],
      error: 'Error response from daemon: No such container: missing-b'
    })
    expect(await dockerActions.removeVolumes(['v1'])).toEqual({ done: ['v1'], error: null })
    expect(await dockerActions.stop([])).toEqual({ done: [], error: null })
    expect(await dockerLog()).toEqual(['stop a b', 'start a', 'rm a missing-b', 'volume rm v1'])
  })
})
