import { describe, it, expect } from 'vitest'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  evaluateToolCall,
  normalizePath,
  resolveKnownFolder,
  type Policy,
  type ToolCall
} from '../src/main/mcp/permission-core'

/**
 * T3 — the security heart. `evaluateToolCall` is a PURE decision function over a
 * policy snapshot: no `fs`/`electron`/timers, deterministic, lands in the
 * pure-core coverage surface (ADR-0001) and is the #1 Stryker target.
 *
 * These tests pin the POST-REVERSAL contract (agents free by default):
 *
 *  - the server kill switch still denies EVERYTHING (even reads);
 *  - an explicitly BLOCKED folder (`denyFolders`) is denied — and so is anything
 *    INSIDE it. This is the only per-folder gate left, and it is absolute;
 *  - every other read is allowed, transcript-disclosing reads included (there is
 *    no allowlist left to gate them by);
 *  - every other mutation is ALLOWED — including in a folder nobody ever pinned.
 *    That unknown-folder case is the exact bug this reversal removes;
 *  - `ask: true` (the opt-in friction switch) turns mutations back into `confirm`
 *    and re-arms containment (`PATH_ESCAPE`), which does NOT fire by default;
 *  - path equality is normalized (trailing slash / `~` variants match).
 */

/** A healthy default policy — free mode, nothing blocked. `over` wins per-field. */
const policy = (over: Partial<Policy> = {}): Policy => ({
  serverEnabled: true,
  denyFolders: [],
  allowFolders: ['/home/u/repo'],
  knownRoots: ['/home/u/repo'],
  ...over
})

/** A read tool call (no folder by default — a global status read). */
const read = (over: Partial<ToolCall> = {}): ToolCall => ({
  tool: 'fleet_status',
  kind: 'read',
  ...over
})

/** A mutation tool call targeting a known folder. */
const mutation = (over: Partial<ToolCall> = {}): ToolCall => ({
  tool: 'session_send',
  kind: 'mutation',
  folder: '/home/u/repo',
  ...over
})

describe('evaluateToolCall — server kill switch (the one unconditional gate)', () => {
  it('serverEnabled:false denies a plain read', () => {
    expect(
      evaluateToolCall(read({ folder: '/home/u/repo' }), policy({ serverEnabled: false }))
    ).toEqual({
      verdict: 'deny',
      reason: 'SERVER_DISABLED'
    })
  })

  it('serverEnabled:false denies a folderless read too', () => {
    expect(evaluateToolCall(read(), policy({ serverEnabled: false })).verdict).toBe('deny')
  })

  it('serverEnabled:false denies a mutation', () => {
    expect(evaluateToolCall(mutation(), policy({ serverEnabled: false }))).toEqual({
      verdict: 'deny',
      reason: 'SERVER_DISABLED'
    })
  })

  it('the kill switch outranks even an otherwise-free mutation in an unblocked folder', () => {
    expect(
      evaluateToolCall(
        mutation({ folder: '/somewhere/brand/new' }),
        policy({ serverEnabled: false })
      )
    ).toEqual({ verdict: 'deny', reason: 'SERVER_DISABLED' })
  })
})

describe('evaluateToolCall — reads are free', () => {
  it('a plain read is allowed', () => {
    expect(evaluateToolCall(read({ folder: '/home/u/repo' }), policy())).toEqual({
      verdict: 'allow'
    })
  })

  it('a folderless read is allowed', () => {
    expect(evaluateToolCall(read(), policy())).toEqual({ verdict: 'allow' })
  })

  it('a transcript-disclosing read is ALLOWED — the allowlist that gated it is gone', () => {
    expect(
      evaluateToolCall(
        read({ tool: 'get_session', disclosesTranscript: true, folder: '/home/u/repo' }),
        policy()
      )
    ).toEqual({ verdict: 'allow' })
  })

  it('a transcript read in a folder that was NEVER pinned is allowed (the reported bug)', () => {
    // `create_session` handed the agent a session id, then `get_session` was refused
    // with FOLDER_NOT_ALLOWED and the machine sat idle. Not any more.
    expect(
      evaluateToolCall(
        read({ tool: 'get_session', disclosesTranscript: true, folder: '/tmp/never-pinned' }),
        policy({ knownRoots: [], allowFolders: [] })
      )
    ).toEqual({ verdict: 'allow' })
  })

  it('a read INSIDE a blocked folder is denied', () => {
    expect(
      evaluateToolCall(
        read({ tool: 'get_session', disclosesTranscript: true, folder: '/home/u/repo/src' }),
        policy({ denyFolders: ['/home/u/repo'] })
      )
    ).toEqual({ verdict: 'deny', reason: 'FOLDER_NOT_ALLOWED' })
  })
})

describe('evaluateToolCall — mutations are free by default', () => {
  it('a mutation in a known folder is ALLOWED (no confirm)', () => {
    expect(evaluateToolCall(mutation(), policy())).toEqual({ verdict: 'allow' })
  })

  it('a mutation in a folder that is NOT in projects.json at all is ALLOWED', () => {
    // The heart of the reversal: an unknown folder is no longer an error.
    expect(
      evaluateToolCall(
        mutation({ folder: '/home/u/brand-new-folder' }),
        policy({ knownRoots: [], allowFolders: [] })
      )
    ).toEqual({ verdict: 'allow' })
  })

  it('a folderless mutation is allowed (nothing to block it against)', () => {
    expect(evaluateToolCall(mutation({ folder: undefined }), policy())).toEqual({
      verdict: 'allow'
    })
  })
})

describe('evaluateToolCall — the denylist is the per-folder opt-out, and it is absolute', () => {
  it('a mutation in a BLOCKED folder is denied', () => {
    expect(
      evaluateToolCall(
        mutation({ folder: '/home/u/repo' }),
        policy({ denyFolders: ['/home/u/repo'] })
      )
    ).toEqual({ verdict: 'deny', reason: 'FOLDER_NOT_ALLOWED' })
  })

  it('a mutation in a path INSIDE a blocked folder is denied (the block covers the subtree)', () => {
    expect(
      evaluateToolCall(
        mutation({ folder: '/home/u/repo/.claude/worktrees/feat' }),
        policy({ denyFolders: ['/home/u/repo'] })
      )
    ).toEqual({ verdict: 'deny', reason: 'FOLDER_NOT_ALLOWED' })
  })

  it('a SIBLING of a blocked folder is untouched — the block is scoped, not global', () => {
    expect(
      evaluateToolCall(
        mutation({ folder: '/home/u/repo-two' }),
        policy({ denyFolders: ['/home/u/repo'] })
      )
    ).toEqual({ verdict: 'allow' })
  })

  it('the block is checked on the NORMALIZED path (trailing slash / ~ variants)', () => {
    const home = os.homedir()
    expect(
      evaluateToolCall(mutation({ folder: '~/repo' }), policy({ denyFolders: [`${home}/repo/`] }))
    ).toEqual({ verdict: 'deny', reason: 'FOLDER_NOT_ALLOWED' })
  })

  it('a block outranks the ask mode (it denies, it does not merely confirm)', () => {
    expect(
      evaluateToolCall(mutation(), policy({ denyFolders: ['/home/u/repo'], ask: true }))
    ).toEqual({ verdict: 'deny', reason: 'FOLDER_NOT_ALLOWED' })
  })
})

describe('evaluateToolCall — the `ask` friction switch (opt-in)', () => {
  it('ask:true turns a mutation back into a confirm', () => {
    expect(evaluateToolCall(mutation(), policy({ ask: true }))).toEqual({ verdict: 'confirm' })
  })

  it('ask:true still allows reads', () => {
    expect(evaluateToolCall(read({ folder: '/home/u/repo' }), policy({ ask: true }))).toEqual({
      verdict: 'allow'
    })
  })

  it('ask:true does NOT resurrect the allowlist — an unknown-but-contained folder still confirms, not denies', () => {
    expect(
      evaluateToolCall(
        mutation({ folder: '/home/u/repo/sub' }),
        policy({ ask: true, allowFolders: [] })
      )
    ).toEqual({ verdict: 'confirm' })
  })
})

describe('evaluateToolCall — containment (PATH_ESCAPE) fires only in the ask mode', () => {
  const escape = '/home/u/repo/../../../etc'

  it('an escaping folder is ALLOWED in the default free mode — no boundary at all', () => {
    // The operator explicitly chose this: `adopt_folder` is silent, so a containment
    // boundary would have been bypassable in two hops anyway.
    expect(
      evaluateToolCall(mutation({ folder: escape }), policy({ knownRoots: ['/home/u/repo'] }))
    ).toEqual({ verdict: 'allow' })
  })

  it('the SAME call is denied PATH_ESCAPE once ask is on', () => {
    expect(
      evaluateToolCall(
        mutation({ folder: escape }),
        policy({ ask: true, knownRoots: ['/home/u/repo'] })
      )
    ).toEqual({ verdict: 'deny', reason: 'PATH_ESCAPE' })
  })

  it('ask mode: a contained subdirectory passes containment', () => {
    expect(
      evaluateToolCall(
        mutation({ folder: '/home/u/repo/packages/app' }),
        policy({ ask: true, knownRoots: ['/home/u/repo'] })
      )
    ).toEqual({ verdict: 'confirm' })
  })
})

describe('evaluateToolCall — absent optional policy fields fail OPEN (the new posture)', () => {
  it('a policy with no denyFolders at all allows a mutation', () => {
    const bare: Policy = { serverEnabled: true, allowFolders: [], knownRoots: [] }
    expect(evaluateToolCall(mutation(), bare)).toEqual({ verdict: 'allow' })
  })

  it('a policy with no `ask` field does not confirm', () => {
    const bare: Policy = { serverEnabled: true, allowFolders: [], knownRoots: [] }
    expect(evaluateToolCall(mutation({ folder: '/anywhere' }), bare).verdict).toBe('allow')
  })
})

describe('normalizePath', () => {
  it('strips a trailing separator', () => {
    expect(normalizePath('/home/u/repo/')).toBe('/home/u/repo')
  })

  it('keeps the filesystem root intact', () => {
    expect(normalizePath('/')).toBe('/')
  })

  it('expands a leading ~ to the home directory', () => {
    expect(normalizePath('~/repo')).toBe(path.join(os.homedir(), 'repo'))
  })

  it('honors an injected home directory', () => {
    expect(normalizePath('~/repo', '/custom/home')).toBe(path.join('/custom/home', 'repo'))
  })

  it('collapses . and .. segments', () => {
    expect(normalizePath('/a/b/../c')).toBe('/a/c')
    expect(normalizePath('/a/./b')).toBe('/a/b')
  })
})

/**
 * `resolveKnownFolder` — the 2026-07-13 agent-pane-routing design's routing
 * canonicalization: a pane-routing key must be the CANONICAL path of a known
 * folder, never the agent's raw spelling (the hidden second cause behind
 * BUG-20 — a trailing slash / `~` spelling minting a phantom key that appends
 * to a stack no session renders).
 */
describe('resolveKnownFolder (2026-07-13 agent-pane-routing design)', () => {
  const known = ['/home/u/repo', '/home/u/repo-worktrees/feature']

  it('exact match → returns the canonical path unchanged', () => {
    expect(resolveKnownFolder('/home/u/repo', known)).toBe('/home/u/repo')
  })

  it('a trailing slash resolves to the SAME known folder (no phantom key)', () => {
    expect(resolveKnownFolder('/home/u/repo/', known)).toBe('/home/u/repo')
  })

  it('a ~-relative spelling resolves against the injected home dir', () => {
    expect(resolveKnownFolder('~/repo', known, '/home/u')).toBe('/home/u/repo')
  })

  it('./.. segments normalize to the same known folder', () => {
    expect(resolveKnownFolder('/home/u/repo/../repo', known)).toBe('/home/u/repo')
  })

  it('an unknown folder resolves to undefined — never a fallback guess', () => {
    expect(resolveKnownFolder('/home/u/unknown-folder', known)).toBeUndefined()
  })

  it('a folder that is merely a PREFIX of a known one is not a match', () => {
    expect(resolveKnownFolder('/home/u/repo-worktrees', known)).toBeUndefined()
  })

  it('an empty known-folder list always resolves to undefined', () => {
    expect(resolveKnownFolder('/home/u/repo', [])).toBeUndefined()
  })
})
