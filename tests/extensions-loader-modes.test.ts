import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildExtensionRegistry } from '../src/main/extensions/extension-registry'
import {
  listSessionModes,
  resolveModeContract,
  __setRegistryForTest
} from '../src/main/extensions/extensions-loader'

/**
 * T138 — the shell's merge (builtins ∪ extension modes) and the on-demand
 * doc-content resolver. `extensions-loader.ts` also does chokidar/electron
 * wiring not exercised here (mirrors the T137 precedent of testing the pure
 * fold, not the IPC wiring) — importing the module must never execute that
 * wiring itself, only `registerExtensionsHandlers()` does.
 */
describe('listSessionModes / resolveModeContract', () => {
  afterEach(() => {
    __setRegistryForTest({ themes: [], boardTemplates: new Map(), modes: [] })
  })

  it('lists the learning builtin even with zero extensions installed', () => {
    const modes = listSessionModes()
    expect(modes.some((m) => m.id === 'learning' && m.origin === 'builtin')).toBe(true)
  })

  it('resolves the builtin contract without touching the filesystem', async () => {
    const doc = await resolveModeContract('learning')
    expect(doc.length).toBeGreaterThan(0)
  })

  it('returns "" for an unknown mode id, never throwing', async () => {
    await expect(resolveModeContract('not-a-real-mode')).resolves.toBe('')
    await expect(resolveModeContract(undefined)).resolves.toBe('')
  })

  it('lists an installed extension mode alongside the builtin, with origin metadata', () => {
    const reg = buildExtensionRegistry([
      {
        id: 'pack-a',
        dirPath: '/ext/pack-a',
        raw: {
          id: 'pack-a',
          label: 'Pack A',
          contributes: { modes: [{ id: 'reviewer', label: 'Reviewer', doc: './reviewer.md' }] }
        }
      }
    ])
    __setRegistryForTest(reg)
    const modes = listSessionModes()
    expect(modes.map((m) => m.id)).toEqual(['learning', 'ext-pack-a-reviewer'])
    expect(modes[1]).toMatchObject({
      label: 'Reviewer',
      origin: 'extension',
      extensionId: 'pack-a',
      extensionLabel: 'Pack A'
    })
  })

  it('reads an extension mode doc file fresh from disk', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'harnu-ext-mode-'))
    try {
      writeFileSync(join(dir, 'reviewer.md'), 'Be a strict reviewer.')
      const reg = buildExtensionRegistry([
        {
          id: 'pack-a',
          dirPath: dir,
          raw: {
            id: 'pack-a',
            label: 'Pack A',
            contributes: { modes: [{ id: 'reviewer', label: 'Reviewer', doc: './reviewer.md' }] }
          }
        }
      ])
      expect(reg.modes[0].docPath).toBe(join(dir, 'reviewer.md'))
      __setRegistryForTest(reg)
      const doc = await resolveModeContract('ext-pack-a-reviewer')
      expect(doc).toBe('Be a strict reviewer.')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('degrades to "" (never throws) when the doc file is missing', async () => {
    const reg = buildExtensionRegistry([
      {
        id: 'pack-a',
        dirPath: '/nonexistent-dir-xyz',
        raw: {
          id: 'pack-a',
          label: 'Pack A',
          contributes: { modes: [{ id: 'ghost', label: 'Ghost', doc: './ghost.md' }] }
        }
      }
    ])
    __setRegistryForTest(reg)
    await expect(resolveModeContract('ext-pack-a-ghost')).resolves.toBe('')
  })
})
