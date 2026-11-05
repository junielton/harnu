import { describe, it, expect } from 'vitest'
import { computeTotals } from '../src/main/containers/containers-core'
import type {
  ContainersSnapshotAvailable,
  ContainersSnapshotUnavailable,
  StackRow,
  Tombstone
} from '../src/main/containers/containers-wire'
import {
  containersListing,
  containersScopeRoots,
  dockerUnavailableRefusal,
  type ListedStack
} from '../src/main/mcp/containers-listing'
import { available, GONE, HOUR, MAIN, NOW, stackRow, WT, WT2 } from './containers-fixtures'

/**
 * T328 — `list_containers`' payload: U1's snapshot with paths redacted to
 * aliases, blocked folders marked, and an optional one-repo scope. The
 * verdicts are U1's; this file only proves they pass through untouched.
 */

const HOME = '/home/dev'
const OTHER = '/home/dev/org/api-gateway'

function attributed(
  id: string,
  p: string,
  folderKind: 'main-checkout' | 'worktree',
  over: Partial<StackRow> = {}
): StackRow {
  return stackRow({
    id,
    verdict: folderKind === 'main-checkout' ? 'protected' : 'zombie',
    attribution: { rung: 'compose-label', path: p, folderPath: p, folderKind },
    ...over
  })
}

const mainStack = attributed('www', MAIN, 'main-checkout')
const wtStack = stackRow({ id: 'wave-1', verdict: 'zombie' })
const wt2Stack = attributed('wave-2', WT2, 'worktree', {
  verdict: 'pending',
  unusedForMs: HOUR,
  zombieInMs: HOUR
})
const orphanStack = stackRow({ id: 'wave-0', verdict: 'orphan' })
const strayStack = stackRow({ id: 'stray', verdict: 'unknown', kind: 'container', project: null })
const otherStack = attributed('gateway', OTHER, 'main-checkout', { verdict: 'active' })
const STACKS = [mainStack, wtStack, wt2Stack, orphanStack, strayStack, otherStack]

const tombWt: Tombstone = {
  at: NOW - HOUR,
  actor: 'agent',
  verb: 'remove',
  stacks: [
    {
      stack: 'wave-1',
      name: 'wave-1',
      path: WT,
      containerIds: ['c1'],
      freed: { ramBytes: 0, ports: [], volumes: [], volumeBytes: 0 }
    }
  ],
  restoreHint: `docker compose --project-directory '${WT}' up -d`
}
const tombOther: Tombstone = {
  at: NOW - 2 * HOUR,
  actor: 'operator',
  verb: 'stop',
  stacks: [
    {
      stack: 'gateway',
      name: 'gateway',
      path: OTHER,
      containerIds: ['c2'],
      freed: { ramBytes: 5, ports: [8080], volumes: [], volumeBytes: 0 }
    }
  ],
  restoreHint: 'docker start c2'
}

const SNAP: ContainersSnapshotAvailable = {
  ...available(STACKS),
  totals: computeTotals(STACKS),
  recent: [tombWt, tombOther]
}

const FOLDERS = [
  { path: MAIN, repoId: 'www' },
  { path: WT, repoId: 'www' },
  { path: WT2, repoId: 'www' },
  { path: OTHER, repoId: 'gateway' }
]

function omit(o: object, keys: string[]): Record<string, unknown> {
  return Object.fromEntries(Object.entries(o).filter(([k]) => !keys.includes(k)))
}

function byId(stacks: ListedStack[], id: string): ListedStack {
  const s = stacks.find((x) => x.id === id)
  if (!s) throw new Error(`no stack ${id}`)
  return s
}

describe('containersListing — unscoped (AC-1)', () => {
  const out = containersListing(SNAP, { denyFolders: [], home: HOME })

  it('keeps the snapshot header and totals unchanged', () => {
    expect(out.dockerAvailable).toBe(true)
    expect(out.scannedAt).toBe(SNAP.scannedAt)
    expect(out.zombieAfterDays).toBe(SNAP.zombieAfterDays)
    expect(out.totals).toEqual(SNAP.totals)
  })

  it('keeps every stack, in order, with every non-path field untouched', () => {
    expect(out.stacks.map((s) => s.id)).toEqual(SNAP.stacks.map((s) => s.id))
    out.stacks.forEach((s, i) => {
      const orig = SNAP.stacks[i]!
      expect(omit(s, ['attribution', 'folderAlias', 'agentControllable'])).toEqual(
        omit(orig, ['attribution'])
      )
      expect(s.verdict).toBe(orig.verdict)
      expect(s.attribution.rung).toBe(orig.attribution.rung)
      expect(s.attribution.folderKind).toBe(orig.attribution.folderKind)
    })
  })

  it('keeps every journal entry, newest first', () => {
    expect(out.recent.map((t) => t.at)).toEqual([tombWt.at, tombOther.at])
    expect(out.recent[0]!.actor).toBe('agent')
  })
})

describe('containersListing — redaction (AC-2)', () => {
  const out = containersListing(SNAP, { denyFolders: [], home: HOME })

  it('no absolute path leaves the listing', () => {
    const text = JSON.stringify(out)
    for (const p of [MAIN, WT, WT2, GONE, OTHER, `${HOME}/`]) expect(text).not.toContain(p)
  })

  it('replaces paths with basename aliases', () => {
    expect(byId(out.stacks, 'wave-1').folderAlias).toBe('PROJ-231-wave-1')
    expect(byId(out.stacks, 'wave-1').attribution.pathAlias).toBe('PROJ-231-wave-1')
    expect(byId(out.stacks, 'www').folderAlias).toBe('www')
    // An orphan's worktree is gone: its path still has an alias, no folder does.
    expect(byId(out.stacks, 'wave-0').folderAlias).toBeNull()
    expect(byId(out.stacks, 'wave-0').attribution.pathAlias).toBe('PROJ-231-wave-0')
    expect(byId(out.stacks, 'stray').folderAlias).toBeNull()
    expect(byId(out.stacks, 'stray').attribution.pathAlias).toBeNull()
    expect(byId(out.stacks, 'wave-1').attribution).not.toHaveProperty('path')
    expect(byId(out.stacks, 'wave-1').attribution).not.toHaveProperty('folderPath')
  })

  it('redacts journal paths and the restore hint, keeping the command shape', () => {
    const [wt, other] = out.recent
    expect(wt!.stacks[0]).not.toHaveProperty('path')
    expect(wt!.stacks[0]!.pathAlias).toBe('PROJ-231-wave-1')
    expect(wt!.restoreHint).toBe(`docker compose --project-directory '<PROJ-231-wave-1>' up -d`)
    expect(other!.restoreHint).toBe('docker start c2')
  })

  it('a stack a blocked folder covers still lists, with agentControllable:false', () => {
    const blocked = containersListing(SNAP, { denyFolders: [WT], home: HOME })
    expect(blocked.stacks).toHaveLength(STACKS.length)
    expect(byId(blocked.stacks, 'wave-1').agentControllable).toBe(false)
    expect(byId(blocked.stacks, 'www').agentControllable).toBe(true)
    expect(byId(blocked.stacks, 'wave-2').agentControllable).toBe(true)
  })

  it('blocking a repo covers its worktrees, gone ones included', () => {
    const blocked = containersListing(SNAP, { denyFolders: [MAIN], home: HOME })
    for (const id of ['www', 'wave-1', 'wave-2', 'wave-0']) {
      expect(byId(blocked.stacks, id).agentControllable).toBe(false)
    }
    expect(byId(blocked.stacks, 'gateway').agentControllable).toBe(true)
    // No folder covers an unattributed stack, so no block does either.
    expect(byId(blocked.stacks, 'stray').agentControllable).toBe(true)
  })
})

describe('containersListing — folder scope (AC-1)', () => {
  it('a worktree scope lists its whole repo: main checkout and every worktree', () => {
    const roots = containersScopeRoots(WT, FOLDERS, HOME)
    expect([...roots].sort()).toEqual([MAIN, WT, WT2].sort())
    const out = containersListing(SNAP, { denyFolders: [], home: HOME, scopeRoots: roots })
    expect(out.stacks.map((s) => s.id)).toEqual(['www', 'wave-1', 'wave-2', 'wave-0'])
  })

  it('recomputes totals over the scoped stacks with the core function', () => {
    const roots = containersScopeRoots(MAIN, FOLDERS, HOME)
    const out = containersListing(SNAP, { denyFolders: [], home: HOME, scopeRoots: roots })
    const kept = STACKS.filter((s) => ['www', 'wave-1', 'wave-2', 'wave-0'].includes(s.id))
    expect(out.totals).toEqual(computeTotals(kept))
  })

  it('narrows the journal to the same repo', () => {
    const roots = containersScopeRoots(WT, FOLDERS, HOME)
    const out = containersListing(SNAP, { denyFolders: [], home: HOME, scopeRoots: roots })
    expect(out.recent.map((t) => t.stacks[0]!.stack)).toEqual(['wave-1'])
  })

  it('a subfolder of a checkout resolves to its repo', () => {
    expect(containersScopeRoots(`${MAIN}/docker`, FOLDERS, HOME)).toContain(WT2)
  })

  it('a folder no known repo contains narrows to itself', () => {
    const roots = containersScopeRoots(OTHER, [], HOME)
    expect(roots).toEqual([OTHER])
    const out = containersListing(SNAP, { denyFolders: [], home: HOME, scopeRoots: roots })
    expect(out.stacks.map((s) => s.id)).toEqual(['gateway'])
  })
})

describe('dockerUnavailableRefusal (AC-3)', () => {
  const unavailable = (dockerError: string): ContainersSnapshotUnavailable => ({
    scannedAt: NOW,
    dockerAvailable: false,
    dockerError,
    zombieAfterDays: 2,
    recent: []
  })

  it('is a DOCKER_UNAVAILABLE refusal carrying docker’s error line, never a list', () => {
    const line =
      'Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?'
    const r = dockerUnavailableRefusal(unavailable(line), HOME)
    expect(r).toMatchObject({ ok: false, error: 'DOCKER_UNAVAILABLE', dockerError: line })
    expect(r.scannedAt).toBe(NOW)
    expect(r.message).toContain(line)
    expect(r.nextActions.length).toBeGreaterThan(0)
    expect(r).not.toHaveProperty('stacks')
    expect(r).not.toHaveProperty('totals')
  })

  it('scrubs the home directory out of docker’s error', () => {
    const r = dockerUnavailableRefusal(
      unavailable(`open ${HOME}/.docker/config.json: permission denied`),
      HOME
    )
    expect(r.dockerError).not.toContain(`${HOME}/`)
  })
})

describe('containersListing — paused stacks (U3.4 AC-5)', () => {
  const OUTSIDE = '/srv/shared/compose'
  const pausedAt = NOW - 3 * HOUR
  const pausedStack = (over: Partial<ContainersSnapshotAvailable['paused'][number]> = {}) => ({
    stack: 'wave-9',
    name: 'wave-9',
    actor: 'autopilot' as const,
    project: 'wave-9',
    workingDir: WT,
    configFiles: [`${WT}/compose.yml`, `${OUTSIDE}/base.yml`],
    profiles: ['web'],
    envFile: `${OUTSIDE}/.env`,
    hasBuild: true,
    ports: [8082],
    pausedAt,
    restoreCommand:
      `docker compose -p wave-9 --project-directory ${WT} -f ${WT}/compose.yml ` +
      `-f ${OUTSIDE}/base.yml --profile web --env-file ${OUTSIDE}/.env up -d --build`,
    ...over
  })
  const withPaused = (...p: ReturnType<typeof pausedStack>[]): ContainersSnapshotAvailable => ({
    ...SNAP,
    paused: p
  })

  it('marks the stack paused and carries its restore command, paths shown as aliases', () => {
    const out = containersListing(withPaused(pausedStack()), { denyFolders: [], home: HOME })
    expect(out.paused).toEqual([
      {
        id: 'wave-9',
        name: 'wave-9',
        project: 'wave-9',
        actor: 'autopilot',
        pausedAt,
        ports: [8082],
        profiles: ['web'],
        hasBuild: true,
        folderAlias: 'PROJ-231-wave-1',
        agentControllable: true,
        restoreCommand:
          'docker compose -p wave-9 --project-directory <PROJ-231-wave-1> ' +
          '-f <PROJ-231-wave-1>/compose.yml -f <base.yml> --profile web --env-file <.env> up -d --build'
      }
    ])
  })

  it('no absolute path of a pause leaves the listing — not in paused, not in recent', () => {
    const p = pausedStack()
    const tomb: Tombstone = {
      at: pausedAt,
      actor: 'autopilot',
      verb: 'stop',
      stacks: [
        {
          stack: 'wave-9',
          name: 'wave-9',
          path: WT,
          containerIds: ['c9'],
          freed: { ramBytes: 0, ports: [8082], volumes: [], volumeBytes: 0 },
          paused: p
        }
      ],
      restoreHint: p.restoreCommand
    }
    const out = containersListing(
      { ...withPaused(p), recent: [tomb] },
      { denyFolders: [], home: HOME }
    )
    const text = JSON.stringify(out)
    for (const leak of [WT, MAIN, OUTSIDE, `${HOME}/`]) expect(text).not.toContain(leak)
    expect(out.recent[0]!.restoreHint).toContain('--project-directory <PROJ-231-wave-1>')
    expect(out.recent[0]!.stacks[0]!.paused?.restoreCommand).toBe(out.paused[0]!.restoreCommand)
  })

  it('a compose file outside the folder never leaks from a remove hint either', () => {
    const tomb: Tombstone = {
      ...tombWt,
      restoreHint: `docker compose -p wave-1 --project-directory '${WT}' -f '${OUTSIDE}/it'\\''s.yml' --env-file ${OUTSIDE}/.env up -d`
    }
    const out = containersListing({ ...SNAP, recent: [tomb] }, { denyFolders: [], home: HOME })
    expect(out.recent[0]!.restoreHint).toBe(
      "docker compose -p wave-1 --project-directory '<PROJ-231-wave-1>' -f <it's.yml> --env-file <.env> up -d"
    )
  })

  it('a stack row never carries the compose label facts (absolute paths)', () => {
    const row = stackRow({
      id: 'wave-1',
      verdict: 'zombie',
      compose: { configFiles: [`${WT}/compose.yml`], envFile: `${OUTSIDE}/.env` }
    })
    const out = containersListing(
      { ...SNAP, stacks: [row], totals: computeTotals([row]) },
      { denyFolders: [], home: HOME }
    )
    expect(JSON.stringify(out)).not.toContain(OUTSIDE)
    expect(out.stacks[0]).not.toHaveProperty('compose')
  })

  it('a blocked folder still lists its pause, with agentControllable:false', () => {
    const out = containersListing(withPaused(pausedStack()), { denyFolders: [WT], home: HOME })
    expect(out.paused[0]!.agentControllable).toBe(false)
  })

  it('a scoped listing keeps only the pauses of that repo', () => {
    const other = pausedStack({
      stack: 'gateway-3',
      name: 'gateway-3',
      workingDir: OTHER,
      configFiles: [],
      envFile: null,
      restoreCommand: `docker compose -p gateway-3 --project-directory ${OTHER} up -d`
    })
    const roots = containersScopeRoots(WT, FOLDERS, HOME)
    const out = containersListing(withPaused(pausedStack(), other), {
      denyFolders: [],
      home: HOME,
      scopeRoots: roots
    })
    expect(out.paused.map((p) => p.id)).toEqual(['wave-9'])
    expect(
      containersListing(withPaused(pausedStack(), other), { denyFolders: [], home: HOME }).paused
    ).toHaveLength(2)
  })

  it('lists an empty array, never a missing key, when nothing is paused', () => {
    expect(containersListing(SNAP, { denyFolders: [], home: HOME }).paused).toEqual([])
  })
})
