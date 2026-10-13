import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { InspectedContainer } from '../src/main/containers/containers-core'

/**
 * Delta-1 item 2 (AC-D3): a worktree removed through the sidebar (`worktree:remove`) leaves the
 * same Docker leftovers as one the engine removed, so it is remembered the same way: the compose
 * projects found running from the folder, read from Docker's own labels and from the names the
 * folder pins, before the folder goes.
 */

const h = vi.hoisted(() => ({
  userData: '',
  containers: [] as unknown[],
  dockerFails: false,
  remembered: [] as Array<{ project: string; dir: string }[]>
}))
vi.mock('electron', () => ({
  app: { getPath: (): string => h.userData, isPackaged: false },
  ipcMain: { handle: (): void => {}, on: (): void => {} }
}))
vi.mock('../src/main/claude-reader', () => ({ scanFolders: async () => [] }))
vi.mock('../src/main/containers/containers-shell', () => ({
  inspectAll: async () => {
    if (h.dockerFails) throw new Error('docker down')
    return h.containers
  }
}))

import { projectsRunningFrom, rememberStacksOfFolder } from '../src/main/gc/gc-removed-stacks'
import { setLeftoverRememberer } from '../src/main/gc/gc-leftover-registry'
import { removeWorktree } from '../src/main/worktree-ipc'

const WT = '/ws/org/proj/repo-wt'
const container = (
  id: string,
  project: string | null,
  dir: string | null,
  mounts: string[] = []
): InspectedContainer => ({
  id,
  name: id,
  image: 'img',
  labels: {
    ...(project ? { 'com.docker.compose.project': project } : {}),
    ...(dir ? { 'com.docker.compose.project.working_dir': dir } : {})
  },
  state: 'running',
  startedAt: null,
  finishedAt: null,
  createdAt: null,
  ports: [],
  mounts: mounts.map((source) => ({ type: 'bind', source, name: null }))
})

describe('projectsRunningFrom', () => {
  it('takes the projects whose working dir or bind mount lies in the folder', () => {
    const out = projectsRunningFrom(
      WT,
      [
        container('a', 'pj', `${WT}/docker`),
        container('b', 'other', '/elsewhere', [`${WT}/data`]),
        container('c', 'sibling', `${WT}-2`),
        container('d', null, WT)
      ],
      []
    )
    expect(out.sort()).toEqual(['other', 'pj'])
  })

  it('adds the names the folder pins itself, without duplicates', () => {
    expect(projectsRunningFrom(WT, [container('a', 'pj', WT)], ['pj', 'pinned'])).toEqual([
      'pj',
      'pinned'
    ])
  })
})

describe('rememberStacksOfFolder', () => {
  beforeEach(() => {
    h.remembered = []
    h.dockerFails = false
    h.containers = []
    setLeftoverRememberer((entries) => void h.remembered.push(entries))
  })
  afterEach(() => setLeftoverRememberer(null))

  it('remembers each project with the folder it ran from', async () => {
    h.containers = [container('a', 'pj', WT)]
    await rememberStacksOfFolder(WT)
    expect(h.remembered).toEqual([[{ project: 'pj', dir: WT }]])
  })

  it('docker failing never throws and remembers what the folder pins', async () => {
    h.dockerFails = true
    await expect(
      rememberStacksOfFolder(WT, { pinnedNames: async () => ['pinned'] })
    ).resolves.toBeUndefined()
    expect(h.remembered).toEqual([[{ project: 'pinned', dir: WT }]])
  })

  it('with nothing to remember it writes nothing', async () => {
    await rememberStacksOfFolder(WT)
    expect(h.remembered).toEqual([])
  })
})

describe('the sidebar Remove remembers the stack (worktree:remove)', () => {
  let root: string
  beforeEach(() => {
    h.userData = mkdtempSync(path.join(os.tmpdir(), 'harnu-sbl-ud-'))
    root = mkdtempSync(path.join(os.tmpdir(), 'harnu-sbl-'))
    h.remembered = []
    h.dockerFails = false
    setLeftoverRememberer((entries) => void h.remembered.push(entries))
  })
  afterEach(() => {
    setLeftoverRememberer(null)
    rmSync(root, { recursive: true, force: true })
    rmSync(h.userData, { recursive: true, force: true })
  })

  it('a real removal remembers the compose project that ran from the worktree', async () => {
    const repo = path.join(root, 'repo')
    mkdirSync(repo)
    execFileSync('git', ['init', '-q', '-b', 'main', repo])
    const g = (...a: string[]): void => void execFileSync('git', ['-C', repo, ...a])
    g('config', 'user.email', 'a@b.c')
    g('config', 'user.name', 'T')
    writeFileSync(path.join(repo, 'f.txt'), '1')
    g('add', '.')
    g('commit', '-q', '-m', 'one')
    const wt = path.join(root, 'repo-wt')
    g('worktree', 'add', '-q', '-b', 'feat/x', wt)
    h.containers = [container('a', 'pj', wt), container('z', 'unrelated', '/elsewhere')]
    await removeWorktree(repo, wt, true, false)
    expect(h.remembered).toEqual([[{ project: 'pj', dir: wt }]])
  })
})
