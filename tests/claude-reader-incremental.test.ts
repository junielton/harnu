// tests/claude-reader-incremental.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  scanFolders,
  __resetHeaderCacheForTests,
  __jsonlBytesReadForTests,
  __fileOpensForTests,
  __resetSubagentHeaderCacheForTests,
  __scrapeHeaderWithStatForTests
} from '../src/main/claude-reader'

const SID = 'bbbb0000-0000-4000-8000-000000000001'
const CWD = '/w/Inc'
const line = (o: object): string =>
  JSON.stringify({ sessionId: SID, cwd: CWD, entrypoint: 'cli', ...o })
const userL = (t: string): string =>
  line({ type: 'user', isSidechain: false, message: { role: 'user', content: t }, uuid: 'u' + t })
const asstL = (t: string, stop = 'end_turn'): string =>
  line({
    type: 'assistant',
    isSidechain: false,
    uuid: 'a' + t,
    message: {
      role: 'assistant',
      model: 'm',
      stop_reason: stop,
      content: [{ type: 'text', text: t }],
      usage: { input_tokens: 1000, cache_read_input_tokens: 2000 }
    }
  })

async function scanOne(root: string) {
  const f = await scanFolders({ rootDir: root, slugsFilter: ['-w-Inc'] })
  return f[0].sessions[0]
}

describe('claude-reader — incremental header (AC-16)', () => {
  let root: string
  let file: string
  beforeEach(async () => {
    __resetHeaderCacheForTests()
    root = await fs.mkdtemp(join(tmpdir(), 'harnu-inc-'))
    await fs.mkdir(join(root, '-w-Inc'), { recursive: true })
    file = join(root, '-w-Inc', `${SID}.jsonl`)
    await fs.writeFile(file, [userL('first prompt'), asstL('r1')].join('\n') + '\n')
  })
  afterEach(async () => fs.rm(root, { recursive: true, force: true }))

  it('an append reads only the appended bytes and matches a fresh scrape', async () => {
    await scanOne(root)
    const before = __jsonlBytesReadForTests()
    const extra =
      [
        line({ type: 'custom-title', customTitle: 'renamed' }),
        userL('second'),
        asstL('r2', 'tool_use')
      ].join('\n') + '\n'
    await fs.appendFile(file, extra)
    const incremental = await scanOne(root)
    expect(__jsonlBytesReadForTests() - before).toBeLessThanOrEqual(Buffer.byteLength(extra) + 1)
    __resetHeaderCacheForTests()
    const fresh = await scanOne(root)
    expect(incremental).toEqual(fresh)
  })

  it('a scrape that waited behind a newer one keeps the newer fold instead of regressing to its stale stat', async () => {
    await scanOne(root)
    // Stat taken before another scan advanced the fold, as a scrape queued behind
    // it (per-path serialization) would hold.
    const stale = await fs.stat(file)
    await new Promise((r) => setTimeout(r, 20))
    await fs.appendFile(file, [userL('newer'), asstL('r2')].join('\n') + '\n')
    const newer = await scanOne(root)
    const opens = __fileOpensForTests()
    const header = await __scrapeHeaderWithStatForTests(file, stale)
    expect(__fileOpensForTests() - opens).toBe(0)
    expect(header?.userMessageCount).toBe(2)
    // The cache still describes the newer file: the next pass is a pure hit.
    const bytes = __jsonlBytesReadForTests()
    expect(await scanOne(root)).toEqual(newer)
    expect(__jsonlBytesReadForTests() - bytes).toBe(0)
  })

  it('a /compact rewrite (inode change) falls back to a full scrape that matches a fresh one', async () => {
    await scanOne(root)
    await fs.rm(file)
    await fs.writeFile(file, [userL('compacted'), asstL('r9')].join('\n') + '\n')
    const after = await scanOne(root)
    __resetHeaderCacheForTests()
    expect(after).toEqual(await scanOne(root))
  })

  it('past the 2 MB cap, head fields stay frozen at the cap and tail truth matches a fresh scrape', async () => {
    const big =
      Array.from({ length: 2600 }, (_, i) => asstL('pad' + i + 'x'.repeat(800))).join('\n') + '\n'
    await fs.appendFile(file, big)
    await scanOne(root)
    const before = __jsonlBytesReadForTests()
    const late = [userL('late user'), asstL('late', 'end_turn')].join('\n') + '\n'
    await fs.appendFile(file, late)
    const incremental = await scanOne(root)
    expect(__jsonlBytesReadForTests() - before).toBeLessThanOrEqual(Buffer.byteLength(late) + 1)
    __resetHeaderCacheForTests()
    const fresh = await scanOne(root)
    // Head fields freeze at the cap in both: 'late user' is past it.
    expect(incremental.messageCount).toBe(1)
    expect(incremental).toEqual(fresh)
    expect(incremental.messageCount).toBe(fresh.messageCount)
    expect(incremental.firstPrompt).toBe(fresh.firstPrompt)
    expect(incremental.transcriptState).toBe(fresh.transcriptState)
    expect(incremental.ctxPct).toBe(fresh.ctxPct)
    expect(incremental.summary).toBe(fresh.summary)
  })

  it('an append that crosses the 2 MB cap matches a fresh scrape and reads only appended bytes', async () => {
    await scanOne(root)
    const before = __jsonlBytesReadForTests()
    const big =
      Array.from({ length: 2600 }, (_, i) =>
        i === 300 ? userL('mid user') : asstL('pad' + i + 'y'.repeat(800), 'tool_use')
      ).join('\n') + '\n'
    await fs.appendFile(file, big)
    const incremental = await scanOne(root)
    expect(__jsonlBytesReadForTests() - before).toBeLessThanOrEqual(Buffer.byteLength(big) + 1)
    __resetHeaderCacheForTests()
    const fresh = await scanOne(root)
    expect(incremental).toEqual(fresh)
    expect(incremental.messageCount).toBe(2)
  })

  it('a capped transcript followed by a > 512 KB append matches a fresh scrape', async () => {
    const big =
      Array.from({ length: 2600 }, (_, i) => asstL('pad' + i + 'x'.repeat(800))).join('\n') + '\n'
    await fs.appendFile(file, big)
    await scanOne(root)
    const before = __jsonlBytesReadForTests()
    const huge =
      Array.from({ length: 900 }, (_, i) => asstL('more' + i + 'z'.repeat(800), 'tool_use')).join(
        '\n'
      ) + '\n'
    await fs.appendFile(file, huge)
    const incremental = await scanOne(root)
    expect(__jsonlBytesReadForTests() - before).toBeLessThanOrEqual(Buffer.byteLength(huge) + 1)
    __resetHeaderCacheForTests()
    expect(incremental).toEqual(await scanOne(root))
  })

  it('crossing the cap with a short tail re-reads the window the count-capped ring lost', async () => {
    // ~300-byte tool-call lines: 512 KB holds ~1700 of them, far more than the
    // 800-entry ring kept below the cap, so the fold must fall back to a window read.
    const tool = (i: number): string =>
      line({
        type: 'assistant',
        isSidechain: false,
        timestamp: '2026-10-02T10:00:00.000Z',
        uuid: 't' + i,
        message: {
          role: 'assistant',
          model: 'm',
          stop_reason: 'tool_use',
          content: [{ type: 'tool_use', id: 'tu' + i, name: 'Read', input: { file_path: '/x' } }]
        }
      })
    const chunk = (from: number, to: number): string =>
      Array.from({ length: to - from }, (_, k) => tool(from + k)).join('\n') + '\n'
    const perLine = Buffer.byteLength(tool(0)) + 1
    const belowCap = Math.floor((1.9 * 1024 * 1024) / perLine)
    await fs.appendFile(file, chunk(0, belowCap))
    await scanOne(root)
    const tail = chunk(belowCap, belowCap + Math.floor((300 * 1024) / perLine))
    await fs.appendFile(file, tail)
    const incremental = await scanOne(root)
    __resetHeaderCacheForTests()
    const fresh = await scanOne(root)
    expect(incremental).toEqual(fresh)
    // Independent oracle (both scrapes share the fold): the pre-C2 tail read —
    // the last 512 KB, first partial line dropped — holds exactly these calls.
    const all = await fs.readFile(file)
    const windowLines = all
      .subarray(all.length - 512 * 1024)
      .toString('utf8')
      .split('\n')
      .slice(1)
      .filter((l) => l.includes('"tool_use"'))
    expect(windowLines.length).toBeGreaterThan(800)
    expect(incremental.stagnation?.calls).toBe(windowLines.length)
  })

  it('AC-18: one appended line in a 300-transcript / 400-subagent slug opens ≤ 3 files and reads ≤ 64 KB', async () => {
    __resetSubagentHeaderCacheForTests()
    const slug = join(root, '-w-Inc')
    for (let i = 0; i < 300; i++) {
      const id = `cccc0000-0000-4000-8000-${String(i).padStart(12, '0')}`
      await fs.writeFile(
        join(slug, `${id}.jsonl`),
        JSON.stringify({
          type: 'user',
          sessionId: id,
          cwd: CWD,
          entrypoint: 'cli',
          message: { role: 'user', content: 'p' + i }
        }) + '\n'
      )
    }
    for (let p = 0; p < 40; p++) {
      const d = join(slug, `cccc0000-0000-4000-8000-${String(p).padStart(12, '0')}`, 'subagents')
      await fs.mkdir(d, { recursive: true })
      for (let a = 0; a < 10; a++)
        await fs.writeFile(
          join(d, `agent-x${p}y${a}.jsonl`),
          JSON.stringify({
            type: 'user',
            agentId: `x${p}y${a}`,
            attributionAgent: 'g',
            message: { role: 'user', content: 't' }
          }) + '\n'
        )
    }
    await scanOne(root)
    const opens = __fileOpensForTests()
    const bytes = __jsonlBytesReadForTests()
    await fs.appendFile(file, asstL('one more') + '\n')
    await scanFolders({ rootDir: root, slugsFilter: ['-w-Inc'] })
    expect(__fileOpensForTests() - opens).toBeLessThanOrEqual(3)
    expect(__jsonlBytesReadForTests() - bytes).toBeLessThanOrEqual(64 * 1024)
  })

  it('Review focus 2: a line and a multibyte char split across two appends fold correctly', async () => {
    await scanOne(root)
    const l = line({ type: 'custom-title', customTitle: 'café ☕ title' })
    const bytes = Buffer.from(l + '\n', 'utf8')
    const cut = bytes.indexOf(Buffer.from('☕', 'utf8')) + 1 // split inside the 3-byte char
    await fs.appendFile(file, bytes.subarray(0, cut))
    await scanOne(root)
    await fs.appendFile(file, bytes.subarray(cut))
    const incremental = await scanOne(root)
    __resetHeaderCacheForTests()
    expect(incremental).toEqual(await scanOne(root))
    expect(incremental.summary).toBe('café ☕ title')
  })

  it('AC-18: one line appended to the most recently active transcript reads only that line', async () => {
    const slug = join(root, '-w-Inc')
    let newest = ''
    for (let i = 0; i < 300; i++) {
      const id = `dddd0000-0000-4000-8000-${String(i).padStart(12, '0')}`
      newest = join(slug, `${id}.jsonl`)
      await fs.writeFile(
        newest,
        JSON.stringify({
          type: 'user',
          sessionId: id,
          cwd: CWD,
          entrypoint: 'cli',
          message: { role: 'user', content: 'p' + i }
        }) + '\n'
      )
    }
    // Make the target unambiguously the newest transcript, as a writing session is.
    const later = new Date(Date.now() + 60_000)
    await fs.utimes(newest, later, later)
    await scanFolders({ rootDir: root, slugsFilter: ['-w-Inc'] })
    const opens = __fileOpensForTests()
    const bytes = __jsonlBytesReadForTests()
    const extra = asstL('one more') + '\n'
    await fs.appendFile(newest, extra)
    await scanFolders({ rootDir: root, slugsFilter: ['-w-Inc'] })
    expect(__fileOpensForTests() - opens).toBe(1)
    expect(__jsonlBytesReadForTests() - bytes).toBe(Buffer.byteLength(extra))
  })

  it('AC-16: past the cap, the raw incremental header equals a fresh one and every head field freezes at MAX_SCAN_BYTES', async () => {
    const CAP = 2 * 1024 * 1024
    const big =
      Array.from({ length: 1400 }, (_, i) =>
        i % 2 === 0 ? userL('pad' + i + 'x'.repeat(800)) : asstL('pad' + i + 'x'.repeat(800))
      ).join('\n') + '\n'
    await fs.appendFile(file, big)
    await __scrapeHeaderWithStatForTests(file, await fs.stat(file))
    const late =
      [
        line({ type: 'custom-title', customTitle: 'late title' }),
        JSON.stringify({
          type: 'user',
          sessionId: 'other',
          cwd: '/elsewhere',
          gitBranch: 'late',
          teamName: 'session-late',
          agentName: 'late',
          entrypoint: 'sdk-py',
          isSidechain: false,
          message: { role: 'user', content: 'late user' }
        }),
        line({ type: 'bridge-session' }),
        asstL('late', 'end_turn')
      ].join('\n') + '\n'
    await fs.appendFile(file, late)
    const incremental = await __scrapeHeaderWithStatForTests(file, await fs.stat(file))
    __resetHeaderCacheForTests()
    const fresh = await __scrapeHeaderWithStatForTests(file, await fs.stat(file))
    expect(incremental).not.toBeNull()
    expect(incremental).toEqual(fresh)
    // Independent oracle: a line feeds the head iff it starts before the cap.
    const all = (await fs.readFile(file, 'utf8')).split('\n')
    let off = 0
    let users = 0
    let turns = 0
    let totalTurns = 0
    for (const raw of all) {
      if (raw) {
        const o = JSON.parse(raw) as { type?: string; isSidechain?: boolean }
        const turn = (o.type === 'user' || o.type === 'assistant') && o.isSidechain !== true
        if (turn) totalTurns++
        if (off < CAP && turn) {
          turns++
          if (o.type === 'user') users++
        }
      }
      off += Buffer.byteLength(raw) + 1
    }
    expect(turns).toBeLessThan(totalTurns)
    expect(incremental?.turnCount).toBe(turns)
    expect(incremental?.userMessageCount).toBe(users)
    // Head-only fields ignore everything past the cap.
    expect(incremental?.sessionId).toBe(SID)
    expect(incremental?.cwd).toBe(CWD)
    expect(incremental?.gitBranch).toBe('')
    expect(incremental?.teamName).toBe('')
    expect(incremental?.agentName).toBe('')
    expect(incremental?.entrypoint).toBe('cli')
    expect(incremental?.bridged).toBe(false)
    expect(incremental?.firstPrompt).toBe('first prompt')
    // Tail truth still sees the late lines (re-appended title wins, as before).
    expect(incremental?.customTitle).toBe('late title')
  })

  it('AC-16: an inode change to a LARGER file (rename-over) re-scrapes and equals a fresh scrape', async () => {
    await scanOne(root)
    const { ino: oldIno, size: oldSize } = await fs.stat(file)
    const tmp = file + '.tmp'
    await fs.writeFile(
      tmp,
      [
        userL('rewritten prompt'),
        asstL('a'),
        userL('two'),
        asstL('b', 'tool_use'),
        line({ type: 'ai-title', aiTitle: 'new ai' })
      ].join('\n') + '\n'
    )
    await fs.rename(tmp, file)
    const st = await fs.stat(file)
    expect(st.ino).not.toBe(oldIno)
    expect(st.size).toBeGreaterThan(oldSize)
    const after = await scanOne(root)
    __resetHeaderCacheForTests()
    const fresh = await scanOne(root)
    expect(after).toEqual(fresh)
    expect(after.firstPrompt).toBe('rewritten prompt')
    expect(after.messageCount).toBe(2)
    expect(after.summary).toBe('new ai')
  })
})
