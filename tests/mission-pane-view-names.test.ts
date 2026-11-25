// @vitest-environment node
/**
 * `sessionNameOf` (the kept view library, read by the Mission dropdown's Ask box, Next card and attach picker):
 * a session a hand-off started is named after the mission, plainly, not after the instruction line it received.
 * (This was the Mission pane's AC-6; the pane is gone, the naming rule stays with the library.)
 */
import { describe, expect, it } from 'vitest'
import { i18n } from '../src/renderer/src/i18n'
import { sessionNameOf } from '../src/renderer/src/lib/mission-pane-view'
import { HANDOFF_INSTRUCTION } from '../src/main/missions/handoff'

const t = i18n.global.t as unknown as (key: string, args?: Record<string, unknown>) => string
const MISSION_TITLE = 'Measure the spec skill, then fix what the numbers show'
const PREFIX = 'You are taking over this mission'

describe('a session a hand-off started is named after the mission', () => {
  it('the name prefix is the start of the instruction line the hand-off sends (the two are pinned together)', () => {
    expect(HANDOFF_INSTRUCTION.startsWith(PREFIX)).toBe(true)
  })

  it('names it with the mission’s title, plainly, not the instruction it received', () => {
    const instruction = `${PREFIX} from another session. Harnu attaches you as its leader.`
    const name = sessionNameOf(
      'new-leader',
      [{ sessionId: 'new-leader', firstPrompt: instruction }],
      t,
      MISSION_TITLE
    )
    expect(name).toBe(MISSION_TITLE)
    expect(name).not.toContain(PREFIX)
  })

  it('a session with a name of its own keeps it; one that is not loaded is "Session" and its id', () => {
    const instruction = `${PREFIX} from another session.`
    const own = [{ sessionId: 's1', summary: 'Fix the importer', firstPrompt: instruction }]
    expect(sessionNameOf('s1', own, t, MISSION_TITLE)).toBe('Fix the importer')
    expect(sessionNameOf('abcdef0123456789', [], t)).toBe('Session abcdef01')
  })
})
