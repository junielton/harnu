import { describe, expect, it } from 'vitest'
import { lastSeenText, refusalToast } from '../src/renderer/src/lib/external-view'
import { stateLine } from '../src/renderer/src/lib/companion-view'
import en from '../src/renderer/src/i18n/en.json'
import ptBR from '../src/renderer/src/i18n/pt-BR.json'

function translator(messages: Record<string, unknown>) {
  return (key: string, params: Record<string, unknown> = {}): string => {
    const found = key
      .split('.')
      .reduce<unknown>((o, k) => (o as Record<string, unknown> | undefined)?.[k], messages)
    if (typeof found !== 'string') throw new Error(`missing key ${key}`)
    return found.replace(/\{(\w+)\}/g, (_m, name: string) => String(params[name] ?? ''))
  }
}
const t = translator(en)

describe('refusal toasts (P4W3 §10)', () => {
  it('every refusal reason has a sentence, and a managed cause is only named for policy', () => {
    const reasons = [
      'unparseable',
      'occupied',
      'symlink',
      'policy',
      'mods-off',
      'no-companion',
      'failed'
    ] as const
    for (const reason of reasons) {
      const toast = refusalToast({ ok: false, reason }, t)
      expect(toast?.title.length).toBeGreaterThan(5)
    }
    expect(refusalToast({ ok: false, reason: 'policy' }, t)?.title).toBe(
      "Blocked by your organization's policy."
    )
    // The neutral sentence names no cause: the probe shows mods are off, not why (DOC-8).
    expect(refusalToast({ ok: false, reason: 'mods-off' }, t)?.title).toBe(
      "Turned off by a setting or by your organization's policy."
    )
    expect(refusalToast({ ok: true, on: true }, t)).toBeNull()
  })

  it('an undo that cannot run names the one path to remove by hand', () => {
    const toast = refusalToast(
      { ok: false, reason: 'unparseable', manualPath: '/data/example/staged/abc' },
      t
    )
    expect(toast?.description).toBe(
      'To remove it by hand, delete /data/example/staged/abc from `CLAUDE_CODE_PLUGIN_DIRS`.'
    )
  })
})

describe('last outside session seen', () => {
  it('says never until one reported, then a relative time', () => {
    expect(lastSeenText(null, 1_000_000, t, 'en')).toBe('No outside session has reported yet.')
    const text = lastSeenText(1_000_000 - 120_000, 1_000_000, t, 'en')
    expect(text).toBe('Last outside session seen: 2 minutes ago')
  })
})

describe('the hover preview line of an outside session', () => {
  it('reads "live · outside Harnu", and only a corroborated one has a state', () => {
    expect(stateLine({ state: 'live', outside: true }, t)?.text).toBe(
      'Harnu mod: live · outside Harnu'
    )
    expect(stateLine({ state: 'live' }, t)?.text).toBe('Harnu mod: live')
    expect(stateLine(null, t)).toBeNull()
  })
})

describe('locales stay at parity for the outside keys', () => {
  it('both locales carry every harnuMod.external key and the two suffixes', () => {
    const keys = (o: unknown, prefix = ''): string[] =>
      Object.entries(o as Record<string, unknown>).flatMap(([k, v]) =>
        typeof v === 'object' && v !== null ? keys(v, `${prefix}${k}.`) : [`${prefix}${k}`]
      )
    expect(keys(ptBR.harnuMod.external).sort()).toEqual(keys(en.harnuMod.external).sort())
    expect(ptBR.harnuMod.state.outside).toBeTruthy()
    expect(ptBR.approvalInbox.row.outside).toBeTruthy()
  })
})
