import { describe, it, expect } from 'vitest'
import { createI18n } from 'vue-i18n'
import en from '../src/renderer/src/i18n/en.json'
import ptBR from '../src/renderer/src/i18n/pt-BR.json'
import {
  declinedChipText,
  declinedTooltip,
  isNoteworthyLiveReason,
  parkedExplanation
} from '../src/renderer/src/components/system-monitor-format'
import type { DeclinedView, ParkNegotiation } from '../src/main/monitor/types'

/**
 * T456 W3 (spec §6.5) — the pure formatters behind the System Monitor's "Asked to stay" chip, its
 * tooltip and the parked row's explanation line. They run against the REAL en.json / pt-BR.json so a
 * missing or misspelled key fails here, not on screen.
 */

function translator(locale: 'en' | 'pt-BR') {
  const i18n = createI18n({
    legacy: false,
    locale,
    fallbackLocale: undefined,
    missingWarn: false,
    messages: { en, 'pt-BR': ptBR } as never
  })
  return (key: string, params?: Record<string, unknown>): string =>
    i18n.global.t(key, params ?? {}) as string
}
const t = translator('en')

function declined(over: Partial<DeclinedView> = {}): DeclinedView {
  return {
    declines: 3,
    max: 8,
    reasons: ['background-task'],
    counts: { 'background-task': 2 },
    retryInMs: 9 * 60_000 + 20_000,
    ...over
  }
}

function neg(over: Partial<ParkNegotiation> = {}): ParkNegotiation {
  return { declines: 0, reasons: [], why: 'free', ...over }
}

describe('declinedChipText', () => {
  it('reads "Asked to stay · 2 background tasks"', () => {
    expect(declinedChipText(declined(), t)).toBe('Asked to stay · 2 background tasks')
  })

  it('uses the singular form for one', () => {
    expect(declinedChipText(declined({ counts: { 'background-task': 1 } }), t)).toBe(
      'Asked to stay · 1 background task'
    )
  })

  it('shows at most two reasons and counts the rest', () => {
    const d = declined({
      reasons: ['background-task', 'scheduled-wakeup', 'permission', 'turn'],
      counts: { 'background-task': 2, 'scheduled-wakeup': 1, permission: 1 }
    })
    expect(declinedChipText(d, t)).toBe('Asked to stay · 2 background tasks, 1 scheduled wakeup +2')
  })

  it('names a reason that carries no count without a number', () => {
    expect(declinedChipText(declined({ reasons: ['turn'], counts: {} }), t)).toBe(
      'Asked to stay · turn in progress'
    )
  })

  it('falls back to the bare kind for a reason it does not know', () => {
    expect(declinedChipText(declined({ reasons: ['future-kind'], counts: {} }), t)).toBe(
      'Asked to stay · future-kind'
    )
  })

  it('names a counted reason with no known count in the singular, never "0"', () => {
    expect(declinedChipText(declined({ counts: {} }), t)).toBe('Asked to stay · background task')
  })
})

describe('declinedTooltip', () => {
  it('lists every reason, the count "3 of 8" and when it asks again', () => {
    const d = declined({
      reasons: ['background-task', 'scheduled-wakeup', 'permission'],
      counts: { 'background-task': 2, 'scheduled-wakeup': 1, permission: 1 }
    })
    const lines = declinedTooltip(d, t).split('\n')
    expect(lines).toContain('• 2 background tasks')
    expect(lines).toContain('• 1 scheduled wakeup')
    expect(lines).toContain('• 1 permission request')
    expect(lines).toContain('Asked 3 of 8 times')
    expect(lines).toContain('Asks again in 9 min')
  })

  it('says "<1 min" instead of "0 min" when the retry is imminent', () => {
    expect(declinedTooltip(declined({ retryInMs: 20_000 }), t)).toContain('Asks again in <1 min')
  })

  it('never prints a negative wait', () => {
    expect(declinedTooltip(declined({ retryInMs: -5_000 }), t)).toContain('Asks again in <1 min')
  })
})

describe('parkedExplanation — one clause per ledger `why`', () => {
  it('limit: "Parked after 8 declines (background task)"', () => {
    expect(
      parkedExplanation(neg({ why: 'limit', declines: 8, reasons: ['background-task'] }), t)
    ).toBe('Parked after 8 declines (background task)')
  })

  it('limit with a single decline uses the singular', () => {
    expect(
      parkedExplanation(neg({ why: 'limit', declines: 1, reasons: ['scheduled-wakeup'] }), t)
    ).toBe('Parked after 1 decline (scheduled wakeup)')
  })

  it('memory-pressure after a decline: "the session said busy"', () => {
    expect(
      parkedExplanation(
        neg({ why: 'memory-pressure', declines: 2, reasons: ['background-task'] }),
        t
      )
    ).toBe('Parked under memory pressure; the session said busy')
  })

  it('memory-pressure with no prior decline stays short', () => {
    expect(parkedExplanation(neg({ why: 'memory-pressure' }), t)).toBe(
      'Parked under memory pressure'
    )
  })

  it('operator on a session that was declining names the override', () => {
    expect(
      parkedExplanation(
        neg({ why: 'operator', declines: 3, reasons: ['background-task'], override: true }),
        t
      )
    ).toBe('Parked by you; it had asked to stay (background task)')
  })

  it('operator on a quiet session is just "Parked by you"', () => {
    expect(parkedExplanation(neg({ why: 'operator' }), t)).toBe('Parked by you')
  })

  it('free: the session said nothing was running', () => {
    expect(parkedExplanation(neg({ why: 'free' }), t)).toBe('Parked; the session said it was free')
  })

  it('free after declines says how many', () => {
    expect(
      parkedExplanation(neg({ why: 'free', declines: 2, reasons: ['background-task'] }), t)
    ).toBe('Parked once the session was free, after 2 declines (background task)')
  })

  it('silent: no background work reported', () => {
    expect(parkedExplanation(neg({ why: 'silent' }), t)).toBe(
      'Parked; no background work was reported'
    )
  })

  it('silent after declines still says what it declined for', () => {
    expect(
      parkedExplanation(neg({ why: 'silent', declines: 4, reasons: ['scheduled-wakeup'] }), t)
    ).toBe('Parked after 4 declines (scheduled wakeup); it then reported nothing busy')
  })

  it('lists several reasons in plain words', () => {
    expect(
      parkedExplanation(
        neg({ why: 'limit', declines: 8, reasons: ['background-task', 'scheduled-wakeup'] }),
        t
      )
    ).toBe('Parked after 8 declines (background task, scheduled wakeup)')
  })
})

describe('isNoteworthyLiveReason', () => {
  it('shows a chip for `declined` as well as the sweep candidates', () => {
    expect(isNoteworthyLiveReason('declined')).toBe(true)
    expect(isNoteworthyLiveReason('lru')).toBe(true)
    expect(isNoteworthyLiveReason('hard-idle')).toBe(true)
    expect(isNoteworthyLiveReason('active')).toBe(false)
    expect(isNoteworthyLiveReason('mission-owner')).toBe(false)
  })
})

describe('pt-BR', () => {
  const tp = translator('pt-BR')
  it('translates the chip, the tooltip and the explanation (no key falls through)', () => {
    const chip = declinedChipText(declined(), tp)
    expect(chip).not.toContain('systemMonitor.')
    expect(chip).not.toBe(declinedChipText(declined(), t))
    expect(declinedTooltip(declined(), tp)).not.toContain('systemMonitor.')
    for (const why of ['free', 'silent', 'limit', 'memory-pressure', 'operator'] as const) {
      for (const declines of [0, 1, 3]) {
        const line = parkedExplanation(
          neg({ why, declines, reasons: declines ? ['background-task'] : [], override: undefined }),
          tp
        )
        expect(line, `${why}/${declines}`).not.toContain('systemMonitor.')
        expect(line.length).toBeGreaterThan(5)
      }
    }
  })
})
