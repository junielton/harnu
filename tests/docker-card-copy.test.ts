// U3.7 AC-2/AC-5: a report-only item reads as a sentence about the FUTURE ("Would remove …"), in the
// app's language, instead of the journal's past-tense sentence; an unknown reason is shown as it is.
import { describe, expect, it } from 'vitest'
import { createI18n } from 'vue-i18n'
import en from '../src/renderer/src/i18n/en.json'
import ptBR from '../src/renderer/src/i18n/pt-BR.json'
import { groupDetail, groupTitle, wouldSentence } from '../src/renderer/src/lib/docker-card-copy'
import type { ActionGroup } from '../src/renderer/src/lib/docker-card-view'

function tIn(
  locale: 'en' | 'pt-BR'
): (key: string, named?: Record<string, unknown>, plural?: number) => string {
  const i = createI18n({ legacy: false, locale, messages: { en, 'pt-BR': ptBR } })
  return (key, named, plural) =>
    (plural === undefined
      ? i.global.t(key, named ?? {})
      : i.global.t(key, named ?? {}, plural)) as string
}

const network = {
  kind: 'network' as const,
  target: 'ext-12_default',
  reason: 'Removed empty network `ext-12_default` — no containers'
}
const orphan = {
  kind: 'orphan' as const,
  target: 'ext-03',
  reason: 'Removed orphan stack `ext-03` — worktree gone, volumes kept: ext-03_data, ext-03_redis'
}
const pause = { kind: 'pause' as const, target: 'ext-12', reason: 'idle 120 h' }

describe('wouldSentence (English)', () => {
  const t = tIn('en')
  it('rewrites the verb of each kind and keeps the reason', () => {
    expect(wouldSentence(network, t)).toBe(
      'Would remove empty network ext-12_default — no containers'
    )
    expect(wouldSentence(orphan, t)).toBe(
      'Would remove orphan stack ext-03 — worktree gone, volumes kept: ext-03_data, ext-03_redis'
    )
    expect(wouldSentence(pause, t)).toBe('Would pause ext-12 — idle 120 h')
  })

  it('an orphan with no volume names still reads whole', () => {
    expect(
      wouldSentence(
        { ...orphan, reason: 'Removed orphan stack `ext-03` — worktree gone, volumes kept' },
        t
      )
    ).toBe('Would remove orphan stack ext-03 — worktree gone, volumes kept')
  })

  it('a reason it does not know is shown as it is', () => {
    expect(wouldSentence({ kind: 'network', target: 'x', reason: 'reason 0' }, t)).toBe('reason 0')
  })
})

describe('wouldSentence (pt-BR)', () => {
  const t = tIn('pt-BR')
  it('says the same in Portuguese', () => {
    expect(wouldSentence(network, t)).toBe(
      'Removeria a rede vazia ext-12_default — nenhum container'
    )
    expect(wouldSentence(orphan, t)).toBe(
      'Removeria a stack órfã ext-03 — worktree removida, volumes mantidos: ext-03_data, ext-03_redis'
    )
    expect(wouldSentence(pause, t)).toBe('Pausaria ext-12 — ociosa há 120 h')
  })
})

const group = (over: Partial<ActionGroup>): ActionGroup => ({
  id: 'g',
  kind: 'network',
  count: 1,
  volumes: 0,
  names: [],
  at: 1,
  would: false,
  idleMinutes: null,
  items: [],
  ...over
})

describe('groupTitle (English)', () => {
  const t = tIn('en')
  it('counts with plural forms, volumes included', () => {
    expect(groupTitle(group({ kind: 'network', count: 1 }), t)).toBe('1 empty network removed')
    expect(groupTitle(group({ kind: 'network', count: 4 }), t)).toBe('4 empty networks removed')
    expect(groupTitle(group({ kind: 'orphan', count: 6, volumes: 9 }), t)).toBe(
      '6 orphan stacks removed · 9 volumes kept'
    )
    expect(groupTitle(group({ kind: 'orphan', count: 1, volumes: 1 }), t)).toBe(
      '1 orphan stack removed · 1 volume kept'
    )
    expect(groupTitle(group({ kind: 'orphan', count: 2, volumes: 0 }), t)).toBe(
      '2 orphan stacks removed'
    )
    expect(groupTitle(group({ kind: 'pause', count: 2 }), t)).toBe('2 stacks paused')
    expect(groupTitle(group({ kind: 'pause', count: 1 }), t)).toBe('1 stack paused')
  })
  it('would-have rows use the future', () => {
    expect(groupTitle(group({ kind: 'network', count: 1, would: true }), t)).toBe(
      'Would remove 1 empty network'
    )
    expect(groupTitle(group({ kind: 'pause', count: 2, would: true }), t)).toBe(
      'Would pause 2 stacks'
    )
  })
})

describe('groupTitle (pt-BR)', () => {
  const t = tIn('pt-BR')
  it('has the plural forms in Portuguese', () => {
    expect(groupTitle(group({ kind: 'network', count: 1 }), t)).toBe('1 rede vazia removida')
    expect(groupTitle(group({ kind: 'network', count: 4 }), t)).toBe('4 redes vazias removidas')
    expect(groupTitle(group({ kind: 'orphan', count: 6, volumes: 9 }), t)).toBe(
      '6 stacks órfãs removidas · 9 volumes mantidos'
    )
    expect(groupTitle(group({ kind: 'pause', count: 1 }), t)).toBe('1 stack pausada')
    expect(groupTitle(group({ kind: 'pause', count: 2, would: true }), t)).toBe('Pausaria 2 stacks')
  })
})

describe('groupDetail', () => {
  it('says why, per kind, in both languages', () => {
    const en = tIn('en')
    expect(groupDetail(group({ kind: 'network' }), en)).toBe(
      'No containers were attached; compose up recreates them.'
    )
    expect(groupDetail(group({ kind: 'orphan', count: 3 }), en)).toBe(
      'Their worktrees were removed. The volumes stay under Orphan volumes.'
    )
    expect(groupDetail(group({ kind: 'pause', count: 1, idleMinutes: 180 }), en)).toBe(
      'Idle for 3 h.'
    )
    expect(groupDetail(group({ kind: 'pause', count: 2, idleMinutes: 40 }), en)).toBe(
      'Idle for 40 min or more.'
    )
    expect(groupDetail(group({ kind: 'pause', count: 2, idleMinutes: null }), en)).toBeNull()
    expect(groupDetail(group({ kind: 'network' }), tIn('pt-BR'))).toBe(
      'Nenhum container estava conectado; o compose up recria as redes.'
    )
  })
})
