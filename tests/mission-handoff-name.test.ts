/**
 * Missions v4 · stp-21 (T751) · AC-6 — the leader a hand-off starts has a plain name.
 *
 * The door answers with the name the new leader goes by: the mission's title (the same words the pane's
 * Sessions row shows), never the instruction line that is the new session's first prompt. A refusal names
 * nothing.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  HANDOFF_INSTRUCTION,
  handOff,
  runHandOff,
  type HandoffDeps,
  type HandoffStart
} from '../src/main/missions/handoff'
import { buildMissionRecordContent, type MissionV4 } from '../src/main/missions/model'

const LEADER = '3f1c9a52-7d4e-4b8a-9c21-5e6a0b7d8f10'
const NEW_ONE = '9d2e7a10-5c3b-4f68-8a14-2b9e6c0d7f31'
const ID = 'mnt-d0000021'
const TITLE = 'Score report for every candidate'
const AT = '2026-11-15T12:00:00.000Z'

const record = (over: Partial<MissionV4> = {}): MissionV4 => ({
  schemaVersion: 4,
  id: ID,
  title: TITLE,
  doneWhen: 'Every candidate sees a score report',
  status: 'open',
  milestones: [],
  steps: [
    {
      id: 'stp-1',
      title: 'Load the test files',
      acs: [{ id: 'ac-1', text: 'The pull request is merged', by: 'fact', fact: 'pr-merged' }],
      links: [],
      blockers: []
    }
  ],
  sessions: [{ id: LEADER, role: 'leads', from: '2026-11-15T10:00:00Z', to: null }],
  links: [],
  blockers: [],
  ...over
})

let root = ''
beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'harnu-handoff-name-'))
  const dir = path.join(root, '.harnu', 'missions-v4')
  mkdirSync(dir, { recursive: true })
  writeFileSync(path.join(dir, `${ID}-score-report.md`), buildMissionRecordContent(record(), '# Log\n'))
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

const start =
  (answer: Awaited<ReturnType<HandoffStart>>): HandoffStart =>
  async () =>
    answer

describe('the hand-off result names the new leader after the mission', () => {
  it('answers with the mission’s title as the leader’s name, not the first prompt', async () => {
    const deps: HandoffDeps = { start: start({ ok: true, sessionId: NEW_ONE }) }
    const r = await handOff(root, ID, { kind: 'operator' }, deps, { at: AT })
    expect(r).toMatchObject({ ok: true, sessionId: NEW_ONE, leaderName: TITLE })
    if (r.ok) {
      expect(r.leaderName).not.toContain(HANDOFF_INSTRUCTION.slice(0, 20))
    }
  })

  it('the channel’s reply carries it to the renderer', async () => {
    const reply = await runHandOff(
      { folder: root, missionId: ID },
      { start: start({ ok: true, sessionId: NEW_ONE }) }
    )
    expect(reply).toMatchObject({ ok: true, sessionId: NEW_ONE, leaderName: TITLE })
  })

  it('a refused hand-off names no leader', async () => {
    const r = await handOff(
      root,
      ID,
      { kind: 'operator' },
      { start: start({ ok: false, reason: 'timeout' }) },
      { at: AT }
    )
    expect(r.ok).toBe(false)
    expect(r).not.toHaveProperty('leaderName')
  })
})
