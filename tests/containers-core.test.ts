import { describe, it, expect } from 'vitest'
import {
  attributionRung,
  buildSnapshot,
  harnuStopTimes,
  classifyStack,
  groupStacks,
  isInside,
  lastContainerEvent,
  normalizePath,
  parseDfVolumes,
  parseDockerSize,
  parseDockerTime,
  parseEchoedIds,
  parseGitDirs,
  parseInspect,
  parseStats,
  resolveAttribution,
  statProvesGone,
  summarizeDockerError,
  unavailableSnapshot,
  unusedFor,
  type InspectedContainer,
  type KnownFolder,
  type ScanInput
} from '../src/main/containers/containers-core'
import type { Attribution, StackRow, Tombstone } from '../src/main/containers/containers-wire'
import {
  DAY,
  GONE,
  HOUR,
  MAIN,
  NOW,
  WT,
  WT2,
  composeContainer,
  container,
  fixtureGitCheckout,
  knownFolder,
  scanInput
} from './containers-fixtures'

function onlyStack(input: Partial<ScanInput>): StackRow {
  const snap = buildSnapshot(scanInput(input))
  expect(snap.stacks).toHaveLength(1)
  return snap.stacks[0]!
}

describe('docker output parsing', () => {
  it('parses RFC 3339 instants, treating docker zero time as never', () => {
    expect(parseDockerTime('2026-09-10T20:49:01.862916353Z')).toBe(
      Date.parse('2026-09-10T20:49:01.862Z')
    )
    expect(parseDockerTime('2026-09-10T17:49:01-03:00')).toBe(Date.parse('2026-09-10T20:49:01Z'))
    expect(parseDockerTime('0001-01-01T00:00:00Z')).toBeNull()
    expect(parseDockerTime('')).toBeNull()
    expect(parseDockerTime('soon')).toBeNull()
    expect(parseDockerTime(42)).toBeNull()
  })

  it('parses decimal (df) and binary (stats) sizes', () => {
    expect(parseDockerSize('219.9MB')).toBe(219_900_000)
    expect(parseDockerSize('12.3kB')).toBe(12_300)
    expect(parseDockerSize('1.5GB')).toBe(1_500_000_000)
    expect(parseDockerSize('612MiB')).toBe(612 * 1024 ** 2)
    expect(parseDockerSize(' 1GiB ')).toBe(1024 ** 3)
    expect(parseDockerSize('0B')).toBe(0)
    expect(parseDockerSize('12 parsecs')).toBeNull()
    expect(parseDockerSize('')).toBeNull()
    expect(parseDockerSize(undefined)).toBeNull()
  })

  it('reduces docker inspect output to the facts the core reads', () => {
    const stdout = JSON.stringify([
      {
        Id: 'a'.repeat(64),
        Name: '/proj-82-app-1',
        Created: '2026-09-01T10:00:00.123456789Z',
        State: {
          Status: 'running',
          StartedAt: '2026-09-01T10:00:01.5Z',
          FinishedAt: '0001-01-01T00:00:00Z'
        },
        Config: {
          Image: 'sail-8.4/app',
          Labels: { 'com.docker.compose.project': 'proj-82', junk: 3 }
        },
        Mounts: [
          { Type: 'bind', Source: WT, Destination: '/var/www/html' },
          { Type: 'volume', Name: 'proj-82_mysql', Source: '/var/lib/docker/volumes/x/_data' }
        ],
        NetworkSettings: {
          Ports: {
            '80/tcp': [
              { HostIp: '0.0.0.0', HostPort: '8082' },
              { HostIp: '::', HostPort: '8082' }
            ],
            '5173/tcp': [{ HostIp: '0.0.0.0', HostPort: '5182' }],
            '9000/tcp': null
          }
        }
      },
      { Name: '/no-id' },
      'junk'
    ])
    const [c, ...rest] = parseInspect(stdout)
    expect(rest).toEqual([])
    expect(c).toEqual({
      id: 'a'.repeat(64),
      name: 'proj-82-app-1',
      image: 'sail-8.4/app',
      labels: { 'com.docker.compose.project': 'proj-82' },
      state: 'running',
      startedAt: Date.parse('2026-09-01T10:00:01.5Z'),
      finishedAt: null,
      createdAt: Date.parse('2026-09-01T10:00:00.123Z'),
      ports: [5182, 8082],
      mounts: [
        { type: 'bind', source: WT, name: null },
        { type: 'volume', source: '/var/lib/docker/volumes/x/_data', name: 'proj-82_mysql' }
      ]
    })
    expect(parseInspect('not json')).toEqual([])
    expect(parseInspect('{}')).toEqual([])
  })

  it('reads resident memory from docker stats lines', () => {
    const out = parseStats(
      [
        JSON.stringify({ ID: 'abc', MemUsage: '612MiB / 15.5GiB' }),
        'garbage',
        JSON.stringify({ Container: 'def', MemUsage: '1.5GiB / 15.5GiB' }),
        JSON.stringify({ ID: 'ghi', MemUsage: '--' }),
        ''
      ].join('\n')
    )
    expect([...out]).toEqual([
      ['abc', 612 * 1024 ** 2],
      ['def', 1.5 * 1024 ** 3]
    ])
  })

  it('reads volume sizes and their compose project from system df -v', () => {
    const out = parseDfVolumes(
      JSON.stringify([
        {
          Name: 'proj-82_mysql',
          Size: '249.2MB',
          Labels: 'com.docker.compose.config-hash=x,com.docker.compose.project=proj-82'
        },
        { Name: 'loose', Size: 'N/A', Labels: '' },
        { Size: '1MB' }
      ])
    )
    expect(out.get('proj-82_mysql')).toEqual({ sizeBytes: 249_200_000, project: 'proj-82' })
    expect(out.get('loose')).toEqual({ sizeBytes: null, project: null })
    expect(out.size).toBe(2)
    expect(parseDfVolumes('').size).toBe(0)
    expect(parseDfVolumes('{').size).toBe(0)
  })

  it('tells which arguments a multi-target docker command handled', () => {
    expect(parseEchoedIds('a\nc\n', ['a', 'b', 'c'])).toEqual(['a', 'c'])
    expect(parseEchoedIds('', ['a'])).toEqual([])
  })

  it('summarizes a docker failure to one line', () => {
    expect(summarizeDockerError({ code: 'ENOENT' })).toBe('docker CLI not found on PATH')
    expect(
      summarizeDockerError({
        code: 1,
        stderr: '\nCannot connect to the Docker daemon at unix:///var/run/docker.sock.\nmore'
      })
    ).toBe('Cannot connect to the Docker daemon at unix:///var/run/docker.sock.')
    expect(summarizeDockerError(new Error('boom'))).toBe('boom')
    expect(summarizeDockerError('plain')).toBe('plain')
  })
})

describe('paths', () => {
  it('normalizes separators, trailing slashes and Windows case', () => {
    expect(normalizePath('/a//b/', 'linux')).toBe('/a/b')
    expect(normalizePath('/', 'linux')).toBe('/')
    expect(normalizePath('/A/B', 'linux')).toBe('/A/B')
    expect(normalizePath('C:\\Users\\Dev\\proj\\', 'win32')).toBe('c:/users/dev/proj')
  })

  it('treats a sibling with a shared prefix as outside', () => {
    expect(isInside('/a/b', '/a/b')).toBe(true)
    expect(isInside('/a/b/c', '/a/b')).toBe(true)
    expect(isInside('/a/bc', '/a/b')).toBe(false)
    expect(isInside('/x', '/')).toBe(true)
  })
})

describe('statProvesGone', () => {
  const err = (code: string): Error => Object.assign(new Error(code), { code })

  it('only a missing entry proves a path gone', () => {
    expect(statProvesGone(err('ENOENT'))).toBe(true)
    expect(statProvesGone(err('ENOTDIR'))).toBe(true)
  })

  it('an unreadable or failing path stays unproven, so it can never become an orphan', () => {
    expect(statProvesGone(err('EACCES'))).toBe(false)
    expect(statProvesGone(err('EIO'))).toBe(false)
    expect(statProvesGone(new Error('no code'))).toBe(false)
    expect(statProvesGone(null)).toBe(false)
  })
})

describe('parseGitDirs', () => {
  it('main checkout, or any subfolder of it: the git dir is the common dir', () => {
    expect(parseGitDirs('/r/.git\n/r/.git\n')).toBe('main')
    expect(parseGitDirs('/r/.git/\n/r/.git\n')).toBe('main')
    expect(parseGitDirs('C:\\r\\.git\nC:/r/.git\n')).toBe('main')
  })

  it('linked worktree: its git dir lives under .git/worktrees', () => {
    expect(parseGitDirs('/r/.git/worktrees/wave-1\n/r/.git\n')).toBe('linked')
  })

  it('anything else is unproven', () => {
    expect(parseGitDirs('')).toBeNull()
    expect(parseGitDirs('/r/.git\n')).toBeNull()
    expect(parseGitDirs('.git\n.git\n')).toBeNull()
    // An older git echoes an unknown flag back instead of failing.
    expect(parseGitDirs('--path-format=absolute\n/r/.git\n/r/.git\n')).toBeNull()
  })
})

describe('attribution ladder (PRD §3.2)', () => {
  const folders = [knownFolder(MAIN), knownFolder(WT), knownFolder(WT2)]

  it('rung 1: the compose working_dir label wins, even over a bind mount elsewhere', () => {
    const c = composeContainer('proj-231', WT, {
      mounts: [{ type: 'bind', source: `${WT2}/src`, name: null }]
    })
    expect(attributionRung([c], folders, 'linux')).toEqual({ rung: 'compose-label', path: WT })
  })

  it('rung 1 matches on any container of the stack', () => {
    const a = composeContainer('p', null)
    const b = composeContainer('p', WT, { service: 'db' })
    expect(attributionRung([a, b], folders, 'linux')).toEqual({ rung: 'compose-label', path: WT })
  })

  it('rung 2: a bind mount inside a known folder attributes to the deepest such folder', () => {
    const c = container({ mounts: [{ type: 'bind', source: `${WT}/storage/logs`, name: null }] })
    expect(attributionRung([c], folders, 'linux')).toEqual({ rung: 'bind-mount', path: WT })
  })

  it('rung 2 ignores volumes and bind mounts outside every known folder', () => {
    const c = container({
      mounts: [
        { type: 'volume', source: `${WT}/looks-inside`, name: 'vol' },
        { type: 'bind', source: '/srv/elsewhere', name: null },
        { type: 'bind', source: `${MAIN}-sibling/x`, name: null }
      ]
    })
    expect(attributionRung([c], folders, 'linux')).toEqual({ rung: 'none', path: null })
  })

  it('rung 3: nothing matches, the stack is unattributed', () => {
    expect(attributionRung([container()], folders, 'linux')).toEqual({ rung: 'none', path: null })
    expect(attributionRung([container()], [], 'linux')).toEqual({ rung: 'none', path: null })
  })

  it('compares Windows paths case- and separator-insensitively', () => {
    const c = container({
      mounts: [{ type: 'bind', source: 'c:/users/dev/proj/src', name: null }]
    })
    const winFolders = [knownFolder('C:\\Users\\Dev\\proj')]
    expect(attributionRung([c], winFolders, 'win32')).toEqual({
      rung: 'bind-mount',
      path: 'C:\\Users\\Dev\\proj'
    })
  })

  it('resolves the attributed path to main checkout, worktree, gone, plain or untracked', () => {
    const exists = (p: string): boolean => p !== GONE
    const kind = (path: string, fs = folders): Attribution['folderKind'] =>
      resolveAttribution({ rung: 'compose-label', path }, fs, exists, fixtureGitCheckout, 'linux')
        .attribution.folderKind
    expect(kind(MAIN)).toBe('main-checkout')
    expect(kind(WT)).toBe('worktree')
    expect(kind(`${WT}/docker`)).toBe('worktree')
    expect(kind(GONE)).toBe('gone')
    expect(kind('/srv/scratch')).toBe('untracked')
    expect(kind('/srv/plain', [knownFolder('/srv/plain')])).toBe('plain')
    expect(
      resolveAttribution({ rung: 'none', path: null }, folders, exists, fixtureGitCheckout, 'linux')
        .attribution
    ).toEqual({ rung: 'none', path: null, folderPath: null, folderKind: null })
  })

  describe('main vs worktree comes from git on the attributed path, not the Harnu folder', () => {
    const resolve = (
      path: string,
      fs: KnownFolder[],
      git: typeof fixtureGitCheckout = fixtureGitCheckout
    ): Attribution =>
      resolveAttribution({ rung: 'compose-label', path }, fs, () => true, git, 'linux').attribution

    it('(a) <main>/docker, where only <main> is a Harnu folder → main checkout', () => {
      expect(resolve(`${MAIN}/docker`, [knownFolder(MAIN)])).toEqual({
        rung: 'compose-label',
        path: `${MAIN}/docker`,
        folderPath: MAIN,
        folderKind: 'main-checkout'
      })
    })

    it('(b) <main>/docker pinned as its own Harnu folder → still the main checkout', () => {
      expect(resolve(`${MAIN}/docker`, [knownFolder(MAIN), knownFolder(`${MAIN}/docker`)])).toEqual(
        {
          rung: 'compose-label',
          path: `${MAIN}/docker`,
          folderPath: `${MAIN}/docker`,
          folderKind: 'main-checkout'
        }
      )
    })

    it('a real linked worktree still resolves as a worktree', () => {
      expect(resolve(WT, [knownFolder(MAIN), knownFolder(WT)]).folderKind).toBe('worktree')
    })

    it('a path git cannot vouch for is plain, never a worktree', () => {
      expect(resolve(WT, [knownFolder(WT)], () => null).folderKind).toBe('plain')
    })
  })
})

describe('verdicts (PRD §3.3)', () => {
  it('unknown: an unattributed stack', () => {
    expect(onlyStack({ containers: [container()] }).verdict).toBe('unknown')
  })

  it('unknown: a compose path outside every Harnu folder', () => {
    expect(onlyStack({ containers: [composeContainer('p', '/srv/scratch')] }).verdict).toBe(
      'unknown'
    )
  })

  it('unknown, never orphan: a vanished compose path outside every Harnu folder', () => {
    const s = onlyStack({
      containers: [composeContainer('p', '/srv/vanished')],
      pathExists: () => false
    })
    expect(s.verdict).toBe('unknown')
    expect(s.attribution.folderKind).toBe('untracked')
  })

  it('orphan: the attributed path no longer exists', () => {
    const s = onlyStack({ containers: [composeContainer('p', GONE)] })
    expect(s.verdict).toBe('orphan')
    expect(s.attribution).toEqual({
      rung: 'compose-label',
      path: GONE,
      folderPath: MAIN,
      folderKind: 'gone'
    })
  })

  it('active: a live Harnu session in the attributed folder', () => {
    const s = onlyStack({
      containers: [composeContainer('p', WT)],
      folders: [knownFolder(MAIN), knownFolder(WT, { liveSessionId: 'sess-1' })]
    })
    expect(s.verdict).toBe('active')
    expect(s.liveSessionId).toBe('sess-1')
  })

  it("protected: the attributed folder is a repo's main checkout", () => {
    expect(onlyStack({ containers: [composeContainer('p', MAIN)] }).verdict).toBe('protected')
  })

  it('protected: a Harnu folder git cannot vouch for', () => {
    const s = onlyStack({
      containers: [composeContainer('p', '/srv/plain')],
      folders: [knownFolder('/srv/plain')]
    })
    expect(s.verdict).toBe('protected')
  })

  it('protected, never zombie: an idle stack inside the main checkout, pinned or not', () => {
    for (const folders of [
      [knownFolder(MAIN)],
      [knownFolder(MAIN), knownFolder(`${MAIN}/docker`)]
    ]) {
      const s = onlyStack({
        containers: [composeContainer('p', `${MAIN}/docker`, { startedAt: NOW - 30 * DAY })],
        folders
      })
      expect(s.verdict).toBe('protected')
      expect(s.attribution.folderKind).toBe('main-checkout')
    }
  })

  it('pending: an idle worktree stack, unused for less than the threshold', () => {
    const s = onlyStack({ containers: [composeContainer('p', WT, { startedAt: NOW - DAY })] })
    expect(s.verdict).toBe('pending')
    expect(s.unusedForMs).toBe(DAY)
    expect(s.zombieInMs).toBe(DAY)
  })

  it('zombie: an idle worktree stack, unused for at least the threshold', () => {
    const s = onlyStack({ containers: [composeContainer('p', WT, { startedAt: NOW - 3 * DAY })] })
    expect(s.verdict).toBe('zombie')
    expect(s.unusedForMs).toBe(3 * DAY)
    expect(s.zombieInMs).toBeNull()
  })

  it('the threshold is inclusive, and follows zombieAfterDays', () => {
    const at = (startedAt: number, zombieAfterDays = 2): string =>
      onlyStack({ containers: [composeContainer('p', WT, { startedAt })], zombieAfterDays }).verdict
    expect(at(NOW - 2 * DAY)).toBe('zombie')
    expect(at(NOW - 2 * DAY + 1)).toBe('pending')
    expect(at(NOW - 3 * DAY, 5)).toBe('pending')
  })

  describe('precedence: the first verdict that applies wins', () => {
    const base = (over: Partial<Attribution>): Attribution => ({
      rung: 'compose-label',
      path: WT,
      folderPath: WT,
      folderKind: 'worktree',
      ...over
    })
    const facts = { liveSession: true, unusedForMs: 30 * DAY, zombieAfterDays: 2 }

    it('unknown beats every other rule', () => {
      const a = base({ rung: 'none', path: null, folderPath: null, folderKind: null })
      expect(classifyStack({ ...facts, attribution: a })).toBe('unknown')
    })

    it('orphan beats active', () => {
      expect(classifyStack({ ...facts, attribution: base({ folderKind: 'gone' }) })).toBe('orphan')
    })

    it('active beats protected', () => {
      expect(classifyStack({ ...facts, attribution: base({ folderKind: 'main-checkout' }) })).toBe(
        'active'
      )
    })

    it('protected beats zombie', () => {
      const a = base({ folderKind: 'main-checkout' })
      expect(classifyStack({ ...facts, liveSession: false, attribution: a })).toBe('protected')
    })

    it('active beats zombie', () => {
      expect(classifyStack({ ...facts, attribution: base({}) })).toBe('active')
    })

    it('a gone path with a live session still reads orphan end to end', () => {
      const s = onlyStack({
        containers: [composeContainer('p', GONE)],
        folders: [knownFolder(MAIN, { liveSessionId: 'sess-main' })]
      })
      expect(s.verdict).toBe('orphan')
      expect(s.liveSessionId).toBeNull()
    })
  })

  describe('inheritedBucket (workspace GC): a worktree stack inherits its worktree bucket', () => {
    const attr = (folderKind: Attribution['folderKind']): Attribution => ({
      rung: 'compose-label',
      path: WT,
      folderPath: WT,
      folderKind
    })
    const idle = { liveSession: false, unusedForMs: 0, zombieAfterDays: 2 }

    it('corpse → zombie immediately, even with a zero idle clock', () => {
      expect(
        classifyStack({ ...idle, attribution: attr('worktree'), inheritedBucket: 'corpse' })
      ).toBe('zombie')
    })

    it('corpse → zombie even when the idle clock is unmeasurable', () => {
      expect(
        classifyStack({
          ...idle,
          unusedForMs: null,
          attribution: attr('worktree'),
          inheritedBucket: 'corpse'
        })
      ).toBe('zombie')
    })

    it('alive → active, even when the idle clock is long past the threshold', () => {
      expect(
        classifyStack({
          ...idle,
          unusedForMs: 30 * DAY,
          attribution: attr('worktree'),
          inheritedBucket: 'alive'
        })
      ).toBe('active')
    })

    it('decide → pending, even when the idle clock is long past the threshold', () => {
      expect(
        classifyStack({
          ...idle,
          unusedForMs: 30 * DAY,
          attribution: attr('worktree'),
          inheritedBucket: 'decide'
        })
      ).toBe('pending')
    })

    it('a plain folder ignores it', () => {
      for (const inheritedBucket of ['corpse', 'decide', 'alive'] as const) {
        expect(classifyStack({ ...idle, attribution: attr('plain'), inheritedBucket })).toBe(
          'protected'
        )
      }
    })

    it('a main checkout ignores it too', () => {
      expect(
        classifyStack({ ...idle, attribution: attr('main-checkout'), inheritedBucket: 'corpse' })
      ).toBe('protected')
    })

    it('unknown and orphan still beat it', () => {
      const none: Attribution = { rung: 'none', path: null, folderPath: null, folderKind: null }
      expect(classifyStack({ ...idle, attribution: none, inheritedBucket: 'corpse' })).toBe(
        'unknown'
      )
      expect(classifyStack({ ...idle, attribution: attr('gone'), inheritedBucket: 'corpse' })).toBe(
        'orphan'
      )
    })

    it('a live session still wins over a corpse bucket (alive beats everything)', () => {
      expect(
        classifyStack({
          ...idle,
          liveSession: true,
          attribution: attr('worktree'),
          inheritedBucket: 'corpse'
        })
      ).toBe('active')
    })

    it('no inheritedBucket leaves the idle clock in charge (existing behavior)', () => {
      expect(classifyStack({ ...idle, attribution: attr('worktree') })).toBe('pending')
      expect(classifyStack({ ...idle, unusedForMs: 3 * DAY, attribution: attr('worktree') })).toBe(
        'zombie'
      )
    })
  })
})

describe('the "unused for" clock (PRD §3.3, provisional)', () => {
  it('counts from the later of the last session activity and the last container event', () => {
    const recentSession = onlyStack({
      containers: [composeContainer('p', WT, { startedAt: NOW - 10 * DAY })],
      folders: [knownFolder(MAIN), knownFolder(WT, { lastActivityAt: NOW - HOUR })]
    })
    expect(recentSession.verdict).toBe('pending')
    expect(recentSession.unusedForMs).toBe(HOUR)
    expect(recentSession.zombieInMs).toBe(2 * DAY - HOUR)
    expect(recentSession.lastSessionActivityAt).toBe(NOW - HOUR)

    const recentStart = onlyStack({
      containers: [composeContainer('p', WT, { startedAt: NOW - 2 * HOUR })],
      folders: [knownFolder(MAIN), knownFolder(WT, { lastActivityAt: NOW - 10 * DAY })]
    })
    expect(recentStart.unusedForMs).toBe(2 * HOUR)
  })

  it('stopping a stack through Harnu does not reset the clock', () => {
    const c = composeContainer('p', WT, {
      state: 'exited',
      startedAt: NOW - 10 * DAY,
      finishedAt: NOW - HOUR
    })
    const stoppedAt = new Map([[c.id, NOW - HOUR + 5_000]])
    const s = onlyStack({ containers: [c], harnuStoppedAt: stoppedAt })
    expect(s.verdict).toBe('zombie')
    expect(s.running).toBe(false)
    expect(s.unusedForMs).toBe(10 * DAY)
    expect(s.lastContainerEventAt).toBe(NOW - 10 * DAY)
  })

  it('a stop Harnu did not perform counts as a container event', () => {
    const c = composeContainer('p', WT, {
      state: 'exited',
      startedAt: NOW - 10 * DAY,
      finishedAt: NOW - HOUR
    })
    expect(onlyStack({ containers: [c] }).verdict).toBe('pending')
  })

  it('a start after a Harnu stop resets the clock', () => {
    const c = composeContainer('p', WT, { startedAt: NOW - HOUR, finishedAt: NOW - 3 * DAY })
    const s = onlyStack({ containers: [c], harnuStoppedAt: new Map([[c.id, NOW - 3 * DAY]]) })
    expect(s.verdict).toBe('pending')
    expect(s.unusedForMs).toBe(HOUR)
  })

  it('a later stop, after a restart, is not treated as Harnu’s', () => {
    const c = composeContainer('p', WT, {
      state: 'exited',
      startedAt: NOW - 2 * HOUR,
      finishedAt: NOW - HOUR
    })
    const s = onlyStack({ containers: [c], harnuStoppedAt: new Map([[c.id, NOW - 3 * DAY]]) })
    expect(s.unusedForMs).toBe(HOUR)
  })

  it('falls back to creation time for a container never started', () => {
    const c = composeContainer('p', WT, {
      state: 'created',
      startedAt: null,
      finishedAt: null,
      createdAt: NOW - 5 * DAY
    })
    const s = onlyStack({ containers: [c] })
    expect(s.verdict).toBe('zombie')
    expect(s.unusedForMs).toBe(5 * DAY)
  })

  it('with no clock at all, an attributed worktree stack stays pending', () => {
    const c = composeContainer('p', WT, { startedAt: null, finishedAt: null, createdAt: null })
    const s = onlyStack({ containers: [c] })
    expect(s.verdict).toBe('pending')
    expect(s.unusedForMs).toBeNull()
    expect(s.zombieInMs).toBeNull()
  })

  it('does not expose the clock for verdicts that do not use it', () => {
    expect(onlyStack({ containers: [composeContainer('p', MAIN)] }).unusedForMs).toBeNull()
  })

  it('lastContainerEvent and unusedFor, directly', () => {
    const a = container({ startedAt: 100, finishedAt: 300 })
    const b = container({ startedAt: 200, finishedAt: null })
    expect(lastContainerEvent([a, b], new Map())).toBe(300)
    expect(lastContainerEvent([a, b], new Map([[a.id, 300]]))).toBe(200)
    expect(lastContainerEvent([], new Map())).toBeNull()
    expect(unusedFor(1000, null, null)).toBeNull()
    expect(unusedFor(1000, 400, 700)).toBe(300)
    expect(unusedFor(1000, 2000, null)).toBe(0)
  })

  it('derives the Harnu stop times from stop tombstones only, latest wins', () => {
    const t = (at: number, verb: Tombstone['verb'], ids: string[]): Tombstone => ({
      at,
      actor: 'operator',
      verb,
      stacks: [
        {
          stack: 's',
          name: 's',
          path: null,
          containerIds: ids,
          freed: { ramBytes: 0, ports: [], volumes: [], volumeBytes: 0 }
        }
      ],
      restoreHint: null
    })
    const times = harnuStopTimes([
      t(1, 'stop', ['a']),
      t(3, 'stop', ['a', 'b']),
      t(9, 'start', ['a'])
    ])
    expect([...times]).toEqual([
      ['a', 3],
      ['b', 3]
    ])
  })
})

describe('buildSnapshot', () => {
  it('groups one stack per compose project and one per standalone container', () => {
    const groups = groupStacks([
      composeContainer('proj-82', WT),
      composeContainer('proj-82', WT, { service: 'mysql' }),
      container({ name: 'postgres-scratch' }),
      container({ name: 'proj-82' })
    ])
    expect(groups.map((g) => [g.id, g.kind, g.containers.length])).toEqual([
      ['proj-82', 'compose', 2],
      ['postgres-scratch', 'container', 1],
      ['container:proj-82', 'container', 1]
    ])
  })

  it('counts RAM and ports for running containers only', () => {
    const run = composeContainer('p', WT, { ports: [8082, 5182] })
    const off = composeContainer('p', WT, {
      service: 'db',
      state: 'exited',
      ports: [3306],
      finishedAt: NOW - 3 * DAY
    })
    const s = onlyStack({
      containers: [run, off],
      memById: new Map([
        [run.id.slice(0, 12), 600],
        [off.id, 999]
      ])
    })
    expect(s.running).toBe(true)
    expect(s.ramBytes).toBe(600)
    expect(s.ports).toEqual([5182, 8082])
    expect(s.containers.find((c) => c.id === off.id)).toMatchObject({
      running: false,
      memBytes: null,
      ports: []
    })
  })

  it('flags volumes shared with another stack or owned by another project', () => {
    const mount = (name: string): InspectedContainer['mounts'][number] => ({
      type: 'volume',
      source: `/var/lib/docker/volumes/${name}/_data`,
      name
    })
    const a = composeContainer('a', WT, {
      mounts: [mount('a_mysql'), mount('shared_cache'), mount('b_external')]
    })
    const b = composeContainer('b', WT2, { mounts: [mount('shared_cache')] })
    const snap = buildSnapshot(
      scanInput({
        containers: [a, b],
        volumes: new Map([
          ['a_mysql', { sizeBytes: 100, project: 'a' }],
          ['shared_cache', { sizeBytes: 50, project: null }],
          ['b_external', { sizeBytes: 20, project: 'b' }]
        ])
      })
    )
    const stackA = snap.stacks.find((s) => s.id === 'a')!
    expect(stackA.volumes).toEqual([
      { name: 'a_mysql', sizeBytes: 100, shared: false },
      { name: 'b_external', sizeBytes: 20, shared: true },
      { name: 'shared_cache', sizeBytes: 50, shared: true }
    ])
    expect(stackA.volumeBytes).toBe(100)
  })

  it('totals what the hero, the meter and the bulk button show', () => {
    const zombieRun = composeContainer('z1', WT, { ports: [8080, 8081] })
    const orphanRun = composeContainer('o1', GONE, { ports: [8081] })
    const zombieOff = composeContainer('z2', WT2, {
      state: 'exited',
      finishedAt: NOW - 5 * DAY,
      mounts: [{ type: 'volume', source: '', name: 'z2_db' }]
    })
    const protectedRun = composeContainer('m1', MAIN, { ports: [80] })
    const snap = buildSnapshot(
      scanInput({
        containers: [protectedRun, zombieOff, orphanRun, zombieRun],
        memById: new Map([
          [zombieRun.id, 100],
          [orphanRun.id, 50],
          [protectedRun.id, 70]
        ]),
        volumes: new Map([['z2_db', { sizeBytes: 1000, project: 'z2' }]])
      })
    )
    expect(snap.stacks.map((s) => [s.id, s.verdict])).toEqual([
      ['z1', 'zombie'],
      ['z2', 'zombie'],
      ['o1', 'orphan'],
      ['m1', 'protected']
    ])
    expect(snap.totals).toEqual({
      zombieRamBytes: 150,
      zombiePorts: 2,
      volumeBytesAtStake: 1000,
      ramByVerdict: { unknown: 0, orphan: 50, active: 0, protected: 70, pending: 0, zombie: 100 },
      needsYou: 3,
      stoppable: 2
    })
    expect(snap).toMatchObject({ dockerAvailable: true, scannedAt: NOW, zombieAfterDays: 2 })
  })
})

describe('docker unavailable (PRD §5)', () => {
  it('says so instead of reporting an empty machine', () => {
    const snap = unavailableSnapshot('Cannot connect to the Docker daemon', NOW, 2, [])
    expect(snap).toEqual({
      scannedAt: NOW,
      dockerAvailable: false,
      dockerError: 'Cannot connect to the Docker daemon',
      zombieAfterDays: 2,
      recent: []
    })
    expect('stacks' in snap).toBe(false)
    expect('totals' in snap).toBe(false)
    expect(unavailableSnapshot('  ', NOW, 2, []).dockerError).toBe('docker is unavailable')
  })
})
