import { describe, it, expect, vi } from 'vitest'
import type { IBuffer, IBufferLine, IBufferCell, ILink, Terminal } from '@xterm/xterm'
import {
  extractPathCandidates,
  readLogicalLine,
  createFileLinkProvider,
  isFileLinkModifier,
  type FileLinkContext
} from '../src/renderer/src/lib/terminal-file-links'

describe('extractPathCandidates', () => {
  it('finds a relative path in prose', () => {
    const line = 'Edited src/main/pty.ts to fix it'
    expect(extractPathCandidates(line)).toEqual([{ text: 'src/main/pty.ts', start: 7, end: 22 }])
  })

  it('strips a line:col suffix from the text but keeps it underlined', () => {
    const line = 'See src/main/pty.ts:42:7.'
    // `end` covers `src/main/pty.ts:42:7` (20 chars from index 4) but not the period.
    expect(extractPathCandidates(line)).toEqual([{ text: 'src/main/pty.ts', start: 4, end: 24 }])
  })

  it('strips a bare line suffix', () => {
    expect(extractPathCandidates('at docs/user/sessions.md:9')).toEqual([
      { text: 'docs/user/sessions.md', start: 3, end: 26 }
    ])
  })

  it('rejects a bare basename with no separator', () => {
    expect(extractPathCandidates('I changed pty.ts today')).toEqual([])
  })

  it('ignores backticks, parens and quotes around a path', () => {
    expect(extractPathCandidates('(see `docs/user/sessions.md`)')).toEqual([
      { text: 'docs/user/sessions.md', start: 6, end: 27 }
    ])
  })

  it('keeps absolute and home-relative paths', () => {
    expect(extractPathCandidates('/repo/a/b.ts and ~/notes/todo.md')).toEqual([
      { text: '/repo/a/b.ts', start: 0, end: 12 },
      { text: '~/notes/todo.md', start: 17, end: 32 }
    ])
  })

  it('rejects URLs — WebLinksAddon owns those', () => {
    expect(extractPathCandidates('https://example.com/a/b and file:///tmp/x')).toEqual([])
  })

  it('is permissive about shape — existence is the real gate', () => {
    // `and/or` looks like a path; the resolver in main is what rejects it.
    expect(extractPathCandidates('and/or')).toEqual([{ text: 'and/or', start: 0, end: 6 }])
  })

  it('finds every occurrence on a line', () => {
    const found = extractPathCandidates('src/a.ts and src/b.ts')
    expect(found.map((c) => c.text)).toEqual(['src/a.ts', 'src/b.ts'])
  })

  it('returns nothing for an empty line', () => {
    expect(extractPathCandidates('')).toEqual([])
  })
})

/**
 * A fake xterm buffer built from plain strings, one string per ROW (not per
 * logical line). `wrapped` marks which rows continue the row above — that is
 * exactly how xterm represents a line too long for the grid, and a path split
 * across a wrap must still linkify.
 */
function fakeBuffer(rows: string[], wrapped: number[] = []): IBuffer {
  const lines: IBufferLine[] = rows.map((text, i) => {
    const chars = [...text]
    return {
      isWrapped: wrapped.includes(i),
      // Real xterm pads every row out to `cols` with blank cells; the fake stops
      // at the last real character so assertions don't carry trailing spaces.
      // `readLogicalLine` treats both identically — the extractor skips
      // whitespace either way.
      length: chars.length,
      getCell: (x: number): IBufferCell | undefined =>
        ({ getChars: () => chars[x] ?? '', getWidth: () => 1 }) as unknown as IBufferCell
    } as unknown as IBufferLine
  })
  return { getLine: (y: number) => lines[y] } as unknown as IBuffer
}

function fakeTerm(buffer: IBuffer): Terminal {
  return { buffer: { active: buffer } } as unknown as Terminal
}

function ctxFor(
  overrides: Partial<FileLinkContext> = {},
  resolved: Array<{ text: string; path: string; isDir: boolean }> = []
): FileLinkContext {
  return {
    root: () => '/repo',
    cwd: () => '/repo',
    isAltHeld: () => true,
    resolve: vi.fn().mockResolvedValue(resolved),
    onReveal: vi.fn(),
    ...overrides
  }
}

/** Drive `provideLinks` and await its callback. */
function provide(term: Terminal, ctx: FileLinkContext, y: number): Promise<ILink[] | undefined> {
  const provider = createFileLinkProvider(term, ctx)
  return new Promise((res) => provider.provideLinks(y, res))
}

describe('isFileLinkModifier', () => {
  it('is true for Alt/Option or Ctrl, alone or together', () => {
    expect(isFileLinkModifier({ altKey: true, ctrlKey: false })).toBe(true)
    expect(isFileLinkModifier({ altKey: false, ctrlKey: true })).toBe(true)
    expect(isFileLinkModifier({ altKey: true, ctrlKey: true })).toBe(true)
  })

  it('is false for no modifier, and for shift/meta alone', () => {
    expect(isFileLinkModifier({})).toBe(false)
    expect(isFileLinkModifier({ altKey: false, ctrlKey: false })).toBe(false)
    expect(
      isFileLinkModifier({ shiftKey: true, metaKey: true } as unknown as { altKey?: boolean })
    ).toBe(false)
  })
})

describe('readLogicalLine', () => {
  it('reads a single unwrapped row', () => {
    const logical = readLogicalLine(fakeBuffer(['abc']), 1)
    expect(logical?.text).toBe('abc')
    expect(logical?.rows).toEqual([1, 1, 1])
    expect(logical?.cols).toEqual([1, 2, 3])
  })

  it('stitches a wrapped line and maps offsets back to rows and columns', () => {
    // Row 0 holds 'src/', row 1 continues with 'a.ts' — a 4-column grid.
    const logical = readLogicalLine(fakeBuffer(['src/', 'a.ts'], [1]), 2)
    expect(logical?.text).toBe('src/a.ts')
    expect(logical?.rows).toEqual([1, 1, 1, 1, 2, 2, 2, 2])
    expect(logical?.cols).toEqual([1, 2, 3, 4, 1, 2, 3, 4])
  })

  it('returns null for a row that does not exist', () => {
    expect(readLogicalLine(fakeBuffer(['a']), 9)).toBeNull()
  })
})

describe('file link provider', () => {
  it('provides nothing while Option is not held', async () => {
    const ctx = ctxFor({ isAltHeld: () => false })
    const links = await provide(fakeTerm(fakeBuffer(['src/a.ts'])), ctx, 1)
    expect(links).toBeUndefined()
    expect(ctx.resolve).not.toHaveBeenCalled()
  })

  it('links a path that resolves, with an inclusive end cell', async () => {
    const ctx = ctxFor({}, [{ text: 'src/a.ts', path: '/repo/src/a.ts', isDir: false }])
    const links = await provide(fakeTerm(fakeBuffer(['see src/a.ts'])), ctx, 1)
    expect(links).toHaveLength(1)
    expect(links?.[0].text).toBe('src/a.ts')
    // 'src/a.ts' spans columns 5..12 (1-based), end inclusive.
    expect(links?.[0].range).toEqual({ start: { x: 5, y: 1 }, end: { x: 12, y: 1 } })
  })

  it('drops a path that does not resolve', async () => {
    const ctx = ctxFor({}, [])
    const links = await provide(fakeTerm(fakeBuffer(['see src/gone.ts'])), ctx, 1)
    expect(links).toBeUndefined()
  })

  it('spans a link across a wrap', async () => {
    const ctx = ctxFor({}, [{ text: 'src/a.ts', path: '/repo/src/a.ts', isDir: false }])
    const links = await provide(fakeTerm(fakeBuffer(['src/', 'a.ts'], [1])), ctx, 2)
    expect(links?.[0].range).toEqual({ start: { x: 1, y: 1 }, end: { x: 4, y: 2 } })
  })

  it('reveals on option+click', async () => {
    const ctx = ctxFor({}, [{ text: 'src/a.ts', path: '/repo/src/a.ts', isDir: false }])
    const links = await provide(fakeTerm(fakeBuffer(['src/a.ts'])), ctx, 1)
    links?.[0].activate({ altKey: true } as MouseEvent, 'src/a.ts')
    expect(ctx.onReveal).toHaveBeenCalledWith('/repo/src/a.ts', false)
  })

  it('reveals on ctrl+click, exactly like option+click', async () => {
    const ctx = ctxFor({}, [{ text: 'src/a.ts', path: '/repo/src/a.ts', isDir: false }])
    const links = await provide(fakeTerm(fakeBuffer(['src/a.ts'])), ctx, 1)
    links?.[0].activate({ altKey: false, ctrlKey: true } as MouseEvent, 'src/a.ts')
    expect(ctx.onReveal).toHaveBeenCalledWith('/repo/src/a.ts', false)
  })

  it('reveals a directory on ctrl+click (the caller expands it)', async () => {
    const ctx = ctxFor({}, [{ text: 'src/main', path: '/repo/src/main', isDir: true }])
    const links = await provide(fakeTerm(fakeBuffer(['src/main'])), ctx, 1)
    links?.[0].activate({ altKey: false, ctrlKey: true } as MouseEvent, 'src/main')
    expect(ctx.onReveal).toHaveBeenCalledWith('/repo/src/main', true)
  })

  it('links the motivating .harnu/out line in prose with trailing punctuation', async () => {
    const line = 'Abri o roteiro: .harnu/out/T389-roteiro-operador.md, fora do git.'
    const ctx = ctxFor({}, [
      {
        text: '.harnu/out/T389-roteiro-operador.md',
        path: '/repo/.harnu/out/T389-roteiro-operador.md',
        isDir: false
      }
    ])
    const links = await provide(fakeTerm(fakeBuffer([line])), ctx, 1)
    expect(ctx.resolve).toHaveBeenCalledWith('/repo', '/repo', [
      '.harnu/out/T389-roteiro-operador.md'
    ])
    expect(links).toHaveLength(1)
    // The comma is shaved off the underline.
    expect(links?.[0].text).toBe('.harnu/out/T389-roteiro-operador.md')
    links?.[0].activate({ ctrlKey: true } as MouseEvent, links[0].text)
    expect(ctx.onReveal).toHaveBeenCalledWith('/repo/.harnu/out/T389-roteiro-operador.md', false)
  })

  it('does nothing on a plain click', async () => {
    const ctx = ctxFor({}, [{ text: 'src/a.ts', path: '/repo/src/a.ts', isDir: false }])
    const links = await provide(fakeTerm(fakeBuffer(['src/a.ts'])), ctx, 1)
    links?.[0].activate({ altKey: false } as MouseEvent, 'src/a.ts')
    expect(ctx.onReveal).not.toHaveBeenCalled()
  })

  it('does nothing on a shift/meta-only click', async () => {
    const ctx = ctxFor({}, [{ text: 'src/a.ts', path: '/repo/src/a.ts', isDir: false }])
    const links = await provide(fakeTerm(fakeBuffer(['src/a.ts'])), ctx, 1)
    links?.[0].activate({ shiftKey: true, metaKey: true } as MouseEvent, 'src/a.ts')
    expect(ctx.onReveal).not.toHaveBeenCalled()
  })

  it('drops a stale reply once a newer provideLinks call has superseded it, WITHOUT invoking its callback', async () => {
    // Pins the guard against the race the Alt tracker's resync can create: it
    // issues a decoy `provideLinks` call (a different, uninteresting row)
    // purely to force xterm's internal state to change, immediately followed
    // by the real call for the pointer's actual row. If the decoy's async
    // resolve settles AFTER the real call's, it must not answer at all — xterm
    // keys its reply cache by provider index, not by row, so a late decoy
    // reply would clobber the real row's correct one.
    //
    // The stale callback must never be called at all — not even with
    // `undefined`. xterm writes whatever a callback is given into its OWN
    // current reply map, so `callback(undefined)` would null out the real,
    // already-landed reply: a later hover onto a second path on the same row
    // would take xterm's cached-reply branch, find nothing, and produce no
    // link until the pointer leaves the row and re-enters. xterm has no
    // timeout on an unanswered ask, so silence is the safe, correct response.
    const term = fakeTerm(fakeBuffer(['src/a.ts', 'src/b.ts']))
    let resolveDecoy: (() => void) | undefined
    const ctx = ctxFor({
      resolve: vi.fn((_root: string, _cwd: string, candidates: string[]) => {
        if (candidates[0] === 'src/a.ts') {
          // The decoy call (row 1) never resolves on its own — capture the
          // resolver so the test can settle it AFTER the real call below.
          return new Promise<Array<{ text: string; path: string; isDir: boolean }>>((res) => {
            resolveDecoy = () => res([{ text: 'src/a.ts', path: '/repo/src/a.ts', isDir: false }])
          })
        }
        return Promise.resolve([{ text: 'src/b.ts', path: '/repo/src/b.ts', isDir: false }])
      })
    })
    const provider = createFileLinkProvider(term, ctx)

    const decoyCallback = vi.fn()
    provider.provideLinks(1, decoyCallback)
    // The real call, issued right after — resolves normally.
    const realResult = await new Promise((res) => provider.provideLinks(2, res))
    expect(realResult).toHaveLength(1)

    // Now let the superseded decoy call settle.
    expect(resolveDecoy).toBeDefined()
    resolveDecoy?.()
    await Promise.resolve()
    await Promise.resolve()
    expect(decoyCallback).not.toHaveBeenCalled()
  })

  it('resolves each distinct token once per line', async () => {
    const ctx = ctxFor({}, [{ text: 'src/a.ts', path: '/repo/src/a.ts', isDir: false }])
    const term = fakeTerm(fakeBuffer(['src/a.ts and src/a.ts']))
    const provider = createFileLinkProvider(term, ctx)
    await new Promise((res) => provider.provideLinks(1, res))
    expect(ctx.resolve).toHaveBeenCalledWith('/repo', '/repo', ['src/a.ts'])
  })

  it('caches a line, so re-hovering costs no IPC', async () => {
    const ctx = ctxFor({}, [{ text: 'src/a.ts', path: '/repo/src/a.ts', isDir: false }])
    const term = fakeTerm(fakeBuffer(['src/a.ts']))
    const provider = createFileLinkProvider(term, ctx)
    await new Promise((res) => provider.provideLinks(1, res))
    await new Promise((res) => provider.provideLinks(1, res))
    expect(ctx.resolve).toHaveBeenCalledTimes(1)
  })

  it('expires a cached reply after its TTL, so a path created moments after it was printed still resolves', async () => {
    // A negative reply (the file didn't exist yet when this line was first
    // hovered) must not be cached forever — Claude routinely prints a path
    // before creating it.
    const ctx = ctxFor({}, [])
    const term = fakeTerm(fakeBuffer(['src/a.ts']))
    const provider = createFileLinkProvider(term, ctx)
    const now = vi.spyOn(Date, 'now')
    try {
      now.mockReturnValue(0)
      await new Promise((res) => provider.provideLinks(1, res))
      expect(ctx.resolve).toHaveBeenCalledTimes(1)

      now.mockReturnValue(500) // well within the TTL — still cached
      await new Promise((res) => provider.provideLinks(1, res))
      expect(ctx.resolve).toHaveBeenCalledTimes(1)

      now.mockReturnValue(10_000) // past the TTL — re-resolves
      await new Promise((res) => provider.provideLinks(1, res))
      expect(ctx.resolve).toHaveBeenCalledTimes(2)
    } finally {
      now.mockRestore()
    }
  })

  it('provides nothing when there is no root yet', async () => {
    const ctx = ctxFor({ root: () => '' })
    expect(await provide(fakeTerm(fakeBuffer(['src/a.ts'])), ctx, 1)).toBeUndefined()
  })
})
