import { describe, it, expect, vi } from 'vitest'
import * as os from 'node:os'
import * as path from 'node:path'
import { mkdtempSync, writeFileSync, symlinkSync, rmSync } from 'node:fs'

/**
 * Containment hardening for the T74 markdown reader (AC5/AC6), broadened by
 * Cluster G to cover ANY file (the extension allowlist that used to gate
 * admission here is gone — see `markdown-core.test.ts` for the binary sniff
 * that replaced it). The gate is a pure function over (resolvedPath, roots)
 * reusing `settings.ts`'s tested `isPathAllowed`/`isPathWithinRoot`, so a
 * renderer/agent path can't escape the known Harnu folders. `markdown-read.ts`
 * imports `electron` (ipcMain) and the folder-scan modules transitively; stub
 * the env-bound bits so the pure helpers are importable without an Electron
 * runtime.
 */
vi.mock('electron', () => ({
  app: { getPath: (): string => os.tmpdir() },
  dialog: {},
  shell: {},
  BrowserWindow: class {},
  ipcMain: { handle: (): void => {}, on: (): void => {} }
}))

import {
  checkMarkdownReadAllowed,
  isExactPathSymlink,
  isProseExt,
  PROSE_EXTENSIONS,
  MAX_MARKDOWN_BYTES
} from '../src/main/markdown-read'

describe('markdown read — prose-rendering extensions (Cluster G: no longer an admission gate)', () => {
  it('treats .md / .markdown (case-insensitive) as prose', () => {
    expect(isProseExt('/a/b/README.md')).toBe(true)
    expect(isProseExt('/a/b/notes.markdown')).toBe(true)
    expect(isProseExt('/a/b/DESIGN.MD')).toBe(true)
  })

  it('treats every other extension (including .txt) as plain text, not prose', () => {
    expect(isProseExt('/a/b/log.txt')).toBe(false)
    expect(isProseExt('/a/b/app.js')).toBe(false)
    expect(isProseExt('/a/b/pic.png')).toBe(false)
    expect(isProseExt('/a/b/Makefile')).toBe(false)
    // A dot in the dir but not the basename must not fool extname.
    expect(isProseExt('/a.md/b/app')).toBe(false)
  })

  it('exposes the frozen prose-extension list + a positive size cap', () => {
    expect([...PROSE_EXTENSIONS]).toEqual(['.md', '.markdown'])
    expect(MAX_MARKDOWN_BYTES).toBeGreaterThan(0)
  })
})

describe('markdown read — path containment', () => {
  const root = path.resolve('/home/user/repos/harnu')
  const otherRoot = path.resolve('/home/user/repos/notes')

  it('allows a markdown file directly inside a known root', () => {
    expect(checkMarkdownReadAllowed(path.join(root, 'design.md'), [root])).toEqual({ ok: true })
  })

  it('allows a nested markdown file inside a known root', () => {
    expect(checkMarkdownReadAllowed(path.join(root, 'docs', 'lessons', 'x.md'), [root])).toEqual({
      ok: true
    })
  })

  it('rejects a file escaping the root via ..', () => {
    const escaped = path.resolve(root, '..', '..', '..', 'etc', 'passwd.md')
    expect(checkMarkdownReadAllowed(escaped, [root])).toEqual({ ok: false, code: 'outside-roots' })
  })

  it('rejects an absolute path outside every root', () => {
    expect(checkMarkdownReadAllowed('/etc/passwd.md', [root, otherRoot])).toEqual({
      ok: false,
      code: 'outside-roots'
    })
  })

  it('rejects a sibling whose name only prefixes the root (projects-other/ false positive)', () => {
    // `/home/user/repos/harnu-secrets/x.md` must not count as inside `.../harnu`.
    expect(checkMarkdownReadAllowed(root + '-secrets/x.md', [root])).toEqual({
      ok: false,
      code: 'outside-roots'
    })
  })

  it('rejects when there are no known roots at all', () => {
    expect(checkMarkdownReadAllowed(path.join(root, 'design.md'), [])).toEqual({
      ok: false,
      code: 'outside-roots'
    })
  })

  it('accepts when any one of several roots contains the path', () => {
    expect(checkMarkdownReadAllowed(path.join(otherRoot, 'hot.md'), [root, otherRoot])).toEqual({
      ok: true
    })
  })

  it('allows a contained non-markdown file too (Cluster G — no extension gate here anymore)', () => {
    expect(checkMarkdownReadAllowed(path.join(root, 'index.ts'), [root])).toEqual({ ok: true })
  })

  it('rejects an extensionless file outside every root (containment still applies)', () => {
    expect(checkMarkdownReadAllowed('/etc/passwd', [root])).toEqual({
      ok: false,
      code: 'outside-roots'
    })
  })

  describe('exact-path exception (T1 P5 — keybindings.json editor pane)', () => {
    const kb = path.resolve('/home/user/.config/Harnu/keybindings.json')

    it('admits the one exact out-of-root path when it is passed', () => {
      expect(checkMarkdownReadAllowed(kb, [root], kb)).toEqual({ ok: true })
    })

    it('does not admit that path without the exception (the open_file validator path)', () => {
      expect(checkMarkdownReadAllowed(kb, [root])).toEqual({ ok: false, code: 'outside-roots' })
    })

    it('the exception is exact — a sibling in the same dir is still refused', () => {
      const sibling = path.resolve('/home/user/.config/Harnu/settings.json')
      expect(checkMarkdownReadAllowed(sibling, [root], kb)).toEqual({
        ok: false,
        code: 'outside-roots'
      })
    })

    it('still admits an in-root path when an exception is also supplied', () => {
      expect(checkMarkdownReadAllowed(path.join(root, 'design.md'), [root], kb)).toEqual({
        ok: true
      })
    })
  })

  describe('isExactPathSymlink (T1 P5 — refuse a symlink at the exact-path exception)', () => {
    it('true only when the exact-path exception admitted a real symlink', async () => {
      const tmp = mkdtempSync(path.join(os.tmpdir(), 'kb-symlink-'))
      try {
        const real = path.join(tmp, 'real.json')
        const link = path.join(tmp, 'keybindings.json')
        writeFileSync(real, '[]\n', 'utf8')
        symlinkSync(real, link)

        // Admitted by the exact-path exception AND a symlink → refuse.
        expect(await isExactPathSymlink(link, link)).toBe(true)
        // A plain file at the exact path → fine.
        expect(await isExactPathSymlink(real, real)).toBe(false)
        // The symlink, but NOT the passed exact path → not our concern here
        // (containment already handled it).
        expect(await isExactPathSymlink(link, real)).toBe(false)
        // No exception supplied at all.
        expect(await isExactPathSymlink(link, null)).toBe(false)
      } finally {
        rmSync(tmp, { recursive: true, force: true })
      }
    })
  })
})
