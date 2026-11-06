import { describe, expect, it } from 'vitest'
import {
  DEFAULT_ACTIVITY_THRESHOLDS,
  computeStackActivity,
  parseStatsSample,
  type StatsSample
} from '../src/main/containers/docker-activity-core'

const line = (
  id: string,
  cpu: string,
  net: string,
  block: string,
  extra: Record<string, unknown> = {}
): string =>
  JSON.stringify({
    ID: id,
    Container: id,
    Name: `ctr-${id}`,
    CPUPerc: cpu,
    NetIO: net,
    BlockIO: block,
    MemUsage: '60.03MiB / 62.6GiB',
    ...extra
  })

const sample = (at: number, rows: Record<string, [number, number, number, number, number]>) => {
  const out: StatsSample = { at, rows: new Map() }
  for (const [id, [cpu, rx, tx, br, bw]] of Object.entries(rows)) {
    out.rows.set(id, {
      cpuPercent: cpu,
      netRxBytes: rx,
      netTxBytes: tx,
      blockReadBytes: br,
      blockWriteBytes: bw
    })
  }
  return out
}

describe('parseStatsSample', () => {
  it('reads CPU %, net and block IO counters keyed by the full container id', () => {
    const s = parseStatsSample(
      [
        line('a'.repeat(64), '0.24%', '66.9kB / 43.1kB', '17.4MB / 45.1kB'),
        'garbage',
        line('b'.repeat(64), '--', '0B / 0B', '0B / 0B'),
        line('c'.repeat(64), '12.50%', '1.5MB / 2MB', '1GiB / 0B'),
        ''
      ].join('\n'),
      1000
    )
    expect(s.at).toBe(1000)
    expect([...s.rows.keys()]).toEqual(['a'.repeat(64), 'c'.repeat(64)])
    expect(s.rows.get('a'.repeat(64))).toEqual({
      cpuPercent: 0.24,
      netRxBytes: 66_900,
      netTxBytes: 43_100,
      blockReadBytes: 17_400_000,
      blockWriteBytes: 45_100
    })
    expect(s.rows.get('c'.repeat(64))).toMatchObject({
      cpuPercent: 12.5,
      netRxBytes: 1_500_000,
      netTxBytes: 2_000_000,
      blockReadBytes: 1024 ** 3
    })
  })

  it('returns an empty sample for empty output', () => {
    expect(parseStatsSample('', 5).rows.size).toBe(0)
  })
})

describe('computeStackActivity', () => {
  const projectOf = new Map([
    ['a', 'proj-1'],
    ['b', 'proj-1'],
    ['c', 'proj-2']
  ])

  it('exposes the default thresholds', () => {
    expect(DEFAULT_ACTIVITY_THRESHOLDS).toEqual({ cpuPercent: 2, ioBytesPerSec: 4096 })
  })

  it('reads a quiet stack as idle', () => {
    const [r] = computeStackActivity({
      first: sample(0, { a: [0.1, 1000, 1000, 5000, 0] }),
      second: sample(5000, { a: [0.3, 1050, 1050, 5000, 0] }),
      projectOf
    })
    expect(r).toMatchObject({
      project: 'proj-1',
      cpuPercent: 0.2,
      netBytes: 100,
      blockBytes: 0,
      ioBytesPerSec: 20,
      restarted: false,
      active: false
    })
  })

  it('reads CPU work as active', () => {
    const [r] = computeStackActivity({
      first: sample(0, { a: [11, 0, 0, 0, 0] }),
      second: sample(5000, { a: [13, 0, 0, 0, 0] }),
      projectOf
    })
    expect(r).toMatchObject({ cpuPercent: 12, active: true })
  })

  it('reads IO alone as active (a host-driven import with the CPU elsewhere)', () => {
    const [r] = computeStackActivity({
      first: sample(0, { a: [0, 0, 0, 0, 0] }),
      second: sample(5000, { a: [0, 0, 0, 0, 200 * 1024] }),
      projectOf
    })
    expect(r).toMatchObject({ blockBytes: 200 * 1024, active: true })
    expect(r!.ioBytesPerSec).toBe((200 * 1024) / 5)
  })

  it('aggregates the containers of one compose project', () => {
    const rows = computeStackActivity({
      first: sample(0, { a: [1, 0, 0, 0, 0], b: [1, 0, 0, 0, 0], c: [0, 0, 0, 0, 0] }),
      second: sample(10_000, { a: [1, 100, 0, 0, 0], b: [2, 0, 300, 0, 0], c: [0, 0, 0, 0, 0] }),
      projectOf
    })
    expect(rows.map((r) => r.project)).toEqual(['proj-1', 'proj-2'])
    expect(rows[0]).toMatchObject({ cpuPercent: 2.5, netBytes: 400, ioBytesPerSec: 40 })
  })

  it('reads a counter reset (container restarted between samples) as active, never negative', () => {
    const [r] = computeStackActivity({
      first: sample(0, { a: [0, 9_000_000, 9_000_000, 0, 0] }),
      second: sample(5000, { a: [0, 100, 100, 0, 0] }),
      projectOf
    })
    expect(r!.restarted).toBe(true)
    expect(r!.active).toBe(true)
    expect(r!.netBytes).toBeGreaterThanOrEqual(0)
  })

  it('reads a container that only appears in the second sample as active', () => {
    const [r] = computeStackActivity({
      first: sample(0, {}),
      second: sample(5000, { a: [0, 0, 0, 0, 0] }),
      projectOf
    })
    expect(r).toMatchObject({ project: 'proj-1', restarted: true, active: true })
  })

  it('ignores a container that vanished, and containers with no compose project', () => {
    const rows = computeStackActivity({
      first: sample(0, { a: [50, 0, 0, 0, 0], x: [90, 0, 0, 0, 0] }),
      second: sample(5000, { x: [90, 0, 0, 0, 0] }),
      projectOf
    })
    expect(rows).toEqual([])
  })

  it('honours custom thresholds', () => {
    const [r] = computeStackActivity({
      first: sample(0, { a: [0, 0, 0, 0, 0] }),
      second: sample(1000, { a: [3, 0, 0, 0, 0] }),
      projectOf,
      thresholds: { cpuPercent: 5, ioBytesPerSec: 1 }
    })
    expect(r!.active).toBe(false)
  })
})
