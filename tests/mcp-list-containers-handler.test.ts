import { describe, it, expect, beforeEach, vi } from 'vitest'
import * as path from 'node:path'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'

/**
 * T328 — `list_containers` driven through the REAL wired handler.
 *
 * The Containers service (T330) is replaced by a stub so no docker command
 * runs: this file pins what the verb does with the snapshot the service hands
 * back — a fresh scan, redaction, the scope, and the DOCKER_UNAVAILABLE
 * refusal. The redaction details are pinned purely in
 * `mcp-containers-listing.test.ts`.
 */

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getPath: (): string => '/tmp',
    getAppPath: (): string => process.cwd()
  },
  dialog: {},
  shell: {},
  BrowserWindow: class {},
  ipcMain: { handle: (): void => {}, on: (): void => {} }
}))

const h = vi.hoisted(() => ({
  service: null as null | { scan: () => Promise<unknown> },
  scans: 0
}))

vi.mock('../src/main/containers/containers-ipc', () => ({
  getContainersService: () => h.service
}))

import { WIRED_TOOLS } from '../src/main/mcp/tool-handlers'
import type { FolderEntry } from '../src/main/folder-model'
import type { ContainersSnapshot } from '../src/main/containers/containers-wire'
import { available, MAIN, NOW, stackRow, WT } from './containers-fixtures'

const handler = WIRED_TOOLS.find((t) => t.op === 'list_containers')!.handler!

const OTHER = '/home/dev/org/api-gateway'

function serve(snap: ContainersSnapshot): void {
  h.service = {
    scan: async () => {
      h.scans++
      return snap
    }
  }
}

function folderEntry(p: string, repoId: string): FolderEntry {
  return { path: p, alias: path.basename(p), repoId, sessions: [] } as unknown as FolderEntry
}

function ctx(denyFolders: string[] = [], folders: FolderEntry[] = []) {
  return { folder: '', folders, denyFolders, bridge: undefined }
}

function textOf(res: CallToolResult): string {
  const first = res.content[0]
  if (!first || first.type !== 'text') throw new Error('expected text content')
  return first.text
}

const mainStack = stackRow({
  id: 'www',
  verdict: 'protected',
  attribution: { rung: 'compose-label', path: MAIN, folderPath: MAIN, folderKind: 'main-checkout' }
})
const wtStack = stackRow({ id: 'wave-1', verdict: 'zombie' })
const otherStack = stackRow({
  id: 'gateway',
  verdict: 'active',
  attribution: {
    rung: 'compose-label',
    path: OTHER,
    folderPath: OTHER,
    folderKind: 'main-checkout'
  }
})

beforeEach(() => {
  h.service = null
  h.scans = 0
})

describe('list_containers handler (T328)', () => {
  it('AC-1: answers from a fresh scan with the snapshot’s stacks and verdicts', async () => {
    serve(available([mainStack, wtStack]))
    const res = await handler({}, ctx())
    expect(res.isError).toBeFalsy()
    const payload = JSON.parse(textOf(res))
    expect(h.scans).toBe(1)
    expect(payload).toMatchObject({ ok: true, dockerAvailable: true, scannedAt: NOW })
    expect(payload.stacks.map((s: { id: string; verdict: string }) => [s.id, s.verdict])).toEqual([
      ['www', 'protected'],
      ['wave-1', 'zombie']
    ])
  })

  it('AC-1: folder scopes the listing to one repo and its worktrees', async () => {
    serve(available([mainStack, wtStack, otherStack]))
    const folders = [folderEntry(MAIN, 'www'), folderEntry(WT, 'www'), folderEntry(OTHER, 'gw')]
    const res = await handler({ folder: WT }, ctx([], folders))
    const ids = JSON.parse(textOf(res)).stacks.map((s: { id: string }) => s.id)
    expect(ids).toEqual(['www', 'wave-1'])
  })

  it('AC-2: a blocked folder’s stack lists with agentControllable:false, paths redacted', async () => {
    serve(available([mainStack, wtStack, otherStack]))
    const res = await handler({}, ctx([MAIN]))
    const text = textOf(res)
    expect(text).not.toContain(MAIN)
    expect(text).not.toContain(OTHER)
    const stacks = JSON.parse(text).stacks as Array<{
      id: string
      folderAlias: string | null
      agentControllable: boolean
    }>
    expect(stacks.map((s) => [s.id, s.agentControllable])).toEqual([
      ['www', false],
      ['wave-1', false],
      ['gateway', true]
    ])
    expect(stacks[1]!.folderAlias).toBe('PROJ-231-wave-1')
  })

  it('AC-3: docker unavailable is a DOCKER_UNAVAILABLE refusal, never an empty list', async () => {
    serve({
      scannedAt: NOW,
      dockerAvailable: false,
      dockerError: 'docker CLI not found on PATH',
      zombieAfterDays: 2,
      recent: []
    })
    const res = await handler({}, ctx())
    expect(res.isError).toBe(true)
    const payload = JSON.parse(textOf(res))
    expect(payload).toMatchObject({
      ok: false,
      error: 'DOCKER_UNAVAILABLE',
      dockerError: 'docker CLI not found on PATH'
    })
    expect(payload).not.toHaveProperty('stacks')
  })

  it('refuses CONTAINERS_NOT_READY before the service is registered', async () => {
    const res = await handler({}, ctx())
    expect(res.isError).toBe(true)
    expect(textOf(res)).toMatch(/^CONTAINERS_NOT_READY/)
  })
})
