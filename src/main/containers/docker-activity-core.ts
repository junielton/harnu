/**
 * Pure core of the per-stack activity facts (U3.2): is a compose stack doing work right now?
 * (autonomous-cleanup design §4 U3 "Park" idle definition, risk 10 "idle session ≠ unused stack").
 *
 * No I/O. Two `docker stats --no-stream` samples are taken a few seconds apart by the shell.
 * CPU % is a point reading (averaged over both samples); net and block IO are cumulative counters,
 * so activity is their delta over the gap. Counters reset when a container restarts: that is
 * itself activity and never a negative delta. Everything is aggregated by compose project.
 */

import { parseDockerSize } from './containers-core'

export interface StatsRow {
  cpuPercent: number
  netRxBytes: number
  netTxBytes: number
  blockReadBytes: number
  blockWriteBytes: number
}

export interface StatsSample {
  /** Epoch ms the sample was taken. */
  at: number
  /** Full container id → counters. Only running containers appear in `docker stats`. */
  rows: Map<string, StatsRow>
}

export interface ActivityThresholds {
  /** A stack whose containers burn at least this much CPU (sum of %) is active. */
  cpuPercent: number
  /** A stack moving at least this many net+block bytes per second is active. */
  ioBytesPerSec: number
}

/**
 * Above the heartbeat chatter of an idle Laravel/queue stack (tens of bytes per second, well under
 * 1% CPU), below a developer clicking through the app. U3.5 owns the idle policy and may override.
 */
export const DEFAULT_ACTIVITY_THRESHOLDS: ActivityThresholds = {
  cpuPercent: 2,
  ioBytesPerSec: 4096
}

export interface StackActivity {
  project: string
  cpuPercent: number
  netBytes: number
  blockBytes: number
  ioBytesPerSec: number
  /** A container restarted (counters reset) or started between the samples. */
  restarted: boolean
  active: boolean
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

/** Both halves of docker's `a / b` pair, in bytes; null when either is unreadable. */
function sizePair(v: unknown): [number, number] | null {
  const [a, b] = asString(v).split('/')
  const left = parseDockerSize(a)
  const right = parseDockerSize(b)
  return left === null || right === null ? null : [left, right]
}

/**
 * Parses `docker stats --no-stream --no-trunc --format '{{json .}}'` (one JSON object per line).
 * A row docker could not measure (`--`) is dropped rather than read as zero.
 */
export function parseStatsSample(stdout: string, at: number): StatsSample {
  const rows = new Map<string, StatsRow>()
  for (const text of stdout.split('\n')) {
    if (!text.trim()) continue
    let row: Record<string, unknown> | null
    try {
      row = asRecord(JSON.parse(text))
    } catch {
      continue
    }
    const id = asString(row?.ID) || asString(row?.Container)
    const cpu = /^\s*([\d.]+)%\s*$/.exec(asString(row?.CPUPerc))
    const net = sizePair(row?.NetIO)
    const block = sizePair(row?.BlockIO)
    if (!id || !cpu || !net || !block) continue
    rows.set(id, {
      cpuPercent: Number.parseFloat(cpu[1] ?? ''),
      netRxBytes: net[0],
      netTxBytes: net[1],
      blockReadBytes: block[0],
      blockWriteBytes: block[1]
    })
  }
  return { at, rows }
}

const round4 = (n: number): number => Math.round(n * 1e4) / 1e4

/**
 * Per-project activity between two samples. `projectOf` maps a full container id to its compose
 * project (from the inspect labels); containers without one are skipped. A container that left
 * between the samples is ignored; one that appeared, or whose counters went backwards, marks the
 * stack `restarted` and active.
 */
export function computeStackActivity(input: {
  first: StatsSample
  second: StatsSample
  projectOf: ReadonlyMap<string, string>
  thresholds?: ActivityThresholds
}): StackActivity[] {
  const { first, second, projectOf } = input
  const thresholds = input.thresholds ?? DEFAULT_ACTIVITY_THRESHOLDS
  const elapsedSec = Math.max((second.at - first.at) / 1000, 0.001)

  interface Acc {
    cpu: number
    net: number
    block: number
    restarted: boolean
  }
  const byProject = new Map<string, Acc>()

  for (const [id, now] of second.rows) {
    const project = projectOf.get(id)
    if (!project) continue
    const acc = byProject.get(project) ?? { cpu: 0, net: 0, block: 0, restarted: false }
    byProject.set(project, acc)
    const before = first.rows.get(id)
    if (!before) {
      acc.restarted = true
      acc.cpu += now.cpuPercent
      acc.net += now.netRxBytes + now.netTxBytes
      acc.block += now.blockReadBytes + now.blockWriteBytes
      continue
    }
    acc.cpu += (before.cpuPercent + now.cpuPercent) / 2
    const delta = (a: number, b: number): number => {
      if (b >= a) return b - a
      acc.restarted = true
      return b
    }
    acc.net += delta(before.netRxBytes, now.netRxBytes) + delta(before.netTxBytes, now.netTxBytes)
    acc.block +=
      delta(before.blockReadBytes, now.blockReadBytes) +
      delta(before.blockWriteBytes, now.blockWriteBytes)
  }

  return [...byProject.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([project, acc]) => {
      const cpuPercent = round4(acc.cpu)
      const ioBytesPerSec = (acc.net + acc.block) / elapsedSec
      return {
        project,
        cpuPercent,
        netBytes: acc.net,
        blockBytes: acc.block,
        ioBytesPerSec,
        restarted: acc.restarted,
        active:
          acc.restarted ||
          cpuPercent >= thresholds.cpuPercent ||
          ioBytesPerSec >= thresholds.ioBytesPerSec
      }
    })
}
