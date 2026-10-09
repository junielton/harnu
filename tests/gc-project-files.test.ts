import { describe, it, expect } from 'vitest'
import {
  collectProjectFiles,
  isComposeFile,
  isEnvFile,
  scanProjectFiles,
  projectNamesFromFiles,
  type FsProbe
} from '../src/main/gc/gc-project-files'
import { hiddenWhenCandidates, volumeGuards } from '../src/main/gc/gc-housekeeping-input'
import {
  planHousekeeping,
  unownedVolumeCount,
  type HousekeepingVolume
} from '../src/main/gc/housekeeping-core'
import {
  COMPOSE_PROJECT_LABEL,
  COMPOSE_WORKING_DIR_LABEL,
  type InspectedContainer
} from '../src/main/containers/containers-core'

/** A fake filesystem: path → file text, or a directory listed by its children. */
function fake(tree: Record<string, string | null>): FsProbe {
  const children = (dir: string): string[] =>
    [
      ...new Set(
        Object.keys(tree)
          .filter((p) => p.startsWith(`${dir}/`))
          .map((p) => p.slice(dir.length + 1).split('/')[0]!)
      )
    ].sort()
  return {
    readdir: async (dir) =>
      children(dir).map((name) => ({ name, isDir: tree[`${dir}/${name}`] === undefined })),
    readFile: async (p) => (typeof tree[p] === 'string' ? (tree[p] as string) : undefined)
  }
}

describe('which files are read', () => {
  it.each([
    ['.env', true],
    ['.env.local', false],
    ['env', false],
    ['x.env', false]
  ])('isEnvFile(%j) = %j', (name, want) => expect(isEnvFile(name)).toBe(want))

  it.each([
    ['compose.yaml', true],
    ['compose.yml', true],
    ['compose.prod.yml', true],
    ['docker-compose.yml', true],
    ['docker-compose.override.yaml', true],
    ['docker-compose.json', false],
    ['my-compose.yml', false],
    ['values.yaml', false]
  ])('isComposeFile(%j) = %j', (name, want) => expect(isComposeFile(name)).toBe(want))
})

describe('collectProjectFiles: down to depth 3 under a folder (delta 3b, item 10)', () => {
  const tree = {
    '/ws/a/.env': 'COMPOSE_PROJECT_NAME=root',
    '/ws/a/compose.yml': 'name: root-c',
    '/ws/a/docker/compose.yml': 'name: shop',
    '/ws/a/docker/.env': 'X=1',
    '/ws/a/ops/prod/stack/docker-compose.yaml': 'name: deep',
    '/ws/a/ops/prod/stack/too/deep/compose.yml': 'name: depth-five',
    '/ws/a/node_modules/pkg/compose.yml': 'name: skipped',
    '/ws/a/vendor/x/compose.yml': 'name: skipped',
    '/ws/a/.git/compose.yml': 'name: skipped',
    '/ws/a/.venv/compose.yml': 'name: skipped',
    '/ws/a/readme.md': 'hi'
  }

  it('finds .env and compose files at the root and down to three levels', async () => {
    const files = await collectProjectFiles('/ws/a', fake(tree))
    expect(files.map((f) => f.path).sort()).toEqual([
      '/ws/a/.env',
      '/ws/a/compose.yml',
      '/ws/a/docker/.env',
      '/ws/a/docker/compose.yml',
      '/ws/a/ops/prod/stack/docker-compose.yaml'
    ])
  })

  it('does not descend into node_modules, vendor, .git or .venv', async () => {
    const files = await collectProjectFiles('/ws/a', fake(tree))
    expect(files.some((f) => /node_modules|vendor|\.git|\.venv/.test(f.path))).toBe(false)
  })

  it('reads only the files it needs', async () => {
    const read: string[] = []
    const probe = fake(tree)
    await collectProjectFiles('/ws/a', {
      ...probe,
      readFile: async (p) => {
        read.push(p)
        return probe.readFile(p)
      }
    })
    expect(read).not.toContain('/ws/a/readme.md')
    expect(read.some((p) => p.includes('depth-five') || p.includes('/too/'))).toBe(false)
  })

  it('tags each file with its kind and folder', async () => {
    const files = await collectProjectFiles('/ws/a', fake(tree))
    expect(files.find((f) => f.path === '/ws/a/docker/compose.yml')).toMatchObject({
      dir: '/ws/a/docker',
      kind: 'compose',
      text: 'name: shop'
    })
  })

  it('survives a folder it cannot list or a file it cannot read', async () => {
    const probe: FsProbe = {
      readdir: async (dir) => {
        if (dir === '/ws/a')
          return [
            { name: 'compose.yml', isDir: false },
            { name: 'x', isDir: true }
          ]
        throw new Error('EACCES')
      },
      readFile: async () => undefined
    }
    expect(await collectProjectFiles('/ws/a', probe)).toEqual([])
  })

  it('caps how many files one folder can contribute', async () => {
    const many: Record<string, string> = {}
    for (let i = 0; i < 200; i++) many[`/ws/b/d${i}/compose.yml`] = `name: n${i}`
    const files = await collectProjectFiles('/ws/b', fake(many))
    expect(files.length).toBeLessThanOrEqual(100)
  })
})

describe('projectNamesFromFiles', () => {
  const file = (dir: string, kind: 'env' | 'compose', text: string) => ({
    path: `${dir}/${kind === 'env' ? '.env' : 'compose.yml'}`,
    dir,
    kind,
    text
  })

  it('reads COMPOSE_PROJECT_NAME from an .env in a subfolder', () => {
    const out = projectNamesFromFiles([file('/ws/a/docker', 'env', 'COMPOSE_PROJECT_NAME=shop')])
    expect(out).toEqual({ names: ['shop'], unresolved: false })
  })

  it('reads name: from a compose file in a subfolder', () => {
    const out = projectNamesFromFiles([file('/ws/a/docker', 'compose', 'name: shop\nservices: {}')])
    expect(out).toEqual({ names: ['shop'], unresolved: false })
  })

  it('resolves ${VAR} from the sibling .env', () => {
    const out = projectNamesFromFiles([
      file('/ws/a/docker', 'compose', 'name: ${STACK}'),
      file('/ws/a/docker', 'env', 'STACK=shop')
    ])
    expect(out).toEqual({ names: ['shop'], unresolved: false })
  })

  it('resolves ${VAR:-default} with the sibling value first, the default second', () => {
    expect(
      projectNamesFromFiles([
        file('/d', 'compose', 'name: ${STACK:-fallback}'),
        file('/d', 'env', 'STACK=shop')
      ]).names
    ).toEqual(['shop'])
    expect(
      projectNamesFromFiles([file('/d', 'compose', 'name: ${STACK:-fallback}')]).names
    ).toEqual(['fallback'])
  })

  it('does not take a variable from an .env in another folder', () => {
    const out = projectNamesFromFiles([
      file('/ws/a/docker', 'compose', 'name: ${STACK}'),
      file('/ws/a', 'env', 'STACK=shop')
    ])
    expect(out).toEqual({ names: [], unresolved: true })
  })

  it('marks the folder unresolved when a name cannot be resolved', () => {
    const out = projectNamesFromFiles([file('/d', 'compose', 'name: ${NOPE}')])
    expect(out).toEqual({ names: [], unresolved: true })
  })

  it('keeps the names it could read next to the one it could not', () => {
    const out = projectNamesFromFiles([
      file('/d', 'compose', 'name: ${NOPE}'),
      file('/e', 'compose', 'name: api')
    ])
    expect(out).toEqual({ names: ['api'], unresolved: true })
  })

  it('has nothing for no files', () => {
    expect(projectNamesFromFiles([])).toEqual({ names: [], unresolved: false })
  })
})

describe('a name pinned in a subfolder protects its volume (delta 3b, item 10)', () => {
  const stopped = (project: string, dir: string): InspectedContainer =>
    ({
      id: 'c'.repeat(64),
      name: `${project}-db-1`,
      image: 'postgres',
      labels: { [COMPOSE_PROJECT_LABEL]: project, [COMPOSE_WORKING_DIR_LABEL]: dir },
      state: 'exited',
      startedAt: null,
      finishedAt: null,
      createdAt: null,
      ports: [],
      mounts: []
    }) as InspectedContainer
  const volumes: HousekeepingVolume[] = [{ name: 'shop_db', project: 'shop', sizeBytes: 5 }]
  const gone = (p: string): boolean => !p.startsWith('/ws/old')
  const orphans = { cacheMaxAgeDays: 7, danglingImages: false, orphanVolumes: true }

  it('docker/compose.yml with name: shop protects shop_db', () => {
    const live = {
      path: '/ws/live',
      files: [
        {
          path: '/ws/live/docker/compose.yml',
          dir: '/ws/live/docker',
          kind: 'compose' as const,
          text: 'name: shop'
        }
      ]
    }
    const unguarded = volumeGuards([{ path: '/ws/live' }], gone)
    expect(
      planHousekeeping(
        orphans,
        volumes,
        [stopped('shop', '/ws/old')],
        gone,
        unguarded.knownFolders,
        unguarded.protectedProjects
      ).orphanVolumes
    ).toEqual(['shop_db'])

    const g = volumeGuards([live], gone)
    expect(g.protectedProjects.has('shop')).toBe(true)
    expect(
      planHousekeeping(
        orphans,
        volumes,
        [stopped('shop', '/ws/old')],
        gone,
        g.knownFolders,
        g.protectedProjects
      ).orphanVolumes
    ).toEqual([])
  })

  it('an unresolved name protects every volume, since none is provably foreign', () => {
    const live = {
      path: '/ws/live',
      files: [
        {
          path: '/ws/live/d/compose.yml',
          dir: '/ws/live/d',
          kind: 'compose' as const,
          text: 'name: ${WHO}'
        }
      ]
    }
    const g = volumeGuards([live], gone)
    expect(g.unresolved).toBe(true)
    const plan = planHousekeeping(
      orphans,
      volumes,
      [stopped('shop', '/ws/old')],
      gone,
      g.knownFolders,
      g.protectedProjects,
      new Map(),
      g.unresolved
    )
    expect(plan.orphanVolumes).toEqual([])
  })

  it('a folder that no longer exists pins nothing, resolved or not', () => {
    const g = volumeGuards(
      [
        {
          path: '/ws/old',
          files: [{ path: '/ws/old/c.yml', dir: '/ws/old', kind: 'compose', text: 'name: ${X}' }]
        }
      ],
      gone
    )
    expect(g.unresolved).toBe(false)
    expect(g.protectedProjects.size).toBe(0)
  })
})

describe('scanProjectFiles reports when a cap cut the scan short (delta 4, N5)', () => {
  const many = (n: number): Record<string, string> => {
    const t: Record<string, string> = {}
    for (let i = 0; i < n; i++) t[`/ws/b/d${i}/compose.yml`] = `name: n${i}`
    return t
  }

  it('is not truncated on an ordinary folder', async () => {
    const out = await scanProjectFiles(
      '/ws/a',
      fake({ '/ws/a/compose.yml': 'name: a', '/ws/a/x/.env': 'A=1' })
    )
    expect(out.truncated).toBe(false)
    expect(out.files).toHaveLength(2)
  })

  it('is truncated when more matching files exist than the file cap lets through', async () => {
    const out = await scanProjectFiles('/ws/b', fake(many(200)))
    expect(out.files.length).toBeLessThanOrEqual(100)
    expect(out.truncated).toBe(true)
  })

  it('is not truncated when the files fit exactly in the cap', async () => {
    const out = await scanProjectFiles('/ws/b', fake(many(100)))
    expect(out.files).toHaveLength(100)
    expect(out.truncated).toBe(false)
  })

  it('is truncated when a folder has more entries than the entry cap', async () => {
    const probe: FsProbe = {
      readdir: async () => Array.from({ length: 600 }, (_, i) => ({ name: `f${i}`, isDir: false })),
      readFile: async () => undefined
    }
    expect((await scanProjectFiles('/ws/c', probe)).truncated).toBe(true)
  })

  it('is truncated when a matching file cannot be read: too large, or gone', async () => {
    const probe: FsProbe = {
      readdir: async () => [{ name: 'compose.yml', isDir: false }],
      readFile: async () => undefined
    }
    const out = await scanProjectFiles('/ws/d', probe)
    expect(out.files).toEqual([])
    expect(out.truncated).toBe(true)
  })

  it('ignores a file that is not a project file, however large', async () => {
    const probe: FsProbe = {
      readdir: async () => [{ name: 'big.log', isDir: false }],
      readFile: async () => undefined
    }
    expect((await scanProjectFiles('/ws/e', probe)).truncated).toBe(false)
  })

  it('collectProjectFiles still returns just the files', async () => {
    expect(await collectProjectFiles('/ws/b', fake(many(3)))).toHaveLength(3)
  })
})

describe('a truncated scan hides orphan volumes (delta 4, N5)', () => {
  const gone = (p: string): boolean => !p.startsWith('/ws/old')
  it('marks the folder unresolved, keeping the names it did read', () => {
    const g = volumeGuards(
      [
        {
          path: '/ws/live',
          truncated: true,
          files: [{ path: '/ws/live/c.yml', dir: '/ws/live', kind: 'compose', text: 'name: shop' }]
        }
      ],
      gone
    )
    expect(g.unresolved).toBe(true)
    expect(g.protectedProjects.has('shop')).toBe(true)
  })

  it('names the folder and the reason', () => {
    const g = volumeGuards([{ path: '/ws/live', truncated: true }, { path: '/ws/ok' }], gone)
    expect(g.hidden).toEqual({ reason: 'scan-limit', folders: ['/ws/live'] })
  })

  it('an unresolved name is reported before a scan limit', () => {
    const g = volumeGuards(
      [
        { path: '/ws/a', truncated: true },
        {
          path: '/ws/b',
          files: [{ path: '/ws/b/c.yml', dir: '/ws/b', kind: 'compose', text: 'name: ${WHO}' }]
        }
      ],
      gone
    )
    expect(g.hidden).toEqual({ reason: 'unresolved-compose-name', folders: ['/ws/b'] })
  })

  it('is null when nothing is hidden, and a folder that is gone hides nothing', () => {
    expect(volumeGuards([{ path: '/ws/ok' }], gone).hidden).toBeNull()
    expect(volumeGuards([{ path: '/ws/old/x', truncated: true }], gone).hidden).toBeNull()
  })
})

describe('the hidden warning needs a volume it could be hiding', () => {
  const container = (volume: string): InspectedContainer => ({
    id: 'c1',
    name: 'shop-mysql-1',
    image: 'mysql',
    labels: { [COMPOSE_PROJECT_LABEL]: 'shop' },
    state: 'running',
    startedAt: null,
    finishedAt: null,
    createdAt: null,
    ports: [],
    mounts: [{ type: 'volume', source: `/var/lib/docker/volumes/${volume}/_data`, name: volume }]
  })
  const vol = (name: string, project: string | null): HousekeepingVolume => ({
    name,
    sizeBytes: 10,
    project
  })
  const unresolved = { reason: 'unresolved-compose-name' as const, folders: ['/ws/a'] }

  it('counts only labelled volumes that no container, running or stopped, uses', () => {
    const volumes = [vol('shop_mysql', 'shop'), vol('old_data', 'old'), vol('anon', null)]
    expect(unownedVolumeCount(volumes, [container('shop_mysql')])).toBe(1)
    expect(unownedVolumeCount(volumes, [])).toBe(2)
  })

  it('does not show hidden when every volume belongs to a live stack, even with an unresolved name', () => {
    const volumes = [vol('shop_mysql', 'shop'), vol('shop_redis', 'shop')]
    const containers = [container('shop_mysql'), container('shop_redis')]
    expect(hiddenWhenCandidates(unresolved, volumes, containers)).toBeNull()
  })

  it('does not show hidden when docker has no volumes at all', () => {
    expect(hiddenWhenCandidates(unresolved, [], [])).toBeNull()
  })

  it('still shows hidden when an unowned volume exists and a name is unresolved', () => {
    const volumes = [vol('shop_mysql', 'shop'), vol('old_data', 'old')]
    expect(hiddenWhenCandidates(unresolved, volumes, [container('shop_mysql')])).toEqual(unresolved)
  })

  it('stays null when nothing is hidden to begin with', () => {
    expect(hiddenWhenCandidates(null, [vol('old_data', 'old')], [])).toBeNull()
  })
})
