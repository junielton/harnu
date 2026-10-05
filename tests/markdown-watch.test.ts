import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  refCount,
  addRef,
  removeRef,
  suppressNextChange,
  consumeSuppression,
  __resetMarkdownWatchStateForTests,
  registerMarkdownWatchHandlers,
  notifyMarkdownChanged,
  closeAllMarkdownWatchers
} from '../src/main/markdown-watch'

// markdown-watch imports `ipcMain` from `electron` directly (registerMarkdownWatchHandlers)
// — stub it the same way tests/markdown-write-containment.test.ts does, since
// this suite runs outside a real Electron process.
vi.mock('electron', () => ({
  ipcMain: { handle: (): void => {}, on: (): void => {} }
}))

// markdown-watch confines against `markdownKnownRoots()` — stub it so the temp
// dir this test creates counts as a known root without touching real user
// settings/scanned folders.
vi.mock('../src/main/markdown-read', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/main/markdown-read')>()
  return {
    ...actual,
    markdownKnownRoots: async () => [(globalThis as Record<string, unknown>).__TEST_ROOT__]
  }
})

beforeEach(() => {
  __resetMarkdownWatchStateForTests()
})

describe('markdown-watch ref counting', () => {
  it('addRef on a fresh path returns "first" and refCount becomes 1', () => {
    expect(addRef('/repo/a.md')).toBe('first')
    expect(refCount('/repo/a.md')).toBe(1)
  })

  it('a second addRef on the same path returns "more" and refCount becomes 2', () => {
    addRef('/repo/a.md')
    expect(addRef('/repo/a.md')).toBe('more')
    expect(refCount('/repo/a.md')).toBe(2)
  })

  it('removeRef down to zero returns "last"; below zero (or unknown path) returns "none"', () => {
    addRef('/repo/a.md')
    expect(removeRef('/repo/a.md')).toBe('last')
    expect(refCount('/repo/a.md')).toBe(0)
    expect(removeRef('/repo/a.md')).toBe('none')
    expect(removeRef('/repo/never-added.md')).toBe('none')
  })

  it('removeRef with 2 refs returns "more" and leaves 1 ref', () => {
    addRef('/repo/a.md')
    addRef('/repo/a.md')
    expect(removeRef('/repo/a.md')).toBe('more')
    expect(refCount('/repo/a.md')).toBe(1)
  })
})

describe('markdown-watch self-write suppression', () => {
  it('consumeSuppression is false when nothing was suppressed', () => {
    expect(consumeSuppression('/repo/a.md')).toBe(false)
  })

  it('suppressNextChange makes the NEXT consumeSuppression true, then resets to false', () => {
    suppressNextChange('/repo/a.md')
    expect(consumeSuppression('/repo/a.md')).toBe(true)
    expect(consumeSuppression('/repo/a.md')).toBe(false)
  })

  it('suppression is scoped per-path — suppressing a.md does not affect b.md', () => {
    suppressNextChange('/repo/a.md')
    expect(consumeSuppression('/repo/b.md')).toBe(false)
    expect(consumeSuppression('/repo/a.md')).toBe(true)
  })
})

describe('markdown-watch — real filesystem + confinement', () => {
  let dir: string
  let file: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'harnu-markdown-watch-'))
    file = join(dir, 'doc.md')
    writeFileSync(file, 'v1', 'utf8')
    ;(globalThis as Record<string, unknown>).__TEST_ROOT__ = dir
    __resetMarkdownWatchStateForTests()
  })

  afterEach(async () => {
    await closeAllMarkdownWatchers()
    rmSync(dir, { recursive: true, force: true })
  })

  it('notifyMarkdownChanged on a path with no refs returns "not-open" and broadcasts nothing', async () => {
    const sent: unknown[] = []
    registerMarkdownWatchHandlers(
      () =>
        ({
          isDestroyed: () => false,
          webContents: { send: (_ch: string, p: unknown) => sent.push(p) }
        }) as never
    )
    const result = await notifyMarkdownChanged(file)
    expect(result).toBe('not-open')
    expect(sent).toHaveLength(0)
  })

  it('notifyMarkdownChanged on a REFFED, in-root path returns "ok" and broadcasts {path}', async () => {
    const sent: unknown[] = []
    registerMarkdownWatchHandlers(
      () =>
        ({
          isDestroyed: () => false,
          webContents: { send: (_ch: string, p: unknown) => sent.push(p) }
        }) as never
    )
    addRef(file)
    const result = await notifyMarkdownChanged(file)
    expect(result).toBe('ok')
    expect(sent).toEqual([{ path: file }])
    removeRef(file)
  })

  it('notifyMarkdownChanged on a path outside known roots returns "outside-roots"', async () => {
    const outside = join(tmpdir(), 'not-a-known-root.md')
    writeFileSync(outside, 'x', 'utf8')
    addRef(outside)
    const result = await notifyMarkdownChanged(outside)
    expect(result).toBe('outside-roots')
    removeRef(outside)
    rmSync(outside, { force: true })
  })
})
