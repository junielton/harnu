import { describe, expect, it } from 'vitest'
import {
  buildSegment,
  hasAssistantText,
  hasOperatorEntry,
  isJudgeable,
  renderForJudge,
  splitSegment,
  type SegmentEntry
} from '../../src/main/your-move/segment'

const user = (text: string, extra: Record<string, unknown> = {}) => ({
  type: 'user',
  message: { role: 'user', content: text },
  ...extra
})
const assistant = (content: unknown, extra: Record<string, unknown> = {}) => ({
  type: 'assistant',
  message: { role: 'assistant', content },
  ...extra
})

describe('buildSegment', () => {
  it('a human entry is tagged OPERATOR', () => {
    expect(buildSegment([user('go ahead', { origin: { kind: 'human' } })])).toEqual([
      { tag: 'OPERATOR', from: 'human', text: 'go ahead' }
    ])
  })

  it('origin human starting "[Harnu ·" is AGENT_MESSAGE from human', () => {
    expect(
      buildSegment([user('[Harnu · dispatch] do the thing', { origin: { kind: 'human' } })])
    ).toEqual([{ tag: 'AGENT_MESSAGE', from: 'human', text: '[Harnu · dispatch] do the thing' }])
  })

  it.each(['peer', 'task-notification', 'external'])(
    'origin %s is AGENT_MESSAGE from that kind',
    (kind) => {
      expect(buildSegment([user('hello', { origin: { kind } })])).toEqual([
        { tag: 'AGENT_MESSAGE', from: kind, text: 'hello' }
      ])
    }
  )

  it('missing origin on a non-meta user entry is AGENT_MESSAGE from external', () => {
    expect(buildSegment([user('no origin here')])).toEqual([
      { tag: 'AGENT_MESSAGE', from: 'external', text: 'no origin here' }
    ])
  })

  it('isMeta entries are dropped unless origin kind is peer', () => {
    const out = buildSegment([
      user('meta noise', { isMeta: true }),
      user('meta from peer', { isMeta: true, origin: { kind: 'peer' } })
    ])
    expect(out.map((e) => e.text)).toEqual(['meta from peer'])
  })

  it('tool_result user entries, isCompactSummary and isSidechain entries are dropped', () => {
    const out = buildSegment([
      { type: 'user', message: { content: [{ type: 'tool_result', content: 'big output' }] } },
      user('summary of the past', { isCompactSummary: true }),
      user('inside a subagent', { isSidechain: true, origin: { kind: 'human' } }),
      assistant([{ type: 'text', text: 'subagent text' }], { isSidechain: true })
    ])
    expect(out).toEqual([])
  })

  it('assistant text of 50_000 chars is carried whole', () => {
    const big = 'x'.repeat(50_000)
    const out = buildSegment([assistant([{ type: 'text', text: big }])])
    expect(out).toHaveLength(1)
    expect(out[0].text).toHaveLength(50_000)
  })

  it('tool_use is summarized: name plus JSON input cut at 120 chars, at most 3 per assistant entry', () => {
    const tool = (n: number) => ({
      type: 'tool_use',
      name: `Tool${n}`,
      input: { payload: 'p'.repeat(500) }
    })
    const out = buildSegment([
      assistant([{ type: 'text', text: 'working' }, tool(1), tool(2), tool(3), tool(4)])
    ])
    const tools = out.filter((e) => e.tag === 'TOOL')
    expect(tools).toHaveLength(3)
    expect(tools[0].text.startsWith('Tool1(')).toBe(true)
    expect(tools[0].text).toBe(`Tool1(${JSON.stringify(tool(1).input).slice(0, 120)})`)
    expect(out[0]).toEqual({ tag: 'ASSISTANT', text: 'working' })
  })

  it('keeps entries in transcript order across inbound and assistant turns', () => {
    const out = buildSegment([
      user('first', { origin: { kind: 'human' } }),
      assistant([{ type: 'text', text: 'second' }]),
      user('third', { origin: { kind: 'peer' } })
    ])
    expect(out.map((e) => e.text)).toEqual(['first', 'second', 'third'])
  })

  it('reads text blocks of a user content array and skips thinking blocks', () => {
    const out = buildSegment([
      {
        type: 'user',
        origin: { kind: 'human' },
        message: { content: [{ type: 'text', text: 'hi' }] }
      },
      assistant([
        { type: 'thinking', thinking: 'secret' },
        { type: 'text', text: 'ok' }
      ])
    ])
    expect(out.map((e) => e.text)).toEqual(['hi', 'ok'])
  })
})

describe('renderForJudge', () => {
  it('matches the spike format', () => {
    const entries: SegmentEntry[] = [
      { tag: 'OPERATOR', text: 'x' },
      { tag: 'AGENT_MESSAGE', from: 'peer', text: 'y' }
    ]
    expect(renderForJudge([], entries)).toBe(
      'OPEN_CARDS: []\n\nSEGMENT:\n[OPERATOR] x\n[AGENT_MESSAGE from peer] y'
    )
    expect(renderForJudge([{ id: 'c1', ask: 'Pick' }], [{ tag: 'ASSISTANT', text: 'z' }])).toBe(
      'OPEN_CARDS: [{"id":"c1","ask":"Pick"}]\n\nSEGMENT:\n[ASSISTANT] z'
    )
  })

  it('an AGENT_MESSAGE without a from reads unknown', () => {
    expect(renderForJudge([], [{ tag: 'AGENT_MESSAGE', text: 'q' }])).toContain(
      '[AGENT_MESSAGE from unknown] q'
    )
  })
})

describe('splitSegment', () => {
  it('keeps order and never drops text, cutting an oversized entry into same-tag parts', () => {
    const entries: SegmentEntry[] = [
      { tag: 'OPERATOR', from: 'human', text: 'short' },
      { tag: 'ASSISTANT', text: 'a'.repeat(250) },
      { tag: 'TOOL', text: 'Bash({})' }
    ]
    const parts = splitSegment(entries, 100)
    expect(parts.length).toBeGreaterThan(1)
    const flat = parts.flat()
    expect(
      flat
        .filter((e) => e.tag === 'ASSISTANT')
        .map((e) => e.text)
        .join('')
    ).toBe('a'.repeat(250))
    expect(flat[0]).toEqual(entries[0])
    expect(flat[flat.length - 1]).toEqual(entries[2])
    expect(flat.slice(1, -1).every((e) => e.tag === 'ASSISTANT')).toBe(true)
  })

  it('a segment that fits is a single part', () => {
    const entries: SegmentEntry[] = [{ tag: 'ASSISTANT', text: 'hi' }]
    expect(splitSegment(entries, 1000)).toEqual([entries])
  })

  it('never cuts a surrogate pair in half', () => {
    const text = '😀'.repeat(60)
    const parts = splitSegment([{ tag: 'ASSISTANT', text }], 51)
    expect(
      parts
        .flat()
        .map((e) => e.text)
        .join('')
    ).toBe(text)
    for (const e of parts.flat()) expect(e.text).not.toMatch(/[\ud800-\udbff]$/)
  })
})

describe('predicates', () => {
  it('hasOperatorEntry, isJudgeable and hasAssistantText', () => {
    expect(hasOperatorEntry([{ tag: 'OPERATOR', text: 'a' }])).toBe(true)
    expect(hasOperatorEntry([{ tag: 'AGENT_MESSAGE', text: 'a' }])).toBe(false)
    expect(isJudgeable([{ tag: 'TOOL', text: 'a' }])).toBe(false)
    expect(
      isJudgeable([
        { tag: 'TOOL', text: 'a' },
        { tag: 'AGENT_MESSAGE', text: 'b' }
      ])
    ).toBe(true)
    expect(hasAssistantText([{ tag: 'OPERATOR', text: 'a' }])).toBe(false)
    expect(hasAssistantText([{ tag: 'ASSISTANT', text: 'a' }])).toBe(true)
  })
})
