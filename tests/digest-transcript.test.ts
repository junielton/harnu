import { describe, it, expect } from 'vitest'
import {
  emptyFacts,
  gitWindows,
  isUserTurn,
  scanTranscriptLines,
  type TranscriptFacts
} from '../src/main/mcp/digest-transcript'
import {
  atMinute,
  fixtureSession,
  loadMemoryU1Fixture,
  transcriptLines
} from './helpers/memory-u1-fixture'

/**
 * Memory U1 · S-1 — the pure transcript scan (`digest-transcript.ts`): user turns, the
 * asked-and-answered pairs, the open questions of the last assistant message, the git-call
 * windows, and the incremental fold (scan(A) then scan(B) deep-equals scan(A + B)).
 */

const PATHS = { repo: '/r', plain: '/p', gone: '/g' }

const ts = (ms: number): string => new Date(ms).toISOString()
const line = (entry: Record<string, unknown>): string => JSON.stringify(entry)

/** A non-sidechain assistant line with one text block. */
const say = (id: string | undefined, text: string, ms = 1_000): string =>
  line({
    type: 'assistant',
    timestamp: ts(ms),
    message: { ...(id === undefined ? {} : { id }), content: [{ type: 'text', text }] }
  })

/** An AskUserQuestion call and its answered result. */
const askPair = (id: string, answers: unknown, ms = 1_000): string[] => [
  line({
    type: 'assistant',
    timestamp: ts(ms),
    message: { id: `m-${id}`, content: [{ type: 'tool_use', id, name: 'AskUserQuestion' }] }
  }),
  line({
    type: 'user',
    timestamp: ts(ms + 1),
    message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'x' }] },
    toolUseResult: { answers }
  })
]

const cp = (s: string): number => Array.from(s).length

describe('scanTranscriptLines', () => {
  it('extracts pairs, questions and git windows incrementally', () => {
    // a1000003: the two pairs and the two open questions of the example digest.
    const f3 = scanTranscriptLines(transcriptLines(fixtureSession('a1000003'), PATHS).main)
    expect(f3.asked).toEqual([
      { question: 'Which storage should the cache use?', answer: 'file' },
      { question: 'Ship behind a flag?', answer: 'yes, later' }
    ])
    expect(f3.openQuestions).toEqual([
      'Should we also migrate old entries?',
      'Do you want a CHANGELOG entry?'
    ])
    expect(f3.userTurns).toBe(7)
    expect(f3.pending).toEqual([])

    // a1000005: one closed window around minute 65 (its c4 call lives in the subagent file).
    const lines5 = transcriptLines(fixtureSession('a1000005'), PATHS)
    const f5 = scanTranscriptLines(lines5.main)
    const window65 = { startMs: atMinute(65) - 2_000, endMs: atMinute(65, 2) + 5_000 }
    expect(f5.gitCalls).toEqual([window65])
    expect(gitWindows(f5, atMinute(200))).toEqual([window65])
    const sub5 = scanTranscriptLines(lines5.subagent)
    expect(sub5.gitCalls).toEqual([
      { startMs: atMinute(80) - 2_000, endMs: atMinute(80, 2) + 5_000 }
    ])
    expect(sub5.userTurns).toBe(0)

    // Split at any line: two scans deep-equal one, for every fixture transcript.
    for (const s of loadMemoryU1Fixture().sessions) {
      const { main, subagent } = transcriptLines(s, PATHS)
      for (const lines of [main, subagent]) {
        const whole = scanTranscriptLines(lines)
        for (let i = 0; i <= lines.length; i++) {
          const head = scanTranscriptLines(lines.slice(0, i))
          const frozen = JSON.stringify(head)
          expect(scanTranscriptLines(lines.slice(i), head)).toEqual(whole)
          expect(JSON.stringify(head)).toBe(frozen) // the input facts are not mutated
        }
      }
    }

    // Inline lines: the cuts and the limits.
    const long = 'q'.repeat(400) + '?'
    const longAnswer = 'a'.repeat(400)
    const cut = scanTranscriptLines(askPair('t1', { [long]: longAnswer }))
    expect(cp(cut.asked[0].question)).toBe(300)
    expect(cut.asked[0].question.endsWith('…')).toBe(true)
    expect(cut.asked[0].question.startsWith('q'.repeat(299))).toBe(true)
    expect(cp(cut.asked[0].answer)).toBe(300)

    const twelve: string[] = []
    for (let i = 1; i <= 12; i++) twelve.push(...askPair(`t${i}`, { [`Q${i}?`]: `A${i}` }))
    const many = scanTranscriptLines(twelve)
    expect(many.asked).toHaveLength(10)
    expect(many.asked[0]).toEqual({ question: 'Q3?', answer: 'A3' })
    expect(many.asked[9]).toEqual({ question: 'Q12?', answer: 'A12' })

    const seven = Array.from({ length: 7 }, (_, i) => `Question ${i + 1}?`).join(' ')
    expect(scanTranscriptLines([say('m', seven)]).openQuestions).toEqual([
      'Question 3?',
      'Question 4?',
      'Question 5?',
      'Question 6?',
      'Question 7?'
    ])

    const longQuestion = 'w'.repeat(500) + '?'
    const oq = scanTranscriptLines([say('m', longQuestion)]).openQuestions
    expect(oq).toHaveLength(1)
    expect(cp(oq[0])).toBe(300)
    expect(oq[0].endsWith('…')).toBe(true)

    const bigText = '😀'.repeat(2_000)
    const big = scanTranscriptLines([say('m', bigText)])
    expect(cp(big.lastAssistantText)).toBe(1_500)
    expect(big.lastAssistantText).toBe('😀'.repeat(1_499) + '…')
    expect(big.lastAssistantTail).toBe(bigText)
  })

  it('counts only operator text as a user turn', () => {
    for (const s of loadMemoryU1Fixture().sessions) {
      expect(scanTranscriptLines(transcriptLines(s, PATHS).main).userTurns).toBe(s.turns)
    }
    const u = (content: unknown, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
      type: 'user',
      ...extra,
      message: { content }
    })
    expect(isUserTurn(u('hello'))).toBe(true)
    expect(
      isUserTurn(
        u([
          { type: 'text', text: 'a' },
          { type: 'text', text: 'b' }
        ])
      )
    ).toBe(true)
    expect(isUserTurn(u('  '))).toBe(false)
    expect(isUserTurn(u('hello', { isMeta: true }))).toBe(false)
    expect(isUserTurn(u('hello', { isSidechain: true }))).toBe(false)
    expect(isUserTurn(u('hello', { isCompactSummary: true }))).toBe(false)
    expect(isUserTurn(u('<command-name>/clear</command-name>'))).toBe(false)
    expect(isUserTurn(u('  <local-command-stdout>x</local-command-stdout>'))).toBe(false)
    expect(isUserTurn(u('[Request interrupted by user]'))).toBe(false)
    expect(
      isUserTurn(
        u([
          { type: 'text', text: 'note' },
          { type: 'tool_result', tool_use_id: 'x', content: 'ok' }
        ])
      )
    ).toBe(false)
    expect(isUserTurn(u([{ type: 'image', source: {} }]))).toBe(false)
    expect(isUserTurn({ type: 'assistant', message: { content: 'hello' } })).toBe(false)
    expect(isUserTurn({ type: 'user' })).toBe(false)
  })

  it('skips lines that do not parse to an object and tracks first and last timestamps', () => {
    const facts = scanTranscriptLines([
      'not json',
      '[1,2]',
      'null',
      '42',
      line({ type: 'summary' }),
      line({ type: 'user', timestamp: '2026-11-01T10:00:00Z', message: { content: 'hi' } }),
      line({ type: 'x', timestamp: 'garbage' }),
      line({ type: 'x', timestamp: '2026-11-01T11:00:00.500+00:00' })
    ])
    expect(facts.userTurns).toBe(1)
    expect(facts.firstAt).toBe('2026-11-01T10:00:00.000Z')
    expect(facts.lastAt).toBe('2026-11-01T11:00:00.500Z')
    expect(scanTranscriptLines([])).toEqual(emptyFacts())
  })

  it('extends one assistant message across lines and replaces it on a new id', () => {
    let f = scanTranscriptLines([say('m1', 'First part.'), say('m1', 'Is this right?')])
    expect(f.lastAssistantText).toBe('First part.\n\nIs this right?')
    expect(f.lastAssistantId).toBe('m1')
    expect(f.openQuestions).toEqual(['Is this right?'])
    // A tool_use-only line and other kinds of lines change nothing.
    f = scanTranscriptLines(
      [
        line({
          type: 'assistant',
          message: { id: 'm2', content: [{ type: 'tool_use', id: 'x', name: 'Read' }] }
        }),
        line({ type: 'user', message: { content: 'turn' } })
      ],
      f
    )
    expect(f.lastAssistantId).toBe('m1')
    expect(f.lastAssistantText).toBe('First part.\n\nIs this right?')
    // Another id replaces; a line without an id always replaces and clears the id.
    f = scanTranscriptLines([say('m3', 'Fresh.')], f)
    expect(f.lastAssistantText).toBe('Fresh.')
    expect(f.openQuestions).toEqual([])
    f = scanTranscriptLines([say(undefined, 'No id?'), say(undefined, 'Again.')], f)
    expect(f.lastAssistantText).toBe('Again.')
    expect(f.lastAssistantId).toBeNull()
    // A sidechain assistant line never becomes the last message.
    f = scanTranscriptLines(
      [
        line({
          type: 'assistant',
          isSidechain: true,
          message: { id: 'sc', content: [{ type: 'text', text: 'side?' }] }
        })
      ],
      f
    )
    expect(f.lastAssistantText).toBe('Again.')
  })

  it('keeps the head when a long message grows and reads questions from its tail', () => {
    const headText = 'h'.repeat(1_600)
    const f = scanTranscriptLines([say('m', headText), say('m', 'Tail question?')])
    expect(f.lastAssistantText).toBe('h'.repeat(1_499) + '…')
    expect(f.openQuestions).toEqual(['Tail question?'])
    const short = scanTranscriptLines([say('m', 'a'.repeat(1_400)), say('m', 'b'.repeat(200))])
    expect(short.lastAssistantText).toBe('a'.repeat(1_400) + '\n\n' + 'b'.repeat(97) + '…')
    const huge = 'z'.repeat(70_000)
    const tail = scanTranscriptLines([say('m', huge), say('m', 'End?')])
    expect(cp(tail.lastAssistantTail)).toBe(65_536)
    expect(tail.lastAssistantTail.endsWith('\n\nEnd?')).toBe(true)
    expect(tail.openQuestions).toEqual(['End?'])
  })

  it('drops fenced code, inline code, urls and duplicates from open questions', () => {
    const text = [
      'Intro. Should we keep this?',
      '```ts',
      'const a = b ? c : d // why?',
      '```',
      'Use `x?` here. Open https://localhost/a? What now?',
      'Should we keep this?',
      '~~~',
      'unclosed fence, ignored?'
    ].join('\n')
    expect(scanTranscriptLines([say('m', text)]).openQuestions).toEqual([
      'What now?',
      'Should we keep this?'
    ])
    expect(scanTranscriptLines([say('m', 'Really? ? ok')]).openQuestions).toEqual(['Really?'])
  })

  it('pairs asks only with answered results and normalises answers', () => {
    const f = scanTranscriptLines([
      ...askPair('k1', { '  Trim me?  ': '  yes ', 'Empty?': '', 'Null?': null, 'Num?': 3 }),
      ...askPair('k2', ['not', 'an', 'object']),
      ...askPair('k3', null),
      // A result with no pending ask yields nothing.
      line({
        type: 'user',
        message: { content: [{ type: 'tool_result', tool_use_id: 'ghost', content: 'x' }] },
        toolUseResult: { answers: { 'Ghost?': 'boo' } }
      }),
      // A rejected call has no answers.
      line({
        type: 'assistant',
        message: { content: [{ type: 'tool_use', id: 'k4', name: 'AskUserQuestion' }] }
      }),
      line({
        type: 'user',
        message: { content: [{ type: 'tool_result', tool_use_id: 'k4', content: 'rejected' }] }
      }),
      ...askPair('k5', { 'Multi\nline?': 'a\nb' })
    ])
    expect(f.asked).toEqual([
      { question: 'Trim me?', answer: 'yes' },
      { question: 'Num?', answer: '3' },
      { question: 'Multi\nline?', answer: 'a\nb' }
    ])
    expect(f.pending).toEqual([])
  })

  it('opens a git window at the call and closes it at the result', () => {
    const bash = (id: string, command: string, ms?: number, sidechain = false): string =>
      line({
        type: 'assistant',
        ...(sidechain ? { isSidechain: true } : {}),
        ...(ms === undefined ? {} : { timestamp: ts(ms) }),
        message: { content: [{ type: 'tool_use', id, name: 'Bash', input: { command } }] }
      })
    const result = (id: string, ms?: number): string =>
      line({
        type: 'user',
        ...(ms === undefined ? {} : { timestamp: ts(ms) }),
        message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] }
      })
    const open = scanTranscriptLines([
      bash('g1', 'git commit -m x', 10_000),
      bash('g2', 'ls -la', 11_000),
      bash('g3', 'git rebase main', undefined),
      bash('g4', 'git -C repo pull --rebase', 20_000, true)
    ])
    expect(open.pending).toEqual([
      { id: 'g1', kind: 'git', startMs: 10_000 },
      { id: 'g4', kind: 'git', startMs: 20_000 }
    ])
    expect(gitWindows(open, 50_000)).toEqual([
      { startMs: 8_000, endMs: 55_000 },
      { startMs: 18_000, endMs: 55_000 }
    ])
    const closed = scanTranscriptLines([result('g4', 21_000), result('g1')], open)
    expect(closed.pending).toEqual([])
    expect(closed.gitCalls).toEqual([
      { startMs: 18_000, endMs: 26_000 },
      { startMs: 8_000, endMs: 15_000 }
    ])
    expect(gitWindows(closed, 0)).toEqual([
      { startMs: 8_000, endMs: 15_000 },
      { startMs: 18_000, endMs: 26_000 }
    ])
  })

  it('returns a fresh empty value each time', () => {
    const a: TranscriptFacts = emptyFacts()
    a.pending.push({ id: 'x', kind: 'ask', startMs: null })
    expect(emptyFacts().pending).toEqual([])
  })
})
