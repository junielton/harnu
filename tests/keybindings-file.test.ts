import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  KEYBINDINGS_FILENAME,
  keybindingsPathIn,
  readKeybindingsBody,
  loadResolvedKeybindings,
  loadResolvedKeybindingsSync,
  writeKeybindingsBody
} from '../src/main/keybindings-file'

/**
 * `keybindings-file.ts` is the pure-node (fs only) half of the T1 P2 override
 * layer — the electron glue in `keybindings.ts` (IPC + chokidar) is not exercised
 * here. The resolution semantics themselves (warnings, conflicts, comment
 * stripping) live in `tests/keybindings-core.test.ts`; this suite pins the file
 * behavior: path shape, a missing file resolving to defaults, a written file
 * round-tripping, and a malformed file never throwing.
 */

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'harnu-keybindings-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('keybindingsPathIn', () => {
  it('joins the fixed basename onto the settings directory', () => {
    expect(keybindingsPathIn('/home/u/.config/Harnu')).toBe(
      `/home/u/.config/Harnu/${KEYBINDINGS_FILENAME}`
    )
    expect(KEYBINDINGS_FILENAME).toBe('keybindings.json')
  })
})

describe('readKeybindingsBody', () => {
  it('returns "" when the file does not exist (first-run state)', async () => {
    expect(await readKeybindingsBody(join(dir, 'keybindings.json'))).toBe('')
  })

  it('returns the raw body verbatim when the file exists', async () => {
    const p = join(dir, 'keybindings.json')
    const body = '// a comment\n[{ "key": "Cmd+J", "command": "view.review" }]\n'
    writeFileSync(p, body, 'utf8')
    expect(await readKeybindingsBody(p)).toBe(body)
  })

  it("rethrows a non-ENOENT read error (a directory in the file's place)", async () => {
    const p = join(dir, 'keybindings.json')
    mkdirSync(p) // reading a directory as a file → EISDIR, not ENOENT
    await expect(readKeybindingsBody(p)).rejects.toThrow()
  })
})

describe('loadResolvedKeybindings', () => {
  it('resolves to defaults-only when the file is absent', async () => {
    const resolved = await loadResolvedKeybindings(join(dir, 'keybindings.json'))
    expect(resolved.warnings).toEqual([])
    expect(resolved.byId['app.search'].keys).toBe('Cmd+K')
    expect(resolved.byId['app.search'].source).toBe('default')
  })

  it('applies a valid override from disk', async () => {
    const p = join(dir, 'keybindings.json')
    writeFileSync(p, '[{ "key": "Cmd+Shift+K", "command": "app.search" }]\n', 'utf8')
    const resolved = await loadResolvedKeybindings(p)
    expect(resolved.byId['app.search'].keys).toBe('Cmd+Shift+K')
    expect(resolved.byId['app.search'].source).toBe('override')
    expect(resolved.warnings).toEqual([])
  })

  it('strips JSONC comments before parsing', async () => {
    const p = join(dir, 'keybindings.json')
    writeFileSync(
      p,
      '// Harnu keybindings\n[\n  /* rebind review */ { "key": "Cmd+J", "command": "view.review" }\n]\n',
      'utf8'
    )
    const resolved = await loadResolvedKeybindings(p)
    expect(resolved.byId['view.review'].keys).toBe('Cmd+J')
  })

  it('falls back to defaults with one warning on a malformed file — never throws', async () => {
    const p = join(dir, 'keybindings.json')
    writeFileSync(p, '{ this is not json', 'utf8')
    const resolved = await loadResolvedKeybindings(p)
    expect(resolved.byId['app.search'].keys).toBe('Cmd+K')
    expect(resolved.warnings).toHaveLength(1)
    expect(resolved.warnings[0].code).toBe('not-array')
  })

  it('collects a per-entry warning and keeps the default for a reserved target', async () => {
    const p = join(dir, 'keybindings.json')
    writeFileSync(p, '[{ "key": "Cmd+Y", "command": "app.quit" }]\n', 'utf8')
    const resolved = await loadResolvedKeybindings(p)
    expect(resolved.warnings.some((w) => w.code === 'reserved-command')).toBe(true)
  })
})

describe('loadResolvedKeybindingsSync', () => {
  it('resolves to defaults when the file is absent — never throws (Q3 startup seed)', () => {
    const resolved = loadResolvedKeybindingsSync(join(dir, 'keybindings.json'))
    expect(resolved.byId['app.search'].keys).toBe('Cmd+K')
    expect(resolved.byId['app.search'].source).toBe('default')
  })

  it('applies a valid override from disk, same as the async loader', () => {
    const p = join(dir, 'keybindings.json')
    writeFileSync(p, '[{ "key": "Cmd+Shift+K", "command": "app.search" }]\n', 'utf8')
    const resolved = loadResolvedKeybindingsSync(p)
    expect(resolved.byId['app.search'].keys).toBe('Cmd+Shift+K')
    expect(resolved.byId['app.search'].source).toBe('override')
  })

  it('falls back to defaults on an unreadable path instead of throwing', () => {
    const p = join(dir, 'keybindings.json')
    mkdirSync(p) // a directory in the file's place → EISDIR
    const resolved = loadResolvedKeybindingsSync(p)
    expect(resolved.byId['app.search'].keys).toBe('Cmd+K')
  })
})

describe('writeKeybindingsBody', () => {
  it('creates the directory if needed and writes the body verbatim', async () => {
    const p = join(dir, 'nested', 'deeper', 'keybindings.json')
    const body = '[\n  { "key": null, "command": "session.resumeLast" }\n]\n'
    await writeKeybindingsBody(p, body)
    expect(await readFile(p, 'utf8')).toBe(body)
  })

  it('round-trips through loadResolvedKeybindings', async () => {
    const p = join(dir, 'keybindings.json')
    await writeKeybindingsBody(p, '[{ "key": null, "command": "session.resumeLast" }]\n')
    const resolved = await loadResolvedKeybindings(p)
    expect(resolved.byId['session.resumeLast'].keys).toBeNull()
    expect(resolved.byId['session.resumeLast'].source).toBe('unbound')
  })

  it('is atomic — no .tmp residue after repeated writes', async () => {
    const { readdirSync } = await import('node:fs')
    const p = join(dir, 'keybindings.json')
    await writeKeybindingsBody(p, '[]\n')
    await writeKeybindingsBody(p, '[{ "key": "Cmd+J", "command": "view.review" }]\n')
    await writeKeybindingsBody(p, '[]\n')
    expect(readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toEqual([])
    expect(await readFile(p, 'utf8')).toBe('[]\n')
  })

  it('follows a symlink to its target instead of replacing the link (dotfiles case)', async () => {
    const { symlinkSync, lstatSync } = await import('node:fs')
    const realDir = mkdtempSync(join(tmpdir(), 'harnu-dotfiles-'))
    try {
      const real = join(realDir, 'keybindings.json')
      const link = join(dir, 'keybindings.json')
      writeFileSync(real, '[]\n')
      symlinkSync(real, link)

      await writeKeybindingsBody(link, '[{ "key": "Cmd+J", "command": "view.review" }]\n')

      expect(lstatSync(link).isSymbolicLink()).toBe(true) // link preserved
      expect(await readFile(real, 'utf8')).toBe('[{ "key": "Cmd+J", "command": "view.review" }]\n')
      const { readdirSync } = await import('node:fs')
      expect(readdirSync(realDir).filter((f) => f.endsWith('.tmp'))).toEqual([])
    } finally {
      rmSync(realDir, { recursive: true, force: true })
    }
  })
})

describe('loadResolvedKeybindings — Ctrl/Cmd fold', () => {
  it('folds a hand-edited Ctrl+Q onto the reserved Cmd+Q when mac=false', async () => {
    const p = join(dir, 'keybindings.json')
    writeFileSync(p, '[{ "key": "Ctrl+Q", "command": "app.search" }]\n', 'utf8')
    const resolved = await loadResolvedKeybindings(p, false)
    expect(resolved.byId['app.search'].keys).toBe('Cmd+K') // rejected, default kept
    expect(resolved.warnings[0]?.code).toBe('reserved-chord')
  })
})
