import { describe, it, expect } from 'vitest'
import {
  DATABASE_IMAGES,
  composeFactsFor,
  confirmOnlyReason,
  isPausableVerdict,
  parseComposeConfig,
  pauseDownArgs
} from '../src/main/containers/park-core'
import { parseInspect } from '../src/main/containers/containers-core'
import { VERDICTS } from '../src/main/containers/containers-wire'
import { composeContainer, container, WT } from './containers-fixtures'

const ANON = 'f'.repeat(64)

function mount(destination: string, name: string | null = 'data', type = 'volume') {
  return { type, source: name ?? '/srv/x', name: type === 'volume' ? name : null, destination }
}

describe('inspect mounts carry their destination (U3.4)', () => {
  it('keeps where each mount lands inside the container', () => {
    const [c] = parseInspect(
      JSON.stringify([
        {
          Id: 'a'.repeat(64),
          Mounts: [
            { Type: 'volume', Name: 'pg', Source: '/v', Destination: '/var/lib/postgresql/data' },
            { Type: 'bind', Source: '/srv', Destination: '/app' }
          ]
        }
      ])
    )
    expect(c!.mounts.map((m) => m.destination)).toEqual(['/var/lib/postgresql/data', '/app'])
  })
})

describe('parseComposeConfig (U3.4 AC-2)', () => {
  it('reads profiles and build per service', () => {
    const out = parseComposeConfig(
      JSON.stringify({
        name: 'p',
        services: {
          web: { image: 'x', build: { context: '.' }, profiles: ['web'] },
          db: { image: 'postgres' }
        }
      })
    )
    expect(out).toEqual({
      web: { profiles: ['web'], build: true },
      db: { profiles: [], build: false }
    })
  })

  it('malformed output, or output with no services, is null — never an empty stack', () => {
    expect(parseComposeConfig('')).toBeNull()
    expect(parseComposeConfig('{')).toBeNull()
    expect(parseComposeConfig('[]')).toBeNull()
    expect(parseComposeConfig(JSON.stringify({ name: 'p' }))).toBeNull()
  })
})

describe('composeFactsFor (U3.4 AC-2)', () => {
  const base = {
    project: 'proj-1',
    workingDir: '/w',
    configFiles: ['/w/compose.yml'],
    envFile: '/w/.env'
  }

  it('image-only stack: no profiles, no build', () => {
    expect(
      composeFactsFor({
        ...base,
        services: { app: { profiles: [], build: false } },
        runningServices: ['app']
      })
    ).toEqual({ ...base, profiles: [], hasBuild: false })
  })

  it('a stack with a build: section needs --build', () => {
    const f = composeFactsFor({
      ...base,
      services: { app: { profiles: [], build: true }, db: { profiles: [], build: false } },
      runningServices: ['app', 'db']
    })
    expect(f.hasBuild).toBe(true)
  })

  it('profiles are the union of the running services profiles, sorted', () => {
    const f = composeFactsFor({
      ...base,
      services: {
        app: { profiles: [], build: false },
        worker: { profiles: ['jobs', 'web'], build: false },
        debug: { profiles: ['debug'], build: false }
      },
      runningServices: ['app', 'worker']
    })
    expect(f.profiles).toEqual(['jobs', 'web'])
  })

  it('a build: in a service the restore would not start does not add --build', () => {
    const f = composeFactsFor({
      ...base,
      services: {
        app: { profiles: [], build: false },
        debug: { profiles: ['debug'], build: true }
      },
      runningServices: ['app']
    })
    expect(f.hasBuild).toBe(false)
    // …but it does once its profile was active
    expect(
      composeFactsFor({
        ...base,
        services: {
          app: { profiles: [], build: false },
          debug: { profiles: ['debug'], build: true }
        },
        runningServices: ['app', 'debug']
      })
    ).toMatchObject({ profiles: ['debug'], hasBuild: true })
  })
})

describe('pauseDownArgs (U3.4 AC-1)', () => {
  const facts = {
    project: 'proj-1',
    workingDir: '/w d',
    configFiles: ['/w d/a.yml', '/w d/b.yml'],
    profiles: ['web'],
    envFile: '/w d/.env',
    hasBuild: true
  }

  it('is compose down with the project, directory and files — nothing else', () => {
    expect(pauseDownArgs(facts)).toEqual([
      'compose',
      '-p',
      'proj-1',
      '--project-directory',
      '/w d',
      '-f',
      '/w d/a.yml',
      '-f',
      '/w d/b.yml',
      'down'
    ])
  })

  it('never removes volumes or images', () => {
    const args = pauseDownArgs(facts)
    for (const flag of ['-v', '--volumes', '--rmi', '--force', '--remove-orphans']) {
      expect(args).not.toContain(flag)
    }
  })
})

describe('isPausableVerdict', () => {
  it('only zombie and pending stacks can be paused', () => {
    const ok = VERDICTS.filter(isPausableVerdict)
    expect(ok.sort()).toEqual(['pending', 'zombie'])
  })
})

describe('confirmOnlyReason (U3.4 AC-4)', () => {
  it('an anonymous volume makes the stack confirm-only', () => {
    const c = composeContainer('p', WT, { mounts: [mount('/tmp/scratch', ANON)] })
    expect(confirmOnlyReason([c])).toMatch(/anonymous volume/)
  })

  it('a named volume or a bind mount on a plain image is fine', () => {
    const c = composeContainer('p', WT, {
      image: 'nginx:1.27',
      mounts: [mount('/data', 'named'), mount('/etc/conf', null, 'bind')]
    })
    expect(confirmOnlyReason([c])).toBeNull()
  })

  it('an image with no volumes at all is fine when it is not a database', () => {
    expect(confirmOnlyReason([container({ image: 'busybox' })])).toBeNull()
  })

  it.each([
    ['postgres:16', '/var/lib/postgresql/data'],
    ['docker.io/library/postgres:16-alpine', '/var/lib/postgresql/data'],
    ['mysql:8', '/var/lib/mysql'],
    ['mariadb:11', '/var/lib/mysql'],
    ['mongo:7', '/data/db'],
    ['redis:7', '/data'],
    ['docker.elastic.co/elasticsearch/elasticsearch:8.15.0', '/usr/share/elasticsearch/data'],
    ['opensearchproject/opensearch:2', '/usr/share/opensearch/data'],
    ['rabbitmq:3-management', '/var/lib/rabbitmq']
  ])('%s: confirm-only without a mount on %s, fine with one', (image, dataPath) => {
    const bare = composeContainer('p', WT, { image, mounts: [mount('/somewhere/else')] })
    expect(confirmOnlyReason([bare])).toMatch(/database/)
    const kept = composeContainer('p', WT, { image, mounts: [mount(dataPath, 'db-data')] })
    expect(confirmOnlyReason([kept])).toBeNull()
    const bound = composeContainer('p', WT, {
      image,
      mounts: [mount(dataPath, null, 'bind')]
    })
    expect(confirmOnlyReason([bound])).toBeNull()
  })

  it('a mount on a parent of the data path covers it', () => {
    const c = composeContainer('p', WT, {
      image: 'postgres:16',
      mounts: [mount('/var/lib/postgresql', 'pg')]
    })
    expect(confirmOnlyReason([c])).toBeNull()
  })

  it('matches the image name, not a substring of a registry or tag', () => {
    expect(confirmOnlyReason([container({ image: 'registry.local/postgres-tools:1' })])).toBeNull()
    expect(confirmOnlyReason([container({ image: 'myorg/redis-exporter:1' })])).toBeNull()
  })

  it('one confirm-only container makes the whole stack confirm-only', () => {
    const ok = composeContainer('p', WT, { service: 'web', image: 'nginx' })
    const db = composeContainer('p', WT, { service: 'db', image: 'postgres:16' })
    expect(confirmOnlyReason([ok, db])).toMatch(/database/)
  })

  it('lists the database images in one place', () => {
    expect(Object.keys(DATABASE_IMAGES).sort()).toEqual(
      [
        'elasticsearch',
        'mariadb',
        'mongo',
        'mongodb',
        'mysql',
        'opensearch',
        'postgres',
        'postgresql',
        'rabbitmq',
        'redis'
      ].sort()
    )
  })
})
