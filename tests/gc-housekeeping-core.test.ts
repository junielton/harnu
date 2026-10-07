import { describe, it, expect } from 'vitest'
import {
  COMPOSE_PROJECT_LABEL,
  COMPOSE_WORKING_DIR_LABEL,
  type InspectedContainer
} from '../src/main/containers/containers-core'
import {
  housekeepingArgv,
  parseReclaimed,
  planHousekeeping,
  type HousekeepingParams,
  type HousekeepingPlan,
  type HousekeepingVolume
} from '../src/main/gc/housekeeping-core'

const DIR = '/home/dev/org/proj/www'
const DIR_B = '/home/dev/org/proj/www-b'
const ALL_ON: HousekeepingParams = { cacheMaxAgeDays: 7, danglingImages: true, orphanVolumes: true }

function container(over: Partial<InspectedContainer> = {}): InspectedContainer {
  return {
    id: 'c0ffee000001',
    name: 'api-gateway-app-1',
    image: 'busybox',
    labels: {},
    state: 'running',
    startedAt: 1_000,
    finishedAt: null,
    createdAt: 500,
    ports: [],
    mounts: [{ type: 'volume', source: '/var/lib/docker/volumes/x/_data', name: 'x' }],
    ...over
  }
}

/** A compose container of `project` whose working dir label is `dir`. */
function composeContainer(
  project: string,
  dir: string | null,
  over: Partial<InspectedContainer> = {}
): InspectedContainer {
  return container({
    labels: {
      [COMPOSE_PROJECT_LABEL]: project,
      ...(dir ? { [COMPOSE_WORKING_DIR_LABEL]: dir } : {})
    },
    ...over
  })
}

function volume(name: string, project: string | null): HousekeepingVolume {
  return { name, project, sizeBytes: 1_000 }
}

/** Mount of the named volume, as `docker inspect` reports it. */
function mountOf(name: string): InspectedContainer['mounts'][number] {
  return { type: 'volume', source: `/var/lib/docker/volumes/${name}/_data`, name }
}

const dirGone = (): boolean => false
const dirAlive = (): boolean => true

describe('parseReclaimed', () => {
  it('parses a zero size', () => {
    expect(parseReclaimed('0B')).toBe(0)
  })

  it('parses a bare byte count', () => {
    expect(parseReclaimed('512B')).toBe(512)
  })

  it('parses decimal units as powers of 1000', () => {
    expect(parseReclaimed('512kB')).toBe(512_000)
    expect(parseReclaimed('1.2GB')).toBe(1.2e9)
  })

  it('parses binary units as powers of 1024', () => {
    expect(parseReclaimed('3.4GiB')).toBe(Math.round(3.4 * 1024 ** 3))
  })

  it('reads the Total reclaimed space line of image and volume prune', () => {
    expect(parseReclaimed('Deleted Images:\nuntagged: x\n\nTotal reclaimed space: 1.2GB\n')).toBe(
      1.2e9
    )
    expect(parseReclaimed('Total reclaimed space: 1.2GB')).toBe(1.2e9)
  })

  it('reads the builder prune Total line after the id lines', () => {
    const out = 'k8w7q0z1d2f3\nm9n8b7v6c5x4\nTotal:\t512MB\n'
    expect(parseReclaimed(out)).toBe(5.12e8)
  })

  it('returns 0 for malformed output instead of throwing', () => {
    expect(parseReclaimed('')).toBe(0)
    expect(parseReclaimed('nope')).toBe(0)
    expect(parseReclaimed('Total reclaimed space: lots')).toBe(0)
    expect(parseReclaimed('5iB')).toBe(0)
  })

  it('does not mistake a volume name ending in a size for a size', () => {
    expect(parseReclaimed('cache2GB')).toBe(0)
  })
})

describe('planHousekeeping: orphan volumes', () => {
  it('never plans a volume that carries no compose project label', () => {
    const plan = planHousekeeping(ALL_ON, [volume('scratch-data', null)], [], dirGone, [])
    expect(plan.orphanVolumes).toEqual([])
  })

  it('never plans a labeled volume whose project working dir still exists', () => {
    const volumes = [volume('proj_db', 'proj')]
    const containers = [composeContainer('proj', DIR)]
    const plan = planHousekeeping(ALL_ON, volumes, containers, dirAlive, [])
    expect(plan.orphanVolumes).toEqual([])
  })

  it('never plans a volume mounted by a running container, even if its dir is gone', () => {
    const volumes = [volume('proj_db', 'proj')]
    const containers = [
      composeContainer('proj', DIR, { state: 'running', mounts: [mountOf('proj_db')] })
    ]
    const plan = planHousekeeping(ALL_ON, volumes, containers, dirGone, [])
    expect(plan.orphanVolumes).toEqual([])
  })

  it('never plans a volume mounted by a stopped container, even if its dir is gone', () => {
    const volumes = [volume('proj_db', 'proj')]
    const containers = [
      composeContainer('proj', DIR, {
        state: 'exited',
        finishedAt: 2_000,
        mounts: [mountOf('proj_db')]
      })
    ]
    const plan = planHousekeeping(ALL_ON, volumes, containers, dirGone, [])
    expect(plan.orphanVolumes).toEqual([])
  })

  it('plans a labeled, unreferenced volume whose working dir is gone', () => {
    const volumes = [volume('proj_db', 'proj')]
    const containers = [composeContainer('proj', DIR, { mounts: [mountOf('proj_cache')] })]
    const plan = planHousekeeping(ALL_ON, volumes, containers, dirGone, [])
    expect(plan.orphanVolumes).toEqual(['proj_db'])
  })

  it('plans only the unreferenced volumes of a project when siblings are still mounted', () => {
    const volumes = [volume('proj_db', 'proj'), volume('proj_cache', 'proj')]
    const containers = [composeContainer('proj', DIR, { mounts: [mountOf('proj_cache')] })]
    const plan = planHousekeeping(ALL_ON, volumes, containers, dirGone, [])
    expect(plan.orphanVolumes).toEqual(['proj_db'])
  })

  it.each([
    ['live dir listed last', [DIR, DIR_B]],
    ['live dir listed first', [DIR_B, DIR]]
  ])(
    'does not plan a project with several working dirs while one of them still exists (%s)',
    (_label, dirs) => {
      const volumes = [volume('proj_db', 'proj')]
      const containers = dirs.map((d, i) => composeContainer('proj', d, { id: `c0ffee00000${i}` }))
      const aliveOnlyB = (p: string): boolean => p === DIR_B
      const plan = planHousekeeping(ALL_ON, volumes, containers, aliveOnlyB, [])
      expect(plan.orphanVolumes).toEqual([])
    }
  )

  it('never plans a volume mounted by a plain docker run container with no compose labels', () => {
    const volumes = [volume('proj_db', 'proj')]
    const containers = [
      composeContainer('proj', DIR, { mounts: [] }),
      container({ id: 'c0ffee000009', labels: {}, mounts: [mountOf('proj_db')] })
    ]
    const plan = planHousekeeping(ALL_ON, volumes, containers, dirGone, [])
    expect(plan.orphanVolumes).toEqual([])
  })

  it('does not plan a project when one of its containers carries no working dir label', () => {
    const volumes = [volume('proj_db', 'proj')]
    const containers = [
      composeContainer('proj', DIR, { id: 'c0ffee000001', mounts: [] }),
      composeContainer('proj', null, { id: 'c0ffee000002', mounts: [] })
    ]
    const plan = planHousekeeping(ALL_ON, volumes, containers, dirGone, [])
    expect(plan.orphanVolumes).toEqual([])
  })

  it('does not plan a project whose unlabeled container is listed before the labeled one', () => {
    const volumes = [volume('proj_db', 'proj')]
    const containers = [
      composeContainer('proj', null, { id: 'c0ffee000002', mounts: [] }),
      composeContainer('proj', DIR, { id: 'c0ffee000001', mounts: [] })
    ]
    const plan = planHousekeeping(ALL_ON, volumes, containers, dirGone, [])
    expect(plan.orphanVolumes).toEqual([])
  })

  it('plans a project with several working dirs once every one of them is gone', () => {
    const volumes = [volume('proj_db', 'proj')]
    const containers = [
      composeContainer('proj', DIR, { id: 'c0ffee000001' }),
      composeContainer('proj', DIR_B, { id: 'c0ffee000002' })
    ]
    const plan = planHousekeeping(ALL_ON, volumes, containers, dirGone, [])
    expect(plan.orphanVolumes).toEqual(['proj_db'])
  })

  it('does not plan a project whose working dir cannot be learned from any container', () => {
    const volumes = [volume('proj_db', 'proj'), volume('other_db', 'other')]
    const containers = [
      composeContainer('proj', null),
      container({ labels: {}, mounts: [] }),
      composeContainer('unrelated', DIR)
    ]
    const plan = planHousekeeping(ALL_ON, volumes, containers, dirGone, [])
    expect(plan.orphanVolumes).toEqual([])
  })

  it('does not plan a labeled volume when there are no containers at all', () => {
    const plan = planHousekeeping(ALL_ON, [volume('proj_db', 'proj')], [], dirGone, [])
    expect(plan.orphanVolumes).toEqual([])
  })

  it('never plans a hostile or odd volume name, even when it would otherwise be an orphan', () => {
    const volumes = [
      volume('-a', 'proj'),
      volume('--all', 'proj'),
      volume('a b', 'proj'),
      volume('', 'proj'),
      volume('_lead', 'proj'),
      volume('proj_db', 'proj')
    ]
    const containers = [composeContainer('proj', DIR, { mounts: [] })]
    const plan = planHousekeeping(ALL_ON, volumes, containers, dirGone, [])
    expect(plan.orphanVolumes).toEqual(['proj_db'])
  })

  it('returns no volumes when orphanVolumes is off', () => {
    const volumes = [volume('proj_db', 'proj')]
    const containers = [composeContainer('proj', DIR, { mounts: [] })]
    const plan = planHousekeeping(
      { ...ALL_ON, orphanVolumes: false },
      volumes,
      containers,
      dirGone,
      []
    )
    expect(plan.orphanVolumes).toEqual([])
  })
})

describe('planHousekeeping: a project name shared with a live checkout', () => {
  // Compose names a project after its folder, so /w/a/www and /w/b/www are both `www`.
  const LIVE = '/w/a/www'
  const DELETED = '/w/b/www'
  const volumes = [volume('www_pgdata', 'www')]
  // The live checkout ran `compose down`: only a leftover container of the deleted one remains.
  const containers = [composeContainer('www', DELETED, { mounts: [] })]
  const onlyLive = (p: string): boolean => p === LIVE

  it('never plans the volume of a live checkout that has no containers', () => {
    const plan = planHousekeeping(ALL_ON, volumes, containers, onlyLive, [LIVE])
    expect(plan.orphanVolumes).toEqual([])
  })

  it('plans it once no existing known folder shares the project name', () => {
    const plan = planHousekeeping(ALL_ON, volumes, containers, dirGone, [LIVE])
    expect(plan.orphanVolumes).toEqual(['www_pgdata'])
  })

  it('ignores known folders whose compose project name differs', () => {
    const plan = planHousekeeping(ALL_ON, volumes, containers, (p) => p === '/w/a/api-gateway', [
      '/w/a/api-gateway'
    ])
    expect(plan.orphanVolumes).toEqual(['www_pgdata'])
  })

  it('normalizes the folder name the way compose does: lowercase, only [a-z0-9_-]', () => {
    const vols = [volume('mywebapp_db', 'mywebapp'), volume('my-app_db', 'my-app')]
    const ctrs = [
      composeContainer('mywebapp', '/w/gone/mywebapp', { mounts: [] }),
      composeContainer('my-app', '/w/gone/my-app', { mounts: [] })
    ]
    const folders = ['/w/a/My Web.App', '/w/a/My-App/']
    const plan = planHousekeeping(ALL_ON, vols, ctrs, (p) => !p.startsWith('/w/gone'), folders)
    expect(plan.orphanVolumes).toEqual([])
  })

  it('reads the folder name from a Windows-style path too', () => {
    const plan = planHousekeeping(ALL_ON, volumes, containers, (p) => p === 'C:\\work\\WWW', [
      'C:\\work\\WWW'
    ])
    expect(plan.orphanVolumes).toEqual([])
  })
})

describe('planHousekeeping: build cache and images', () => {
  it('converts cacheMaxAgeDays to hours', () => {
    expect(planHousekeeping(ALL_ON, [], [], dirGone, []).builderPruneUntilHours).toBe(168)
    expect(
      planHousekeeping({ ...ALL_ON, cacheMaxAgeDays: 1 }, [], [], dirGone, [])
        .builderPruneUntilHours
    ).toBe(24)
  })

  it('disables the builder prune for zero, negative and NaN ages instead of pruning everything', () => {
    for (const days of [0, -1, Number.NaN]) {
      const plan = planHousekeeping({ ...ALL_ON, cacheMaxAgeDays: days }, [], [], dirGone, [])
      expect(plan.builderPruneUntilHours).toBeNull()
    }
  })

  it('passes danglingImages through unchanged', () => {
    expect(planHousekeeping(ALL_ON, [], [], dirGone, []).danglingImages).toBe(true)
    expect(
      planHousekeeping({ ...ALL_ON, danglingImages: false }, [], [], dirGone, []).danglingImages
    ).toBe(false)
  })
})

describe('housekeepingArgv', () => {
  it('builds the exact builder prune argv', () => {
    const plan: HousekeepingPlan = {
      builderPruneUntilHours: 168,
      danglingImages: false,
      orphanVolumes: []
    }
    expect(housekeepingArgv(plan)).toEqual([['builder', 'prune', '-f', '--filter', 'until=168h']])
  })

  it('builds the exact dangling image prune argv', () => {
    const plan: HousekeepingPlan = {
      builderPruneUntilHours: null,
      danglingImages: true,
      orphanVolumes: []
    }
    expect(housekeepingArgv(plan)).toEqual([['image', 'prune', '-f']])
  })

  it('builds one volume rm argv per orphan volume', () => {
    const plan: HousekeepingPlan = {
      builderPruneUntilHours: null,
      danglingImages: false,
      orphanVolumes: ['proj_db', 'proj_cache']
    }
    expect(housekeepingArgv(plan)).toEqual([
      ['volume', 'rm', 'proj_db'],
      ['volume', 'rm', 'proj_cache']
    ])
  })

  it('emits builder, image and volume commands in that order for a full plan', () => {
    const plan: HousekeepingPlan = {
      builderPruneUntilHours: 24,
      danglingImages: true,
      orphanVolumes: ['proj_db']
    }
    expect(housekeepingArgv(plan)).toEqual([
      ['builder', 'prune', '-f', '--filter', 'until=24h'],
      ['image', 'prune', '-f'],
      ['volume', 'rm', 'proj_db']
    ])
  })

  it('emits nothing for an empty plan', () => {
    const plan: HousekeepingPlan = {
      builderPruneUntilHours: null,
      danglingImages: false,
      orphanVolumes: []
    }
    expect(housekeepingArgv(plan)).toEqual([])
  })

  it('drops hostile entries of a hand-built plan and emits nothing for them', () => {
    const plan: HousekeepingPlan = {
      builderPruneUntilHours: Number.NaN,
      danglingImages: false,
      orphanVolumes: ['-a', '--all', 'a b', '']
    }
    expect(housekeepingArgv(plan)).toEqual([])
  })

  it('refuses a non-integer or non-positive until hours', () => {
    for (const hours of [Number.NaN, 0, -3, 1.5, Number.POSITIVE_INFINITY]) {
      const plan: HousekeepingPlan = {
        builderPruneUntilHours: hours,
        danglingImages: false,
        orphanVolumes: []
      }
      expect(housekeepingArgv(plan)).toEqual([])
    }
  })

  it('keeps the safe volume names of a mixed hand-built plan', () => {
    const plan: HousekeepingPlan = {
      builderPruneUntilHours: null,
      danglingImages: false,
      orphanVolumes: ['-a', 'proj_db', '--all']
    }
    expect(housekeepingArgv(plan)).toEqual([['volume', 'rm', 'proj_db']])
  })

  describe('never reaches for a broad prune (AC-1)', () => {
    const plans: Array<[string, HousekeepingPlan]> = [
      ['empty', { builderPruneUntilHours: null, danglingImages: false, orphanVolumes: [] }],
      ['cache only', { builderPruneUntilHours: 168, danglingImages: false, orphanVolumes: [] }],
      ['images only', { builderPruneUntilHours: null, danglingImages: true, orphanVolumes: [] }],
      [
        'volumes only',
        { builderPruneUntilHours: null, danglingImages: false, orphanVolumes: ['proj_db', 'x.y-z'] }
      ],
      [
        'all',
        {
          builderPruneUntilHours: 24,
          danglingImages: true,
          orphanVolumes: ['proj_db', 'proj_cache']
        }
      ],
      [
        'hostile names',
        {
          builderPruneUntilHours: 24,
          danglingImages: true,
          orphanVolumes: ['-a', '--all', '-af', 'a b', 'proj_db']
        }
      ],
      [
        'hostile until NaN',
        { builderPruneUntilHours: Number.NaN, danglingImages: true, orphanVolumes: ['-a'] }
      ],
      [
        'hostile until 0',
        { builderPruneUntilHours: 0, danglingImages: true, orphanVolumes: ['--all'] }
      ],
      [
        'hostile until 1.5',
        { builderPruneUntilHours: 1.5, danglingImages: true, orphanVolumes: ['-fa'] }
      ]
    ]

    it.each(plans)('plan shape "%s" emits only safe argvs', (_label, plan) => {
      const argvs = housekeepingArgv(plan)
      for (const argv of argvs) {
        expect(Array.isArray(argv)).toBe(true)
        expect(argv.length).toBeGreaterThan(0)
        for (const arg of argv) {
          expect(typeof arg).toBe('string')
          expect(arg).not.toBe('-a')
          expect(arg).not.toBe('--all')
          if (arg.startsWith('-') && !arg.startsWith('--')) {
            expect(arg).not.toMatch(/^-[a-zA-Z]*a/)
          }
        }
        expect(argv[0]).not.toBe('system')
        expect(argv[0]).not.toBe('prune')
      }
    })

    it('only ever emits builder prune, image prune or volume rm', () => {
      for (const [, plan] of plans) {
        for (const argv of housekeepingArgv(plan)) {
          const head = argv.slice(0, 2).join(' ')
          expect(['builder prune', 'image prune', 'volume rm']).toContain(head)
        }
      }
    })
  })
})
