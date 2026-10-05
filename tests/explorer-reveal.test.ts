import { describe, it, expect } from 'vitest'
import { ancestorChain } from '../src/renderer/src/lib/explorer-reveal'

/**
 * The Explorer tree is lazy: a row only exists once its parent has been
 * listed and expanded. Revealing a path therefore means walking the chain of
 * directories between the root and the target, shallowest first. The target
 * itself is excluded — the pane expands a directory target separately, and
 * a file target is never expanded at all.
 */

describe('ancestorChain', () => {
  it('lists the directories between root and a nested file', () => {
    expect(ancestorChain('/repo', '/repo/src/main/pty.ts')).toEqual(['/repo/src', '/repo/src/main'])
  })

  it('excludes the target directory itself', () => {
    expect(ancestorChain('/repo', '/repo/src/main')).toEqual(['/repo/src'])
  })

  it('returns an empty chain for a top-level entry', () => {
    expect(ancestorChain('/repo', '/repo/README.md')).toEqual([])
  })

  it('tolerates a trailing separator on the root', () => {
    expect(ancestorChain('/repo/', '/repo/src/a.ts')).toEqual(['/repo/src'])
  })

  it('rejects a target outside the root', () => {
    expect(ancestorChain('/repo', '/elsewhere/a.ts')).toBeNull()
    expect(ancestorChain('/repo', '/repository/a.ts')).toBeNull()
  })

  it('rejects the root itself', () => {
    expect(ancestorChain('/repo', '/repo')).toBeNull()
  })

  it('handles Windows separators', () => {
    expect(ancestorChain('C:\\repo', 'C:\\repo\\src\\main\\pty.ts')).toEqual([
      'C:\\repo\\src',
      'C:\\repo\\src\\main'
    ])
  })
})
