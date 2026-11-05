/**
 * Pure core of the Docker capacity facts (U3.2): which engine Harnu is talking to, and how many
 * bridge-network slots are left (autonomous-cleanup design §4 U3 "Capacity watcher", C11).
 *
 * No I/O. A user-defined bridge network takes one subnet from the daemon's
 * `default-address-pools`; once every slot is used `compose up` fails with "all predefined
 * address pools have been fully subnetted". Slots are counted by arithmetic on the pools, never by
 * enumerating them, so a `/8` split into `/24`s costs nothing.
 *
 * Capacity is only claimed for a native Linux engine reading `/etc/docker/daemon.json`. Anywhere
 * else the daemon's pools are out of reach, and the answer is `unknown` with a reason.
 */

import type { DockerNetworkFact } from './docker-networks-core'

export type EngineKind = 'native-linux' | 'docker-desktop' | 'rootless' | 'remote' | 'other-local'

export interface EngineFacts {
  kind: EngineKind
  /** True only when the daemon's address pools can be read from this machine. */
  capacityKnown: boolean
  /** Why capacity is unknown; null when it is known. */
  reason: string | null
}

/** The slice of `docker info --format '{{json .}}'` the detection reads. */
export interface DockerInfoFacts {
  OSType?: string
  OperatingSystem?: string
  Name?: string
  SecurityOptions?: string[]
}

const NATIVE_SOCKETS = new Set(['unix:///var/run/docker.sock', 'unix:///run/docker.sock'])

/**
 * Classifies the engine from `docker info`, the resolved endpoint (`DOCKER_HOST` or the active
 * context's host; null = the default socket) and the host platform. Order matters: a remote
 * endpoint wins over everything it might report about itself.
 */
export function detectEngineKind(input: {
  platform: NodeJS.Platform
  dockerHost: string | null
  info: DockerInfoFacts
}): EngineFacts {
  const { platform, dockerHost, info } = input
  const unknown = (kind: EngineKind, reason: string): EngineFacts => ({
    kind,
    capacityKnown: false,
    reason
  })

  if (dockerHost && !dockerHost.startsWith('unix://')) {
    return unknown('remote', `The engine is remote (${dockerHost.split('://')[0]}).`)
  }
  const label = `${info.OperatingSystem ?? ''} ${info.Name ?? ''}`.toLowerCase()
  if (label.includes('docker desktop') || label.includes('docker-desktop')) {
    return unknown('docker-desktop', 'Docker Desktop keeps its address pools inside its VM.')
  }
  if ((info.SecurityOptions ?? []).some((o) => o.split(',')[0] === 'name=rootless')) {
    return unknown('rootless', 'A rootless engine keeps its address pools in the user config.')
  }
  if (platform !== 'linux' || info.OSType !== 'linux') {
    return unknown('other-local', 'The engine does not run natively on this Linux host.')
  }
  if (dockerHost && !NATIVE_SOCKETS.has(dockerHost)) {
    return unknown('other-local', 'The engine socket is not the system socket.')
  }
  return { kind: 'native-linux', capacityKnown: true, reason: null }
}

// ---- address pools ----------------------------------------------------------------

export interface AddressPool {
  /** IPv4 CIDR the pool is carved from. */
  base: string
  /** Prefix length of each network handed out of it. */
  size: number
}

/**
 * Docker's documented default pools: `172.17.0.0/16` … `172.31.0.0/16` as-is, then `192.168.0.0/16`
 * split into `/20`s. 15 + 16 = 31 slots.
 */
export const DEFAULT_ADDRESS_POOLS: AddressPool[] = [
  ...Array.from({ length: 15 }, (_, i) => ({ base: `172.${17 + i}.0.0/16`, size: 16 })),
  { base: '192.168.0.0/16', size: 20 }
]

export type PoolSource = 'daemon.json' | 'default'

interface Cidr {
  start: number
  end: number
  prefix: number
}

function parseIpv4Cidr(cidr: string): Cidr | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/.exec(cidr)
  if (!m) return null
  const octets = m.slice(1, 5).map(Number)
  const prefix = Number(m[5])
  if (octets.some((o) => o > 255) || prefix > 32) return null
  const ip = octets.reduce((acc, o) => acc * 256 + o, 0)
  const span = 2 ** (32 - prefix)
  const start = Math.floor(ip / span) * span
  return { start, end: start + span - 1, prefix }
}

/**
 * Reads `default-address-pools` out of the text of `/etc/docker/daemon.json` (null = no file).
 * No file, or no such key, means docker's defaults. IPv6 pools are skipped: slot accounting is
 * IPv4. A file we cannot read as a pool list is an error, never a silent fallback to defaults.
 */
export function parseDaemonPools(
  daemonJson: string | null
): { pools: AddressPool[]; source: PoolSource } | { error: string } {
  if (daemonJson === null) return { pools: DEFAULT_ADDRESS_POOLS, source: 'default' }
  let parsed: unknown
  try {
    parsed = JSON.parse(daemonJson)
  } catch {
    return { error: 'daemon.json is not valid JSON.' }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { error: 'daemon.json is not a JSON object.' }
  }
  const raw = (parsed as Record<string, unknown>)['default-address-pools']
  if (raw === undefined) return { pools: DEFAULT_ADDRESS_POOLS, source: 'default' }
  if (!Array.isArray(raw)) return { error: 'default-address-pools is not a list.' }

  const pools: AddressPool[] = []
  for (const entry of raw) {
    const rec = entry && typeof entry === 'object' ? (entry as Record<string, unknown>) : {}
    const base = typeof rec.base === 'string' ? rec.base : ''
    const size = rec.size
    if (base.includes(':')) continue
    const cidr = parseIpv4Cidr(base)
    if (!cidr || typeof size !== 'number' || !Number.isInteger(size)) {
      return { error: `default-address-pools has an invalid entry (${base || 'no base'}).` }
    }
    if (size < cidr.prefix || size > 32) {
      return { error: `default-address-pools size ${size} does not fit ${base}.` }
    }
    pools.push({ base, size })
  }
  if (pools.length === 0) return { error: 'default-address-pools has no usable IPv4 pool.' }
  return { pools, source: 'daemon.json' }
}

export type BridgeCapacity =
  | { known: true; total: number; used: number; free: number; source: PoolSource }
  | { known: false; reason: string }

/**
 * `{ total, used, free }` slots. A slot is used when any IPv4 subnet of an existing `bridge`
 * network overlaps it — a `/24` inside a `/16` slot takes the whole slot. Subnets outside every
 * pool take none. Overlapping pools make the count ambiguous, so they are `unknown`.
 */
export function computeBridgeCapacity(input: {
  pools: readonly AddressPool[]
  source: PoolSource
  networks: readonly DockerNetworkFact[]
}): BridgeCapacity {
  const pools = input.pools.map((p) => {
    const cidr = parseIpv4Cidr(p.base) as Cidr
    return { cidr, slotSize: 2 ** (32 - p.size), slots: 2 ** (p.size - cidr.prefix) }
  })

  const byStart = [...pools].sort((a, b) => a.cidr.start - b.cidr.start)
  for (let i = 1; i < byStart.length; i++) {
    if (byStart[i]!.cidr.start <= byStart[i - 1]!.cidr.end) {
      return { known: false, reason: 'The address pools overlap each other.' }
    }
  }

  const subnets: Cidr[] = []
  for (const n of input.networks) {
    if (n.driver !== 'bridge') continue
    for (const s of n.subnets) {
      const cidr = parseIpv4Cidr(s)
      if (cidr) subnets.push(cidr)
    }
  }

  let total = 0
  let used = 0
  for (const pool of pools) {
    total += pool.slots
    const ranges: [number, number][] = []
    for (const s of subnets) {
      if (s.end < pool.cidr.start || s.start > pool.cidr.end) continue
      ranges.push([
        Math.floor((Math.max(s.start, pool.cidr.start) - pool.cidr.start) / pool.slotSize),
        Math.floor((Math.min(s.end, pool.cidr.end) - pool.cidr.start) / pool.slotSize)
      ])
    }
    ranges.sort((a, b) => a[0] - b[0])
    let coveredUpTo = -1
    for (const [lo, hi] of ranges) {
      const from = Math.max(lo, coveredUpTo + 1)
      if (hi >= from) used += hi - from + 1
      coveredUpTo = Math.max(coveredUpTo, hi)
    }
  }
  return { known: true, total, used, free: total - used, source: input.source }
}
