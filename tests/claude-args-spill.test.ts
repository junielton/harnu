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

  it('measures bytes, not JS string length', async () => {
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

  // BUG-298: the doc has no size cliff. It rides a prompt file whatever its length, so growing it past 121 KB
  // (the point where the guided-walk smoke test first stalled) or well past the 128 KiB argv cap changes nothing
  // about what the spawn puts in argv: one option pair, the file path.
  it.each([121_374, 200 * 1024, 1024 * 1024])(
    'a %d-byte doc is delivered whole through one prompt file and never through argv',
    async (bytes) => {
      const doc = '<!-- harnu-features v1 -->\n' + 'x'.repeat(bytes)
      const argv = buildClaudeArgs([], { appendSystemPrompt: 'user append' }, doc)
      const written: string[] = []
      const out = await spillOversizedPromptArgs(argv, (_flag, text) => {
        written.push(text)
        return '/tmp/p.md'
      })
      expect(written).toHaveLength(1)
      expect(written[0]).toContain(doc)
      expect(written[0]).toContain('user append')
      expect(out).toContain('--append-system-prompt-file')
      expect(out).not.toContain('--append-system-prompt')
      expect(out.join('').length).toBeLessThan(1024)
    }
  )
})
