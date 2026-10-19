import { describe, expect, it } from 'vitest'
import { formatHealNotice, HEAL_NOTICE_GROUP } from '../src/renderer/src/lib/statusline-heal-notice'

// A translator that echoes the key and its params keeps this test independent of the wording,
// which lives in the locale files (parity is pinned by the i18n schema).
const t = (key: string, params?: Record<string, unknown>): string =>
  params ? `${key}:${JSON.stringify(params)}` : key

describe('formatHealNotice (AC-4)', () => {
  it('names the stale sessions and the heal time', () => {
    const out = formatHealNotice({ time: '11:02', titles: ['Alpha', 'Beta'] }, t)
    expect(out.title).toBe('statuslineHeal.title')
    expect(out.description).toBe(
      'statuslineHeal.description:' + JSON.stringify({ time: '11:02', sessions: 'Alpha, Beta' })
    )
  })

  it('caps the list and counts the rest', () => {
    const titles = ['a', 'b', 'c', 'd', 'e', 'f', 'g']
    const out = formatHealNotice({ time: '11:02', titles }, t)
    expect(out.description).toContain('"sessions":"a, b, c, d, e statuslineHeal.more:{\\"n\\":2}"')
  })

  it('says so when no session was running', () => {
    const out = formatHealNotice({ time: '11:02', titles: [] }, t)
    expect(out.description).toBe('statuslineHeal.descriptionNone')
  })

  it('upserts into one Activity entry', () => {
    expect(HEAL_NOTICE_GROUP).toBe('statusline-heal')
  })
})
