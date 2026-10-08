import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// The advisor routes as the cheap triage tier (operator decision 2026-10-08, T444 delta 1):
// kind `scout`, Haiku at low effort by default, and the folder's own routing table still wins.

vi.mock('electron', () => ({
  app: { getPath: (): string => '' },
  ipcMain: { handle: (): void => {} }
}))

import { OPINION_ROUTING_KIND } from '../src/main/gc/opinion-core'
import { HARDCODED_ROUTING_DEFAULTS, resolveRouting } from '../src/main/routing-policy'

describe('the advisor model comes from the routing table as kind scout', () => {
  it('uses the scout kind', () => {
    expect(OPINION_ROUTING_KIND).toBe('scout')
  })

  it('defaults to Haiku at low effort', () => {
    expect(resolveRouting(undefined, OPINION_ROUTING_KIND)).toEqual({
      model: 'haiku',
      effort: 'low'
    })
    expect(HARDCODED_ROUTING_DEFAULTS.scout).toEqual({ model: 'haiku', effort: 'low' })
  })

  it('follows the folder’s own scout entry, and ignores its review entry', () => {
    const table = {
      byKind: {
        scout: { model: 'sonnet', effort: 'medium' },
        review: { model: 'opus', effort: 'max' }
      }
    }
    expect(resolveRouting(table, OPINION_ROUTING_KIND)).toEqual({
      model: 'sonnet',
      effort: 'medium'
    })
  })

  it('the shell resolves the folder routing with that kind and no other', () => {
    const shell = readFileSync(join(__dirname, '../src/main/gc/opinion-shell.ts'), 'utf8')
    expect(shell).toContain('resolveFolderRouting(group, OPINION_ROUTING_KIND)')
    expect(shell).not.toMatch(/resolveFolderRouting\([^)]*'review'/)
  })
})
