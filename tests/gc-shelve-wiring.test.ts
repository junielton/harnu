// Source-level wiring checks for shelving (U2.2 AC-5), in the style of tests/gc-wiring.test.ts:
// the pieces that need electron are not run here, but the seams between them must be there.

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import * as path from 'node:path'
import { defaultGcPrefs } from '../src/main/gc/gc-prefs'
import type { CycleRecord, GcSnapshot } from '../src/main/gc/gc-wire'

const read = (rel: string): string =>
  readFileSync(path.join(__dirname, '..', 'src', ...rel.split('/')), 'utf8')

describe('wire types are plain data', () => {
  it('a snapshot with a shelved worktree and a cycle with a shelve record survive JSON', () => {
    const snap = {
      scannedAt: 1,
      bundles: [],
      orphanVolumes: [],
      orphanTranscripts: [],
      stackLeftovers: [],
      prefs: defaultGcPrefs(),
      lastCycle: null,
      nextCycleAt: null,
      nextClean: null,
      backgroundScan: true,
      shelved: [
        {
          id: 'a',
          repoPath: '/r',
          worktreePath: '/r/w',
          branch: 'feat/x',
          headSha: 'a'.repeat(40),
          namespace: 'refs/archive/feat/x/1',
          shelvedAt: 1,
          idleDays: 9,
          reason: 'Shelved `feat/x` — idle 9 d, branch kept',
          freedBytes: null
        }
      ]
    } as unknown as GcSnapshot
    expect(JSON.parse(JSON.stringify(snap))).toEqual(snap)
    const cycle = {
      shelve: {
        mode: 'shelve',
        found: 1,
        foundBytes: 1,
        shelved: [],
        refused: 0,
        failed: 0,
        deferred: 0,
        paused: false,
        locked: 0,
        journalFailed: 0
      }
    } as unknown as CycleRecord
    expect(JSON.parse(JSON.stringify(cycle))).toEqual(cycle)
  })
})

describe('the gather reads the store and protects shelved transcripts', () => {
  const scan = read('main/gc/gc-scan-shell.ts')
  it('reads gc-shelved.json, exposes it on the gather, and hands its folders to the orphan source', () => {
    expect(scan).toMatch(/readShelvedForUpdate\(/)
    expect(scan).toMatch(/SHELVED_FILE/)
    expect(scan).toMatch(/shelvedFolders/)
    expect(scan).toMatch(/shelved,?\n/)
  })
  it('hands the transcript scan’s drifted folders to the cycle', () => {
    expect(scan).toMatch(/driftedCwds/)
    expect(scan).toMatch(/transcripts\.drifted/)
  })
})

describe('the service wires the cycle behind its own switch', () => {
  const ipc = read('main/gc/gc-ipc.ts')
  it('registers the Restore channel on the shared restore service and pushes a change event', () => {
    expect(ipc).toMatch(/ipcMain\.handle\('gc:shelve:restore'/)
    expect(ipc).toMatch(/restoreShelvedById\(/)
    expect(ipc).toMatch(/onShelvedChanged\(/)
    expect(ipc).toMatch(/send\('gc:shelved:changed'/)
  })

  it('builds the snapshot with the shelved list', () => {
    expect(ipc).toMatch(/shelved:\s*g\.shelved/)
  })
  it('gives the cycle a shelve hook built from the real shells, the repo lock and the journal', () => {
    expect(ipc).toMatch(/shelve:\s*\(bundles\)\s*=>\s*runShelveCycle/)
    expect(ipc).toMatch(/withRepoLock/)
    expect(ipc).toMatch(/shelveWorktree\(/)
    expect(ipc).toMatch(/appendTombstone/)
    expect(ipc).toMatch(/withShelveDisabled/)
  })
  it('has its own acknowledgement channel, separate from the autopilot’s', () => {
    expect(ipc).toMatch(/'gc:shelve:ack'/)
    expect(ipc).toMatch(/withShelveAcknowledged/)
    expect(read('preload/index.ts')).toMatch(/gcAckShelveReport/)
  })
  it('does not reach any door that treats a folder as removed', () => {
    for (const file of [
      'main/gc/shelve-cycle.ts',
      'main/gc/shelve-exec-shell.ts',
      'main/gc/shelve-store.ts'
    ]) {
      const src = read(file)
      expect(src).not.toMatch(/detachFromSidebar|recordRemovedFolder|removeGhostFoldersUnder/)
    }
  })
})

describe('the tool catalog describes the new fields', () => {
  it('list_cleanup says it lists shelved worktrees and the shelving switch', () => {
    const catalog = read('main/mcp/tool-catalog.ts')
    const at = catalog.indexOf("name: 'list_cleanup'")
    const window = catalog.slice(at, at + 2500)
    expect(window).toMatch(/shelved/i)
  })
})
