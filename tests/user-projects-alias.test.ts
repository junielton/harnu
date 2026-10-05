import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

/**
 * T52 persistence — `setUserProjectAlias` (rename) and
 * `setUserProjectAliasFromBranch` (auto-alias opt-in). Both must CREATE a pinned
 * record for an auto-discovered folder (so the choice survives a restart) and be
 * idempotent. Real `projects.json` round-trips against a throwaway userData dir;
 * `electron.app.getPath` is mocked to point at it.
 */

const h = vi.hoisted(() => ({ userDataDir: '' }))
vi.mock('electron', () => ({
  app: { getPath: (): string => h.userDataDir },
  ipcMain: { handle: (): void => {} }
}))

import {
  setUserProjectAlias,
  setUserProjectAliasFromBranch,
  setUserProjectInheritAgentControl,
  addUserProject
} from '../src/main/user-projects'

// A path that doesn't exist on disk → `normalizePath` returns it verbatim
// (realpath fails, falls back to the resolved string), so assertions are stable.
const P = '/repos/app'

describe('setUserProjectAlias (T52 rename)', () => {
  beforeEach(async () => {
    h.userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harnu-upalias-'))
  })
  afterEach(async () => {
    await fs.rm(h.userDataDir, { recursive: true, force: true })
  })

  it('creates a pinned record carrying the alias for an auto-discovered folder', async () => {
    const file = await setUserProjectAlias(P, 'My App')
    const rec = file.projects.find((p) => p.path === P)!
    expect(rec).toBeTruthy()
    expect(rec.alias).toBe('My App')
    expect(rec.worktrees).toEqual([])
  })

  it('updates the alias on an existing record', async () => {
    await addUserProject({ path: P, alias: 'app', addedAt: '2026-01-01', worktrees: [] })
    const file = await setUserProjectAlias(P, 'Renamed')
    expect(file.projects.find((p) => p.path === P)!.alias).toBe('Renamed')
  })

  it('a blank alias resets the label to the folder basename', async () => {
    await setUserProjectAlias(P, 'Custom')
    const file = await setUserProjectAlias(P, '   ')
    expect(file.projects.find((p) => p.path === P)!.alias).toBe('app')
  })

  it('is idempotent — no throw and the alias holds when set to the same value', async () => {
    await setUserProjectAlias(P, 'Same')
    const file = await setUserProjectAlias(P, 'Same')
    expect(file.projects.find((p) => p.path === P)!.alias).toBe('Same')
  })
})

describe('setUserProjectAliasFromBranch (T52 auto-alias opt-in)', () => {
  beforeEach(async () => {
    h.userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harnu-upflag-'))
  })
  afterEach(async () => {
    await fs.rm(h.userDataDir, { recursive: true, force: true })
  })

  it('creates a record with the flag on for an auto-discovered folder', async () => {
    const file = await setUserProjectAliasFromBranch(P, true)
    expect(file.projects.find((p) => p.path === P)!.aliasFromBranch).toBe(true)
  })

  it('toggles the flag on an existing record', async () => {
    await addUserProject({ path: P, alias: 'app', addedAt: '2026-01-01', worktrees: [] })
    await setUserProjectAliasFromBranch(P, true)
    const off = await setUserProjectAliasFromBranch(P, false)
    expect(off.projects.find((p) => p.path === P)!.aliasFromBranch).toBe(false)
  })
})

describe('setUserProjectInheritAgentControl (T72 "Sempre" marker — load-bearing)', () => {
  const WT = '/repos/app/.claude/worktrees/wt'
  beforeEach(async () => {
    h.userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harnu-upinherit-'))
  })
  afterEach(async () => {
    await fs.rm(h.userDataDir, { recursive: true, force: true })
  })

  it('creates a record carrying the marker for a not-yet-pinned worktree', async () => {
    const file = await setUserProjectInheritAgentControl(WT, true)
    const rec = file.projects.find((p) => p.path === WT)!
    expect(rec).toBeTruthy()
    expect(rec.inheritAgentControl).toBe(true)
    // Post-reversal the record is born agent-REACHABLE: no `agentAllowed: false` stamp
    // (the field is deprecated and read by nothing), and no `agentDenied` either —
    // absent means agents may act, which is the whole point of the flip.
    expect(rec.agentAllowed).toBeUndefined()
    expect(rec.agentDenied).toBeUndefined()
  })

  it('flips the marker in place on an existing record, preserving other fields', async () => {
    await addUserProject({
      path: WT,
      alias: 'wt',
      addedAt: '2026-01-01',
      worktrees: [],
      agentAllowed: false,
      gitBranch: 'feat/x'
    })
    const file = await setUserProjectInheritAgentControl(WT, true)
    const rec = file.projects.find((p) => p.path === WT)!
    expect(rec.inheritAgentControl).toBe(true)
    expect(rec.gitBranch).toBe('feat/x') // untouched
    expect(rec.agentAllowed).toBe(false)
  })

  it('is idempotent — setting the same value does not throw and holds', async () => {
    await setUserProjectInheritAgentControl(WT, true)
    const file = await setUserProjectInheritAgentControl(WT, true)
    expect(file.projects.find((p) => p.path === WT)!.inheritAgentControl).toBe(true)
  })
})
