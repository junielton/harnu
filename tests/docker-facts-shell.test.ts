import { describe, expect, it } from 'vitest'
import {
  readBridgeCapacity,
  readEmptyComposeNetworks,
  readEngineFacts,
  readStackActivity,
  type DockerRunner,
  type FactsDeps
} from '../src/main/containers/docker-facts-shell'
import { composeProjectsOf } from '../src/main/containers/docker-networks-core'
import {
  COMPOSE_PROJECT_LABEL,
  COMPOSE_WORKING_DIR_LABEL,
  parseInspect
} from '../src/main/containers/containers-core'
import { composeContainer } from './containers-fixtures'

const CONFIG_FILES_LABEL = 'com.docker.compose.project.config_files'

// ---- fixtures ---------------------------------------------------------------------------------

interface Ctr {
  id: string
  project?: string
  state?: string
  networks?: string[]
  workingDir?: string
  files?: string
}

const inspectJson = (ctrs: Ctr[]): string =>
  JSON.stringify(
    ctrs.map((c) => ({
      Id: c.id,
      Name: `/${c.id}`,
      State: { Status: c.state ?? 'running' },
      Config: {
        Image: 'busybox',
        Labels: c.project
          ? {
              [COMPOSE_PROJECT_LABEL]: c.project,
              ...(c.workingDir ? { [COMPOSE_WORKING_DIR_LABEL]: c.workingDir } : {}),
              ...(c.files ? { [CONFIG_FILES_LABEL]: c.files } : {})
            }
          : {}
      },
      NetworkSettings: {
        Networks: Object.fromEntries((c.networks ?? []).map((n) => [n, { NetworkID: `id-${n}` }]))
      }
    }))
  )

interface Net {
  name: string
  project?: string
  driver?: string
  subnet?: string
}

const networkInspectJson = (nets: Net[]): string =>
  JSON.stringify(
    nets.map((n) => ({
      Id: `id-${n.name}`,
      Name: n.name,
      Driver: n.driver ?? 'bridge',
      Labels: n.project ? { [COMPOSE_PROJECT_LABEL]: n.project } : {},
      IPAM: { Config: n.subnet ? [{ Subnet: n.subnet }] : [] }
    }))
  )

const NATIVE_INFO = JSON.stringify({
  OSType: 'linux',
  OperatingSystem: 'Ubuntu 26.04.1 LTS',
  Name: 'dev-box',
  SecurityOptions: ['name=seccomp,profile=builtin']
})

const READ_ONLY_VERBS = new Set(['ps', 'inspect', 'info', 'stats'])

/** The exact allowlist: every argv the shell may send, nothing that changes docker state. */
function assertReadOnly(argv: readonly string[]): void {
  const [verb, sub] = argv
  const ok =
    READ_ONLY_VERBS.has(verb ?? '') ||
    (verb === 'network' && (sub === 'ls' || sub === 'inspect')) ||
    (verb === 'context' && sub === 'inspect') ||
    (verb === 'compose' && argv.includes('config') && !argv.includes('up'))
  if (!ok) throw new Error(`state-changing or unexpected docker command: ${argv.join(' ')}`)
}

type Handler = (argv: readonly string[]) => string | Error | undefined

/** A recording fake `runDocker`. Rejects any disallowed verb and any call without a timeout. */
function fakeRun(handler: Handler): { run: DockerRunner; calls: string[][] } {
  const calls: string[][] = []
  const run: DockerRunner = async (argv, opts) => {
    calls.push([...argv])
    assertReadOnly(argv)
    expect(opts.timeout).toBeGreaterThan(0)
    const out = handler(argv)
    if (out instanceof Error) throw out
    if (out === undefined) throw new Error(`unhandled docker call: ${argv.join(' ')}`)
    return { stdout: out }
  }
  return { run, calls }
}

const is = (argv: readonly string[], ...prefix: string[]): boolean =>
  prefix.every((p, i) => argv[i] === p)

function deps(run: DockerRunner, over: Partial<FactsDeps> = {}): FactsDeps {
  return {
    run,
    readFile: async () => null,
    fileExists: async () => true,
    platform: 'linux',
    env: {},
    sleep: async () => {},
    now: (() => {
      let t = 0
      return () => (t += 5000)
    })(),
    ...over
  }
}

const dockerDown = (): Error =>
  Object.assign(new Error('Cannot connect to the Docker daemon at unix:///var/run/docker.sock'), {
    stderr:
      'Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?'
  })

// ---- composeProjectsOf (pure, in the networks core) -------------------------------------------

describe('composeProjectsOf', () => {
  it('groups containers by compose project with their working dir and config files', () => {
    const [a, b] = parseInspect(
      inspectJson([
        { id: 'a', project: 'p1', workingDir: '/w/p1', files: '/w/p1/compose.yaml,/w/p1/o.yaml' },
        { id: 'b', project: 'p1', workingDir: '/w/p1', files: '/w/p1/compose.yaml,/w/p1/o.yaml' }
      ])
    )
    expect(composeProjectsOf([a!, b!, composeContainer('p2', null)])).toEqual([
      {
        project: 'p1',
        workingDir: '/w/p1',
        configFiles: ['/w/p1/compose.yaml', '/w/p1/o.yaml']
      },
      { project: 'p2', workingDir: null, configFiles: [] }
    ])
  })
})

// ---- readEmptyComposeNetworks -----------------------------------------------------------------

describe('readEmptyComposeNetworks', () => {
  const LIVE_CONFIG = JSON.stringify({
    name: 'live',
    networks: { default: { name: 'live_default' }, ext: { name: 'ext_default', external: true } }
  })

  const world = (over: { compose?: Handler } = {}): Handler => {
    return (argv) => {
      if (is(argv, 'ps')) return 'cid1\n'
      if (is(argv, 'inspect'))
        return inspectJson([
          {
            id: 'cid1',
            project: 'live',
            networks: ['live_default'],
            workingDir: '/w/live',
            files: '/w/live/compose.yaml'
          }
        ])
      if (is(argv, 'network', 'ls')) return 'id-live_default\nid-empty_default\nid-ext_default\n'
      if (is(argv, 'network', 'inspect'))
        return networkInspectJson([
          { name: 'live_default', project: 'live' },
          { name: 'empty_default', project: 'empty' },
          { name: 'ext_default', project: 'ext' }
        ])
      if (is(argv, 'compose')) return over.compose?.(argv) ?? LIVE_CONFIG
      return undefined
    }
  }

  it('finds the empty compose network and holds the one another stack declares external', async () => {
    const { run } = fakeRun(world())
    const r = await readEmptyComposeNetworks(deps(run))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.garbage.map((n) => n.name)).toEqual(['empty_default'])
    expect(r.value.held.map((h) => [h.network.name, h.reason])).toEqual([
      ['ext_default', 'external']
    ])
  })

  it('reads compose config with every profile enabled, from the stack config files', async () => {
    const { run, calls } = fakeRun(world())
    await readEmptyComposeNetworks(deps(run))
    const compose = calls.find((c) => c[0] === 'compose')!
    expect(compose).toEqual([
      'compose',
      '--profile',
      '*',
      '-p',
      'live',
      '--project-directory',
      '/w/live',
      '-f',
      '/w/live/compose.yaml',
      'config',
      '--format',
      'json'
    ])
  })

  it('holds every candidate when a stack config cannot be resolved', async () => {
    const { run } = fakeRun(
      world({ compose: () => new Error('required variable APP_KEY is missing') })
    )
    const r = await readEmptyComposeNetworks(deps(run))
    expect(r.ok && r.value.garbage).toEqual([])
    expect(r.ok && r.value.held.map((h) => h.reason)).toEqual([
      'externals-unresolved',
      'externals-unresolved'
    ])
  })

  it('ignores a stack whose config files are gone from disk (nobody can compose up it)', async () => {
    const { run } = fakeRun(world())
    const r = await readEmptyComposeNetworks(deps(run, { fileExists: async () => false }))
    expect(r.ok && r.value.garbage.map((n) => n.name)).toEqual(['empty_default', 'ext_default'])
  })

  it('treats a stack with no config_files label as unresolved', async () => {
    const handler = world()
    const { run } = fakeRun((argv) =>
      is(argv, 'inspect')
        ? inspectJson([{ id: 'cid1', project: 'live', networks: ['live_default'] }])
        : handler(argv)
    )
    const r = await readEmptyComposeNetworks(deps(run))
    expect(r.ok && r.value.garbage).toEqual([])
    expect(r.ok && r.value.held).toHaveLength(2)
  })

  it('snapshots networks before containers, so a container created in between is never missed', async () => {
    const { run, calls } = fakeRun(world())
    await readEmptyComposeNetworks(deps(run))
    const networksAt = calls.findIndex((c) => is(c, 'network', 'ls'))
    const containersAt = calls.findIndex((c) => is(c, 'ps'))
    expect(networksAt).toBeGreaterThanOrEqual(0)
    expect(networksAt).toBeLessThan(containersAt)
  })

  it('skips compose config entirely when no network is empty', async () => {
    const handler = world()
    const { run, calls } = fakeRun((argv) =>
      is(argv, 'network', 'inspect')
        ? networkInspectJson([{ name: 'live_default', project: 'live' }])
        : handler(argv)
    )
    const r = await readEmptyComposeNetworks(deps(run))
    expect(r.ok && r.value).toEqual({ garbage: [], held: [] })
    expect(calls.some((c) => c[0] === 'compose')).toBe(false)
  })

  it('fails instead of planning on a partial container listing', async () => {
    const handler = world()
    const { run } = fakeRun((argv) =>
      is(argv, 'inspect') ? new Error('inspect: context deadline exceeded') : handler(argv)
    )
    const r = await readEmptyComposeNetworks(deps(run))
    expect(r).toEqual({
      ok: false,
      error: { kind: 'failed', message: expect.stringContaining('deadline') }
    })
  })
})

// ---- engine + capacity ------------------------------------------------------------------------

describe('readEngineFacts / readBridgeCapacity', () => {
  const engineHandler =
    (info: string, host = '"unix:///var/run/docker.sock"'): Handler =>
    (argv) => {
      if (is(argv, 'info')) return info
      if (is(argv, 'context', 'inspect')) return host
      if (is(argv, 'network', 'ls')) return 'id-a\n'
      if (is(argv, 'network', 'inspect'))
        return networkInspectJson([{ name: 'a_default', project: 'a', subnet: '172.20.0.0/16' }])
      return undefined
    }

  it('detects a native engine from docker info and the active context', async () => {
    const { run } = fakeRun(engineHandler(NATIVE_INFO))
    expect(await readEngineFacts(deps(run))).toEqual({
      ok: true,
      value: { kind: 'native-linux', capacityKnown: true, reason: null }
    })
  })

  it('prefers DOCKER_HOST over the context and skips the context call', async () => {
    const { run, calls } = fakeRun(engineHandler(NATIVE_INFO))
    const r = await readEngineFacts(deps(run, { env: { DOCKER_HOST: 'tcp://10.0.0.5:2376' } }))
    expect(r.ok && r.value.kind).toBe('remote')
    expect(calls.some((c) => c[0] === 'context')).toBe(false)
  })

  it('reports capacity from the default pools when there is no daemon.json', async () => {
    const { run } = fakeRun(engineHandler(NATIVE_INFO))
    expect(await readBridgeCapacity(deps(run))).toEqual({
      ok: true,
      value: { known: true, total: 31, used: 1, free: 30, source: 'default' }
    })
  })

  it('reads custom pools from /etc/docker/daemon.json', async () => {
    const { run } = fakeRun(engineHandler(NATIVE_INFO))
    const paths: string[] = []
    const r = await readBridgeCapacity(
      deps(run, {
        readFile: async (p) => {
          paths.push(p)
          return '{"default-address-pools":[{"base":"10.10.0.0/16","size":24}]}'
        }
      })
    )
    expect(paths).toEqual(['/etc/docker/daemon.json'])
    expect(r).toEqual({
      ok: true,
      value: { known: true, total: 256, used: 0, free: 256, source: 'daemon.json' }
    })
  })

  it('answers unknown, with the reason, on Docker Desktop', async () => {
    const info = JSON.stringify({
      OSType: 'linux',
      OperatingSystem: 'Docker Desktop',
      Name: 'docker-desktop'
    })
    const { run } = fakeRun(engineHandler(info))
    const r = await readBridgeCapacity(deps(run))
    expect(r.ok && r.value).toEqual({
      known: false,
      reason: expect.stringMatching(/Docker Desktop/)
    })
  })

  it('answers unknown when daemon.json cannot be read or parsed', async () => {
    const { run } = fakeRun(engineHandler(NATIVE_INFO))
    const bad = await readBridgeCapacity(deps(run, { readFile: async () => '{nope' }))
    expect(bad.ok && bad.value.known).toBe(false)
    const denied = await readBridgeCapacity(
      deps(run, {
        readFile: async () => {
          throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' })
        }
      })
    )
    expect(denied.ok && denied.value).toEqual({
      known: false,
      reason: expect.stringContaining('daemon.json')
    })
  })
})

// ---- activity ---------------------------------------------------------------------------------

describe('readStackActivity', () => {
  it('takes two stats samples apart and aggregates them by compose project', async () => {
    let statsCalls = 0
    const { run, calls } = fakeRun((argv) => {
      if (is(argv, 'ps')) return 'cid1\n'
      if (is(argv, 'inspect')) return inspectJson([{ id: 'cid1', project: 'live' }])
      if (is(argv, 'stats')) {
        statsCalls++
        const block = statsCalls === 1 ? '0B / 0B' : '0B / 1MB'
        return (
          JSON.stringify({ ID: 'cid1', CPUPerc: '0.50%', NetIO: '0B / 0B', BlockIO: block }) + '\n'
        )
      }
      return undefined
    })
    const slept: number[] = []
    const r = await readStackActivity(deps(run, { sleep: async (ms) => void slept.push(ms) }), {
      sampleGapMs: 2000
    })
    expect(slept).toEqual([2000])
    expect(calls.filter((c) => c[0] === 'stats')).toHaveLength(2)
    expect(calls.find((c) => c[0] === 'stats')).toEqual([
      'stats',
      '--no-stream',
      '--no-trunc',
      '--format',
      '{{json .}}'
    ])
    expect(r.ok && r.value).toEqual([
      expect.objectContaining({ project: 'live', blockBytes: 1_000_000, active: true })
    ])
  })
})

// ---- docker down + read-only guard --------------------------------------------------------------

describe('docker unavailable and the read-only guarantee', () => {
  it('degrades every reader to a typed docker-unavailable error', async () => {
    const { run } = fakeRun(() => dockerDown())
    const d = deps(run)
    for (const result of [
      await readEngineFacts(d),
      await readEmptyComposeNetworks(d),
      await readBridgeCapacity(d),
      await readStackActivity(d)
    ]) {
      expect(result).toEqual({
        ok: false,
        error: { kind: 'docker-unavailable', message: expect.stringContaining('Cannot connect') }
      })
    }
  })

  it('maps a missing docker binary to docker-unavailable', async () => {
    const { run } = fakeRun(() =>
      Object.assign(new Error('spawn docker ENOENT'), { code: 'ENOENT' })
    )
    expect(await readEngineFacts(deps(run))).toEqual({
      ok: false,
      error: { kind: 'docker-unavailable', message: 'docker CLI not found on PATH' }
    })
  })

  it('never sends a state-changing docker command (the fake run rejects any that is not allowlisted)', async () => {
    const forbidden = ['rm', 'down', 'stop', 'kill', 'prune', 'up', 'start', 'create', 'disconnect']
    const { run, calls } = fakeRun((argv) => {
      if (is(argv, 'ps')) return 'cid1\n'
      if (is(argv, 'inspect'))
        return inspectJson([
          { id: 'cid1', project: 'live', networks: ['live_default'], files: '/w/c.yaml' }
        ])
      if (is(argv, 'info')) return NATIVE_INFO
      if (is(argv, 'context')) return '"unix:///var/run/docker.sock"'
      if (is(argv, 'network', 'ls')) return 'id-x\n'
      if (is(argv, 'network', 'inspect'))
        return networkInspectJson([{ name: 'x_default', project: 'x' }])
      if (is(argv, 'compose')) return '{}'
      if (is(argv, 'stats'))
        return JSON.stringify({ ID: 'cid1', CPUPerc: '1%', NetIO: '0B / 0B', BlockIO: '0B / 0B' })
      return undefined
    })
    const d = deps(run)
    await readEngineFacts(d)
    await readEmptyComposeNetworks(d)
    await readBridgeCapacity(d)
    await readStackActivity(d)
    expect(calls.length).toBeGreaterThan(8)
    for (const argv of calls) {
      expect(argv.filter((a) => forbidden.includes(a))).toEqual([])
    }
  })
})
