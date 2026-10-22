/**
 * T484 (AC-B6-4) — blocking a folder in the folder menu ends every terminal write lease in it.
 * Real `setUserProjectAgentDenied` against a real projects file; the lease table is the live
 * singleton the gate reads.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

const h = vi.hoisted(() => ({ userDataDir: '' }))
vi.mock('electron', () => ({
  app: { getPath: (): string => h.userDataDir },
  ipcMain: { handle: (): void => {} }
}))

import {
  addUserProject,
  removeUserProject,
  setUserProjectAgentDenied,
  setUserProjectTerminalRead
} from '../src/main/user-projects'
import { terminalLeases } from '../src/main/terminal-lease'

describe('the folder block toggle ends write leases', () => {
  let repo = ''
  beforeEach(async () => {
    h.userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harnu-uplease-ud-'))
    repo = await fs.mkdtemp(path.join(os.tmpdir(), 'harnu-uplease-repo-'))
    await addUserProject({
      path: repo,
      alias: 'repo',
      addedAt: new Date(0).toISOString(),
      worktrees: []
    })
    terminalLeases.revokeAll()
  })
  afterEach(async () => {
    terminalLeases.revokeAll()
    await fs.rm(h.userDataDir, { recursive: true, force: true })
    await fs.rm(repo, { recursive: true, force: true })
  })

  it('blocking the folder ends its leases and the leases of terminals below it only', async () => {
    terminalLeases.grant('h-repo', repo, 'p-h-repo')
    terminalLeases.grant('h-wt', path.join(repo, '.claude', 'worktrees', 'wt'), 'p-h-wt')
    terminalLeases.grant('h-elsewhere', '/somewhere/else', 'p-h-elsewhere')
    await setUserProjectAgentDenied(repo, true)
    expect(terminalLeases.isActive('h-repo', 'p-h-repo')).toBe(false)
    expect(terminalLeases.isActive('h-wt', 'p-h-wt')).toBe(false)
    expect(terminalLeases.isActive('h-elsewhere', 'p-h-elsewhere')).toBe(true)
  })

  it('unblocking does not bring a lease back', async () => {
    terminalLeases.grant('h-repo', repo, 'p-h-repo')
    await setUserProjectAgentDenied(repo, true)
    await setUserProjectAgentDenied(repo, false)
    expect(terminalLeases.isActive('h-repo', 'p-h-repo')).toBe(false)
  })

  it('a block that is already on still ends a lease granted in the meantime', async () => {
    await setUserProjectAgentDenied(repo, true)
    terminalLeases.grant('h-repo', repo, 'p-h-repo')
    await setUserProjectAgentDenied(repo, true)
    expect(terminalLeases.isActive('h-repo', 'p-h-repo')).toBe(false)
  })

  it('unblocking never ends a lease', async () => {
    await setUserProjectAgentDenied(repo, true)
    terminalLeases.grant('h-repo', repo, 'p-h-repo')
    await setUserProjectAgentDenied(repo, false)
    expect(terminalLeases.isActive('h-repo', 'p-h-repo')).toBe(true)
  })

  it('T484 F5: turning the read opt-in OFF ends that folder’s leases, and turning it on never revives them', async () => {
    await setUserProjectTerminalRead(repo, true)
    terminalLeases.grant('h-repo', repo, 'p-h-repo')
    terminalLeases.grant('h-sub', path.join(repo, 'sub'), 'p-h-sub')
    await setUserProjectTerminalRead(repo, false)
    expect(terminalLeases.isActive('h-repo', 'p-h-repo')).toBe(false)
    // The opt-in is exact-folder, so a terminal in a subfolder is not this folder's business.
    expect(terminalLeases.isActive('h-sub', 'p-h-sub')).toBe(true)
    await setUserProjectTerminalRead(repo, true)
    expect(terminalLeases.isActive('h-repo', 'p-h-repo')).toBe(false)
  })

  it('T484 F5: turning the opt-in ON does not end a lease', async () => {
    terminalLeases.grant('h-repo', repo, 'p-h-repo')
    await setUserProjectTerminalRead(repo, true)
    expect(terminalLeases.isActive('h-repo', 'p-h-repo')).toBe(true)
  })

  it('T487 F5-bis: removing the folder ends its leases; re-adding and opting in again never revives one', async () => {
    await setUserProjectTerminalRead(repo, true)
    terminalLeases.grant('h-repo', repo, 'p-h-repo')
    terminalLeases.grant('h-sub', path.join(repo, 'sub'), 'p-h-sub')
    await removeUserProject(repo)
    expect(terminalLeases.isActive('h-repo', 'p-h-repo')).toBe(false)
    // Exact folder, like the opt-in itself: a terminal in a subfolder is another folder's business.
    expect(terminalLeases.isActive('h-sub', 'p-h-sub')).toBe(true)
    await addUserProject({
      path: repo,
      alias: 'repo',
      addedAt: new Date(0).toISOString(),
      worktrees: []
    })
    await setUserProjectTerminalRead(repo, true)
    expect(terminalLeases.isActive('h-repo', 'p-h-repo')).toBe(false)
  })

  it('removing a folder that is not there leaves other leases alone', async () => {
    terminalLeases.grant('h-repo', repo, 'p-h-repo')
    await removeUserProject('/not/a/pinned/folder')
    expect(terminalLeases.isActive('h-repo', 'p-h-repo')).toBe(true)
  })
})
