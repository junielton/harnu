/**
 * T154 — which family each event plays, and what silences it (pure parts).
 *
 * - session kinds → family (`needs-input` asks, `completed` is done, `failed` is a fail);
 * - the Sound switch is the master for every family, and each family has its own mute;
 * - one combined mission cue plays the most urgent family (fail > ask > info), and each owed kind maps
 *   to the family the card's table names.
 */
import { describe, it, expect } from 'vitest'
import {
  DEFAULT_NOTIFY_PREFS,
  NOTIFY_KIND_FAMILY,
  decideNotification,
  parseNotifyPrefs,
  soundAllowed,
  type NotifyPrefs
} from '../src/renderer/src/stores/session-notify'
import { decideCue, owedKeys, type CueMemory } from '../src/renderer/src/lib/mission-cue'
import { cueFamilyOfKey, mostUrgentFamily } from '../src/renderer/src/lib/mission-cue'
import { SOUND_FAMILIES } from '../src/renderer/src/lib/notification-sound'

const prefs = (over: Partial<NotifyPrefs> = {}): NotifyPrefs => ({
  ...DEFAULT_NOTIFY_PREFS,
  ...over
})

describe('session kinds → family', () => {
  it('needs-input asks, completed is done, failed is a fail', () => {
    expect(NOTIFY_KIND_FAMILY).toEqual({ 'needs-input': 'ask', completed: 'done', failed: 'fail' })
  })

  it('the decision follows the family mute and the Sound master', () => {
    const ctx = (p: NotifyPrefs) => ({ prefs: p, isSelected: false, windowFocused: false })
    expect(decideNotification('working', 'idle', ctx(prefs()))?.sound).toBe(true)
    expect(decideNotification('working', 'idle', ctx(prefs({ soundDone: false })))?.sound).toBe(
      false
    )
    // Muting "done" leaves the other families alone.
    expect(decideNotification('working', 'failed', ctx(prefs({ soundDone: false })))?.sound).toBe(
      true
    )
    expect(decideNotification('working', 'failed', ctx(prefs({ sound: false })))?.sound).toBe(false)
  })
})

describe('soundAllowed — the master and the per-family mute', () => {
  it('defaults every family on', () => {
    for (const f of SOUND_FAMILIES) expect(soundAllowed(DEFAULT_NOTIFY_PREFS, f)).toBe(true)
  })

  it('the Sound switch off silences every family', () => {
    for (const f of SOUND_FAMILIES) expect(soundAllowed(prefs({ sound: false }), f)).toBe(false)
  })

  it('a family mute silences only that family', () => {
    const muted = {
      ask: 'soundAsk',
      done: 'soundDone',
      fail: 'soundFail',
      info: 'soundInfo'
    } as const
    for (const mute of SOUND_FAMILIES) {
      const p = prefs({ [muted[mute]]: false })
      for (const f of SOUND_FAMILIES) expect(soundAllowed(p, f)).toBe(f !== mute)
    }
  })

  it('parses the four mutes, defaulting each on, coercing to booleans', () => {
    expect(parseNotifyPrefs(null)).toMatchObject({
      soundAsk: true,
      soundDone: true,
      soundFail: true,
      soundInfo: true
    })
    expect(parseNotifyPrefs(JSON.stringify({ soundFail: 0, soundAsk: 1 }))).toMatchObject({
      soundAsk: true,
      soundDone: true,
      soundFail: false,
      soundInfo: true
    })
    // A blob stored before T154 has no mutes: everything stays on.
    expect(parseNotifyPrefs(JSON.stringify({ sound: true, enabled: true }))).toMatchObject({
      soundAsk: true,
      soundDone: true,
      soundFail: true,
      soundInfo: true
    })
  })
})

describe('mission cue → family', () => {
  const empty = (): CueMemory => ({ owed: new Map() })
  const NOW = 1_790_000_000_000

  /** A v4 reader-shaped view: only the fields the cue reads. */
  const v4 = (id: string, you: unknown[]) =>
    ({ mission: { id }, you }) as unknown as Parameters<typeof decideCue>[0][number]

  const item = {
    unblock: {
      kind: 'unblock',
      id: 'blk-1',
      stepId: 'stp-1',
      ask: 'merge it',
      prs: [],
      stepIds: []
    },
    attach: { kind: 'attach', id: 'attach:s1', prs: [], stepIds: [], ask: 'x' },
    close: { kind: 'close', id: 'close', prs: [], stepIds: [], ask: 'x' },
    settle: { kind: 'settle', id: 'settle:stp-1:ac-1', prs: [], stepIds: [], ask: 'x' },
    rescope: { kind: 'rescope', id: 'rescope:x', prs: [], stepIds: [], ask: 'x' },
    review: { kind: 'review', id: 'review', prs: [1, 2], stepIds: [], ask: 'x' },
    mainFailing: { kind: 'main-failing', id: 'main-failing:abc', prs: [], stepIds: [], ask: 'x' }
  }
  const v3 = {
    blocker: { kind: 'blocker', reason: 'merge PR #6', unblocks: 'merged' },
    decide: { kind: 'decide', stepId: 'stp-2', title: 'Which store?' },
    humanSteps: { kind: 'human-steps', stepIds: ['stp-1'] },
    rescope: { kind: 'rescope', end: { kind: 'code', target: 'a memo', evidence: 'e' } },
    checks: { kind: 'checks', count: 1, stepIds: ['stp-1'] },
    reviewImport: { kind: 'review-import' }
  }

  const familyOf = (you: unknown[]) => decideCue([v4('mnt-1', you)], empty(), NOW).family

  it('blocking kinds ask', () => {
    for (const you of [
      item.unblock,
      item.attach,
      item.close,
      item.settle,
      item.rescope,
      v3.blocker,
      v3.decide,
      v3.humanSteps,
      v3.rescope
    ]) {
      expect(familyOf([you])).toBe('ask')
    }
  })

  it('a red main is a fail', () => {
    expect(familyOf([item.mainFailing])).toBe('fail')
  })

  it('review, due checks and an imported end are info', () => {
    for (const you of [item.review, v3.checks, v3.reviewImport])
      expect(familyOf([you])).toBe('info')
  })

  it('a poll with no cue has no family', () => {
    const first = decideCue([v4('mnt-1', [item.review])], empty(), NOW)
    const again = decideCue([v4('mnt-1', [item.review])], first.memory, NOW + 20_000)
    expect(again.cue).toBe(false)
    expect(again.family).toBeNull()
  })

  it('one combined cue plays the most urgent family: fail > ask > info', () => {
    expect(familyOf([item.review, item.unblock])).toBe('ask')
    expect(familyOf([item.review, item.mainFailing])).toBe('fail')
    expect(familyOf([item.unblock, item.mainFailing, item.review])).toBe('fail')
    // Across missions in the same poll too.
    const across = decideCue(
      [v4('mnt-1', [item.review]), v4('mnt-2', [item.unblock])],
      empty(),
      NOW
    )
    expect(across.family).toBe('ask')
  })

  it('only keys that cue count: a quiet red main does not upgrade a new review cue', () => {
    const first = decideCue([v4('mnt-1', [item.mainFailing])], empty(), NOW)
    expect(first.family).toBe('fail')
    const next = decideCue(
      [v4('mnt-1', [item.mainFailing, item.review])],
      first.memory,
      NOW + 20_000
    )
    expect(next.cue).toBe(true)
    expect(next.family).toBe('info')
  })

  it('maps keys and ranks families', () => {
    expect(cueFamilyOfKey('main-failing:abc')).toBe('fail')
    expect(cueFamilyOfKey('unblock:mission:merge')).toBe('ask')
    expect(cueFamilyOfKey('review')).toBe('info')
    expect(cueFamilyOfKey('checks')).toBe('info')
    expect(mostUrgentFamily(['info', 'ask'])).toBe('ask')
    expect(mostUrgentFamily(['info', 'fail', 'ask'])).toBe('fail')
    expect(mostUrgentFamily([])).toBeNull()
  })

  it('still keys every kind the same way', () => {
    expect([...owedKeys(v4('mnt-1', [item.review, item.unblock]))].map(([k]) => k)).toEqual([
      'review',
      'unblock:stp-1:merge it'
    ])
  })
})
