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

// ---- pauseStack (U3.4 AC-1, AC-2, AC-4) ------------------------------------------

import { vi } from 'vitest'
import {
  pauseStack,
  type PauseDeps,
  type PauseDecision,
  type PauseOutcome
} from '../src/main/containers/park-core'
import { parseJournal, serializeTombstone } from '../src/main/containers/containers-journal'
import type { StackRow, Tombstone } from '../src/main/containers/containers-wire'
import { NOW, available, containerRow, stackRow } from './containers-fixtures'

const UNPAUSED_LIFE = { stdout: '' }

interface World {
  stack: StackRow
  /** What `docker inspect` answers, per container id. */
  inspected?: Record<string, { image: string; mounts?: unknown[]; service?: string }>
  config?: unknown
  configFails?: boolean
  downFails?: boolean
  appendFails?: boolean
}

function setup(w: World): {
  deps: PauseDeps
  calls: string[][]
  tombstones: Tombstone[]
  decision: PauseDecision
} {
  const calls: string[][] = []
  const tombstones: Tombstone[] = []
  const stack = w.stack
  const deps: PauseDeps = {
    scan: vi.fn(async () => available([stack])),
    run: vi.fn(async (args: readonly string[]) => {
      calls.push([...args])
      if (args[0] === 'inspect') {
        const ids = args.slice(1)
        return {
          stdout: JSON.stringify(
            ids.map((id) => ({
              Id: id,
              Name: `/${id.slice(0, 6)}`,
              State: { Status: 'running' },
              Config: { Image: w.inspected?.[id]?.image ?? 'busybox', Labels: {} },
              Mounts: w.inspected?.[id]?.mounts ?? []
            }))
          )
        }
      }
      if (args.includes('config')) {
        if (w.configFails) throw new Error('required variable DB_PASS is missing')
        return {
          stdout: JSON.stringify(w.config ?? { services: { app: { image: 'busybox' } } })
        }
      }
      if (args.includes('down')) {
        if (w.downFails) throw new Error('network has active endpoints')
        return UNPAUSED_LIFE
      }
      throw new Error(`unexpected docker call: ${args.join(' ')}`)
    }),
    appendTombstone: vi.fn(async (t: Tombstone) => {
      if (w.appendFails) throw new Error('disk full')
      tombstones.push(t)
    }),
    now: () => NOW
  }
  return {
    deps,
    calls,
    tombstones,
    decision: {
      stack: stack.id,
      containerIds: stack.containers.map((c) => c.id),
      verdict: stack.verdict
    }
  }
}

function composeStack(over: Partial<StackRow> = {}): StackRow {
  const c = containerRow({ service: 'app', ports: [8082, 5182] })
  return stackRow({
    id: 'proj-82',
    verdict: 'zombie',
    containers: [c],
    compose: { configFiles: [`${WT}/compose.yml`], envFile: null },
    ...over
  })
}

const downCall = (calls: string[][]): string[] | undefined => calls.find((a) => a.includes('down'))

describe('pauseStack — the happy path (U3.4 AC-1, AC-2)', () => {
  it('runs compose down with the exact argv, never -v/--volumes/--rmi', async () => {
    const w = setup({ stack: composeStack() })
    const out = await pauseStack(w.decision, 'autopilot', w.deps)
    expect(out.ok).toBe(true)
    expect(downCall(w.calls)).toEqual([
      'compose',
      '-p',
      'proj-82',
      '--project-directory',
      WT,
      '-f',
      `${WT}/compose.yml`,
      'down'
    ])
  })

  it('records ports, files, profiles, env file, project dir and build; the hint brings it back', async () => {
    const w = setup({
      stack: composeStack({
        containers: [
          containerRow({ service: 'app', ports: [8082, 5182] }),
          containerRow({ service: 'web', ports: [] })
        ],
        compose: { configFiles: [`${WT}/a.yml`, `${WT}/b.yml`], envFile: `${WT}/.env.x` }
      }),
      config: {
        services: {
          app: { image: 'x', build: { context: '.' } },
          web: { image: 'y', profiles: ['web'] }
        }
      }
    })
    const out = (await pauseStack(w.decision, 'autopilot', w.deps)) as Extract<
      PauseOutcome,
      { ok: true }
    >
    expect(out.record).toMatchObject({
      project: 'proj-82',
      workingDir: WT,
      configFiles: [`${WT}/a.yml`, `${WT}/b.yml`],
      profiles: ['web'],
      envFile: `${WT}/.env.x`,
      hasBuild: true,
      ports: [5182, 8082],
      pausedAt: NOW
    })
    expect(out.record.restoreCommand).toBe(
      `docker compose -p proj-82 --project-directory ${WT} -f ${WT}/a.yml -f ${WT}/b.yml ` +
        `--profile web --env-file ${WT}/.env.x up -d --build`
    )
  })

  it('image-only stack: no --build', async () => {
    const w = setup({ stack: composeStack() })
    const out = (await pauseStack(w.decision, 'autopilot', w.deps)) as Extract<
      PauseOutcome,
      { ok: true }
    >
    expect(out.record.hasBuild).toBe(false)
    expect(out.record.restoreCommand).toBe(
      `docker compose -p proj-82 --project-directory ${WT} -f ${WT}/compose.yml up -d`
    )
  })

  it('journals one stop tombstone for the actor, carrying the record and the restore hint', async () => {
    const w = setup({ stack: composeStack() })
    const out = (await pauseStack(w.decision, 'autopilot', w.deps)) as Extract<
      PauseOutcome,
      { ok: true }
    >
    expect(w.tombstones).toHaveLength(1)
    const t = w.tombstones[0]!
    expect(t).toMatchObject({ at: NOW, actor: 'autopilot', verb: 'stop' })
    expect(t.restoreHint).toBe(out.record.restoreCommand)
    expect(t.stacks[0]).toMatchObject({
      stack: 'proj-82',
      path: WT,
      containerIds: w.decision.containerIds,
      freed: { ports: [5182, 8082] },
      paused: out.record
    })
    expect(out.tombstone).toEqual(t)
    // and it survives a restart: the journal line parses back
    expect(parseJournal(serializeTombstone(t))).toEqual([t])
  })

  it('reads the compose config before it brings anything down', async () => {
    const w = setup({ stack: composeStack() })
    await pauseStack(w.decision, 'autopilot', w.deps)
    const order = w.calls.map((a) =>
      a.includes('down') ? 'down' : a.includes('config') ? 'config' : a[0]
    )
    expect(order).toEqual(['inspect', 'config', 'down'])
    expect(w.calls.find((a) => a.includes('config'))).toEqual([
      'compose',
      '-p',
      'proj-82',
      '--project-directory',
      WT,
      '-f',
      `${WT}/compose.yml`,
      '--profile',
      '*',
      'config',
      '--format',
      'json'
    ])
  })
})

describe('pauseStack — re-probe: "changed since decided" (U3.4 AC-1)', () => {
  it('refuses when a container was added since the decision', async () => {
    const w = setup({ stack: composeStack() })
    w.decision.containerIds = []
    const out = await pauseStack(w.decision, 'autopilot', w.deps)
    expect(out).toMatchObject({ ok: false, outcome: 'refused', code: 'CHANGED_SINCE_DECIDED' })
    if (!out.ok) expect(out.message).toMatch(/changed since decided/)
    expect(downCall(w.calls)).toBeUndefined()
  })

  it('refuses when a container was removed since the decision', async () => {
    const w = setup({ stack: composeStack() })
    w.decision.containerIds = [...w.decision.containerIds, 'b'.repeat(64)]
    const out = await pauseStack(w.decision, 'autopilot', w.deps)
    expect(out).toMatchObject({ ok: false, code: 'CHANGED_SINCE_DECIDED' })
    expect(downCall(w.calls)).toBeUndefined()
  })

  it('refuses when the verdict moved since the decision', async () => {
    const w = setup({ stack: composeStack() })
    w.decision.verdict = 'pending'
    const out = await pauseStack(w.decision, 'autopilot', w.deps)
    expect(out).toMatchObject({ ok: false, code: 'CHANGED_SINCE_DECIDED' })
    expect(downCall(w.calls)).toBeUndefined()
  })

  it.each(['unknown', 'protected', 'active', 'orphan'] as const)(
    'refuses a %s stack even when the decision says so too',
    async (verdict) => {
      const w = setup({ stack: composeStack({ verdict }) })
      const out = await pauseStack(w.decision, 'autopilot', w.deps)
      expect(out).toMatchObject({ ok: false, outcome: 'refused', code: 'NOT_PAUSABLE' })
      expect(w.calls).toEqual([])
    }
  )

  it('refuses a stack that is gone, and a standalone container', async () => {
    const w = setup({ stack: composeStack() })
    expect(await pauseStack({ ...w.decision, stack: 'nope' }, 'autopilot', w.deps)).toMatchObject({
      ok: false,
      code: 'STACK_NOT_FOUND'
    })
    const solo = setup({
      stack: stackRow({ id: 'scratch', kind: 'container', project: null, verdict: 'zombie' })
    })
    expect(await pauseStack(solo.decision, 'autopilot', solo.deps)).toMatchObject({
      ok: false,
      code: 'NOT_COMPOSE'
    })
    expect(solo.calls).toEqual([])
  })

  it('refuses when docker is unavailable', async () => {
    const w = setup({ stack: composeStack() })
    w.deps.scan = async () => ({
      scannedAt: NOW,
      dockerAvailable: false,
      dockerError: 'daemon down',
      zombieAfterDays: 2,
      recent: []
    })
    expect(await pauseStack(w.decision, 'autopilot', w.deps)).toMatchObject({
      ok: false,
      code: 'DOCKER_UNAVAILABLE'
    })
  })
})

describe('pauseStack — confirm-only stacks (U3.4 AC-4)', () => {
  it('a database with no volume on its data path returns confirm-required and runs nothing', async () => {
    const stack = composeStack()
    const id = stack.containers[0]!.id
    const w = setup({
      stack,
      inspected: { [id]: { image: 'postgres:16', mounts: [] } }
    })
    const out = await pauseStack(w.decision, 'autopilot', w.deps)
    expect(out).toMatchObject({ ok: false, outcome: 'confirm-required', code: 'CONFIRM_ONLY' })
    if (!out.ok) expect(out.message).toMatch(/database/)
    expect(downCall(w.calls)).toBeUndefined()
    expect(w.tombstones).toEqual([])
  })

  it('an anonymous volume returns confirm-required', async () => {
    const stack = composeStack()
    const id = stack.containers[0]!.id
    const w = setup({
      stack,
      inspected: {
        [id]: {
          image: 'nginx',
          mounts: [{ Type: 'volume', Name: 'e'.repeat(64), Source: '/v', Destination: '/x' }]
        }
      }
    })
    const out = await pauseStack(w.decision, 'autopilot', w.deps)
    expect(out).toMatchObject({ ok: false, outcome: 'confirm-required' })
    if (!out.ok) expect(out.message).toMatch(/anonymous volume/)
    expect(downCall(w.calls)).toBeUndefined()
  })

  it('a database whose data is on a named volume pauses', async () => {
    const stack = composeStack()
    const id = stack.containers[0]!.id
    const w = setup({
      stack,
      inspected: {
        [id]: {
          image: 'postgres:16',
          mounts: [
            { Type: 'volume', Name: 'pg', Source: '/v', Destination: '/var/lib/postgresql/data' }
          ]
        }
      }
    })
    expect(await pauseStack(w.decision, 'autopilot', w.deps)).toMatchObject({ ok: true })
  })
})

describe('pauseStack — failures leave the stack alone or say so (U3.4 review focus)', () => {
  it('an unreadable compose config refuses before down', async () => {
    const w = setup({ stack: composeStack(), configFails: true })
    const out = await pauseStack(w.decision, 'autopilot', w.deps)
    expect(out).toMatchObject({ ok: false, outcome: 'refused', code: 'CONFIG_UNREADABLE' })
    if (!out.ok) expect(out.message).toMatch(/DB_PASS/)
    expect(downCall(w.calls)).toBeUndefined()
  })

  it('a config with no services refuses before down', async () => {
    const w = setup({ stack: composeStack(), config: { name: 'x' } })
    const out = await pauseStack(w.decision, 'autopilot', w.deps)
    expect(out).toMatchObject({ ok: false, code: 'CONFIG_UNREADABLE' })
    expect(downCall(w.calls)).toBeUndefined()
  })

  it('a failed down is a failure with no tombstone', async () => {
    const w = setup({ stack: composeStack(), downFails: true })
    const out = await pauseStack(w.decision, 'autopilot', w.deps)
    expect(out).toMatchObject({ ok: false, outcome: 'failed', code: 'DOWN_FAILED' })
    expect(w.tombstones).toEqual([])
  })

  it('a journal write that fails after down is a failure that still carries the restore command', async () => {
    const w = setup({ stack: composeStack(), appendFails: true })
    const out = await pauseStack(w.decision, 'autopilot', w.deps)
    expect(out).toMatchObject({ ok: false, outcome: 'failed', code: 'JOURNAL_FAILED' })
    if (!out.ok) {
      expect(out.record?.restoreCommand).toContain('docker compose -p proj-82')
      expect(out.message).toMatch(/disk full/)
    }
  })

  it('a path with a space and a quote stays pasteable in the recorded command', async () => {
    const stack = composeStack({
      compose: { configFiles: ["/tmp/my proj/it's.yml"], envFile: null }
    })
    stack.attribution = { ...stack.attribution, path: '/tmp/my proj' }
    const w = setup({ stack })
    const out = (await pauseStack(w.decision, 'autopilot', w.deps)) as Extract<
      PauseOutcome,
      { ok: true }
    >
    expect(out.record.restoreCommand).toBe(
      `docker compose -p proj-82 --project-directory '/tmp/my proj' -f '/tmp/my proj/it'\\''s.yml' up -d`
    )
    // the argv is not shell-quoted: execFile passes it as is
    expect(downCall(w.calls)).toContain("/tmp/my proj/it's.yml")
  })
})

describe('the pause line the digest reads (U3.5 AC-5)', () => {
  it('an autopilot pause journals its reason: what, how long idle, and how to bring it back', async () => {
    const w = setup({ stack: composeStack() })
    const out = (await pauseStack(
      { ...w.decision, idle: 'idle 3 h' },
      'autopilot',
      w.deps
    )) as Extract<PauseOutcome, { ok: true }>
    expect(w.tombstones[0]!.reason).toBe(
      `Paused \`proj-82\` — idle 3 h · bring back: \`${out.record.restoreCommand}\``
    )
    expect(parseJournal(serializeTombstone(w.tombstones[0]!))[0]!.reason).toBe(
      w.tombstones[0]!.reason
    )
  })

  it('an autopilot pause with no idle text still says what was paused and how to bring it back', async () => {
    const w = setup({ stack: composeStack() })
    const out = (await pauseStack(w.decision, 'autopilot', w.deps)) as Extract<
      PauseOutcome,
      { ok: true }
    >
    expect(w.tombstones[0]!.reason).toBe(
      `Paused \`proj-82\` · bring back: \`${out.record.restoreCommand}\``
    )
  })

  it.each(['operator', 'agent'] as const)('a pause by the %s carries no reason', async (actor) => {
    const w = setup({ stack: composeStack() })
    await pauseStack({ ...w.decision, idle: 'idle 3 h' }, actor, w.deps)
    expect(w.tombstones[0]).not.toHaveProperty('reason')
  })

  it('a pause whose journal write failed has nothing to journal, and still returns the record', async () => {
    const w = setup({ stack: composeStack(), appendFails: true })
    const out = await pauseStack({ ...w.decision, idle: 'idle 3 h' }, 'autopilot', w.deps)
    expect(out).toMatchObject({ ok: false, code: 'JOURNAL_FAILED' })
    expect(w.tombstones).toEqual([])
  })
})
