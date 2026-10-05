import { describe, it, expect } from 'vitest'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  assemblePolicy,
  type McpPolicyPrefs,
  type PolicyFolderInput
} from '../src/main/mcp/policy-assemble'
import { evaluateToolCall, type Policy } from '../src/main/mcp/permission-core'

/**
 * T15 — `assemblePolicy` is the PURE assembler that turns user prefs + pinned
 * folders + scanned roots into the {@link Policy} snapshot T3's `evaluateToolCall`
 * consumes. It reuses the SAME `normalizePath` as permission-core so the two layers
 * agree bit-for-bit on path identity (trailing-slash / `~` variants collapse equal).
 * Pure: no fs/electron/timers, deterministic, in the pure-core coverage surface.
 *
 * POST-REVERSAL contract pinned here: there is no allowlist to assemble. The only
 * per-folder output the gate reads is `denyFolders` (the blocks). `allowFolders`
 * survives as the DISCLOSURE set — every known root minus the blocked subtrees —
 * consumed by the fleet/worktree redaction, never by the gate.
 */

/** A healthy default prefs object; `over` wins per-field. */
const prefs = (over: Partial<McpPolicyPrefs> = {}): McpPolicyPrefs => ({
  serverEnabled: true,
  ...over
})

/** Shorthand for one pinned/user folder row (unblocked unless stated). */
const folder = (p: string, agentDenied = false): PolicyFolderInput => ({
  path: p,
  agentDenied
})

const HOME = '/home/u'

describe('assemblePolicy — prefs pass through', () => {
  it('carries serverEnabled:true through', () => {
    expect(assemblePolicy(prefs({ serverEnabled: true }), [], []).serverEnabled).toBe(true)
  })

  it('carries serverEnabled:false through (kill switch)', () => {
    expect(assemblePolicy(prefs({ serverEnabled: false }), [], []).serverEnabled).toBe(false)
  })

  it('omits `ask` by default (the free posture)', () => {
    expect(assemblePolicy(prefs(), [], []).ask).toBeUndefined()
  })

  it('carries ask:true through (the friction opt-in)', () => {
    expect(assemblePolicy(prefs({ ask: true }), [], []).ask).toBe(true)
  })
})

describe('assemblePolicy — knownRoots = normalized(pinned ∪ scanned)', () => {
  it('unions pinned folders and scanned roots', () => {
    const pol = assemblePolicy(
      prefs(),
      [folder('/home/u/repo'), folder('/home/u/other')],
      ['/var/scan/a'],
      HOME
    )
    expect(pol.knownRoots).toEqual(['/home/u/repo', '/home/u/other', '/var/scan/a'])
  })

  it('includes a BLOCKED folder in knownRoots (it is still a known root)', () => {
    const pol = assemblePolicy(prefs(), [folder('/home/u/repo', true)], [], HOME)
    expect(pol.knownRoots).toEqual(['/home/u/repo'])
  })

  it('dedupes a path that appears in both pinned and scanned', () => {
    const pol = assemblePolicy(prefs(), [folder('/home/u/repo')], ['/home/u/repo'], HOME)
    expect(pol.knownRoots).toEqual(['/home/u/repo'])
  })
})

describe('assemblePolicy — denyFolders = the folders the operator BLOCKED', () => {
  it('only agentDenied folders land in denyFolders', () => {
    const pol = assemblePolicy(
      prefs(),
      [folder('/home/u/free'), folder('/home/u/blocked', true), folder('/home/u/free2')],
      [],
      HOME
    )
    expect(pol.denyFolders).toEqual(['/home/u/blocked'])
  })

  it('no blocks at all → an empty denylist (nothing is refused)', () => {
    const pol = assemblePolicy(prefs(), [folder('/home/u/a'), folder('/home/u/b')], [], HOME)
    expect(pol.denyFolders).toEqual([])
  })

  it('a scanned root is never auto-blocked', () => {
    const pol = assemblePolicy(prefs(), [], ['/var/scan/a'], HOME)
    expect(pol.denyFolders).toEqual([])
  })

  it('DEPRECATED `agentAllowed` is IGNORED — a legacy false record is not blocked', () => {
    // The retroactivity proof at the assembler level: a record written before the
    // reversal says `agentAllowed: false`, and nothing on disk is migrated.
    const legacy: PolicyFolderInput = { path: '/home/u/legacy', agentAllowed: false }
    const pol = assemblePolicy(prefs(), [legacy], [], HOME)
    expect(pol.denyFolders).toEqual([])
    expect(pol.allowFolders).toEqual(['/home/u/legacy'])
  })

  it('a legacy `agentAllowed: false` record can still be blocked explicitly', () => {
    const both: PolicyFolderInput = {
      path: '/home/u/legacy',
      agentAllowed: false,
      agentDenied: true
    }
    expect(assemblePolicy(prefs(), [both], [], HOME).denyFolders).toEqual(['/home/u/legacy'])
  })
})

describe('assemblePolicy — allowFolders is the DISCLOSURE set, not a gate', () => {
  it('every known root is disclosable by default (pinned AND scanned)', () => {
    const pol = assemblePolicy(prefs(), [folder('/home/u/repo')], ['/var/scan/a'], HOME)
    expect(pol.allowFolders).toEqual(['/home/u/repo', '/var/scan/a'])
  })

  it('a BLOCKED folder is dropped from the disclosure set', () => {
    const pol = assemblePolicy(
      prefs(),
      [folder('/home/u/repo'), folder('/home/u/secret', true)],
      [],
      HOME
    )
    expect(pol.allowFolders).toEqual(['/home/u/repo'])
  })

  it('a known root INSIDE a blocked folder is dropped too (prefix-scoped)', () => {
    const pol = assemblePolicy(
      prefs(),
      [folder('/home/u/repo', true), folder('/home/u/repo/.claude/worktrees/wt')],
      [],
      HOME
    )
    expect(pol.allowFolders).toEqual([])
    expect(pol.knownRoots).toEqual(['/home/u/repo', '/home/u/repo/.claude/worktrees/wt'])
  })
})

describe('assemblePolicy — normalization parity with permission-core', () => {
  it('trailing-slash variants collapse to one knownRoot', () => {
    const pol = assemblePolicy(prefs(), [folder('/home/u/repo/')], ['/home/u/repo'], HOME)
    expect(pol.knownRoots).toEqual(['/home/u/repo'])
  })

  it('a ~ variant normalizes equal to its absolute twin', () => {
    const pol = assemblePolicy(prefs(), [folder('~/repo')], [`${HOME}/repo`], HOME)
    expect(pol.knownRoots).toEqual([`${HOME}/repo`])
  })

  it('a blocked path is normalized before it lands in denyFolders', () => {
    const pol = assemblePolicy(prefs(), [folder('/home/u/a/../blocked/', true)], [], HOME)
    expect(pol.denyFolders).toEqual(['/home/u/blocked'])
  })

  it('defaults the home dir to os.homedir() when none is injected', () => {
    const pol = assemblePolicy(prefs(), [folder('~/repo')], [])
    expect(pol.knownRoots).toEqual([path.join(os.homedir(), 'repo')])
  })
})

describe('assemblePolicy — output is consumable by evaluateToolCall (T3)', () => {
  it('a mutation in a pinned, unblocked folder is ALLOWED (no confirm)', () => {
    const pol: Policy = assemblePolicy(prefs(), [folder('/home/u/repo/')], [], HOME)
    expect(
      evaluateToolCall({ tool: 'session_send', kind: 'mutation', folder: '/home/u/repo' }, pol)
    ).toEqual({ verdict: 'allow' })
  })

  it('a mutation in a folder NOBODY pinned is ALLOWED (the reported bug)', () => {
    const pol = assemblePolicy(prefs(), [], [], HOME)
    expect(
      evaluateToolCall({ tool: 'create_session', kind: 'mutation', folder: '/tmp/new' }, pol)
    ).toEqual({ verdict: 'allow' })
  })

  it('a legacy agentAllowed:false record is STILL allowed end-to-end (retroactive)', () => {
    const pol = assemblePolicy(prefs(), [{ path: '/home/u/legacy', agentAllowed: false }], [], HOME)
    expect(
      evaluateToolCall({ tool: 'create_session', kind: 'mutation', folder: '/home/u/legacy' }, pol)
        .verdict
    ).toBe('allow')
  })

  it('a blocked folder denies end-to-end, and so does a path inside it', () => {
    const pol = assemblePolicy(prefs(), [folder('/home/u/repo', true)], [], HOME)
    expect(
      evaluateToolCall({ tool: 'create_session', kind: 'mutation', folder: '/home/u/repo' }, pol)
    ).toEqual({ verdict: 'deny', reason: 'FOLDER_NOT_ALLOWED' })
    expect(
      evaluateToolCall(
        { tool: 'create_session', kind: 'mutation', folder: '/home/u/repo/src/deep' },
        pol
      )
    ).toEqual({ verdict: 'deny', reason: 'FOLDER_NOT_ALLOWED' })
  })

  it('ask:true assembles a policy whose mutations confirm', () => {
    const pol = assemblePolicy(prefs({ ask: true }), [folder('/home/u/repo')], [], HOME)
    expect(
      evaluateToolCall({ tool: 'create_session', kind: 'mutation', folder: '/home/u/repo' }, pol)
        .verdict
    ).toBe('confirm')
  })

  it('a disabled assembled policy denies everything', () => {
    const pol = assemblePolicy(prefs({ serverEnabled: false }), [folder('/home/u/repo')], [])
    expect(evaluateToolCall({ tool: 'fleet_status', kind: 'read' }, pol)).toEqual({
      verdict: 'deny',
      reason: 'SERVER_DISABLED'
    })
  })

  it('a mutation outside every known root is ALLOWED in free mode (no containment)', () => {
    const pol = assemblePolicy(prefs(), [folder('/home/u/repo')], [], HOME)
    expect(
      evaluateToolCall(
        { tool: 'session_send', kind: 'mutation', folder: '/home/u/repo/../../etc' },
        pol
      ).verdict
    ).toBe('allow')
  })

  it('…but is PATH_ESCAPE once the operator turns ask on', () => {
    const pol = assemblePolicy(prefs({ ask: true }), [folder('/home/u/repo')], [], HOME)
    expect(
      evaluateToolCall(
        { tool: 'session_send', kind: 'mutation', folder: '/home/u/repo/../../etc' },
        pol
      ).reason
    ).toBe('PATH_ESCAPE')
  })
})

describe('assemblePolicy — does not mutate its inputs', () => {
  it('leaves the userProjects array and entries untouched', () => {
    const projects = [folder('/home/u/repo/', true)]
    const snapshot = JSON.parse(JSON.stringify(projects))
    assemblePolicy(prefs(), projects, ['/var/scan'], HOME)
    expect(projects).toEqual(snapshot)
  })
})
