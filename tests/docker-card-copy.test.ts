// U3.7 AC-2/AC-5: a report-only item reads as a sentence about the FUTURE ("Would remove …"), in the
// app's language, instead of the journal's past-tense sentence; an unknown reason is shown as it is.
import { describe, expect, it } from 'vitest'
import { createI18n } from 'vue-i18n'
import en from '../src/renderer/src/i18n/en.json'
import ptBR from '../src/renderer/src/i18n/pt-BR.json'
import { wouldSentence } from '../src/renderer/src/lib/docker-card-copy'

function tIn(locale: 'en' | 'pt-BR'): (key: string, named?: Record<string, unknown>) => string {
  const i = createI18n({ legacy: false, locale, messages: { en, 'pt-BR': ptBR } })
  return (key, named) => i.global.t(key, named ?? {}) as string
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
