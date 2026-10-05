import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * T31 — the Sentinel resolver over the T30 substrate. The electron mock points
 * app.getPath at a tmpdir (responder-registry writes prefs there). All the risk
 * logic is the pure classifier (tests/sentinel-core.test.ts); this pins the ramp
 * composition: deny only when active + on-ramp, preview otherwise, always visible.
 */
let userDataDir = ''
vi.mock('electron', () => ({
  app: { getPath: () => userDataDir }
}))

import { sentinelResolver } from '../src/main/sentinel-resolver'
import {
  writeMode,
  setInterceptFolders,
  getShadowLog,
  _resetResponderState
} from '../src/main/responder-registry'
import { parseHookRequest } from '../src/main/responder-dispatch'

const WT = '/repo/wt'
const req = (command: string, event = 'PreToolUse'): ReturnType<typeof parseHookRequest> =>
  parseHookRequest(
    event,
    undefined,
    { session_id: 'S1', cwd: WT, tool_name: 'Bash', tool_input: { command } },
    'S1'
  )
const run = (r: ReturnType<typeof parseHookRequest>): unknown =>
  sentinelResolver.resolve(r, new AbortController().signal)

beforeEach(() => {
  userDataDir = mkdtempSync(join(tmpdir(), 'sentinel-'))
  _resetResponderState()
})

describe('sentinel resolver — runs before the inbox (priority)', () => {
  it('priority is below the approval-inbox resolver (50) so it pre-empts', () => {
    expect(sentinelResolver.priority).toBeLessThan(50)
  })
})

describe('active + on-ramp → auto-DENY the catastrophe', () => {
  beforeEach(async () => {
    await writeMode('active')
    setInterceptFolders([WT])
  })

  it('denies rm -rf / and records a by:sentinel shadow entry', () => {
    const out = run(req('rm -rf /')) as { permissionDecision: string; by: string } | null
    expect(out).toEqual({
      permissionDecision: 'deny',
      reason: expect.stringContaining('Harnu Sentinel blocked'),
      by: 'sentinel'
    })
    const log = getShadowLog()
    expect(log).toHaveLength(1)
    expect(log[0]).toMatchObject({ by: 'sentinel', sessionId: 'S1' })
  })

  it('abstains (null) on a benign command, no shadow entry', () => {
    expect(run(req('ls -la'))).toBeNull()
    expect(getShadowLog()).toHaveLength(0)
  })

  it('abstains on a non-gated event even if the command is dangerous', () => {
    expect(run(req('rm -rf /', 'UserPromptSubmit'))).toBeNull()
    expect(getShadowLog()).toHaveLength(0)
  })
})

describe('preview modes → would-deny, never actually deny', () => {
  it('shadow mode: dangerous → null + a would-deny shadow entry', async () => {
    await writeMode('shadow')
    expect(run(req('rm -rf /'))).toBeNull()
    expect(getShadowLog()).toHaveLength(1)
    expect(getShadowLog()[0]).toMatchObject({ by: 'sentinel' })
  })

  it('active but OFF-ramp: dangerous → null + a would-deny shadow entry', async () => {
    await writeMode('active')
    setInterceptFolders(['/some/other'])
    expect(run(req('rm -rf /'))).toBeNull()
    expect(getShadowLog()).toHaveLength(1)
  })

  it('off mode: inert — null, no shadow entry', async () => {
    await writeMode('off')
    expect(run(req('rm -rf /'))).toBeNull()
    expect(getShadowLog()).toHaveLength(0)
  })
})
