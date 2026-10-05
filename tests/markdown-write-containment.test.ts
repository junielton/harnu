import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as os from 'node:os'
import * as path from 'node:path'
import { promises as fs } from 'node:fs'
import { MAX_MARKDOWN_BYTES } from '../src/main/markdown-core'

/**
 * Containment + size hardening for the T74 WRITER (phase 2; broadened by
 * Cluster G — no extension gate anymore, any path is writable). Writing is the
 * most sensitive surface of the feature, so it MIRRORS the reader exactly:
 * same known-folder roots, same size cap, reusing the real
 * `checkMarkdownReadAllowed` containment (which leans on `settings.ts`'s
 * tested `isPathAllowed`). A path outside the known roots — via `..`, an
 * absolute re-root, or a false-positive prefix (`harnu-secrets/`) — must NEVER
 * create or overwrite a file.
 *
 * `markdown-write.ts` imports `electron` (ipcMain) + `markdown-read.ts` (which
 * pulls the folder-scan modules). We stub the env-bound bits so the confinement
 * runs against a controlled tmp root, but keep the REAL containment logic.
 */
const h = vi.hoisted(() => ({ root: '' }))

vi.mock('electron', () => ({
  app: { getPath: (): string => os.tmpdir() },
  dialog: {},
  shell: {},
  BrowserWindow: class {},
  ipcMain: { handle: (): void => {}, on: (): void => {} }
}))
// The live known roots resolve to our controlled tmp dir (pinned project only).
vi.mock('../src/main/user-projects', () => ({
  readUserProjects: async (): Promise<{ projects: { path: string }[] }> => ({
    projects: [{ path: h.root }]
  })
}))
vi.mock('../src/main/claude-reader', () => ({
  scanFolders: async (): Promise<unknown[]> => []
}))

import { writeMarkdownFile } from '../src/main/markdown-write'
import { consumeSuppression, __resetMarkdownWatchStateForTests } from '../src/main/markdown-watch'

const absent = async (p: string): Promise<boolean> => {
  try {
    await fs.stat(p)
    return false
  } catch {
    return true
  }
}

beforeEach(async () => {
  h.root = await fs.mkdtemp(path.join(os.tmpdir(), 'harnu-mdw-'))
})
afterEach(async () => {
  await fs.rm(h.root, { recursive: true, force: true }).catch(() => {})
})

describe('writeMarkdownFile — happy path (inside a known root)', () => {
  it('creates a new markdown file and returns the resolved path + byte count', async () => {
    const target = path.join(h.root, 'report.md')
    const res = await writeMarkdownFile(target, '# Hello\n\nbody')
    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(res.path).toBe(path.resolve(target))
      expect(res.bytes).toBe(Buffer.byteLength('# Hello\n\nbody', 'utf8'))
    }
    expect(await fs.readFile(target, 'utf8')).toBe('# Hello\n\nbody')
  })

  it('overwrites an existing file in place (atomic replace)', async () => {
    const target = path.join(h.root, 'notes.md')
    await fs.writeFile(target, 'old')
    const res = await writeMarkdownFile(target, 'new content')
    expect(res.ok).toBe(true)
    expect(await fs.readFile(target, 'utf8')).toBe('new content')
    // The temp sibling used for the atomic rename must not linger.
    expect(await absent(`${path.resolve(target)}.harnu-tmp`)).toBe(true)
  })

  it('accepts empty content (the "New markdown" flow creates a 0-byte file)', async () => {
    const target = path.join(h.root, 'untitled.md')
    const res = await writeMarkdownFile(target, '')
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.bytes).toBe(0)
    expect(await fs.readFile(target, 'utf8')).toBe('')
  })

  it('accepts .markdown and .txt too', async () => {
    expect((await writeMarkdownFile(path.join(h.root, 'a.markdown'), 'x')).ok).toBe(true)
    expect((await writeMarkdownFile(path.join(h.root, 'b.txt'), 'x')).ok).toBe(true)
  })
})

describe('writeMarkdownFile — containment (never writes outside the known roots)', () => {
  it('rejects a path escaping the root via .. and writes nothing', async () => {
    const escaped = path.join(h.root, '..', 'escaped.md')
    const res = await writeMarkdownFile(escaped, 'pwned')
    expect(res).toMatchObject({ ok: false, code: 'outside-roots' })
    expect(await absent(path.resolve(escaped))).toBe(true)
  })

  it('rejects an absolute path outside every root', async () => {
    const res = await writeMarkdownFile('/tmp/definitely-not-a-harnu-root-xyz.md', 'x')
    expect(res).toMatchObject({ ok: false, code: 'outside-roots' })
    expect(await absent('/tmp/definitely-not-a-harnu-root-xyz.md')).toBe(true)
  })

  it('rejects a sibling whose name only prefixes the root (harnu-secrets/ false positive)', async () => {
    const sibling = `${h.root}-secrets/x.md`
    const res = await writeMarkdownFile(sibling, 'x')
    expect(res).toMatchObject({ ok: false, code: 'outside-roots' })
  })
})

describe('writeMarkdownFile — extension + size + shape', () => {
  it('writes a contained non-markdown file too (Cluster G — no extension gate anymore)', async () => {
    const target = path.join(h.root, 'app.js')
    const res = await writeMarkdownFile(target, 'x')
    expect(res.ok).toBe(true)
    expect(await fs.readFile(target, 'utf8')).toBe('x')
  })

  it('rejects content over the size cap (too-large) and writes nothing', async () => {
    const target = path.join(h.root, 'huge.md')
    const res = await writeMarkdownFile(target, 'a'.repeat(MAX_MARKDOWN_BYTES + 1))
    expect(res).toMatchObject({ ok: false, code: 'too-large' })
    expect(await absent(target)).toBe(true)
  })

  it('rejects a non-string path / content (invalid-path)', async () => {
    expect(await writeMarkdownFile('', 'x')).toMatchObject({ ok: false, code: 'invalid-path' })
    expect(
      await writeMarkdownFile(path.join(h.root, 'x.md'), undefined as unknown as string)
    ).toMatchObject({ ok: false, code: 'invalid-path' })
  })
})

describe('writeMarkdownFile — self-write suppression', () => {
  beforeEach(() => {
    __resetMarkdownWatchStateForTests()
  })

  it('arms suppression for the resolved path on a successful write', async () => {
    const target = path.join(h.root, 'note.md')
    await writeMarkdownFile(target, 'hello')
    expect(consumeSuppression(target)).toBe(true)
  })
})
