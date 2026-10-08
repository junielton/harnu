import { describe, it, expect } from 'vitest'
import {
  explicitProjectNames,
  makeDirExists,
  orphanVolumeItems,
  protectedProjects,
  statExistence,
  toHousekeepingVolumes,
  volumeGuards
} from '../src/main/gc/gc-housekeeping-input'
import {
  normalizeComposeProjectName,
  planHousekeeping,
  type HousekeepingParams
} from '../src/main/gc/housekeeping-core'
import {
  COMPOSE_PROJECT_LABEL,
  COMPOSE_WORKING_DIR_LABEL,
  type InspectedContainer,
  type VolumeFact
} from '../src/main/containers/containers-core'

const ORPHANS_ON: HousekeepingParams = {
  cacheMaxAgeDays: 7,
  danglingImages: true,
  orphanVolumes: true
}

/** A stopped compose container of `project` from `dir` that mounts no named volume. */
function stopped(project: string, dir: string): InspectedContainer {
  return {
    id: `${project}-id`.padEnd(64, '0'),
    name: `${project}-db-1`,
    image: 'postgres',
    labels: { [COMPOSE_PROJECT_LABEL]: project, [COMPOSE_WORKING_DIR_LABEL]: dir },
    state: 'exited',
    startedAt: null,
    finishedAt: null,
    createdAt: null,
    ports: [],
    mounts: []
  } as unknown as InspectedContainer
}

describe('normalizeComposeProjectName', () => {
  it.each([
    ['My-App', 'my-app'],
    ['proj.v2 final', 'projv2final'],
    ['_proj', 'proj'],
    ['-proj', 'proj'],
    ['__--proj_x', 'proj_x'],
    ['', ''],
    ['___', '']
  ])('%j → %j', (given, want) => {
    expect(normalizeComposeProjectName(given)).toBe(want)
  })
})

describe('explicitProjectNames: the names a folder pins for its compose project', () => {
  it('reads COMPOSE_PROJECT_NAME from .env', () => {
    expect(explicitProjectNames({ env: 'APP_ENV=local\nCOMPOSE_PROJECT_NAME=shop\n' })).toEqual([
      'shop'
    ])
  })

  it('accepts export, quotes, spaces and a trailing comment', () => {
    expect(explicitProjectNames({ env: 'export COMPOSE_PROJECT_NAME = "Shop-X"  # mine' })).toEqual(
      ['shop-x']
    )
    expect(explicitProjectNames({ env: "COMPOSE_PROJECT_NAME='shop'" })).toEqual(['shop'])
  })

  it('ignores a commented-out line', () => {
    expect(explicitProjectNames({ env: '# COMPOSE_PROJECT_NAME=shop' })).toEqual([])
  })

  it('reads the top-level name: of a compose file', () => {
    expect(explicitProjectNames({ compose: 'name: storefront\nservices:\n  db: {}\n' })).toEqual([
      'storefront'
    ])
  })

  it('does not read an indented name: (a service field)', () => {
    expect(explicitProjectNames({ compose: 'services:\n  db:\n    name: nope\n' })).toEqual([])
  })

  it('returns both when .env and the compose file name different projects', () => {
    expect(
      explicitProjectNames({ env: 'COMPOSE_PROJECT_NAME=a', compose: 'name: b' }).sort()
    ).toEqual(['a', 'b'])
  })

  it('trims a leading underscore or dash the way compose does', () => {
    expect(explicitProjectNames({ env: 'COMPOSE_PROJECT_NAME=_shop' })).toEqual(['shop'])
    expect(explicitProjectNames({ compose: 'name: -shop' })).toEqual(['shop'])
  })

  it('uses the default of an interpolated name, and skips one it cannot resolve', () => {
    expect(explicitProjectNames({ compose: 'name: ${STACK:-shop}' })).toEqual(['shop'])
    expect(explicitProjectNames({ compose: 'name: ${STACK}' })).toEqual([])
  })

  it('returns nothing for empty input', () => {
    expect(explicitProjectNames({})).toEqual([])
    expect(explicitProjectNames({ env: '', compose: '' })).toEqual([])
  })
})

describe('protectedProjects: only folders that still exist protect a name', () => {
  it('collects the explicit names of existing folders', () => {
    const set = protectedProjects(
      [
        { path: '/ws/a', env: 'COMPOSE_PROJECT_NAME=shop' },
        { path: '/ws/b', compose: 'name: api' },
        { path: '/ws/c' }
      ],
      () => true
    )
    expect([...set].sort()).toEqual(['api', 'shop'])
  })

  it('keeps a name whose folder is gone unprotected', () => {
    const set = protectedProjects(
      [{ path: '/ws/a', env: 'COMPOSE_PROJECT_NAME=shop' }],
      () => false
    )
    expect(set.size).toBe(0)
  })
})

describe('an explicit COMPOSE_PROJECT_NAME protects its volume (AC-6)', () => {
  // The working dir of the stack is gone, and its basename ("old-dir") matches nothing alive,
  // but a live checkout pins the same project name in its .env.
  const volumes = toHousekeepingVolumes(
    new Map<string, VolumeFact>([['shop_pgdata', { sizeBytes: 5_000, project: 'shop' }]])
  )
  const containers = [stopped('shop', '/ws/old-dir')]
  const gone = (p: string): boolean => !p.startsWith('/ws/old-dir')

  it('plans the volume when nothing pins the name', () => {
    const plan = planHousekeeping(ORPHANS_ON, volumes, containers, gone, ['/ws/live'])
    expect(plan.orphanVolumes).toEqual(['shop_pgdata'])
  })

  it('does not plan it when a known live folder pins the name', () => {
    const pinned = protectedProjects(
      [{ path: '/ws/live', env: 'COMPOSE_PROJECT_NAME=shop' }],
      () => true
    )
    const plan = planHousekeeping(ORPHANS_ON, volumes, containers, gone, ['/ws/live'], pinned)
    expect(plan.orphanVolumes).toEqual([])
  })

  it('trims a leading underscore of a default folder name before comparing', () => {
    const plan = planHousekeeping(ORPHANS_ON, volumes, containers, gone, ['/ws/_Shop'])
    expect(plan.orphanVolumes).toEqual([])
  })
})

describe('autopilot parameters never plan an orphan volume (AC-6)', () => {
  it('plans none when orphanVolumes is false, whatever the data', () => {
    const volumes = toHousekeepingVolumes(
      new Map<string, VolumeFact>([['gone_data', { sizeBytes: 1, project: 'gone' }]])
    )
    const plan = planHousekeeping(
      { ...ORPHANS_ON, orphanVolumes: false },
      volumes,
      [stopped('gone', '/ws/old-dir')],
      () => false,
      []
    )
    expect(plan.orphanVolumes).toEqual([])
  })
})

describe('makeDirExists: a path that cannot be proven gone exists (AC-6)', () => {
  it('answers from the stat results for a path that was checked', () => {
    const exists = makeDirExists(new Set(['/a', '/b']), new Set(['/a']))
    expect(exists('/a')).toBe(true)
    expect(exists('/b')).toBe(false)
  })

  it('treats a path nobody checked as existing', () => {
    expect(makeDirExists(new Set(), new Set())('/never-asked')).toBe(true)
  })
})

describe('statExistence: only a missing entry proves a folder gone (AC-6)', () => {
  const failing = (code: string) => async () => {
    throw Object.assign(new Error(code), { code })
  }

  it('says gone for ENOENT and ENOTDIR', async () => {
    for (const code of ['ENOENT', 'ENOTDIR']) {
      const r = await statExistence(['/x'], failing(code))
      expect(r.existing.has('/x')).toBe(false)
      expect(r.checked.has('/x')).toBe(true)
    }
  })

  it.each(['EACCES', 'EIO', 'ETIMEDOUT', 'EPERM'])('says exists for %s', async (code) => {
    const r = await statExistence(['/x'], failing(code))
    expect(r.existing.has('/x')).toBe(true)
  })

  it('says exists when the stat succeeds', async () => {
    const r = await statExistence(['/x', '/x'], async () => undefined)
    expect([...r.existing]).toEqual(['/x'])
  })

  it('treats an error without a code as existing', async () => {
    const r = await statExistence(['/x'], async () => {
      throw new Error('remote docker context')
    })
    expect(r.existing.has('/x')).toBe(true)
  })
})

describe('toHousekeepingVolumes', () => {
  it('maps the df scan to named volumes with their sizes', () => {
    const out = toHousekeepingVolumes(
      new Map<string, VolumeFact>([
        ['a', { sizeBytes: 10, project: 'p' }],
        ['b', { sizeBytes: null, project: null }]
      ])
    )
    expect(out).toEqual([
      { name: 'a', sizeBytes: 10, project: 'p' },
      { name: 'b', sizeBytes: null, project: null }
    ])
  })
})

describe('orphanVolumeItems: the review entries for orphan volumes (AC-7)', () => {
  const df = new Map<string, VolumeFact>([
    ['shop_pgdata', { sizeBytes: 5_000, project: 'shop' }],
    ['other', { sizeBytes: 1, project: 'other' }]
  ])

  it('carries the size, the compose project and the reason "no known worktree"', () => {
    const items = orphanVolumeItems(['shop_pgdata'], df)
    expect(items).toEqual([
      {
        id: 'volume:shop_pgdata',
        name: 'shop_pgdata',
        sizeBytes: 5_000,
        project: 'shop',
        reason: {
          code: 'no-known-worktree',
          detail: 'No known worktree uses the compose project "shop".'
        }
      }
    ])
  })

  it('sorts by size, biggest first', () => {
    const items = orphanVolumeItems(['other', 'shop_pgdata'], df)
    expect(items.map((i) => i.name)).toEqual(['shop_pgdata', 'other'])
  })

  it('falls back to a null size and project for an unknown name', () => {
    const [item] = orphanVolumeItems(['mystery'], df)
    expect(item).toMatchObject({ sizeBytes: null, project: null })
  })
})

describe('volumeGuards: what keeps a bundle from owning a volume (delta 1, item 1)', () => {
  it('lists the existing folders and the explicit names they pin', () => {
    const g = volumeGuards(
      [
        { path: '/ws/a', env: 'COMPOSE_PROJECT_NAME=shop' },
        { path: '/ws/gone', env: 'COMPOSE_PROJECT_NAME=lost' },
        { path: '/ws/b', compose: 'name: api' }
      ],
      (p) => p !== '/ws/gone'
    )
    expect(g.knownFolders).toEqual(['/ws/a', '/ws/b'])
    expect([...g.protectedProjects].sort()).toEqual(['api', 'shop'])
  })

  it('adds the trimmed default name of a folder that starts with an underscore or dash', () => {
    const g = volumeGuards(
      [{ path: '/ws/_Shop' }, { path: '/ws/-api' }, { path: '/ws/plain' }],
      () => true
    )
    expect([...g.protectedProjects].sort()).toEqual(['api', 'shop'])
  })

  it('treats a path it cannot prove gone as existing, through the predicate it is given', () => {
    const exists = makeDirExists(new Set(['/ws/a']), new Set())
    const g = volumeGuards([{ path: '/ws/a' }, { path: '/ws/unchecked' }], exists)
    expect(g.knownFolders).toEqual(['/ws/unchecked'])
  })
})
