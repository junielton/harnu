import { describe, expect, it } from 'vitest'
import {
  DEFAULT_ADDRESS_POOLS,
  computeBridgeCapacity,
  detectEngineKind,
  parseDaemonPools
} from '../src/main/containers/docker-capacity-core'
import type { DockerNetworkFact } from '../src/main/containers/docker-networks-core'

const bridge = (name: string, subnets: string[], driver = 'bridge'): DockerNetworkFact => ({
  id: `id-${name}`,
  name,
  driver,
  project: null,
  subnets
})

const NATIVE_INFO = {
  OSType: 'linux',
  OperatingSystem: 'Ubuntu 26.04.1 LTS',
  Name: 'dev-box',
  SecurityOptions: [
    'name=apparmor,profile=default',
    'name=seccomp,profile=builtin',
    'name=cgroupns'
  ]
}

describe('detectEngineKind', () => {
  it('reads a native Linux engine on the system socket as capacity-known', () => {
    for (const dockerHost of [null, 'unix:///var/run/docker.sock', 'unix:///run/docker.sock']) {
      expect(detectEngineKind({ platform: 'linux', dockerHost, info: NATIVE_INFO })).toEqual({
        kind: 'native-linux',
        capacityKnown: true,
        reason: null
      })
    }
  })

  it('reads Docker Desktop as capacity-unknown', () => {
    const r = detectEngineKind({
      platform: 'linux',
      dockerHost: 'unix:///home/dev/.docker/desktop/docker.sock',
      info: { ...NATIVE_INFO, OperatingSystem: 'Docker Desktop', Name: 'docker-desktop' }
    })
    expect(r.kind).toBe('docker-desktop')
    expect(r.capacityKnown).toBe(false)
    expect(r.reason).toMatch(/Docker Desktop/)
  })

  it('reads a rootless engine as capacity-unknown', () => {
    const r = detectEngineKind({
      platform: 'linux',
      dockerHost: 'unix:///run/user/1000/docker.sock',
      info: { ...NATIVE_INFO, SecurityOptions: ['name=seccomp,profile=builtin', 'name=rootless'] }
    })
    expect(r.kind).toBe('rootless')
    expect(r.capacityKnown).toBe(false)
  })

  it('reads a tcp or ssh endpoint as a remote engine', () => {
    for (const dockerHost of ['tcp://10.0.0.5:2376', 'ssh://dev@build-host']) {
      const r = detectEngineKind({ platform: 'linux', dockerHost, info: NATIVE_INFO })
      expect(r).toMatchObject({ kind: 'remote', capacityKnown: false })
    }
  })

  it('treats a non-Linux host or a socket outside the system path as capacity-unknown', () => {
    expect(
      detectEngineKind({ platform: 'darwin', dockerHost: null, info: NATIVE_INFO })
    ).toMatchObject({ kind: 'other-local', capacityKnown: false })
    expect(
      detectEngineKind({
        platform: 'linux',
        dockerHost: 'unix:///home/dev/.colima/default/docker.sock',
        info: NATIVE_INFO
      })
    ).toMatchObject({ kind: 'other-local', capacityKnown: false })
  })

  it('treats a Windows-container daemon as capacity-unknown', () => {
    expect(
      detectEngineKind({
        platform: 'linux',
        dockerHost: null,
        info: { ...NATIVE_INFO, OSType: 'windows' }
      })
    ).toMatchObject({ capacityKnown: false })
  })
})

describe('parseDaemonPools', () => {
  it("falls back to docker's documented defaults when there is no daemon.json or no key", () => {
    expect(parseDaemonPools(null)).toEqual({ pools: DEFAULT_ADDRESS_POOLS, source: 'default' })
    expect(parseDaemonPools('{"log-driver":"json-file"}')).toEqual({
      pools: DEFAULT_ADDRESS_POOLS,
      source: 'default'
    })
  })

  it('has the documented default layout: 172.17-31 /16 and 192.168 split into /20', () => {
    expect(DEFAULT_ADDRESS_POOLS).toHaveLength(16)
    expect(DEFAULT_ADDRESS_POOLS[0]).toEqual({ base: '172.17.0.0/16', size: 16 })
    expect(DEFAULT_ADDRESS_POOLS[14]).toEqual({ base: '172.31.0.0/16', size: 16 })
    expect(DEFAULT_ADDRESS_POOLS[15]).toEqual({ base: '192.168.0.0/16', size: 20 })
  })

  it('reads custom default-address-pools and skips IPv6 bases', () => {
    const json = JSON.stringify({
      'default-address-pools': [
        { base: '10.10.0.0/16', size: 24 },
        { base: 'fd00:abcd::/48', size: 64 }
      ]
    })
    expect(parseDaemonPools(json)).toEqual({
      pools: [{ base: '10.10.0.0/16', size: 24 }],
      source: 'daemon.json'
    })
  })

  it('errors on invalid JSON, an unusable pool list, or a size smaller than the base prefix', () => {
    expect(parseDaemonPools('{nope')).toHaveProperty('error')
    expect(parseDaemonPools('{"default-address-pools":[]}')).toHaveProperty('error')
    expect(
      parseDaemonPools('{"default-address-pools":[{"base":"fd00::/48","size":64}]}')
    ).toHaveProperty('error')
    expect(
      parseDaemonPools('{"default-address-pools":[{"base":"10.0.0.0/16","size":8}]}')
    ).toHaveProperty('error')
    expect(parseDaemonPools('[]')).toHaveProperty('error')
  })
})

describe('computeBridgeCapacity', () => {
  const defaults = { pools: DEFAULT_ADDRESS_POOLS, source: 'default' as const }

  it('counts 31 default slots, all free on an empty machine', () => {
    expect(computeBridgeCapacity({ ...defaults, networks: [] })).toEqual({
      known: true,
      total: 31,
      used: 0,
      free: 31,
      source: 'default'
    })
  })

  it('counts one used slot per existing /16 network (15 in use leaves 16)', () => {
    const networks = Array.from({ length: 15 }, (_, i) => bridge(`n${i}`, [`172.${17 + i}.0.0/16`]))
    expect(computeBridgeCapacity({ ...defaults, networks })).toMatchObject({
      known: true,
      total: 31,
      used: 15,
      free: 16
    })
  })

  it('lets a small user subnet inside a pool consume the whole slot, once', () => {
    const networks = [
      bridge('a', ['172.20.0.0/24']),
      bridge('b', ['172.20.5.0/24']),
      bridge('c', ['192.168.16.0/20'])
    ]
    expect(computeBridgeCapacity({ ...defaults, networks })).toMatchObject({ used: 2, free: 29 })
  })

  it('ignores subnets outside every pool and non-bridge drivers', () => {
    const networks = [
      bridge('vpn', ['10.8.0.0/24']),
      bridge('mac', ['172.20.0.0/16'], 'macvlan'),
      bridge('v6', [])
    ]
    expect(computeBridgeCapacity({ ...defaults, networks })).toMatchObject({ used: 0, free: 31 })
  })

  it('counts every slot a large user subnet overlaps', () => {
    expect(
      computeBridgeCapacity({ ...defaults, networks: [bridge('big', ['172.16.0.0/12'])] })
    ).toMatchObject({ used: 15, free: 16 })
  })

  it('uses custom pools: 10.10.0.0/16 split into /24 is 256 slots', () => {
    const r = computeBridgeCapacity({
      pools: [{ base: '10.10.0.0/16', size: 24 }],
      source: 'daemon.json',
      networks: [bridge('a', ['10.10.3.0/24']), bridge('b', ['10.10.3.128/25'])]
    })
    expect(r).toEqual({ known: true, total: 256, used: 1, free: 255, source: 'daemon.json' })
  })

  it('reports unknown rather than guess when pools overlap', () => {
    const r = computeBridgeCapacity({
      pools: [
        { base: '10.10.0.0/16', size: 24 },
        { base: '10.10.128.0/17', size: 24 }
      ],
      source: 'daemon.json',
      networks: []
    })
    expect(r).toEqual({ known: false, reason: expect.stringMatching(/overlap/i) })
  })
})
