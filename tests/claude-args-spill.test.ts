import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import {
  PROMPT_ARG_SPILL_BYTES,
  spillOversizedPromptArgs,
  buildClaudeArgs,
  withOptionArgs
} from '../src/main/claude-args'

// Linux MAX_ARG_STRLEN: the per-string argv cap that triggers E2BIG.
const MAX_ARG_STRLEN = 131072

describe('spillOversizedPromptArgs', () => {
  it('leaves small prompt values inline', async () => {
    const opts = ['--model', 'opus', '--append-system-prompt', 'be terse']
    const out = await spillOversizedPromptArgs(opts, () => {
      throw new Error('must not write')
    })
    expect(out).toEqual(opts)
  })

  it('moves an oversized append into --append-system-prompt-file', async () => {
    const big = 'x'.repeat(PROMPT_ARG_SPILL_BYTES)
    const writes: Array<[string, string]> = []
    const out = await spillOversizedPromptArgs(
      ['--append-system-prompt', big, '--verbose'],
      (f, t) => {
        writes.push([f, t])
        return '/tmp/p.md'
      }
    )
    expect(out).toEqual(['--append-system-prompt-file', '/tmp/p.md', '--verbose'])
    expect(writes).toEqual([['--append-system-prompt', big]])
  })

  it('spills --system-prompt too, and never touches the positional tail', async () => {
    const big = 'y'.repeat(PROMPT_ARG_SPILL_BYTES + 1)
    const argv = ['--system-prompt', big, '--', big]
    const out = await withOptionArgs(argv, (o) => spillOversizedPromptArgs(o, () => '/tmp/s.md'))
    expect(out).toEqual(['--system-prompt-file', '/tmp/s.md', '--', big])
  })

  it('measures bytes, not UTF-16 code units', async () => {
    const multibyte = 'é'.repeat(PROMPT_ARG_SPILL_BYTES / 2)
    const out = await spillOversizedPromptArgs(['--append-system-prompt', multibyte], () => '/f')
    expect(out[0]).toBe('--append-system-prompt-file')
  })
})

describe('E2BIG guard', () => {
  it('the self-awareness doc plus a user append never reaches execvp as one oversized arg', async () => {
    const doc = readFileSync(join(__dirname, '..', 'docs', 'harnu-features.md'), 'utf8')
    const argv = buildClaudeArgs([], { appendSystemPrompt: 'user append' }, doc)
    const out = await spillOversizedPromptArgs(argv, () => '/tmp/p.md')
    for (const a of out) expect(Buffer.byteLength(a, 'utf8')).toBeLessThan(MAX_ARG_STRLEN)
  })
})
