import { describe, it, expect } from 'vitest'
import {
  buildContextDigest,
  DIGEST_TURN_MAX,
  type DigestTurn
} from '../src/renderer/src/lib/context-digest'

/** T38 slice 1a — pure context-digest formatter. */
const turns: DigestTurn[] = [
  { role: 'user', text: 'refactor the auth module' },
  { role: 'assistant', text: 'Done — split it into auth/{login,session}.ts' }
]

describe('buildContextDigest', () => {
  it('includes summary/folder/branch/messages/firstPrompt/turns', () => {
    const out = buildContextDigest(
      {
        folderAlias: 'harnu',
        branch: 'feat/auth',
        summary: 'Auth refactor',
        firstPrompt: 'refactor the auth module',
        messageCount: 12
      },
      turns
    )
    expect(out).toContain('# Context digest — Auth refactor')
    expect(out).toContain('Folder: harnu')
    expect(out).toContain('Branch: feat/auth')
    expect(out).toContain('Messages: 12')
    expect(out).toContain('First prompt:')
    expect(out).toContain('Recent conversation:')
    expect(out).toContain('User: refactor the auth module')
    expect(out).toContain('Assistant: Done — split it into')
  })

  it('falls back to the folder alias when there is no summary', () => {
    expect(buildContextDigest({ folderAlias: 'harnu' }, [])).toContain('# Context digest — harnu')
  })

  it('omits empty sections (metadata-only session)', () => {
    const out = buildContextDigest({ folderAlias: 'harnu' }, [])
    expect(out).not.toContain('Branch:')
    expect(out).not.toContain('Messages:')
    expect(out).not.toContain('First prompt:')
    expect(out).not.toContain('Recent conversation:')
  })

  it('drops blank turns and clamps a giant turn', () => {
    const big = 'x'.repeat(DIGEST_TURN_MAX + 500)
    const out = buildContextDigest({ folderAlias: 'c' }, [
      { role: 'user', text: '   ' },
      { role: 'assistant', text: big }
    ])
    expect(out).toContain('Recent conversation:')
    expect(out).not.toMatch(/User:/) // the blank user turn is dropped
    expect(out).toContain('…') // clamped
    expect(out.length).toBeLessThan(big.length)
  })

  it('is deterministic', () => {
    const m = { folderAlias: 'c', summary: 's' }
    expect(buildContextDigest(m, turns)).toBe(buildContextDigest(m, turns))
  })
})
