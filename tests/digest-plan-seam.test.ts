import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import * as path from 'node:path'
import { scanTranscriptLines } from '../src/main/mcp/digest-transcript'
import { planDigest, type GitEvidence } from '../src/main/mcp/digest-core'
import { fixtureSession, transcriptLines } from './helpers/memory-u1-fixture'

/**
 * Memory U1 · S-1 — the capture seam (R-8, R-9): a digest plan needs nothing but a transcript and
 * git evidence. No MCP verb, no memory module, no Electron, no file path: an adapter for another
 * CLI only has to produce transcript lines and git evidence to reach the same planner.
 */

const ALLOWED = new Set([
  'vitest',
  'node:fs',
  'node:path',
  '../src/main/mcp/digest-transcript',
  '../src/main/mcp/digest-core',
  './helpers/memory-u1-fixture'
])

describe('the digest plan seam', () => {
  it('plans from a transcript and git evidence alone', () => {
    const source = readFileSync(path.join(__dirname, path.basename(__filename)), 'utf8')
    const imports = [...source.matchAll(/^\s*import\s[^'"]*['"]([^'"]+)['"]/gm)].map((m) => m[1])
    expect(imports.length).toBeGreaterThan(0)
    expect(imports.filter((spec) => !ALLOWED.has(spec))).toEqual([])
    // No dynamic import or require sneaks a dependency past the static list.
    expect(source).not.toMatch(/\brequire\(|\bimport\(/)

    const facts = scanTranscriptLines(
      transcriptLines(fixtureSession('a1000002'), { repo: '/r', plain: '/p', gone: '/g' }).main
    )
    const git: GitEvidence = {
      kind: 'repo',
      head: 'e'.repeat(40),
      commits: [],
      fileStats: [],
      dirtyCount: 0
    }
    expect(planDigest({ facts, git, last: null })).toEqual({
      action: 'write',
      evidence: 'no-commits',
      relevance: 'turns'
    })
  })
})
