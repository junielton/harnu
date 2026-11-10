import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * `your_move` driven through the REAL wired handler, the REAL catalog, validator and plan-input
 * seam, and a REAL store and prefs file over a throwaway userData directory. Only `electron`
 * is stubbed, so the handler can find that directory.
 */

const live = vi.hoisted(() => ({ userData: '' }))

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getPath: (): string => live.userData,
    getAppPath: (): string => process.cwd()
  },
  dialog: {},
  shell: {},
  BrowserWindow: class {},
  ipcMain: { handle: (): void => {}, on: (): void => {} }
}))

import { clearAuditLog, getAuditLog } from '../../src/main/mcp/audit-log'
import { buildPlanInput } from '../../src/main/mcp/plan-input'
import { MCP_TOOLS } from '../../src/main/mcp/tool-catalog'
import { WIRED_TOOLS } from '../../src/main/mcp/tool-handlers'
import { parseToolInput } from '../../src/main/mcp/validate'
import {
  YOUR_MOVE_LIMIT_PER_HOUR,
  emptyState,
  fileFromVerb,
  type YourMoveState
} from '../../src/main/your-move/core'
import {
  getSessionArchive,
  openSessionArchive,
  setSessionArchive
} from '../../src/main/session-archive-core'
import type { FolderEntry } from '../../src/main/folder-model'
import { writeYourMovePrefs } from '../../src/main/your-move/prefs'
import {
  openYourMoveStore,
  setYourMoveStore,
  type YourMoveStore
} from '../../src/main/your-move/store'

const tool = WIRED_TOOLS.find((t) => t.op === 'your_move')
const handler = tool?.handler as NonNullable<typeof tool>['handler']

const FOLDER = '/org/proj/www'
const SESSION = 'sess-0001-aaaa'
const HOUR = 3_600_000
/** The start of a UTC hour, so a run of calls never straddles a boundary. */
const T_START = Date.UTC(2026, 10, 9, 10, 0, 0)
/** Each test runs in its own hour: the rate counter is module state shared by the file. */
let T0 = T_START
let testNo = 0

let store: YourMoveStore
let prefsFile: string

const ctx = (): { folder: string; folders: never[]; denyFolders: string[]; bridge: undefined } => ({
  folder: FOLDER,
  folders: [],
  denyFolders: [],
  bridge: undefined
})

function textOf(res: CallToolResult): string {
  const first = res.content[0]
  if (!first || first.type !== 'text') throw new Error('expected text content')
  return first.text
}
const payload = (res: CallToolResult): Record<string, unknown> =>
  JSON.parse(textOf(res)) as Record<string, unknown>

const call = (over: Record<string, unknown> = {}): Promise<CallToolResult> =>
  handler(
    {
      folder: FOLDER,
      sessionId: SESSION,
      kind: 'decide',
      ask: 'Pick the PROJ-231 rollout',
      ...over
    },
    ctx()
  )

const cards = (): YourMoveState['cards'] => store.state().cards

beforeEach(async () => {
  live.userData = mkdtempSync(path.join(os.tmpdir(), 'your-move-verb-'))
  mkdirSync(live.userData, { recursive: true })
  prefsFile = path.join(live.userData, 'your-move-prefs.json')
  store = await openYourMoveStore(path.join(live.userData, 'your-move.json'))
  setYourMoveStore(store)
  await writeYourMovePrefs(prefsFile, { mode: 'live' })
  clearAuditLog()
  T0 = T_START + 3 * HOUR * ++testNo
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(T0 + 5 * 60_000)
})

afterEach(() => {
  vi.useRealTimers()
  setYourMoveStore(null)
  rmSync(live.userData, { recursive: true, force: true })
})

describe('fileFromVerb (pure)', () => {
  const input = {
    folder: FOLDER,
    sessionId: SESSION,
    kind: 'decide' as const,
    ask: '  Ship Acme now or wait?  ',
    options: ['ship', ' ', 'wait'],
    recommended: 'wait',
    lane: 'live' as const
  }

  it('does not mutate its input and files a verb card with the operator clock set', () => {
    const before = emptyState()
    const out = fileFromVerb(before, input, () => 'card-1', 1000)
    expect(before.cards).toEqual([])
    if ('error' in out) throw new Error('unexpected error')
    expect(out).toMatchObject({ cardId: 'card-1', refreshed: false })
    expect(out.state.cards).toEqual([
      expect.objectContaining({
        id: 'card-1',
        sessionId: SESSION,
        folder: FOLDER,
        kind: 'decide',
        ask: 'Ship Acme now or wait?',
        options: ['ship', 'wait'],
        recommended: 'wait',
        source: 'verb',
        lane: 'live',
        openedAt: 1000,
        updatedAt: 1000
      })
    ])
  })

  it('drops a recommended that is not one of the options', () => {
    const out = fileFromVerb(emptyState(), { ...input, recommended: 'abort' }, () => 'c', 1)
    if ('error' in out) throw new Error('unexpected error')
    expect(out.state.cards[0].recommended).toBeUndefined()
  })
})

describe('your_move handler', () => {
  it('is wired as a free mutating verb with no grant', () => {
    const def = MCP_TOOLS.find((t) => t.op === 'your_move')
    expect(def?.name).toBe('your_move')
    expect(def?.mutates).toBe(true)
    expect(def?.silentAllowInAgentFolder).toBe(true)
    expect(def?.alwaysAllowable).toBe(true)
    expect(def?.grantable).toBeUndefined()
    expect(handler).toBeTypeOf('function')
  })

  it('files a card and returns its id', async () => {
    const res = await call({
      blocks: 'the release',
      options: ['ship', 'wait'],
      recommended: 'ship'
    })
    const ack = payload(res)
    expect(ack).toMatchObject({ ok: true, op: 'your_move', refreshed: false })
    expect(typeof ack.cardId).toBe('string')
    expect(cards()).toHaveLength(1)
    expect(cards()[0]).toMatchObject({
      id: ack.cardId,
      sessionId: SESSION,
      folder: FOLDER,
      kind: 'decide',
      ask: 'Pick the PROJ-231 rollout',
      blocks: 'the release',
      options: ['ship', 'wait'],
      recommended: 'ship',
      source: 'verb',
      openedAt: T0 + 5 * 60_000
    })
  })

  it('cardId refreshes ask and updatedAt and keeps openedAt', async () => {
    const first = payload(await call())
    vi.setSystemTime(T0 + 20 * 60_000)
    const again = payload(
      await call({ cardId: first.cardId, ask: 'Pick again: PROJ-231 or PROJ-232' })
    )
    expect(again).toMatchObject({ ok: true, cardId: first.cardId, refreshed: true })
    expect(cards()).toHaveLength(1)
    expect(cards()[0]).toMatchObject({
      ask: 'Pick again: PROJ-231 or PROJ-232',
      openedAt: T0 + 5 * 60_000,
      updatedAt: T0 + 20 * 60_000
    })
  })

  it('a whitespace-only ask is refused and blanks nothing', async () => {
    const refused = await call({ ask: '   \t ' })
    expect(refused.isError).toBe(true)
    expect(textOf(refused)).toMatch(/^BAD_ARGS/)
    expect(cards()).toHaveLength(0)

    // The same call against an existing card must not blank it either.
    const first = payload(await call())
    const blanked = await call({ cardId: first.cardId, ask: '   ' })
    expect(blanked.isError).toBe(true)
    expect(textOf(blanked)).toMatch(/^BAD_ARGS/)
    expect(cards()).toHaveLength(1)
    expect(cards()[0].ask).toBe('Pick the PROJ-231 rollout')

    // The schema refuses it too, so the seam never lets one through.
    const base = { folder: FOLDER, sessionId: SESSION, kind: 'decide' }
    expect(parseToolInput('your_move', { ...base, ask: '   ' }).ok).toBe(false)
  })

  it('cardId of a closed card or another session is CARD_NOT_FOUND', async () => {
    const first = payload(await call())
    const other = await call({ cardId: first.cardId, sessionId: 'sess-0002-bbbb' })
    expect(other.isError).toBe(true)
    expect(textOf(other)).toMatch(/^CARD_NOT_FOUND/)

    await store.transact((s) => ({
      next: {
        ...s,
        cards: s.cards.map((c) => ({ ...c, closedAt: 1, closedBy: 'answered' as const }))
      },
      result: null
    }))
    const closed = await call({ cardId: first.cardId })
    expect(closed.isError).toBe(true)
    expect(textOf(closed)).toMatch(/^CARD_NOT_FOUND/)
    expect(cards()).toHaveLength(1)
  })

  it('the 31st call within an hour for one session is YOUR_MOVE_RATE_LIMIT and appends an audit row', async () => {
    expect(YOUR_MOVE_LIMIT_PER_HOUR).toBe(30)
    for (let i = 0; i < 30; i++) {
      expect((await call({ ask: `ask ${i}` })).isError).toBeUndefined()
    }
    expect(getAuditLog().filter((r) => r.tool === 'your_move')).toHaveLength(0)

    const refused = await call({ ask: 'ask 31' })
    expect(refused.isError).toBe(true)
    expect(textOf(refused)).toMatch(/^YOUR_MOVE_RATE_LIMIT/)
    expect(cards()).toHaveLength(30)
    const rows = getAuditLog().filter((r) => r.tool === 'your_move')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ verdict: 'deny', result: 'YOUR_MOVE_RATE_LIMIT' })
    expect(rows[0].disclosedPayloadSummary).not.toContain('ask 31')

    // Another session is not capped, and the next UTC hour starts a fresh count.
    expect((await call({ sessionId: 'sess-0002-bbbb' })).isError).toBeUndefined()
    vi.setSystemTime(T0 + HOUR + 1000)
    expect((await call()).isError).toBeUndefined()
  })

  it('mode off, or that folder off, is YOUR_MOVE_OFF and files nothing', async () => {
    await writeYourMovePrefs(prefsFile, { mode: 'off' })
    const off = await call()
    expect(off.isError).toBe(true)
    expect(textOf(off)).toMatch(/^YOUR_MOVE_OFF/)

    await writeYourMovePrefs(prefsFile, { mode: 'observe', disabledFolders: ['/org/proj'] })
    const folderOff = await call()
    expect(folderOff.isError).toBe(true)
    expect(textOf(folderOff)).toMatch(/^YOUR_MOVE_OFF/)
    expect(cards()).toHaveLength(0)
  })

  it('a prefs file that was never written means the default, which is off', async () => {
    rmSync(prefsFile)
    expect(textOf(await call())).toMatch(/^YOUR_MOVE_OFF/)
    expect(cards()).toHaveLength(0)
  })

  it('observe files lane observe; live files lane live', async () => {
    await writeYourMovePrefs(prefsFile, { mode: 'observe' })
    await call({ ask: 'one' })
    await writeYourMovePrefs(prefsFile, { mode: 'live' })
    await call({ ask: 'two' })
    expect(cards().map((c) => [c.ask, c.lane])).toEqual([
      ['one', 'observe'],
      ['two', 'live']
    ])
  })

  it('answers with a refusal, never a throw, when the store could not be opened', async () => {
    setYourMoveStore(null)
    const res = await call()
    expect(res.isError).toBe(true)
    expect(textOf(res)).toMatch(/^YOUR_MOVE_UNAVAILABLE/)
  })

  it('answers with a refusal when the write fails, and the state stays as it was', async () => {
    const failing: YourMoveStore = {
      ...store,
      transact: () => Promise.reject(new Error('disk full'))
    }
    setYourMoveStore(failing)
    const res = await call()
    expect(res.isError).toBe(true)
    expect(textOf(res)).toMatch(/^YOUR_MOVE_WRITE_FAILED/)
    expect(textOf(res)).toContain('disk full')
    expect(cards()).toHaveLength(0)
  })

  it('reads the prefs file ipc.ts writes', () => {
    const ipc = readFileSync(path.join(process.cwd(), 'src/main/your-move/ipc.ts'), 'utf8')
    expect(ipc).toContain("const PREFS_FILE = 'your-move-prefs.json'")
  })
})

describe('your_move schema', () => {
  const ok = { folder: FOLDER, sessionId: SESSION, kind: 'decide', ask: 'Pick' }
  const parse = (over: Record<string, unknown>): ReturnType<typeof parseToolInput> =>
    parseToolInput('your_move', { ...ok, ...over })

  it('accepts the documented shape and rejects what is out of range', () => {
    expect(parse({}).ok).toBe(true)
    expect(parse({ cardId: 'c-1', blocks: 'x', options: ['a'], recommended: 'a' }).ok).toBe(true)
    expect(parse({ folder: 'relative/dir' }).ok).toBe(false)
    expect(parse({ sessionId: '' }).ok).toBe(false)
    expect(parse({ kind: 'maybe' }).ok).toBe(false)
    expect(parse({ ask: '' }).ok).toBe(false)
    expect(parse({ ask: 'x'.repeat(501) }).ok).toBe(false)
    expect(parse({ ask: 'x'.repeat(500) }).ok).toBe(true)
    expect(parse({ blocks: 'x'.repeat(501) }).ok).toBe(false)
    expect(parse({ options: ['a', 'b', 'c', 'd', 'e', 'f', 'g'] }).ok).toBe(false)
    expect(parse({ options: ['a', 'b', 'c', 'd', 'e', 'f'] }).ok).toBe(true)
    expect(parse({ options: [''] }).ok).toBe(false)
    expect(parse({ options: ['x'.repeat(121)] }).ok).toBe(false)
    expect(parse({ recommended: 'x'.repeat(121) }).ok).toBe(false)
  })

  it('carries every field through the plan-input seam, anchored on the folder', () => {
    const input = buildPlanInput('your_move', { ...ok, options: ['a'], cardId: 'c-1' }, FOLDER)
    expect(parseToolInput('your_move', input).ok).toBe(true)
    expect(input).toMatchObject({ folder: FOLDER, sessionId: SESSION, cardId: 'c-1' })
  })

  it('the schema has no close field and the catalog has no close verb', () => {
    const def = MCP_TOOLS.find((t) => t.op === 'your_move')
    const keys = Object.keys((def?.inputSchema as { shape: Record<string, unknown> }).shape)
    expect(keys.sort()).toEqual(
      ['ask', 'blocks', 'cardId', 'folder', 'kind', 'options', 'recommended', 'sessionId'].sort()
    )
    expect(keys.filter((k) => /close|dismiss|resolve|status|answer|done/i.test(k))).toEqual([])

    // No verb at all closes, dismisses or resolves a Your move card.
    const names = MCP_TOOLS.map((t) => t.name)
    expect(names.filter((n) => n.includes('your_move'))).toEqual(['your_move'])
    expect(names.filter((n) => /(close|dismiss|resolve)_(card|your_move)/.test(n))).toEqual([])

    // A close field smuggled into the call is dropped by the validator, never acted on.
    const parsed = parseToolInput('your_move', { ...ok, close: true, closedAt: 1 })
    expect(parsed.ok).toBe(true)
    if (parsed.ok) expect(Object.keys(parsed.value as object)).not.toContain('close')
  })
})

describe('archive_session never closes a Your move card for an agent', () => {
  const archiveTool = WIRED_TOOLS.find((t) => t.op === 'archive_session')
  const archiveHandler = archiveTool?.handler as NonNullable<typeof archiveTool>['handler']
  const entry = (ids: string[]): FolderEntry =>
    ({
      path: FOLDER,
      alias: 'www',
      sessions: ids.map((sessionId) => ({ sessionId, projectPath: FOLDER }))
    }) as unknown as FolderEntry
  const archiveCtx = (): {
    folder: string
    folders: FolderEntry[]
    denyFolders: string[]
    bridge: undefined
  } => ({
    folder: '',
    folders: [entry([SESSION, 'sess-clean-0001'])],
    denyFolders: [],
    bridge: undefined
  })
  type Row = { sessionId: string; outcome: string; reason?: string }
  const rowsOf = (res: CallToolResult): Row[] => payload(res).results as Row[]

  beforeEach(async () => {
    setSessionArchive(await openSessionArchive(path.join(live.userData, 'archived-sessions.json')))
  })
  afterEach(() => setSessionArchive(null))

  it('archive_session refuses a session with an open card', async () => {
    await call()
    const res = await archiveHandler({ sessionIds: [SESSION, 'sess-clean-0001'] }, archiveCtx())
    expect(rowsOf(res)).toEqual([
      { sessionId: SESSION, outcome: 'refused', reason: 'OPEN_CARDS' },
      { sessionId: 'sess-clean-0001', outcome: 'archived' }
    ])
    expect(payload(res).ok).toBe(false)
    expect(getSessionArchive()?.has(SESSION)).toBe(false)
    expect(getSessionArchive()?.has('sess-clean-0001')).toBe(true)
    expect(cards()).toHaveLength(1)
    expect(cards()[0].closedAt).toBeUndefined()
  })

  it('a closed card no longer blocks the archive', async () => {
    await call()
    await store.transact((s) => ({
      next: {
        ...s,
        cards: s.cards.map((c) => ({ ...c, closedAt: 1, closedBy: 'answered' as const }))
      },
      result: null
    }))
    const res = await archiveHandler({ sessionIds: [SESSION] }, archiveCtx())
    expect(rowsOf(res)).toEqual([{ sessionId: SESSION, outcome: 'archived' }])
  })

  it('archive_session is unaffected when the mode is Off', async () => {
    await call()
    await writeYourMovePrefs(prefsFile, { mode: 'off' })
    const res = await archiveHandler({ sessionIds: [SESSION] }, archiveCtx())
    expect(rowsOf(res)).toEqual([{ sessionId: SESSION, outcome: 'archived' }])
  })

  it('archive_session is unaffected when the store is unavailable', async () => {
    await call()
    setYourMoveStore(null)
    const res = await archiveHandler({ sessionIds: [SESSION] }, archiveCtx())
    expect(rowsOf(res)).toEqual([{ sessionId: SESSION, outcome: 'archived' }])
  })

  it('unarchive is unaffected by an open card', async () => {
    await call()
    await getSessionArchive()?.transact(() => ({ archive: [SESSION], result: null }))
    const res = await archiveHandler({ sessionIds: [SESSION], unarchive: true }, archiveCtx())
    expect(rowsOf(res)).toEqual([{ sessionId: SESSION, outcome: 'restored' }])
  })
})
