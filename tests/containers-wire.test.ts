/**
 * The ADR-0014 seam (T330): the wire contract is plain JSON, imports nothing,
 * and is the only containers module the preload may see; only the shell ever
 * spawns docker.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import * as path from 'node:path'
import { buildSnapshot, unavailableSnapshot } from '../src/main/containers/containers-core'
import type {
  ActResult,
  ContainersPrefs,
  ContainersSnapshot,
  Tombstone
} from '../src/main/containers/containers-wire'
import {
  DAY,
  GONE,
  MAIN,
  NOW,
  WT,
  WT2,
  composeContainer,
  container,
  knownFolder,
  scanInput
} from './containers-fixtures'

const REPO = path.join(__dirname, '..')

function roundTrip<T>(x: T): T {
  return JSON.parse(JSON.stringify(x)) as T
}

const TOMBSTONE: Tombstone = {
  at: NOW - DAY,
  actor: 'agent',
  verb: 'stop',
  stacks: [
    {
      stack: 'proj-54',
      name: 'proj-54',
      path: WT,
      containerIds: ['e'.repeat(64)],
      freed: { ramBytes: 1, ports: [8054], volumes: [], volumeBytes: 0 }
    }
  ],
  restoreHint: 'docker start eeeeeeeeeeee'
}

describe('containers-wire.ts (PRD §5, ADR-0014 §1)', () => {
  it('a ContainersSnapshot covering every verdict round-trips through JSON unchanged', () => {
    const mysql = { type: 'volume', source: '/v', name: 'proj-11_mysql' }
    const snap: ContainersSnapshot = buildSnapshot(
      scanInput({
        containers: [
          container({ name: 'postgres-scratch' }), // unknown
          composeContainer('proj-27', GONE, { state: 'exited', mounts: [mysql] }), // orphan
          composeContainer('proj-71', WT2, { ports: [8071] }), // active
          composeContainer('proj-20', MAIN), // protected
          composeContainer('proj-33', WT, { startedAt: NOW - 3_600_000 }), // pending
          composeContainer('proj-82', WT, {
            service: 'db',
            startedAt: NOW - 3 * DAY,
            labels: { 'com.docker.compose.project': 'proj-82' }
          }) // zombie
        ],
        folders: [knownFolder(MAIN), knownFolder(WT), knownFolder(WT2, { liveSessionId: 's1' })],
        memById: new Map([['x', 1]]),
        volumes: new Map([['proj-11_mysql', { sizeBytes: 212_100_000, project: null }]]),
        recent: [TOMBSTONE]
      })
    )
    if (!snap.dockerAvailable) throw new Error('expected an available snapshot')
    expect(new Set(snap.stacks.map((s) => s.verdict))).toEqual(
      new Set(['unknown', 'orphan', 'active', 'protected', 'pending', 'zombie'])
    )
    // toStrictEqual also fails on undefined-valued keys, Maps, Sets and Dates.
    expect(roundTrip(snap)).toStrictEqual(snap)
  })

  it('the unavailable snapshot, an ActResult and the prefs round-trip too', () => {
    const down = unavailableSnapshot('Cannot connect to the Docker daemon', NOW, 2, [TOMBSTONE])
    expect(roundTrip(down)).toStrictEqual(down)
    const result: ActResult = {
      ok: false,
      verb: 'remove',
      results: [
        {
          stack: 'proj-82',
          ok: false,
          error: 'STACK_RUNNING',
          message: 'stop the stack first; removal never uses --force',
          containerIds: [],
          freedRamBytes: 0,
          freedVolumeBytes: 0,
          portsReleased: [],
          removedContainers: [],
          removedVolumes: [],
          keptVolumes: []
        }
      ],
      tombstone: null
    }
    expect(roundTrip(result)).toStrictEqual(result)
    const prefs: ContainersPrefs = {
      version: 1,
      autoScan: true,
      intervalMs: 3_600_000,
      zombieAfterDays: 2,
      notifyOnNewZombies: true
    }
    expect(roundTrip(prefs)).toStrictEqual(prefs)
  })

  it('imports nothing — no Electron, no sibling main-process module', () => {
    const src = readFileSync(path.join(REPO, 'src/main/containers/containers-wire.ts'), 'utf8')
    expect(src).not.toMatch(/^\s*import\s/m)
    expect(src).not.toMatch(/\brequire\s*\(/)
    expect(src).not.toMatch(/from\s+['"]/)
  })

  it('is the only containers module the preload imports, and only as types', () => {
    const preload = readFileSync(path.join(REPO, 'src/preload/index.ts'), 'utf8')
    const specifiers = [...preload.matchAll(/from '(\.\.\/main\/containers\/[^']+)'/g)].map(
      (m) => m[1]
    )
    expect(specifiers.length).toBeGreaterThan(0)
    expect(new Set(specifiers)).toEqual(new Set(['../main/containers/containers-wire']))
    const statements = preload.match(
      /^(import|export)[^;]*?from '\.\.\/main\/containers\/[^']+'/gms
    )
    expect(statements?.every((s) => /^(import|export) type /.test(s))).toBe(true)
  })
})

describe('ADR-0014 §2: containers-shell.ts is the only file that spawns docker', () => {
  function walk(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const full = path.join(dir, name)
      return statSync(full).isDirectory() ? walk(full) : [full]
    })
  }

  it('no other source file names the docker binary', () => {
    const offenders = walk(path.join(REPO, 'src'))
      .filter((f) => /\.(ts|vue|js|mjs)$/.test(f))
      .filter((f) => /['"]docker['"]/.test(readFileSync(f, 'utf8')))
      .map((f) => path.relative(REPO, f).split(path.sep).join('/'))
    expect(offenders).toEqual(['src/main/containers/containers-shell.ts'])
  })

  it('spawns through spawnEnvOnce, with a timeout and maxBuffer on every command', () => {
    const src = readFileSync(path.join(REPO, 'src/main/containers/containers-shell.ts'), 'utf8')
    expect(src).toMatch(/env: await spawnEnvOnce\(\)/)
    // One spawn site (docker and the git probe share it), and every call to it
    // passes one of the bounded option sets.
    expect(src.match(/execFileAsync\(/g)).toHaveLength(1)
    const calls = [...src.matchAll(/runDocker\(\s*[^)]*?,\s*(\w+)\s*\)/gs)].map((m) => m[1])
    expect(calls.length).toBeGreaterThanOrEqual(6)
    expect(new Set(calls)).toEqual(new Set(['PROBE_OPTS', 'SCAN_OPTS', 'ACT_OPTS']))
    expect(src.match(/runTool\(\s*'/g)).toHaveLength(2) // runDocker's, and the git probe's
    expect(src).toMatch(/runTool\(\s*'git',[\s\S]*?\],\s*GIT_OPTS\s*\)/)
    for (const name of ['PROBE_OPTS', 'SCAN_OPTS', 'ACT_OPTS', 'GIT_OPTS']) {
      expect(src).toMatch(new RegExp(`const ${name} = \\{[^}]*timeout: [\\d_]+[^}]*maxBuffer: `))
    }
  })
})
