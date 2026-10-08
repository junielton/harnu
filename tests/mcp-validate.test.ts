import { describe, it, expect } from 'vitest'
import {
  parseCreateSession,
  parseSpawnTerminal,
  parseCreateWorktree,
  parseListWorktrees,
  parseGetSession,
  parseAdoptFolder,
  parseOpenFile,
  parseDrawCanvas,
  parseNotify,
  parseCreateCard,
  parseUpdateCard,
  parseMoveCard,
  parseSubmitManifest,
  parseMessageSession,
  parseSpeak,
  parseCreateWorker,
  parseListWorkers,
  parseOrchestratorArm,
  parseOrchestratorDisarm,
  MAX_MANIFEST_CARDS,
  parseToolInput
} from '../src/main/mcp/validate'
import { MESSAGE_MAX_CHARS } from '../src/main/messaging-socket'
import { SPEAK_MAX_CHARS } from '../src/main/speech-text'
import { buildPlanInput } from '../src/main/mcp/plan-input'

/**
 * T10 — input validation for every MCP tool the router dispatches (mutation +
 * read). Each tool's raw arguments are UNTRUSTED MCP input; these pure
 * zod-backed parsers are the structural gate in front of the router. The
 * contract is uniform: `{ ok: true, value }` on success (defaults resolved),
 * `{ ok: false, error: 'BAD_ARGS', detail }` on any malformed input. Absolute
 * paths are required everywhere a path appears, `..` traversal is refused, and
 * `create_session`'s `bootOverride` is delegated to the T9 RCE sanitizer so a
 * forbidden boot field is rejected here too.
 */

describe('parseCreateSession', () => {
  it('accepts a plain new session', () => {
    const r = parseCreateSession({ folder: '/home/u/repo', kind: 'new' })
    expect(r).toEqual({ ok: true, value: { folder: '/home/u/repo', kind: 'new' } })
  })

  it('accepts a fork with a forkSourceId', () => {
    const r = parseCreateSession({ folder: '/home/u/repo', kind: 'fork', forkSourceId: 'src-1' })
    expect(r).toEqual({
      ok: true,
      value: { folder: '/home/u/repo', kind: 'fork', forkSourceId: 'src-1' }
    })
  })

  it('rejects a fork missing its forkSourceId', () => {
    const r = parseCreateSession({ folder: '/home/u/repo', kind: 'fork' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toBe('BAD_ARGS')
  })

  it('rejects a relative folder', () => {
    const r = parseCreateSession({ folder: 'repo/sub', kind: 'new' })
    expect(r.ok).toBe(false)
  })

  it('rejects an empty folder', () => {
    const r = parseCreateSession({ folder: '', kind: 'new' })
    expect(r.ok).toBe(false)
  })

  it('rejects an unknown kind', () => {
    const r = parseCreateSession({ folder: '/home/u/repo', kind: 'resume' })
    expect(r.ok).toBe(false)
  })

  it('routes bootOverride through the T9 sanitizer (allowed knobs pass)', () => {
    const r = parseCreateSession({
      folder: '/home/u/repo',
      kind: 'new',
      bootOverride: { model: 'opus', effort: 'high' }
    })
    expect(r).toEqual({
      ok: true,
      value: {
        folder: '/home/u/repo',
        kind: 'new',
        bootOverride: { model: 'opus', effort: 'high' }
      }
    })
  })

  it('rejects a forbidden bootOverride field (BAD_ARGS, via T9 sanitizer)', () => {
    const r = parseCreateSession({
      folder: '/home/u/repo',
      kind: 'new',
      bootOverride: { dangerouslySkipPermissions: true }
    })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error).toBe('BAD_ARGS')
      expect(r.detail).toMatch(/dangerouslySkipPermissions/)
    }
  })

  it('rejects raw-argv injection smuggled through bootOverride.extraArgs', () => {
    const r = parseCreateSession({
      folder: '/home/u/repo',
      kind: 'new',
      bootOverride: { extraArgs: '--dangerously-skip-permissions' }
    })
    expect(r.ok).toBe(false)
  })

  it('rejects non-object input', () => {
    expect(parseCreateSession(null).ok).toBe(false)
    expect(parseCreateSession('nope').ok).toBe(false)
    expect(parseCreateSession(['x']).ok).toBe(false)
  })
})

describe('parseSpawnTerminal', () => {
  it('defaults target to split, cwd to worktreePath, kind to shell', () => {
    const r = parseSpawnTerminal({ worktreePath: '/home/u/wt' })
    expect(r).toEqual({
      ok: true,
      value: { worktreePath: '/home/u/wt', target: 'split', cwd: '/home/u/wt', kind: 'shell' }
    })
  })

  it('accepts target tab', () => {
    const r = parseSpawnTerminal({ worktreePath: '/home/u/wt', target: 'tab' })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value.target).toBe('tab')
  })

  it('rejects an unknown target', () => {
    const r = parseSpawnTerminal({ worktreePath: '/home/u/wt', target: 'float' })
    expect(r.ok).toBe(false)
  })

  it('honours an explicit absolute cwd', () => {
    const r = parseSpawnTerminal({ worktreePath: '/home/u/wt', cwd: '/home/u/wt/pkg' })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value.cwd).toBe('/home/u/wt/pkg')
  })

  it('rejects a relative cwd', () => {
    const r = parseSpawnTerminal({ worktreePath: '/home/u/wt', cwd: 'pkg' })
    expect(r.ok).toBe(false)
  })

  it('rejects a relative worktreePath', () => {
    const r = parseSpawnTerminal({ worktreePath: 'wt' })
    expect(r.ok).toBe(false)
  })

  it('requires sessionId when kind is claude', () => {
    const r = parseSpawnTerminal({ worktreePath: '/home/u/wt', kind: 'claude' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toBe('BAD_ARGS')
  })

  it('accepts kind claude with a sessionId', () => {
    const r = parseSpawnTerminal({ worktreePath: '/home/u/wt', kind: 'claude', sessionId: 's-1' })
    expect(r).toEqual({
      ok: true,
      value: {
        worktreePath: '/home/u/wt',
        target: 'split',
        cwd: '/home/u/wt',
        kind: 'claude',
        sessionId: 's-1'
      }
    })
  })
})

describe('parseCreateWorktree', () => {
  it('accepts repoPath + branch, baseRef optional', () => {
    const r = parseCreateWorktree({ repoPath: '/home/u/repo', branch: 'feat/x' })
    expect(r).toEqual({ ok: true, value: { repoPath: '/home/u/repo', branch: 'feat/x' } })
  })

  it('accepts an optional baseRef', () => {
    const r = parseCreateWorktree({ repoPath: '/home/u/repo', branch: 'feat/x', baseRef: 'main' })
    expect(r).toEqual({
      ok: true,
      value: { repoPath: '/home/u/repo', branch: 'feat/x', baseRef: 'main' }
    })
  })

  it('rejects a missing branch', () => {
    const r = parseCreateWorktree({ repoPath: '/home/u/repo' })
    expect(r.ok).toBe(false)
  })

  it('rejects an empty branch', () => {
    const r = parseCreateWorktree({ repoPath: '/home/u/repo', branch: '' })
    expect(r.ok).toBe(false)
  })

  it('rejects a relative repoPath', () => {
    const r = parseCreateWorktree({ repoPath: 'repo', branch: 'feat/x' })
    expect(r.ok).toBe(false)
  })
})

describe('parseListWorktrees (read)', () => {
  it('accepts an absolute repoPath', () => {
    const r = parseListWorktrees({ repoPath: '/home/u/repo' })
    expect(r).toEqual({ ok: true, value: { repoPath: '/home/u/repo' } })
  })

  it('rejects a relative repoPath', () => {
    expect(parseListWorktrees({ repoPath: 'repo' }).ok).toBe(false)
  })

  it('rejects a traversal repoPath (no-traversal guard)', () => {
    const r = parseListWorktrees({ repoPath: '/home/u/repo/../../etc' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toBe('BAD_ARGS')
  })

  it('rejects garbage', () => {
    expect(parseListWorktrees(42).ok).toBe(false)
    expect(parseListWorktrees({}).ok).toBe(false)
  })
})

describe('parseAdoptFolder (T34)', () => {
  it('accepts an absolute folder', () => {
    const r = parseAdoptFolder({ folder: '/home/u/repo' })
    expect(r).toEqual({ ok: true, value: { folder: '/home/u/repo' } })
  })

  it('rejects a relative folder', () => {
    expect(parseAdoptFolder({ folder: 'repo' }).ok).toBe(false)
  })

  it('rejects a traversal folder (no-traversal guard)', () => {
    const r = parseAdoptFolder({ folder: '/home/u/repo/../../etc' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toBe('BAD_ARGS')
  })

  it('rejects garbage / missing folder', () => {
    expect(parseAdoptFolder(42).ok).toBe(false)
    expect(parseAdoptFolder({}).ok).toBe(false)
  })
})

describe('parseGetSession (read)', () => {
  it('accepts a non-empty id', () => {
    expect(parseGetSession({ id: 'sess-9' })).toEqual({ ok: true, value: { id: 'sess-9' } })
  })

  it('rejects an empty / missing id', () => {
    expect(parseGetSession({ id: '' }).ok).toBe(false)
    expect(parseGetSession({}).ok).toBe(false)
  })

  it('rejects non-object input', () => {
    expect(parseGetSession(null).ok).toBe(false)
    expect(parseGetSession('sess-9').ok).toBe(false)
  })
})

describe('parseOpenFile (T74 S4)', () => {
  it('accepts an absolute folder + an absolute markdown path', () => {
    const r = parseOpenFile({ folder: '/home/u/repo', path: '/home/u/repo/docs/report.md' })
    expect(r).toEqual({
      ok: true,
      value: { folder: '/home/u/repo', path: '/home/u/repo/docs/report.md' }
    })
  })

  it('accepts .markdown and .txt (case-insensitive)', () => {
    expect(parseOpenFile({ folder: '/a', path: '/a/x.MARKDOWN' }).ok).toBe(true)
    expect(parseOpenFile({ folder: '/a', path: '/a/notes.txt' }).ok).toBe(true)
    expect(parseOpenFile({ folder: '/a', path: '/a/DESIGN.MD' }).ok).toBe(true)
  })

  it('accepts a non-markdown file too (Cluster G — the extension gate moved to the binary sniff at read-time, not this structural layer)', () => {
    const r = parseOpenFile({ folder: '/home/u/repo', path: '/home/u/repo/app.js' })
    expect(r).toEqual({
      ok: true,
      value: { folder: '/home/u/repo', path: '/home/u/repo/app.js' }
    })
  })

  it('rejects a relative or traversal path (no `..`, must be absolute)', () => {
    expect(parseOpenFile({ folder: '/home/u/repo', path: 'report.md' }).ok).toBe(false)
    expect(parseOpenFile({ folder: '/home/u/repo', path: '/home/u/repo/../secrets.md' }).ok).toBe(
      false
    )
  })

  it('rejects a relative or traversal folder anchor', () => {
    expect(parseOpenFile({ folder: 'repo', path: '/home/u/repo/x.md' }).ok).toBe(false)
    expect(parseOpenFile({ folder: '/home/u/../etc', path: '/home/u/repo/x.md' }).ok).toBe(false)
  })

  it('rejects a missing folder or path', () => {
    expect(parseOpenFile({ path: '/a/x.md' }).ok).toBe(false)
    expect(parseOpenFile({ folder: '/a' }).ok).toBe(false)
    expect(parseOpenFile({}).ok).toBe(false)
  })
})

describe('parseDrawCanvas (T218 U5 §8.1)', () => {
  const OPS = [{ op: 'add_node', shape: 'box', x: 0, y: 0 }]

  it('accepts an absolute folder + ops, and defaults `open` to true', () => {
    const r = parseDrawCanvas({ folder: '/home/u/repo', ops: OPS })
    expect(r).toEqual({ ok: true, value: { folder: '/home/u/repo', ops: OPS, open: true } })
  })

  it('honours an explicit open:false', () => {
    const r = parseDrawCanvas({ folder: '/a', ops: OPS, open: false })
    expect(r.ok && r.value.open).toBe(false)
  })

  it('carries `path` through — relative is allowed here; containment is decided on the resolved path', () => {
    const r = parseDrawCanvas({ folder: '/a', ops: OPS, path: 'docs/canvas/x.harnucanvas.json' })
    expect(r.ok && r.value.path).toBe('docs/canvas/x.harnucanvas.json')
  })

  it('rejects a relative or traversal folder anchor', () => {
    expect(parseDrawCanvas({ folder: 'repo', ops: OPS }).ok).toBe(false)
    expect(parseDrawCanvas({ folder: '/home/u/../etc', ops: OPS }).ok).toBe(false)
  })

  it('rejects an empty or over-cap ops array', () => {
    expect(parseDrawCanvas({ folder: '/a', ops: [] }).ok).toBe(false)
    expect(
      parseDrawCanvas({ folder: '/a', ops: Array.from({ length: 201 }, () => OPS[0]) }).ok
    ).toBe(false)
  })

  it('accepts exactly 200 ops', () => {
    expect(
      parseDrawCanvas({ folder: '/a', ops: Array.from({ length: 200 }, () => OPS[0]) }).ok
    ).toBe(true)
  })

  it('rejects missing ops', () => {
    expect(parseDrawCanvas({ folder: '/a' }).ok).toBe(false)
    expect(parseDrawCanvas({}).ok).toBe(false)
  })

  it('requires image sources to be absolute and traversal-free, and caps them at 6', () => {
    expect(parseDrawCanvas({ folder: '/a', ops: OPS, images: ['/a/s.png'] }).ok).toBe(true)
    expect(parseDrawCanvas({ folder: '/a', ops: OPS, images: ['s.png'] }).ok).toBe(false)
    expect(parseDrawCanvas({ folder: '/a', ops: OPS, images: ['/a/../s.png'] }).ok).toBe(false)
    expect(
      parseDrawCanvas({
        folder: '/a',
        ops: OPS,
        images: Array.from({ length: 7 }, (_, i) => `/a/s${i}.png`)
      }).ok
    ).toBe(false)
  })

  it("copies the arrays rather than aliasing the caller's input", () => {
    const ops = [{ op: 'clear' }]
    const r = parseDrawCanvas({ folder: '/a', ops })
    expect(r.ok && r.value.ops).not.toBe(ops)
  })
})

describe('parseNotify (T116)', () => {
  it('accepts an absolute folder + a single-line title', () => {
    const r = parseNotify({ folder: '/home/u/repo', title: 'Migration finished' })
    expect(r).toEqual({ ok: true, value: { folder: '/home/u/repo', title: 'Migration finished' } })
  })

  it('accepts the optional description/kind/sessionId', () => {
    const r = parseNotify({
      folder: '/home/u/repo',
      title: 'Migration finished',
      description: '12 of 12 files migrated, no conflicts',
      kind: 'success',
      sessionId: 'sess-1'
    })
    expect(r).toEqual({
      ok: true,
      value: {
        folder: '/home/u/repo',
        title: 'Migration finished',
        description: '12 of 12 files migrated, no conflicts',
        kind: 'success',
        sessionId: 'sess-1'
      }
    })
  })

  it('rejects a multi-line title', () => {
    expect(parseNotify({ folder: '/a', title: 'line one\nline two' }).ok).toBe(false)
  })

  it('rejects an unknown kind', () => {
    expect(parseNotify({ folder: '/a', title: 'hi', kind: 'urgent' }).ok).toBe(false)
  })

  it('rejects a relative or traversal folder anchor', () => {
    expect(parseNotify({ folder: 'repo', title: 'hi' }).ok).toBe(false)
    expect(parseNotify({ folder: '/home/u/../etc', title: 'hi' }).ok).toBe(false)
  })

  it('rejects a missing folder or title', () => {
    expect(parseNotify({ title: 'hi' }).ok).toBe(false)
    expect(parseNotify({ folder: '/a' }).ok).toBe(false)
    expect(parseNotify({}).ok).toBe(false)
  })
})

describe('parseCreateCard (T96 §1.1)', () => {
  it('accepts a minimal call (folder + title only)', () => {
    const r = parseCreateCard({ folder: '/home/u/repo', title: 'Fix the flaky test' })
    expect(r).toEqual({ ok: true, value: { folder: '/home/u/repo', title: 'Fix the flaky test' } })
  })

  it('accepts every optional field with valid enum values', () => {
    const r = parseCreateCard({
      folder: '/home/u/repo',
      title: 'Investigate flaky test',
      body: 'notes',
      kind: 'bug',
      complexity: 'standard',
      parent: 'epic-t1',
      deps: ['a', 'b'],
      substrate: 'session',
      priority: 'alta',
      spec: 'roadmap/tasks/prd/x.md'
    })
    expect(r.ok).toBe(true)
  })

  it('rejects a missing/empty title, and a title over 200 chars or with a newline', () => {
    expect(parseCreateCard({ folder: '/a' }).ok).toBe(false)
    expect(parseCreateCard({ folder: '/a', title: '' }).ok).toBe(false)
    expect(parseCreateCard({ folder: '/a', title: 'x'.repeat(201) }).ok).toBe(false)
    expect(parseCreateCard({ folder: '/a', title: 'line1\nline2' }).ok).toBe(false)
  })

  it('rejects an unrecognized kind/complexity/substrate', () => {
    expect(parseCreateCard({ folder: '/a', title: 't', kind: 'epic' }).ok).toBe(false)
    expect(parseCreateCard({ folder: '/a', title: 't', complexity: 'huge' }).ok).toBe(false)
    expect(parseCreateCard({ folder: '/a', title: 't', substrate: 'cloud' }).ok).toBe(false)
  })

  it('rejects a body over the 16 KiB cap', () => {
    expect(parseCreateCard({ folder: '/a', title: 't', body: 'x'.repeat(16_385) }).ok).toBe(false)
  })

  it('status is not a recognized field — a card is always born backlog', () => {
    // `status` isn't in the schema at all; zod strips unknown keys by default, so
    // the call still succeeds — but the field never reaches CreateCardArgs.
    const r = parseCreateCard({ folder: '/a', title: 't', status: 'done' })
    expect(r.ok).toBe(true)
    if (r.ok) expect('status' in r.value).toBe(false)
  })
})

describe('parseUpdateCard (T96 §1.2)', () => {
  it('accepts a call with only `set`', () => {
    const r = parseUpdateCard({ folder: '/a', slug: 'card-1', set: { priority: 'alta' } })
    expect(r).toEqual({
      ok: true,
      value: { folder: '/a', slug: 'card-1', set: { priority: 'alta' } }
    })
  })

  it('accepts a call with only `appendBody`', () => {
    const r = parseUpdateCard({ folder: '/a', slug: 'card-1', appendBody: 'progress note' })
    expect(r.ok).toBe(true)
  })

  it("accepts a `set` carrying a CONTROLLED field at the structural layer — refusal is planCardSet's job", () => {
    // The gate only pins the outer shape; content-level accept/reject (incl.
    // controlled fields) is disk-dependent and lives in the pure planCardSet,
    // exercised in roadmap-core.test.ts.
    const r = parseUpdateCard({ folder: '/a', slug: 'card-1', set: { status: 'done' } })
    expect(r.ok).toBe(true)
  })

  it('rejects a call with NEITHER set nor appendBody', () => {
    expect(parseUpdateCard({ folder: '/a', slug: 'card-1' }).ok).toBe(false)
  })

  it('rejects a missing folder/slug, or an appendBody over the memory entry cap', () => {
    expect(parseUpdateCard({ slug: 'card-1', set: { priority: 'x' } }).ok).toBe(false)
    expect(parseUpdateCard({ folder: '/a', set: { priority: 'x' } }).ok).toBe(false)
    expect(
      parseUpdateCard({ folder: '/a', slug: 'card-1', appendBody: 'x'.repeat(8_001) }).ok
    ).toBe(false)
  })

  it('accepts a call with only `replaceBody` (S2 full-replace edit engine)', () => {
    const r = parseUpdateCard({ folder: '/a', slug: 'card-1', replaceBody: '## Goal\n\nNew.' })
    expect(r).toEqual({
      ok: true,
      value: { folder: '/a', slug: 'card-1', replaceBody: '## Goal\n\nNew.' }
    })
  })

  it('rejects a replaceBody over the card body cap (16_384 chars)', () => {
    expect(
      parseUpdateCard({ folder: '/a', slug: 'card-1', replaceBody: 'x'.repeat(16_385) }).ok
    ).toBe(false)
  })

  it('accepts replaceBody combined with set (both apply)', () => {
    const r = parseUpdateCard({
      folder: '/a',
      slug: 'card-1',
      set: { priority: 'high' },
      replaceBody: 'Body.'
    })
    expect(r.ok).toBe(true)
  })
})

describe('parseMoveCard (T96 §1.3)', () => {
  it('accepts every legal destination', () => {
    for (const to of ['backlog', 'ready', 'review'] as const) {
      expect(parseMoveCard({ folder: '/a', slug: 'card-1', to })).toEqual({
        ok: true,
        value: { folder: '/a', slug: 'card-1', to }
      })
    }
  })

  it('refuses "done" with a DONE_IS_HUMAN-steered detail (not a bare enum mismatch)', () => {
    const r = parseMoveCard({ folder: '/a', slug: 'card-1', to: 'done' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.detail).toContain('DONE_IS_HUMAN')
  })

  it('refuses "in-progress" with an IN_PROGRESS_IS_BOUND-steered detail', () => {
    const r = parseMoveCard({ folder: '/a', slug: 'card-1', to: 'in-progress' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.detail).toContain('IN_PROGRESS_IS_BOUND')
  })

  it('refuses an unrecognized destination with a plain enum-mismatch detail', () => {
    const r = parseMoveCard({ folder: '/a', slug: 'card-1', to: 'archived' })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.detail).not.toContain('DONE_IS_HUMAN')
      expect(r.detail).not.toContain('IN_PROGRESS_IS_BOUND')
    }
  })

  it('rejects a missing folder/slug/to', () => {
    expect(parseMoveCard({ slug: 'card-1', to: 'ready' }).ok).toBe(false)
    expect(parseMoveCard({ folder: '/a', to: 'ready' }).ok).toBe(false)
    expect(parseMoveCard({ folder: '/a', slug: 'card-1' }).ok).toBe(false)
  })
})

describe('parseSubmitManifest (T104 §2.1)', () => {
  it('accepts a minimal single-card manifest, preserving declared array order', () => {
    const r = parseSubmitManifest({
      folder: '/a',
      cards: [{ slug: 'card-1' }, { slug: 'card-2' }, { slug: 'card-3' }]
    })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value.cards.map((c) => c.slug)).toEqual(['card-1', 'card-2', 'card-3'])
  })

  it('accepts per-card substrate/model/effort overrides', () => {
    const r = parseSubmitManifest({
      folder: '/a',
      cards: [{ slug: 'card-1', substrate: 'worktree', model: 'sonnet', effort: 'high' }]
    })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.value.cards[0]).toEqual({
        slug: 'card-1',
        substrate: 'worktree',
        model: 'sonnet',
        effort: 'high'
      })
    }
  })

  it('accepts an optional note', () => {
    const r = parseSubmitManifest({ folder: '/a', cards: [{ slug: 'x' }], note: 'batch 1' })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value.note).toBe('batch 1')
  })

  it('rejects an empty cards array (at least one card required)', () => {
    expect(parseSubmitManifest({ folder: '/a', cards: [] }).ok).toBe(false)
  })

  it('rejects more than MAX_MANIFEST_CARDS cards (bounded, no wildcard batch)', () => {
    const cards = Array.from({ length: MAX_MANIFEST_CARDS + 1 }, (_, i) => ({ slug: `c${i}` }))
    expect(parseSubmitManifest({ folder: '/a', cards }).ok).toBe(false)
    const atCap = Array.from({ length: MAX_MANIFEST_CARDS }, (_, i) => ({ slug: `c${i}` }))
    expect(parseSubmitManifest({ folder: '/a', cards: atCap }).ok).toBe(true)
  })

  it('rejects an unrecognized substrate', () => {
    expect(
      parseSubmitManifest({ folder: '/a', cards: [{ slug: 'x', substrate: 'cloud' }] }).ok
    ).toBe(false)
  })

  it('rejects a relative folder / missing slug', () => {
    expect(parseSubmitManifest({ folder: 'a', cards: [{ slug: 'x' }] }).ok).toBe(false)
    expect(parseSubmitManifest({ folder: '/a', cards: [{}] }).ok).toBe(false)
  })
})

describe('parseToolInput (router dispatch)', () => {
  it('routes get_fleet to an empty-args parse', () => {
    expect(parseToolInput('get_fleet', {})).toEqual({ ok: true, value: {} })
  })

  it('routes get_session', () => {
    expect(parseToolInput('get_session', { sessionId: 's' }).ok).toBe(false)
    expect(parseToolInput('get_session', { id: 's' })).toEqual({ ok: true, value: { id: 's' } })
  })

  it('routes create_session and surfaces the T9 sanitizer rejection', () => {
    const ok = parseToolInput('create_session', { folder: '/abs', kind: 'new' })
    expect(ok.ok).toBe(true)
    const bad = parseToolInput('create_session', {
      folder: '/abs',
      kind: 'new',
      bootOverride: { agent: 'rogue' }
    })
    expect(bad.ok).toBe(false)
  })

  it('routes the remaining ops', () => {
    expect(parseToolInput('list_worktrees', { repoPath: '/abs' }).ok).toBe(true)
    expect(parseToolInput('create_worktree', { repoPath: '/abs', branch: 'b' }).ok).toBe(true)
    expect(parseToolInput('spawn_terminal', { worktreePath: '/abs' }).ok).toBe(true)
    expect(parseToolInput('open_file', { folder: '/abs', path: '/abs/r.md' }).ok).toBe(true)
    // Cluster G: the structural layer no longer gates by extension — a binary
    // file is refused later, when the pane actually reads it.
    expect(parseToolInput('open_file', { folder: '/abs', path: '/abs/r.png' }).ok).toBe(true)
  })

  it('routes the T96 board verbs', () => {
    expect(parseToolInput('create_card', { folder: '/abs', title: 't' }).ok).toBe(true)
    expect(
      parseToolInput('update_card', { folder: '/abs', slug: 's', appendBody: 'note' }).ok
    ).toBe(true)
    expect(parseToolInput('move_card', { folder: '/abs', slug: 's', to: 'ready' }).ok).toBe(true)
    expect(parseToolInput('move_card', { folder: '/abs', slug: 's', to: 'done' }).ok).toBe(false)
  })

  it('routes archive_card/delete_card (T148)', () => {
    expect(parseToolInput('archive_card', { folder: '/abs', slug: 's' }).ok).toBe(true)
    expect(parseToolInput('archive_card', { folder: '/abs' }).ok).toBe(false)
    expect(parseToolInput('delete_card', { folder: '/abs', slug: 's' }).ok).toBe(true)
    expect(parseToolInput('delete_card', { folder: '/abs' }).ok).toBe(false)
  })

  it('routes message_session (T215)', () => {
    expect(parseToolInput('message_session', { sessionId: 's', message: 'hi' }).ok).toBe(true)
    expect(parseToolInput('message_session', { message: 'hi' }).ok).toBe(false)
    expect(parseToolInput('message_session', { sessionId: 's' }).ok).toBe(false)
  })

  it('routes orchestrator_arm/orchestrator_disarm (T309)', () => {
    expect(parseToolInput('orchestrator_arm', { sessionId: 's' }).ok).toBe(true)
    expect(parseToolInput('orchestrator_arm', {}).ok).toBe(false)
    expect(parseToolInput('orchestrator_disarm', { sessionId: 's' }).ok).toBe(true)
    expect(parseToolInput('orchestrator_disarm', {}).ok).toBe(false)
  })

  it('routes submit_manifest (T104)', () => {
    expect(parseToolInput('submit_manifest', { folder: '/abs', cards: [{ slug: 's' }] }).ok).toBe(
      true
    )
    expect(parseToolInput('submit_manifest', { folder: '/abs', cards: [] }).ok).toBe(false)
  })
})

describe('parseMessageSession (T215)', () => {
  it('accepts the happy shape', () => {
    const r = parseMessageSession({ sessionId: 'sess-1', message: 'ping' })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value).toEqual({ sessionId: 'sess-1', message: 'ping' })
  })

  it('carries the resolved RECIPIENT folder through as the gate anchor', () => {
    const r = parseMessageSession({ sessionId: 's', message: 'x', folder: '/home/u/repo' })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value.folder).toBe('/home/u/repo')
  })

  it('rejects an absent or empty sessionId', () => {
    expect(parseMessageSession({ message: 'x' }).ok).toBe(false)
    expect(parseMessageSession({ sessionId: '', message: 'x' }).ok).toBe(false)
  })

  it('rejects an absent or empty message', () => {
    expect(parseMessageSession({ sessionId: 's' }).ok).toBe(false)
    expect(parseMessageSession({ sessionId: 's', message: '' }).ok).toBe(false)
  })

  it('rejects an over-cap message STRUCTURALLY, before any socket work', () => {
    // The cap is enforced here so an oversized body can never reach the audit
    // ring or a peer's inbox — a size refusal at the handler would already be
    // too late for the ring.
    const ok = parseMessageSession({ sessionId: 's', message: 'x'.repeat(MESSAGE_MAX_CHARS) })
    expect(ok.ok).toBe(true)
    const over = parseMessageSession({ sessionId: 's', message: 'x'.repeat(MESSAGE_MAX_CHARS + 1) })
    expect(over.ok).toBe(false)
  })

  it('rejects a relative or traversing folder', () => {
    expect(parseMessageSession({ sessionId: 's', message: 'x', folder: 'rel' }).ok).toBe(false)
    expect(parseMessageSession({ sessionId: 's', message: 'x', folder: '/a/../b' }).ok).toBe(false)
  })
})

describe('parseOrchestratorArm / parseOrchestratorDisarm (T309, ADR-0013)', () => {
  it('accepts the happy shape (sessionId only)', () => {
    const r = parseOrchestratorArm({ sessionId: 'sess-1' })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value).toEqual({ sessionId: 'sess-1' })
  })

  it('carries the resolved TARGET folder through as the gate anchor', () => {
    const r = parseOrchestratorArm({ sessionId: 's', folder: '/home/u/repo' })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value.folder).toBe('/home/u/repo')
  })

  it('rejects an absent or empty sessionId', () => {
    expect(parseOrchestratorArm({}).ok).toBe(false)
    expect(parseOrchestratorArm({ sessionId: '' }).ok).toBe(false)
  })

  it('rejects a relative or traversing folder', () => {
    expect(parseOrchestratorArm({ sessionId: 's', folder: 'rel' }).ok).toBe(false)
    expect(parseOrchestratorArm({ sessionId: 's', folder: '/a/../b' }).ok).toBe(false)
  })

  it('parseOrchestratorDisarm is the identical shape', () => {
    expect(parseOrchestratorDisarm({ sessionId: 's' })).toEqual(
      parseOrchestratorArm({ sessionId: 's' })
    )
    expect(parseOrchestratorDisarm({}).ok).toBe(false)
  })
})

describe('parseSpeak (T238) — with translateSpeak, the pair that makes "truncate, never reject" true', () => {
  const REPO = '/home/u/repo'

  it('accepts an absolute folder + a non-empty utterance', () => {
    expect(parseSpeak({ folder: REPO, text: 'Migration finished.' })).toEqual({
      ok: true,
      value: { folder: REPO, text: 'Migration finished.' }
    })
  })

  it('carries an optional sessionId through', () => {
    const r = parseSpeak({ folder: REPO, text: 'hi', sessionId: 'sess-1' })
    expect(r.ok && r.value.sessionId).toBe('sess-1')
  })

  it('rejects a missing/empty text and a relative or traversing folder', () => {
    expect(parseSpeak({ folder: REPO }).ok).toBe(false)
    expect(parseSpeak({ folder: REPO, text: '' }).ok).toBe(false)
    expect(parseSpeak({ folder: 'rel', text: 'hi' }).ok).toBe(false)
    expect(parseSpeak({ folder: '/a/../b', text: 'hi' }).ok).toBe(false)
  })

  it("the schema's .max NEVER refuses a real call — translateSpeak clamps first", () => {
    // Alone, the schema would reject 2000 characters. Through the seam the shell
    // actually uses, the same call parses — which is AC-4 held structurally
    // rather than by a comment.
    const args = { folder: REPO, text: 'word '.repeat(400) }
    expect(parseSpeak(args).ok).toBe(false)
    const translated = buildPlanInput('speak', args, REPO)
    const parsed = parseSpeak(translated)
    expect(parsed.ok).toBe(true)
    expect(parsed.ok && parsed.value.text.length).toBeLessThanOrEqual(SPEAK_MAX_CHARS)
  })

  it('an utterance that is only whitespace translates to nothing and is BAD_ARGS', () => {
    const parsed = parseSpeak(buildPlanInput('speak', { folder: REPO, text: '  \n ' }, REPO))
    expect(parsed.ok).toBe(false)
  })
})

describe('parseCreateWorker (T308)', () => {
  const REPO = '/home/u/repo'

  it('accepts the minimal shape and defaults mode to observe', () => {
    const r = parseCreateWorker({
      folder: REPO,
      name: 'PR watcher',
      prompt: 'Check gh pr list.',
      everyMinutes: 30
    })
    expect(r).toEqual({
      ok: true,
      value: {
        folder: REPO,
        name: 'PR watcher',
        prompt: 'Check gh pr list.',
        everyMinutes: 30,
        mode: 'observe'
      }
    })
  })

  it('accepts an explicit mode:"act" plus model/effort overrides', () => {
    const r = parseCreateWorker({
      folder: REPO,
      name: 'auto-fixer',
      prompt: 'Fix the flaky test and push.',
      everyMinutes: 15,
      mode: 'act',
      model: 'sonnet',
      effort: 'high'
    })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.value.mode).toBe('act')
      expect(r.value.model).toBe('sonnet')
      expect(r.value.effort).toBe('high')
    }
  })

  it('rejects a missing folder/name/prompt, a non-positive everyMinutes, and an unrecognized mode', () => {
    expect(parseCreateWorker({ name: 'w', prompt: 'p', everyMinutes: 5 }).ok).toBe(false)
    expect(parseCreateWorker({ folder: REPO, prompt: 'p', everyMinutes: 5 }).ok).toBe(false)
    expect(parseCreateWorker({ folder: REPO, name: 'w', everyMinutes: 5 }).ok).toBe(false)
    expect(parseCreateWorker({ folder: REPO, name: 'w', prompt: 'p', everyMinutes: 0 }).ok).toBe(
      false
    )
    expect(parseCreateWorker({ folder: REPO, name: 'w', prompt: 'p', everyMinutes: -5 }).ok).toBe(
      false
    )
    expect(
      parseCreateWorker({
        folder: REPO,
        name: 'w',
        prompt: 'p',
        everyMinutes: 5,
        mode: 'bypass'
      }).ok
    ).toBe(false)
  })

  it('rejects a prompt over the 8000-char cap', () => {
    expect(
      parseCreateWorker({
        folder: REPO,
        name: 'w',
        prompt: 'x'.repeat(8_001),
        everyMinutes: 5
      }).ok
    ).toBe(false)
  })

  it('rejects an unrecognized effort value', () => {
    expect(
      parseCreateWorker({
        folder: REPO,
        name: 'w',
        prompt: 'p',
        everyMinutes: 5,
        effort: 'ultra'
      }).ok
    ).toBe(false)
  })
})

describe('parseListWorkers (T308)', () => {
  it('accepts no folder (an unscoped global list)', () => {
    expect(parseListWorkers({})).toEqual({ ok: true, value: {} })
  })

  it('accepts a scoping folder', () => {
    expect(parseListWorkers({ folder: '/home/u/repo' })).toEqual({
      ok: true,
      value: { folder: '/home/u/repo' }
    })
  })

  it('rejects a relative or traversing folder', () => {
    expect(parseListWorkers({ folder: 'rel' }).ok).toBe(false)
    expect(parseListWorkers({ folder: '/a/../b' }).ok).toBe(false)
  })
})

describe('parseToolInput routes create_worker/list_workers (T308)', () => {
  it('routes create_worker', () => {
    const r = parseToolInput('create_worker', {
      folder: '/abs',
      name: 'w',
      prompt: 'p',
      everyMinutes: 10
    })
    expect(r.ok).toBe(true)
  })

  it('routes list_workers', () => {
    expect(parseToolInput('list_workers', {}).ok).toBe(true)
    expect(parseToolInput('list_workers', { folder: '/abs' }).ok).toBe(true)
  })
})

describe('parseToolInput routes list_containers (T328)', () => {
  it('accepts no args or an absolute folder', () => {
    expect(parseToolInput('list_containers', {}).ok).toBe(true)
    expect(parseToolInput('list_containers', { folder: '/abs' }).ok).toBe(true)
  })

  it('refuses a relative folder', () => {
    expect(parseToolInput('list_containers', { folder: 'relative/dir' }).ok).toBe(false)
  })
})

describe('parseToolInput routes the cleanup verbs (T445)', () => {
  it('list_cleanup accepts no args or an absolute folder, refuses a relative one', () => {
    expect(parseToolInput('list_cleanup', {}).ok).toBe(true)
    expect(parseToolInput('list_cleanup', { folder: '/abs' }).ok).toBe(true)
    expect(parseToolInput('list_cleanup', { folder: 'relative/dir' }).ok).toBe(false)
  })

  it('release_worktree needs an absolute folder', () => {
    expect(parseToolInput('release_worktree', { folder: '/abs/wt' })).toEqual({
      ok: true,
      value: { folder: '/abs/wt' }
    })
    expect(parseToolInput('release_worktree', { id: 'www::worktree::feat::abc12345' })).toEqual({
      ok: true,
      value: { id: 'www::worktree::feat::abc12345' }
    })
    expect(parseToolInput('release_worktree', { folder: '/abs/wt', id: 'x' }).ok).toBe(false)
    expect(parseToolInput('release_worktree', {}).ok).toBe(false)
    expect(parseToolInput('release_worktree', { folder: 'relative/dir' }).ok).toBe(false)
  })
})

describe('parseToolInput routes the Containers actions (T329)', () => {
  it('stop_containers keeps force, so forceConfirmFor reads what the caller sent', () => {
    expect(parseToolInput('stop_containers', { stacks: ['a', 'b'], force: true })).toEqual({
      ok: true,
      value: { stacks: ['a', 'b'], force: true }
    })
    expect(parseToolInput('stop_containers', { stacks: ['a'] })).toEqual({
      ok: true,
      value: { stacks: ['a'] }
    })
    expect(parseToolInput('stop_containers', { stacks: ['a'], force: 'yes' }).ok).toBe(false)
  })

  it('stop_containers and start_containers need a non-empty list of ids', () => {
    for (const op of ['stop_containers', 'start_containers'] as const) {
      expect(parseToolInput(op, { stacks: [] }).ok).toBe(false)
      expect(parseToolInput(op, { stacks: 'a' }).ok).toBe(false)
      expect(parseToolInput(op, { stacks: [''] }).ok).toBe(false)
    }
    expect(parseToolInput('start_containers', { stacks: ['a'] }).ok).toBe(true)
  })

  it('remove_containers takes exactly one stack — never a list', () => {
    expect(parseToolInput('remove_containers', { stack: 'a', removeVolumes: true })).toEqual({
      ok: true,
      value: { stack: 'a', removeVolumes: true }
    })
    expect(parseToolInput('remove_containers', { stack: ['a'] }).ok).toBe(false)
    expect(parseToolInput('remove_containers', { stacks: ['a'] }).ok).toBe(false)
    expect(parseToolInput('remove_containers', { stack: 'a', stacks: ['a', 'b'] }).ok).toBe(false)
  })
})
