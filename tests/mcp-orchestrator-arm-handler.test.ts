import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * T309 — `orchestrator_arm` / `orchestrator_disarm` driven through the REAL
 * wired handlers (mirrors `tests/mcp-speak-handler.test.ts`'s harness).
 *
 * `electron` is mocked so `orchestrator-guard.ts`'s `app.getPath('userData')`
 * points at a fresh tmpdir per test (same approach as
 * `tests/orchestrator-guard.test.ts`). `pty.ts`'s `sessionOwnedByHarnu` /
 * `spawnOriginForSession` are the only two functions overridden (via
 * `importOriginal` passthrough for everything else this module needs) — they
 * are backed by live PTY/hibernation state this process never spawns, so a
 * unit test controls them directly instead of faking a whole process tree.
 *
 * The claims this file exists to prove are about the SHIPPED WIRING
 * (ADR-0013): the target predicate order, that `arm`/`disarm` are actually
 * called with the right arguments, and that the guard's OWN blocking
 * behaviour (armed.json → the PreToolUse hook) is exercised end-to-end via
 * the real `orchestrator-guard.ts` — not re-asserted here, since
 * `tests/orchestrator-guard.test.ts` / `tests/orchestrator-guard-script.test.ts`
 * already own that contract.
 */

let userDataDir = ''
vi.mock('electron', () => ({
  app: {
    getPath: () => userDataDir,
    isPackaged: false,
    getAppPath: () => process.cwd()
  },
  ipcMain: { handle: (): void => {}, on: (): void => {} }
}))

const ownership = vi.hoisted(() => ({
  owned: new Set<string>(),
  origin: new Map<string, 'operator' | 'agent'>()
}))

vi.mock('../src/main/pty', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/main/pty')>()
  return {
    ...actual,
    sessionOwnedByHarnu: (key: string) => ownership.owned.has(key),
    spawnOriginForSession: (key: string) => ownership.origin.get(key)
  }
})

import { WIRED_TOOLS } from '../src/main/mcp/tool-handlers'
import { isArmed, listArmedSessionIds } from '../src/main/orchestrator-guard'
import type { FolderEntry } from '../src/main/folder-model'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'

const armHandler = WIRED_TOOLS.find((t) => t.op === 'orchestrator_arm')!.handler!
const disarmHandler = WIRED_TOOLS.find((t) => t.op === 'orchestrator_disarm')!.handler!

// A REAL tmpdir (not a fake path) — `arm()` writes a real `.claude/settings.local.json`
// under it, so a fake path would fail EACCES/ENOENT noise on every arm.
let folder = ''

function folderWithSession(sessionId: string, projectPath = folder): FolderEntry[] {
  return [
    {
      path: projectPath,
      alias: 'repo',
      sessions: [
        {
          sessionId,
          fullPath: '',
          fileMtime: 0,
          firstPrompt: '',
          summary: '',
          messageCount: 0,
          created: '',
          modified: '',
          gitBranch: '',
          projectPath,
          isSidechain: false,
          status: 'active',
          agents: [],
          resumable: true
        } as unknown as FolderEntry['sessions'][number]
      ]
    }
  ]
}

function ctxFor(
  folders: FolderEntry[],
  extra: Record<string, unknown> = {}
): Parameters<typeof armHandler>[1] {
  return {
    folder,
    folders,
    denyFolders: [],
    bridge: undefined,
    ...extra
  } as Parameters<typeof armHandler>[1]
}

function payload(res: CallToolResult): Record<string, unknown> {
  const first = res.content[0]
  if (!first || first.type !== 'text') throw new Error('expected a text content block')
  return JSON.parse(first.text)
}

function errorPayload(res: CallToolResult): Record<string, unknown> {
  const first = res.content[0]
  if (!first || first.type !== 'text') throw new Error('expected a text content block')
  return JSON.parse(first.text)
}

beforeEach(() => {
  userDataDir = mkdtempSync(join(tmpdir(), 'orchestrator-arm-handler-userdata-'))
  folder = mkdtempSync(join(tmpdir(), 'orchestrator-arm-handler-folder-'))
  ownership.owned.clear()
  ownership.origin.clear()
})

describe('AC-1 — the verbs are wired and reach the real guard', () => {
  it('are registered in the catalog with a handler each', () => {
    expect(WIRED_TOOLS.find((t) => t.name === 'orchestrator_arm')?.handler).toBeTypeOf('function')
    expect(WIRED_TOOLS.find((t) => t.name === 'orchestrator_disarm')?.handler).toBeTypeOf(
      'function'
    )
  })
})

describe('AC-2/AC-4 — arm actually flips the guard, and is idempotent', () => {
  it('arms the real armed.json entry for the target session', async () => {
    ownership.owned.add('sess-1')
    ownership.origin.set('sess-1', 'agent')

    const res = await armHandler({ sessionId: 'sess-1' }, ctxFor(folderWithSession('sess-1')))
    expect(res.isError).toBeFalsy()
    expect(payload(res)).toMatchObject({ ok: true, op: 'orchestrator_arm', sessionId: 'sess-1' })
    expect(await isArmed('sess-1')).toBe(true)
  })

  it('re-arming an already-armed session is a no-op that still confirms armed', async () => {
    ownership.owned.add('sess-1')
    ownership.origin.set('sess-1', 'agent')
    const ctx = ctxFor(folderWithSession('sess-1'))

    await armHandler({ sessionId: 'sess-1' }, ctx)
    const second = await armHandler({ sessionId: 'sess-1' }, ctx)
    expect(second.isError).toBeFalsy()
    expect(await isArmed('sess-1')).toBe(true)
  })

  it('registers the folder hook (readable via the real settings.local.json)', async () => {
    ownership.owned.add('sess-1')
    ownership.origin.set('sess-1', 'agent')

    await armHandler({ sessionId: 'sess-1' }, ctxFor(folderWithSession('sess-1')))

    const settings = JSON.parse(
      readFileSync(join(folder, '.claude', 'settings.local.json'), 'utf8')
    ) as { hooks?: Record<string, unknown[]> }
    expect(settings.hooks?.PreToolUse).toHaveLength(1)
  })
})

describe('AC-3 — disarm is reachable by the same caller, and a no-op if never armed', () => {
  it('disarms a previously armed session', async () => {
    ownership.owned.add('sess-1')
    ownership.origin.set('sess-1', 'agent')
    const ctx = ctxFor(folderWithSession('sess-1'))
    await armHandler({ sessionId: 'sess-1' }, ctx)
    expect(await isArmed('sess-1')).toBe(true)

    const res = await disarmHandler({ sessionId: 'sess-1' }, ctx)
    expect(res.isError).toBeFalsy()
    expect(payload(res)).toMatchObject({ ok: true, op: 'orchestrator_disarm', armed: false })
    expect(await isArmed('sess-1')).toBe(false)
  })

  it('disarming a session that was never armed is a safe no-op, not an error', async () => {
    ownership.owned.add('sess-1')
    ownership.origin.set('sess-1', 'agent')
    const res = await disarmHandler({ sessionId: 'sess-1' }, ctxFor(folderWithSession('sess-1')))
    expect(res.isError).toBeFalsy()
    expect(await isArmed('sess-1')).toBe(false)
  })
})

describe('AC-5 — armed state is visible where get_fleet/get_session already read it', () => {
  it('listArmedSessionIds sees the session the handler just armed', async () => {
    ownership.owned.add('sess-1')
    ownership.origin.set('sess-1', 'agent')
    await armHandler({ sessionId: 'sess-1' }, ctxFor(folderWithSession('sess-1')))
    expect(await listArmedSessionIds()).toContain('sess-1')
  })
})

describe('ADR-0013 — target scope: SESSION_NOT_FOUND / TARGET_NOT_HARNU_SPAWNED / TARGET_OPERATOR_OWNED', () => {
  it('an id Harnu has never seen (on disk or in flight) refuses SESSION_NOT_FOUND', async () => {
    const res = await armHandler({ sessionId: 'ghost' }, ctxFor([]))
    expect(res.isError).toBe(true)
    expect(errorPayload(res).error).toBe('SESSION_NOT_FOUND')
    expect(await isArmed('ghost')).toBe(false)
  })

  it('a known session Harnu holds no process for refuses TARGET_NOT_HARNU_SPAWNED', async () => {
    // known on disk, but never added to `ownership.owned`
    const res = await armHandler(
      { sessionId: 'cold-transcript' },
      ctxFor(folderWithSession('cold-transcript'))
    )
    expect(res.isError).toBe(true)
    expect(errorPayload(res).error).toBe('TARGET_NOT_HARNU_SPAWNED')
    expect(await isArmed('cold-transcript')).toBe(false)
  })

  it('a session the OPERATOR opened refuses TARGET_OPERATOR_OWNED, never arms it', async () => {
    ownership.owned.add('operator-sess')
    ownership.origin.set('operator-sess', 'operator')
    const res = await armHandler(
      { sessionId: 'operator-sess' },
      ctxFor(folderWithSession('operator-sess'))
    )
    expect(res.isError).toBe(true)
    expect(errorPayload(res).error).toBe('TARGET_OPERATOR_OWNED')
    expect(await isArmed('operator-sess')).toBe(false)
  })

  it('an absent spawn origin fails CLOSED (treated as operator-owned), never arms it', async () => {
    ownership.owned.add('unmarked')
    // no origin recorded at all
    const res = await armHandler({ sessionId: 'unmarked' }, ctxFor(folderWithSession('unmarked')))
    expect(res.isError).toBe(true)
    expect(errorPayload(res).error).toBe('TARGET_OPERATOR_OWNED')
  })

  it('the same three refusals apply identically to orchestrator_disarm', async () => {
    const notFound = await disarmHandler({ sessionId: 'ghost' }, ctxFor([]))
    expect(errorPayload(notFound).error).toBe('SESSION_NOT_FOUND')

    const notSpawned = await disarmHandler({ sessionId: 'cold' }, ctxFor(folderWithSession('cold')))
    expect(errorPayload(notSpawned).error).toBe('TARGET_NOT_HARNU_SPAWNED')

    ownership.owned.add('op-sess')
    ownership.origin.set('op-sess', 'operator')
    const operatorOwned = await disarmHandler(
      { sessionId: 'op-sess' },
      ctxFor(folderWithSession('op-sess'))
    )
    expect(errorPayload(operatorOwned).error).toBe('TARGET_OPERATOR_OWNED')
  })

  it('an empty sessionId is refused before any lookup', async () => {
    const res = await armHandler({}, ctxFor([]))
    expect(res.isError).toBe(true)
    expect(errorPayload(res).error).toBe('SESSION_NOT_FOUND')
  })
})
