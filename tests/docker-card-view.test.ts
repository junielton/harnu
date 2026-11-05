// U3.7 AC-2: the Docker card's view model, pure. U3.6's wire records and the Containers snapshot go
// in; the capacity state, the newest automatic actions and the Paused rows come out.

import { describe, expect, it } from 'vitest'
import {
  automaticActions,
  describeAction,
  pausedRows,
  slotsState,
  wouldHaveRows
} from '../src/renderer/src/lib/docker-card-view'
import type { DockerReportItem, DockerWatchRecord } from '../src/main/gc/gc-wire'
import type { PausedStack, Tombstone } from '../src/main/containers/containers-wire'

const watch = (over: Partial<DockerWatchRecord> = {}): DockerWatchRecord => ({
  at: 1,
  trigger: 'timer',
  mode: 'act',
  mark: 3,
  capacity: { known: true, total: 31, used: 15, free: 16, source: 'default' },
  pressure: false,
  found: 0,
  acted: 0,
  refused: 0,
  failed: 0,
  deferred: 0,
  locked: false,
  paused: false,
  pausedReason: null,
  nothingLeft: false,
  items: [],
  notice: null,
  report: null,
  ...over
})

const cap = (free: number, source: 'default' | 'daemon.json' = 'default'): DockerWatchRecord =>
  watch({ capacity: { known: true, total: 31, used: 31 - free, free, source } })

describe('slotsState', () => {
  it('no pass yet reads as unknown, never "0 of 0"', () => {
    expect(slotsState(null, 3)).toEqual({ kind: 'unknown', reason: null })
    expect(slotsState(watch({ capacity: null }), 3)).toEqual({ kind: 'unknown', reason: null })
  })

  it('an unreadable engine is unknown with the reason U3.6 sends', () => {
    const w = watch({ capacity: { known: false, reason: 'Docker Desktop runs in a VM.' } })
    expect(slotsState(w, 3)).toEqual({ kind: 'unknown', reason: 'Docker Desktop runs in a VM.' })
  })

  it('plenty free is ok', () => {
    expect(slotsState(cap(16), 3)).toMatchObject({
      kind: 'known',
      level: 'ok',
      free: 16,
      total: 31,
      source: 'default',
      autonomy: 'on'
    })
  })

  it('at the mark is low (3 or fewer), one above it is ok', () => {
    expect(slotsState(cap(3), 3)).toMatchObject({ level: 'low' })
    expect(slotsState(cap(1), 3)).toMatchObject({ level: 'low' })
    expect(slotsState(cap(4), 3)).toMatchObject({ level: 'ok' })
  })

  it('nothing free is zero', () => {
    expect(slotsState(cap(0), 3)).toMatchObject({ level: 'zero', free: 0 })
  })

  it('custom pools keep their source', () => {
    expect(slotsState(cap(16, 'daemon.json'), 3)).toMatchObject({ source: 'daemon.json' })
  })

  it('a switched-off or paused autonomy still shows capacity and says why nothing is freed', () => {
    expect(slotsState(watch({ mode: 'off' }), 3)).toMatchObject({ kind: 'known', autonomy: 'off' })
    expect(slotsState(watch({ mode: 'paused' }), 3)).toMatchObject({ autonomy: 'paused' })
    expect(slotsState(watch({ mode: 'report' }), 3)).toMatchObject({ autonomy: 'on' })
  })
})

describe('describeAction', () => {
  it('parses an empty-network removal', () => {
    expect(
      describeAction({ reason: 'Removed empty network `ext-12_default` — no containers' })
    ).toEqual({
      kind: 'network',
      target: 'ext-12_default'
    })
  })

  it('parses an orphan removal with the volumes it kept', () => {
    expect(
      describeAction({
        reason:
          'Removed orphan stack `ext-03` — worktree gone, volumes kept: ext-03_data, ext-03_redis'
      })
    ).toEqual({ kind: 'orphan', target: 'ext-03', volumes: ['ext-03_data', 'ext-03_redis'] })
    expect(
      describeAction({ reason: 'Removed orphan stack `ext-03` — worktree gone, volumes kept' })
    ).toEqual({ kind: 'orphan', target: 'ext-03', volumes: [] })
  })

  it('parses a pause, with or without the restore command', () => {
    expect(
      describeAction({
        reason: 'Paused `proj-34` — idle 3 h · bring back: `docker compose -p proj-34 up -d`'
      })
    ).toEqual({ kind: 'pause', target: 'proj-34', idle: '3 h' })
    expect(describeAction({ reason: 'Paused `proj-34` — idle 40 min' })).toEqual({
      kind: 'pause',
      target: 'proj-34',
      idle: '40 min'
    })
  })

  it('a report item gives the kind and target itself; a bare idle reason still parses', () => {
    expect(describeAction({ kind: 'pause', target: 'ext-12', reason: 'idle 120 h' })).toEqual({
      kind: 'pause',
      target: 'ext-12',
      idle: '120 h'
    })
  })

  it('a sentence it does not know falls back to the raw text and never throws', () => {
    expect(describeAction({ reason: 'Something else entirely' })).toEqual({
      kind: null,
      raw: 'Something else entirely'
    })
    expect(describeAction({ reason: '' })).toEqual({ kind: null, raw: '' })
    expect(describeAction({ kind: 'network', target: 'x', reason: 'odd text' })).toEqual({
      kind: 'network',
      target: 'x'
    })
  })
})

const line = (over: Partial<Tombstone> & { at: number }): Tombstone => ({
  actor: 'autopilot',
  verb: 'remove',
  stacks: [],
  restoreHint: null,
  ...over
})
const network = (at: number, name = 'ext-12_default'): Tombstone =>
  line({ at, reason: `Removed empty network \`${name}\` — no containers` })
const orphan = (at: number): Tombstone =>
  line({
    at,
    reason: 'Removed orphan stack `ext-03` — worktree gone, volumes kept: ext-03_data',
    stacks: [
      {
        stack: 'ext-03',
        name: 'ext-03',
        path: null,
        containerIds: [],
        freed: { ramBytes: 0, ports: [], volumes: [], volumeBytes: 0 },
        keptVolumes: ['ext-03_data'],
        keptVolumeOwner: { reason: 'worktree-removed', project: 'ext-03', worktreePath: null }
      }
    ]
  })
const pause = (at: number): Tombstone =>
  line({
    at,
    verb: 'stop',
    reason: 'Paused `proj-34` — idle 3 h · bring back: `docker compose -p proj-34 up -d`',
    stacks: [
      {
        stack: 'proj-34',
        name: 'proj-34',
        path: null,
        containerIds: [],
        freed: { ramBytes: 0, ports: [], volumes: [], volumeBytes: 0 },
        paused: {
          project: 'proj-34',
          workingDir: '/w',
          configFiles: [],
          profiles: [],
          envFile: null,
          hasBuild: false,
          ports: [],
          restoreCommand: 'docker compose -p proj-34 up -d',
          pausedAt: at
        }
      }
    ]
  })
const stopBeforeRemoval = (at: number): Tombstone =>
  line({ at, verb: 'stop', reason: 'Stopped orphan stack `ext-03` before removing it' })
const operatorStop = (at: number): Tombstone => ({ ...pause(at), actor: 'operator' })

describe('automaticActions', () => {
  it('keeps the five newest of seven, newest first', () => {
    const recent = [
      network(70),
      network(60),
      orphan(50),
      pause(40),
      network(30),
      network(20),
      network(10)
    ]
    const rows = automaticActions(recent)
    expect(rows).toHaveLength(5)
    expect(rows.map((r) => r.at)).toEqual([70, 60, 50, 40, 30])
    expect(rows.every((r) => !r.would)).toBe(true)
  })

  it('skips operator lines and the stop that precedes an orphan removal', () => {
    const rows = automaticActions([stopBeforeRemoval(30), operatorStop(20), network(10)])
    expect(rows.map((r) => r.at)).toEqual([10])
    expect(rows[0]).toMatchObject({ kind: 'network', target: 'ext-12_default' })
  })

  it('reads the kind of an orphan removal and a pause', () => {
    const rows = automaticActions([pause(20), orphan(10)])
    expect(rows[0]).toMatchObject({ kind: 'pause', target: 'proj-34', idle: '3 h' })
    expect(rows[1]).toMatchObject({ kind: 'orphan', target: 'ext-03', volumes: ['ext-03_data'] })
  })

  it('an autopilot line with no reason (older journal) is skipped, not shown blank', () => {
    expect(automaticActions([line({ at: 5 })])).toEqual([])
  })
})

describe('wouldHaveRows', () => {
  const items: DockerReportItem[] = [
    {
      kind: 'network',
      target: 'ext-12_default',
      reason: 'Removed empty network `ext-12_default` — no containers'
    },
    { kind: 'pause', target: 'ext-12', reason: 'idle 120 h' }
  ]

  it('marks every row as a would-have', () => {
    const rows = wouldHaveRows({ items, found: 2 })
    expect(rows).toHaveLength(2)
    expect(rows.every((r) => r.would)).toBe(true)
    expect(rows[1]).toMatchObject({ kind: 'pause', target: 'ext-12', idle: '120 h' })
  })

  it('caps at five and reports how many more there are', () => {
    const many = Array.from({ length: 8 }, (_, i) => ({ ...items[0]!, target: `n${i}` }))
    expect(wouldHaveRows({ items: many, found: 8 })).toHaveLength(5)
  })

  it('nothing held is no rows', () => {
    expect(wouldHaveRows(null)).toEqual([])
    expect(wouldHaveRows({ items: [], found: 0 })).toEqual([])
  })
})

describe('pausedRows', () => {
  const stack = (name: string, pausedAt: number): PausedStack => ({
    stack: name,
    name,
    actor: 'autopilot',
    project: name,
    workingDir: `/w/${name}`,
    configFiles: [],
    profiles: [],
    envFile: null,
    hasBuild: false,
    ports: [],
    restoreCommand: `docker compose -p ${name} up -d`,
    pausedAt
  })

  it('shows three rows and counts the rest', () => {
    const five = ['a', 'b', 'c', 'd', 'e'].map((n, i) => stack(n, 100 - i))
    const r = pausedRows(five, 1000)
    expect(r.rows.map((x) => x.name)).toEqual(['a', 'b', 'c'])
    expect(r.more).toBe(2)
    expect(r.total).toBe(5)
    expect(r.rows[0]).toMatchObject({
      restoreCommand: 'docker compose -p a up -d',
      ageMs: 900
    })
  })

  it('none paused is an empty list', () => {
    expect(pausedRows([], 1000)).toEqual({ rows: [], more: 0, total: 0 })
  })
})
