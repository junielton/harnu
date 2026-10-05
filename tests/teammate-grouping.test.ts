import { describe, it, expect } from 'vitest'
import {
  buildSessionRows,
  shouldConfirmTeammateSelect
} from '../src/renderer/src/components/teammate-grouping'

/**
 * Pure grouping logic (T99 — design.md "Teammate group (sidebar)"): pulls
 * teammate sessions out of an already-sorted flat list and nests them under
 * their team lead's row. A group with no lead anywhere in the folder is
 * orphaned and hidden (T168), except a teammate that is currently selected.
 */
type S = { sessionId: string; teamName?: string }

const s = (sessionId: string, teamName?: string): S => ({ sessionId, teamName })

describe('buildSessionRows', () => {
  it('leaves a folder with no teammates completely untouched', () => {
    const input = [s('aaaa'), s('bbbb'), s('cccc')]
    const { rows, teammatesByLeader } = buildSessionRows(input)
    expect(rows).toEqual([{ session: input[0] }, { session: input[1] }, { session: input[2] }])
    expect(teammatesByLeader.size).toBe(0)
  })

  it('nests teammates under their lead when the lead is present in the folder', () => {
    const lead = s('7399191c-0ea7-4d4e-90ab-bf36a3f5c610')
    const teammate1 = s('03777eec-00f1-46a5-a7d0-2df48cb65492', 'session-7399191c')
    const teammate2 = s('aabbccdd-0000-0000-0000-000000000000', 'session-7399191c')
    const other = s('ffffffff-0000-0000-0000-000000000000')

    const { rows, teammatesByLeader } = buildSessionRows([teammate1, lead, teammate2, other])

    // Teammates are removed from the flat run — only the lead + the unrelated
    // session remain as flat rows.
    expect(rows).toEqual([{ session: lead }, { session: other }])
    expect(teammatesByLeader.get(lead.sessionId)).toEqual([teammate1, teammate2])
  })

  it('hides an orphaned group entirely when the lead is absent from the folder', () => {
    const teammate1 = s('03777eec-00f1-46a5-a7d0-2df48cb65492', 'session-7399191c')
    const teammate2 = s('aabbccdd-0000-0000-0000-000000000000', 'session-7399191c')
    const other = s('ffffffff-0000-0000-0000-000000000000')

    const { rows, teammatesByLeader } = buildSessionRows([other, teammate1, teammate2])

    // No lead anywhere in the folder — both teammates drop out, no stand-in
    // header row is emitted, and the unrelated session is untouched.
    expect(rows).toEqual([{ session: other }])
    expect(teammatesByLeader.size).toBe(0)
  })

  it('keeps a selected teammate visible even when its group has no lead in this folder', () => {
    // `sessionsForDisplay` already guarantees a selected session survives the
    // age filter — this asserts the grouping never drops it afterwards, while
    // its non-selected teammate in the same orphaned group stays hidden.
    const selectedTeammate = s('03777eec-00f1-46a5-a7d0-2df48cb65492', 'session-7399191c')
    const otherTeammate = s('aabbccdd-0000-0000-0000-000000000000', 'session-7399191c')

    const { rows } = buildSessionRows(
      [selectedTeammate, otherTeammate],
      [selectedTeammate, otherTeammate],
      selectedTeammate.sessionId
    )

    expect(rows).toEqual([{ session: selectedTeammate }])
  })

  it('keeps two independent teams in the same folder separate', () => {
    const leadA = s('aaaaaaaa-0000-0000-0000-000000000000')
    const teammateA = s('11110000-0000-0000-0000-000000000000', 'session-aaaaaaaa')
    const teammateB = s('bbbbbbbb-1111-0000-0000-000000000000', 'session-bbbbbbbb')

    const { rows, teammatesByLeader } = buildSessionRows([leadA, teammateA, teammateB])

    // Team A has its lead in the folder and nests normally; team B is
    // orphaned (no lead anywhere) and its teammate is hidden, not shown as a
    // stand-in row.
    expect(rows).toEqual([{ session: leadA }])
    expect(teammatesByLeader.get(leadA.sessionId)).toEqual([teammateA])
    expect(teammatesByLeader.size).toBe(1)
  })

  it('injects the lead row when it is absent from `sorted` but present in `leaderCandidates`', () => {
    // The lead aged out of the sidebar's session window (idle since dispatch)
    // and is missing from `sorted`, but still exists in the folder's full
    // session list — the widened lookup should find it and give the group a
    // real lead row to nest under, instead of falling back to hiding it.
    const lead = s('7399191c-0ea7-4d4e-90ab-bf36a3f5c610')
    const teammate1 = s('03777eec-00f1-46a5-a7d0-2df48cb65492', 'session-7399191c')
    const teammate2 = s('aabbccdd-0000-0000-0000-000000000000', 'session-7399191c')
    const other = s('ffffffff-0000-0000-0000-000000000000')

    const sorted = [other, teammate1, teammate2] // lead NOT in the display window
    const leaderCandidates = [other, lead, teammate1, teammate2] // lead present in the folder

    const { rows, teammatesByLeader } = buildSessionRows(sorted, leaderCandidates)

    expect(rows).toEqual([{ session: other }, { session: lead }])
    expect(teammatesByLeader.get(lead.sessionId)).toEqual([teammate1, teammate2])
  })

  it('still hides the group when the lead is absent even from leaderCandidates', () => {
    const teammate1 = s('03777eec-00f1-46a5-a7d0-2df48cb65492', 'session-7399191c')
    const other = s('ffffffff-0000-0000-0000-000000000000')

    const sorted = [other, teammate1]
    const leaderCandidates = [other, teammate1] // no lead anywhere in the folder

    const { rows, teammatesByLeader } = buildSessionRows(sorted, leaderCandidates)

    expect(rows).toEqual([{ session: other }])
    expect(teammatesByLeader.size).toBe(0)
  })
})

describe('shouldConfirmTeammateSelect', () => {
  it('asks for confirmation when the teammate is currently working', () => {
    expect(shouldConfirmTeammateSelect('working')).toBe(true)
  })

  it('opens straight through when the teammate is idle', () => {
    expect(shouldConfirmTeammateSelect('idle')).toBe(false)
  })

  it('opens straight through when the teammate is stuck', () => {
    expect(shouldConfirmTeammateSelect('stuck')).toBe(false)
  })
})
