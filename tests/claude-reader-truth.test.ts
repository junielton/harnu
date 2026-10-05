import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { scanFolders, __resetHeaderCacheForTests } from '../src/main/claude-reader'

/**
 * T91 reader integration — proves the transcript-truth fields land on a
 * `SessionEntry` when `scanFolders` takes the JSONL fallback path (no
 * `sessions-index.json`). Fixtures are real-shaped JSONL written to a temp
 * `~/.claude/projects`-like root, including the metadata tail the CLI re-appends
 * at EOF (which must be filtered out of every derivation).
 */

let root: string
beforeEach(async () => {
  root = await fs.mkdtemp(join(tmpdir(), 'harnu-reader-truth-'))
  __resetHeaderCacheForTests()
})
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

const CWD = '/home/dev/project'

/** Write a slug dir with one JSONL transcript (no index → JSONL fallback path). */
async function writeTranscript(slug: string, sessionId: string, objs: object[]): Promise<void> {
  const dir = join(root, slug)
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(
    join(dir, `${sessionId}.jsonl`),
    objs.map((o) => JSON.stringify(o)).join('\n') + '\n',
    'utf8'
  )
}

let uid = 0
const uuid = (): string => `u-${++uid}`
const envelope = (sid: string): object => ({
  uuid: uuid(),
  isSidechain: false,
  sessionId: sid,
  cwd: CWD,
  gitBranch: 'main',
  entrypoint: 'cli'
})

const user = (sid: string, text: string): object => ({
  ...envelope(sid),
  type: 'user',
  message: { role: 'user', content: text }
})
const assistantToolUse = (sid: string, name: string): object => ({
  ...envelope(sid),
  type: 'assistant',
  message: {
    role: 'assistant',
    model: 'claude-opus-4-8',
    stop_reason: 'tool_use',
    content: [{ type: 'tool_use', id: 't1', name, input: {} }],
    usage: {
      input_tokens: 10000,
      cache_creation_input_tokens: 20000,
      cache_read_input_tokens: 30000,
      output_tokens: 5
    }
  }
})
const assistantEnd = (sid: string, text: string): object => ({
  ...envelope(sid),
  type: 'assistant',
  message: {
    role: 'assistant',
    model: 'claude-opus-4-8',
    stop_reason: 'end_turn',
    content: [{ type: 'text', text }],
    usage: {
      input_tokens: 10000,
      cache_creation_input_tokens: 20000,
      cache_read_input_tokens: 30000,
      output_tokens: 5
    }
  }
})
const sys = (sid: string, subtype: string, extra: object = {}): object => ({
  ...envelope(sid),
  type: 'system',
  subtype,
  ...extra
})
// Metadata block re-appended at EOF — none carry a `uuid`, so all must be filtered.
const metaTail = (sid: string): object[] => [
  { type: 'last-prompt', lastPrompt: 'keep going please', leafUuid: 'l1', sessionId: sid },
  { type: 'custom-title', customTitle: 'Renamed by user', sessionId: sid },
  { type: 'mode', mode: 'normal', sessionId: sid },
  { type: 'permission-mode', permissionMode: 'auto', sessionId: sid }
]

async function onlySession(): Promise<import('../src/main/claude-reader').SessionEntry> {
  const folders = await scanFolders({ rootDir: root })
  const all = folders.flatMap((f) => f.sessions)
  expect(all.length).toBe(1)
  return all[0]
}

describe('scanFolders — transcript truth (JSONL path)', () => {
  it('derives idle from an end_turn tail past the metadata re-append', async () => {
    const sid = 'a1'
    await writeTranscript('proj', sid, [
      user(sid, 'do the work'),
      assistantEnd(sid, 'all done'),
      sys(sid, 'stop_hook_summary', { hookCount: 1, preventedContinuation: false }),
      sys(sid, 'turn_duration', { durationMs: 1000, messageCount: 3, isMeta: false }),
      ...metaTail(sid)
    ])
    const s = await onlySession()
    expect(s.transcriptState).toBe('idle')
    // Tail-latest custom-title wins the summary cascade (never a firstPrompt guess).
    expect(s.summary).toBe('Renamed by user')
    // ctx% = (10000+20000+30000)/200000 = 30%
    expect(s.ctxPct).toBe(30)
  })

  it('derives needs-input from a trailing AskUserQuestion (polluted tail)', async () => {
    const sid = 'a2'
    await writeTranscript('proj', sid, [
      user(sid, 'which database?'),
      assistantToolUse(sid, 'AskUserQuestion'),
      ...metaTail(sid)
    ])
    const s = await onlySession()
    expect(s.transcriptState).toBe('needs-input')
  })

  it('derives working from a trailing normal tool_use', async () => {
    const sid = 'a3'
    await writeTranscript('proj', sid, [user(sid, 'run tests'), assistantToolUse(sid, 'Bash')])
    const s = await onlySession()
    expect(s.transcriptState).toBe('working')
  })

  it('surfaces away_summary verbatim and whatsHappening from last-prompt', async () => {
    const sid = 'a4'
    const away = 'Goal: land T91. Next: run the gates and commit.'
    await writeTranscript('proj', sid, [
      user(sid, 'implement T91'),
      assistantEnd(sid, 'progress'),
      sys(sid, 'away_summary', { content: away, isMeta: false }),
      ...metaTail(sid)
    ])
    const s = await onlySession()
    expect(s.awaySummary).toBe(away)
    // task-summary absent → last-prompt wins "what's happening now".
    expect(s.whatsHappening).toBe('keep going please')
  })

  it('resets ctx% baseline from a trailing compact_boundary postTokens', async () => {
    const sid = 'a5'
    await writeTranscript('proj', sid, [
      user(sid, 'big session'),
      assistantEnd(sid, 'lots of context'),
      sys(sid, 'compact_boundary', {
        content: 'Conversation compacted',
        compactMetadata: { trigger: 'manual', preTokens: 850000, postTokens: 40000 }
      }),
      ...metaTail(sid)
    ])
    const s = await onlySession()
    // 40000 / 200000 = 20% (not the pre-compaction 30%)
    expect(s.ctxPct).toBe(20)
    // Last chain entry is the compact_boundary itself — not a turn-over marker,
    // so the state is 'unknown' and the classifier falls back to its quiet-timer.
    expect(s.transcriptState).toBe('unknown')
  })

  it('tolerates content-replacement / marble-origami-* noise in the tail', async () => {
    const sid = 'a6'
    await writeTranscript('proj', sid, [
      user(sid, 'go'),
      { ...envelope(sid), type: 'content-replacement', uuids: ['x', 'y', 'z'] },
      assistantEnd(sid, 'done'),
      { ...envelope(sid), type: 'marble-origami-snapshot', uuids: ['a', 'b'] },
      sys(sid, 'turn_duration', { durationMs: 1, messageCount: 2 }),
      ...metaTail(sid)
    ])
    const s = await onlySession()
    expect(s.transcriptState).toBe('idle')
    expect(s.ctxPct).toBe(30)
  })
})
