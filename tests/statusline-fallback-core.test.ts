import { describe, expect, it } from 'vitest'
import { deriveTranscriptFallback, parseJsonlTail } from '../src/main/statusline-fallback-core'

const assistant = (
  over: Record<string, unknown> = {},
  usage: Record<string, unknown> | null = null
) => ({
  type: 'assistant',
  uuid: 'u-' + Math.random(),
  timestamp: '2026-10-19T11:49:00.000Z',
  message: {
    model: 'claude-opus-4-8',
    stop_reason: 'end_turn',
    usage: usage ?? {
      input_tokens: 10,
      cache_creation_input_tokens: 40_000,
      cache_read_input_tokens: 60_000
    },
    content: []
  },
  ...over
})

describe('deriveTranscriptFallback (AC-1 transcript source)', () => {
  it('reads the model, the context % and the time from the last assistant turn', () => {
    const out = deriveTranscriptFallback([
      { type: 'user', uuid: 'a', message: { content: 'hi' } },
      assistant()
    ])
    expect(out).toEqual({
      modelId: 'claude-opus-4-8',
      contextPercent: 50,
      atMs: Date.parse('2026-10-19T11:49:00.000Z')
    })
  })

  it('uses the LAST assistant turn, not the first', () => {
    const out = deriveTranscriptFallback([
      assistant({ timestamp: '2026-10-19T09:00:00.000Z' }),
      assistant({
        timestamp: '2026-10-19T10:00:00.000Z',
        message: {
          model: 'claude-sonnet-5-5',
          usage: { input_tokens: 20_000 }
        }
      })
    ])
    expect(out?.modelId).toBe('claude-sonnet-5-5')
    expect(out?.contextPercent).toBe(10)
    expect(out?.atMs).toBe(Date.parse('2026-10-19T10:00:00.000Z'))
  })

  it('skips the synthetic placeholder model the CLI writes for local turns', () => {
    const out = deriveTranscriptFallback([
      assistant(),
      assistant({ message: { model: '<synthetic>', content: [] } })
    ])
    expect(out?.modelId).toBe('claude-opus-4-8')
  })

  it('returns null when the transcript has no assistant turn', () => {
    expect(deriveTranscriptFallback([{ type: 'user', uuid: 'a' }])).toBeNull()
    expect(deriveTranscriptFallback([])).toBeNull()
  })

  it('has a null time when the turn carries no timestamp (the shell substitutes the file mtime)', () => {
    const out = deriveTranscriptFallback([assistant({ timestamp: undefined })])
    expect(out?.atMs).toBeNull()
  })

  it('tolerates junk entries', () => {
    expect(
      deriveTranscriptFallback([null, 'x', 3, { type: 'assistant' }] as unknown as never[])
    ).toBeNull()
  })
})

describe('parseJsonlTail', () => {
  it('drops a partial first line when the read started mid-file', () => {
    const text = '{"type":"user","uuid":"x"}\n{"type":"assistant"}\n'
    const cut = text.slice(5)
    expect(parseJsonlTail(cut, true)).toEqual([{ type: 'assistant' }])
    expect(parseJsonlTail(text, false)).toHaveLength(2)
  })

  it('skips unparseable lines', () => {
    expect(parseJsonlTail('{"a":1}\nnot json\n{"b":2}\n', false)).toEqual([{ a: 1 }, { b: 2 }])
  })
})

describe('readTranscriptFallback (shell)', () => {
  it('only reads <sessionId>.jsonl inside the projects root', async () => {
    const { isReadableTranscriptPath } = await import('../src/main/statusline-fallback')
    const root = '/home/u/.claude/projects'
    const sid = '11111111-1111-4111-8111-111111111111'
    expect(isReadableTranscriptPath(sid, `${root}/-home-u-x/${sid}.jsonl`, root)).toBe(true)
    expect(isReadableTranscriptPath(sid, `${root}/-home-u-x/other.jsonl`, root)).toBe(false)
    expect(isReadableTranscriptPath(sid, `/etc/${sid}.jsonl`, root)).toBe(false)
    expect(isReadableTranscriptPath(sid, `${root}/../../etc/${sid}.jsonl`, root)).toBe(false)
    expect(isReadableTranscriptPath(sid, `relative/${sid}.jsonl`, root)).toBe(false)
  })

  it('reads the tail of a real file and substitutes the mtime for a missing timestamp', async () => {
    const { mkdtempSync, mkdirSync, writeFileSync, rmSync, statSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const { readTranscriptFallback } = await import('../src/main/statusline-fallback')
    const root = mkdtempSync(join(tmpdir(), 'harnu-fb-'))
    try {
      const sid = '22222222-2222-4222-8222-222222222222'
      mkdirSync(join(root, 'proj'))
      const file = join(root, 'proj', `${sid}.jsonl`)
      writeFileSync(
        file,
        JSON.stringify({
          type: 'assistant',
          uuid: 'a',
          message: { model: 'claude-opus-4-8', usage: { input_tokens: 40_000 } }
        }) + '\n'
      )
      const out = await readTranscriptFallback(sid, file, root)
      expect(out).toEqual({
        modelId: 'claude-opus-4-8',
        contextPercent: 20,
        atMs: statSync(file).mtimeMs
      })
      expect(await readTranscriptFallback(sid, join(root, 'proj', 'nope.jsonl'), root)).toBeNull()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
