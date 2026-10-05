import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import en from '../src/renderer/src/i18n/en.json'
import ptBR from '../src/renderer/src/i18n/pt-BR.json'
import { MANIFEST_BOOT_LABELS } from '../src/main/roadmap-core'
import { PEER_FROM_NAME } from '../src/main/messaging-socket'
import { KOKORO_PROTOCOL } from '../src/main/speech-kokoro-plan'

const root = resolve(__dirname, '..')
const read = (rel: string): string => readFileSync(resolve(root, rel), 'utf8')

/** Every string value in a locale tree, with its dotted path. */
function strings(node: unknown, prefix = ''): Array<[string, string]> {
  if (typeof node === 'string') return [[prefix, node]]
  if (node && typeof node === 'object') {
    return Object.entries(node).flatMap(([k, v]) => strings(v, prefix ? `${prefix}.${k}` : k))
  }
  return []
}

describe('visible product name is Harnu', () => {
  it.each([
    ['en', en],
    ['pt-BR', ptBR]
  ])('%s locale carries no product-name "Capy"', (_name, tree) => {
    const hits = strings(tree).filter(([, v]) => /\bCapy\b/.test(v))
    expect(hits).toEqual([])
  })

  it.each([
    ['en', en],
    ['pt-BR', ptBR]
  ])('%s names the app, the default theme and the TTS sample folder Harnu', (_name, tree) => {
    expect(tree.app.name).toBe('Harnu')
    expect(tree.theme.defaultDark).toBe('Harnu')
    expect(tree.voice.phrase.sampleFolder).toBe('harnu')
    expect(tree.settings.harnuAwareness.label).toContain('Harnu')
    expect('capyAwareness' in tree.settings).toBe(false)
  })

  it('keeps the generate / dispatch boot-prompt headings on the new name', () => {
    expect(MANIFEST_BOOT_LABELS.heading).toBe('Harnu · Roadmap dispatch')
    expect(en.roadmap.generate.heading).toBe('Harnu · Generate')
  })

  it('brokers peer messages as Harnu', () => {
    expect(PEER_FROM_NAME).toBe('Harnu')
  })

  it('serves the offline voice over harnu-voice:// (capy-voice stays only as a legacy alias, see speech-kokoro-legacy-scheme.test.ts)', () => {
    expect(KOKORO_PROTOCOL).toBe('harnu-voice')
    expect(read('src/renderer/index.html')).toContain('harnu-voice:')
    expect(read('src/main/index.ts')).toContain('harnu-voice:')
  })

  it('labels the brand mark and signs Reaper archive commits as Harnu', () => {
    expect(read('src/renderer/src/components/BrandMark.vue')).toContain('aria-label="Harnu"')
    const archive = read('src/main/reaper/archive-shell.ts')
    expect(archive).toContain("GIT_AUTHOR_NAME: 'Harnu Reaper'")
    expect(archive).toContain("GIT_COMMITTER_EMAIL: 'reaper@harnu.dev'")
  })

  it('the anchor and the settings key were renamed together', () => {
    const dialog = read('src/renderer/src/components/SettingsDialog.vue')
    expect(dialog).toContain('set-harnu-awareness')
    expect(dialog).not.toContain('set-capy-awareness')
    expect(dialog).not.toContain('capyAwareness')
  })
})
