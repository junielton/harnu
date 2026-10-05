/**
 * Mission v3 §3.5 — the end dialog's warnings speak the operator's language.
 * The server's `closeWarnings[].detail` is English prose with step ids ("stp-3")
 * the operator never sees; the renderer decides WHICH warnings apply from the
 * server's `kind`s but renders them from the view's structured data — step
 * TITLES, never ids — with real i18n plurals in both locales.
 */
import { describe, it, expect } from 'vitest'
import { createI18n } from 'vue-i18n'
import en from '../src/renderer/src/i18n/en.json'
import ptBR from '../src/renderer/src/i18n/pt-BR.json'
import type { MissionView } from '../src/main/mission-ipc'
import type { MissionStep } from '../src/main/mission-core'
import { endWarnings } from '../src/renderer/src/lib/mission-view'
import { fixtureView } from './helpers/mission-v3-view'

const TITLES: Record<string, string> = {
  'stp-1': 'Scope confirmed',
  'stp-3': 'Wire the checkout',
  'stp-4': 'Design review',
  'stp-9': 'Ship the docs',
  'stp-10': 'Delivered and verified'
}

/** faq-like with real step titles, an unticked check, and a blocker on the end step. */
function titledView(): MissionView {
  const base = fixtureView('faq-like')
  const steps: MissionStep[] = base.mission.steps.map((s) => ({
    ...s,
    title: TITLES[s.id] ?? s.title,
    checks:
      s.id === 'stp-4'
        ? [
            {
              id: 'chk-1',
              label: 'DSQA done',
              source: 'agent' as const,
              createdAt: '2026-10-01T10:00:00.000Z'
            }
          ]
        : s.checks,
    blockers:
      s.id === 'stp-9'
        ? [
            {
              reason: 'waiting on the copy',
              unblocks: 'copy lands',
              owner: 'operator' as const,
              raisedAt: '2026-10-01T10:00:00.000Z'
            }
          ]
        : s.blockers
  }))
  return fixtureView('faq-like', { mission: { steps } })
}

describe('endWarnings', () => {
  it('never leaks a step id: every line carries a step title', () => {
    const warnings = endWarnings(titledView())
    expect(warnings.map((w) => w.kind)).toEqual([
      'end-unverified',
      'left-behind',
      'checks-open',
      'blockers-open'
    ])
    const dump = JSON.stringify(warnings)
    expect(dump).not.toMatch(/stp-\d+/)
    expect(dump).not.toContain('(s)')
  })

  it('names the end step by its title', () => {
    const [end] = endWarnings(titledView())
    expect(end.items).toEqual([{ step: 'Delivered and verified' }])
  })

  it('left-behind lists step titles and counts them', () => {
    const w = endWarnings(titledView()).find((x) => x.kind === 'left-behind')!
    expect(w.count).toBe(1)
    expect(w.items).toEqual([{ step: 'Wire the checkout' }])
  })

  it('checks-open lists "step — check label"', () => {
    const w = endWarnings(titledView()).find((x) => x.kind === 'checks-open')!
    expect(w.count).toBe(1)
    expect(w.items).toEqual([{ step: 'Design review', label: 'DSQA done' }])
  })

  it('blockers-open lists the blocker reasons under their step', () => {
    const w = endWarnings(titledView()).find((x) => x.kind === 'blockers-open')!
    expect(w.count).toBe(1)
    expect(w.items).toEqual([{ step: 'Ship the docs', label: 'waiting on the copy' }])
  })

  it('shows only the kinds the server warned about', () => {
    const v = titledView()
    v.closeWarnings = v.closeWarnings.filter((w) => w.kind === 'left-behind')
    expect(endWarnings(v).map((w) => w.kind)).toEqual(['left-behind'])
  })

  it('falls back to the raw id only when the step is not in the view', () => {
    const v = titledView()
    v.progress = { ...v.progress, leftBehind: ['stp-404'] }
    const w = endWarnings(v).find((x) => x.kind === 'left-behind')!
    expect(w.items).toEqual([{ step: 'stp-404' }])
  })
})

describe('end-warning plurals (vue-i18n, both locales)', () => {
  const make = (locale: 'en' | 'pt-BR') =>
    createI18n({ legacy: false, locale, messages: { en, 'pt-BR': ptBR } as never }).global

  it.each(['leftBehind', 'checksOpen', 'blockersOpen'] as const)(
    '%s has a singular and a plural form in en and pt-BR, and no "(s)"',
    (key) => {
      for (const locale of ['en', 'pt-BR'] as const) {
        const t = make(locale).t
        const one = t(`mission.end.warnings.${key}`, 1)
        const many = t(`mission.end.warnings.${key}`, 3)
        expect(one).toContain('1')
        expect(many).toContain('3')
        expect(one).not.toBe(many.replace('3', '1'))
        expect(one + many).not.toContain('(s)')
      }
    }
  )
})
