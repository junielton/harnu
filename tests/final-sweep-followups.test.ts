/**
 * U11 final-sweep follow-ups (AC-3d / AC-3i / AC-3j): small wiring contracts that the
 * rename left behind and that no existing suite pinned.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const state = vi.hoisted(() => ({ root: '', userData: '' }))

vi.mock('electron', () => ({
  app: { getPath: (): string => state.userData, isPackaged: false },
  ipcMain: { handle: (): void => {}, on: (): void => {} },
  protocol: { registerSchemesAsPrivileged: (): void => {}, handle: (): void => {} }
}))

vi.mock('../src/main/markdown-read', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/main/markdown-read')>()
  return { ...actual, markdownKnownRoots: async () => [state.root] }
})

import { readCanvasFile } from '../src/main/canvas-read'
import { setLazyDataDirMigration } from '../src/main/data-dir'
import { harnuPreamble, HARNU_FEATURES_DOC } from '../src/main/harnu-features'
import {
  KOKORO_ENTRY_PATH,
  KOKORO_INSTALL_DIR,
  KOKORO_ORIGIN,
  KOKORO_REWRITES
} from '../src/main/speech-kokoro-plan'
import { registerKokoroProtocol } from '../src/main/speech-kokoro'

beforeEach(() => {
  state.root = mkdtempSync(join(tmpdir(), 'harnu-u11-root-'))
  state.userData = mkdtempSync(join(tmpdir(), 'harnu-u11-ud-'))
})
afterEach(() => {
  setLazyDataDirMigration(false)
  rmSync(state.root, { recursive: true, force: true })
  rmSync(state.userData, { recursive: true, force: true })
})

describe('AC-3d — the canvas pane read path waits for the data-dir copy', () => {
  const DOC = JSON.stringify({ capycanvas: 1, meta: {}, nodes: [], edges: [] })

  it('opens a board that only exists in the legacy .capy/ dir, once the lazy copy has landed', async () => {
    setLazyDataDirMigration(true)
    mkdirSync(join(state.root, '.git'), { recursive: true })
    mkdirSync(join(state.root, '.capy', 'out', 'canvas'), { recursive: true })
    writeFileSync(join(state.root, '.capy', 'out', 'canvas', 'b.capycanvas.json'), DOC)

    // The pane asks for the NEW location; without awaiting the copy this is `not-found`.
    const res = await readCanvasFile(
      join(state.root, '.harnu', 'out', 'canvas', 'b.capycanvas.json')
    )
    expect(res.ok).toBe(true)
  })

  it('is unaffected for a root with no legacy dir (not-found stays not-found)', async () => {
    setLazyDataDirMigration(true)
    const res = await readCanvasFile(
      join(state.root, '.harnu', 'out', 'canvas', 'nope.harnucanvas.json')
    )
    expect(res).toMatchObject({ ok: false, code: 'not-found' })
  })
})

describe('AC-3i — the self-awareness preamble is real content', () => {
  it('harnuPreamble() is non-empty and carries the doc, not just a language line', () => {
    const preamble = harnuPreamble()
    expect(preamble.length).toBeGreaterThan(2000)
    expect(preamble.startsWith(HARNU_FEATURES_DOC)).toBe(true)
    expect(preamble).toMatch(/<!-- harnu-features v\d+/)
    expect(preamble).toContain('mcp__harnu__')
    expect(preamble).toContain('Approval Inbox')
  })

  it('is handed to the spawn path at boot (index.ts wires harnuPreamble into the provider)', () => {
    const index = readFileSync(resolve(__dirname, '../src/main/index.ts'), 'utf8')
    expect(index).toContain('setHarnuPreambleProvider(() => harnuPreamble())')
  })
})

describe('AC-3j — registering the voice protocol migrates a pre-rename install at boot', () => {
  it('rewrites the baked capy-voice:// entry file without anyone calling migrateInstalledMirror()', async () => {
    const entry = join(state.userData, KOKORO_INSTALL_DIR, ...KOKORO_ENTRY_PATH.slice(1).split('/'))
    mkdirSync(join(entry, '..'), { recursive: true })
    writeFileSync(
      entry,
      `const v = "${KOKORO_REWRITES[0].replace.replace(KOKORO_ORIGIN, 'capy-voice://kokoro')}";`
    )

    registerKokoroProtocol() // the boot call: it must kick the migration off itself

    const deadline = Date.now() + 3000
    while (readFileSync(entry, 'utf8').includes('capy-voice') && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20))
    }
    const onDisk = readFileSync(entry, 'utf8')
    expect(onDisk).not.toContain('capy-voice')
    expect(onDisk).toContain(`${KOKORO_ORIGIN}/hf/`)
    expect(existsSync(entry)).toBe(true)
  })
})
