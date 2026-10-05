import { describe, it, expect, beforeEach, vi } from 'vitest'
import * as os from 'node:os'

vi.mock('electron', () => ({
  app: { getPath: (): string => os.tmpdir(), isPackaged: false, getAppPath: () => process.cwd() },
  dialog: {},
  shell: {},
  BrowserWindow: class {},
  ipcMain: { handle: (): void => {}, on: (): void => {} }
}))

// The gate's STORE is the env-bound half (`<userData>/voice-prefs.json`, cached
// for the life of the process). Stubbing it here keeps these tests about the
// handler's own decisions and their ORDER; the store's read/write round-trip has
// its own file, and every rule it applies is pure and tested in
// `tests/speech-gate-core.test.ts`.
const agentPrefs = vi.hoisted(() => ({
  current: { version: 1, folders: {} } as {
    version: 1
    global?: boolean
    folders: Record<string, boolean | undefined>
  }
}))
vi.mock('../src/main/speech', () => ({
  readAgentSpeechPrefs: async () => agentPrefs.current
}))

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import type { CommandBridge } from '../src/main/command-bridge'
import { WIRED_TOOLS } from '../src/main/mcp/tool-handlers'
import { __resetSpeakRateForTests } from '../src/main/mcp/speak-rate-registry'
import { SPEAK_RATE_LIMIT } from '../src/main/speech-gate-core'
import { SPEAK_MAX_CHARS } from '../src/main/speech-text'

/**
 * T238 — `speak` driven through the REAL wired handler.
 *
 * The claims this file exists to prove are claims about the SHIPPED SHELL, not
 * about a pure function: that a refused folder never reaches the bridge, that the
 * bridge only ever sees `speech.say` (never `notify.push`), and that an over-cap
 * line is truncated on its way out rather than refused. Harness borrowed from
 * `tests/mcp-draw-canvas-handler.test.ts`.
 */
const speakHandler = WIRED_TOOLS.find((t) => t.op === 'speak')!.handler!

const FOLDER = '/home/u/repo'

interface Dispatched {
  command: string
  payload: unknown
}

/** A bridge that records every dispatch and answers with `reply`. */
function fakeBridge(reply: unknown = { spoken: true }): {
  bridge: CommandBridge
  calls: Dispatched[]
} {
  const calls: Dispatched[] = []
  const bridge = {
    dispatch: async (command: string, payload: unknown): Promise<unknown> => {
      calls.push({ command, payload })
      return reply
    }
  } as unknown as CommandBridge
  return { bridge, calls }
}

function ctxFor(
  bridge: CommandBridge | undefined,
  extra: Record<string, unknown> = {}
): Parameters<typeof speakHandler>[1] {
  return {
    folder: FOLDER,
    folders: [],
    denyFolders: [],
    bridge,
    ...extra
  } as Parameters<typeof speakHandler>[1]
}

function payload(res: CallToolResult): Record<string, unknown> {
  const first = res.content[0]
  if (!first || first.type !== 'text') throw new Error('expected a text content block')
  return JSON.parse(first.text)
}

/** A steerable refusal serialises as JSON; a bare one is a plain `CODE: detail`. */
function errorPayload(res: CallToolResult): Record<string, unknown> {
  return JSON.parse(errorText(res))
}

/** The raw refusal text, for the bare (unsteered) codes. */
function errorText(res: CallToolResult): string {
  const first = res.content[0]
  if (!first || first.type !== 'text') throw new Error('expected a text content block')
  return first.text
}

beforeEach(() => {
  agentPrefs.current = { version: 1, global: true, folders: {} }
  __resetSpeakRateForTests()
})

describe('AC-1 — the verb is wired and reaches the engine', () => {
  it('is registered in the catalog and has a handler', () => {
    const def = WIRED_TOOLS.find((t) => t.name === 'speak')
    expect(def).toBeDefined()
    expect(def?.op).toBe('speak')
    expect(typeof def?.handler).toBe('function')
  })

  it('dispatches speech.say with the folder, the text and the caller id', async () => {
    const { bridge, calls } = fakeBridge()
    const res = await speakHandler(
      { folder: FOLDER, text: 'The migration finished, zero conflicts.', sessionId: 'sess-1' },
      ctxFor(bridge)
    )
    expect(res.isError).toBeFalsy()
    expect(calls).toEqual([
      {
        command: 'speech.say',
        payload: {
          folderPath: FOLDER,
          text: 'The migration finished, zero conflicts.',
          sessionId: 'sess-1'
        }
      }
    ])
    expect(payload(res)).toMatchObject({ ok: true, op: 'speak', spoken: true, truncated: false })
  })

  it('with no bridge it refuses instead of pretending it spoke', async () => {
    const res = await speakHandler({ folder: FOLDER, text: 'hi' }, ctxFor(undefined))
    expect(res.isError).toBe(true)
  })

  it('an unresolved gate folder refuses rather than answering for the app cwd', async () => {
    const { bridge, calls } = fakeBridge()
    const res = await speakHandler({ text: 'hi' }, ctxFor(bridge, { folder: '' }))
    expect(res.isError).toBe(true)
    expect(errorText(res)).toContain('folder is required')
    expect(calls).toHaveLength(0)
  })

  it('an utterance that normalises to nothing is BAD_ARGS, not a silent success', async () => {
    const { bridge, calls } = fakeBridge()
    const res = await speakHandler({ folder: FOLDER, text: '   ' }, ctxFor(bridge))
    expect(res.isError).toBe(true)
    expect(calls).toHaveLength(0)
  })
})

describe('AC-2 — ephemeral: no Activity row, no toast', () => {
  it('the ONLY thing the bridge ever sees is speech.say', async () => {
    const { bridge, calls } = fakeBridge()
    await speakHandler({ folder: FOLDER, text: 'done', sessionId: 's' }, ctxFor(bridge))
    expect(calls.map((c) => c.command)).toEqual(['speech.say'])
    // The regression this pins: routing a read-aloud through `notify` would fill
    // the Activity history with sentences the operator already heard.
    expect(calls.some((c) => c.command === 'notify.push')).toBe(false)
  })

  it('the ACK carries no notification id — there is nothing to come back to', async () => {
    const { bridge } = fakeBridge()
    const res = await speakHandler({ folder: FOLDER, text: 'done' }, ctxFor(bridge))
    expect(payload(res)).not.toHaveProperty('id')
  })

  it('the speak def and the notify def are different verbs with different handlers', () => {
    const speak = WIRED_TOOLS.find((t) => t.op === 'speak')
    const notify = WIRED_TOOLS.find((t) => t.op === 'notify')
    expect(speak?.handler).not.toBe(notify?.handler)
  })
})

describe('AC-3c/3d — a refused folder never reaches the bridge, and the ACK names the gate', () => {
  it('a BLOCKED folder is silent even with the global ON and the folder explicitly ON', async () => {
    agentPrefs.current = { version: 1, global: true, folders: { [FOLDER]: true } }
    const { bridge, calls } = fakeBridge()
    const res = await speakHandler(
      { folder: FOLDER, text: 'let me in' },
      ctxFor(bridge, { denyFolders: ['/home/u'] })
    )
    expect(res.isError).toBe(true)
    expect(errorPayload(res).error).toBe('FOLDER_NOT_ALLOWED')
    expect(calls).toHaveLength(0)
  })

  it('a folder muted explicitly refuses with VOICE_MUTED_FOR_FOLDER even when the global is ON', async () => {
    agentPrefs.current = { version: 1, global: true, folders: { [FOLDER]: false } }
    const { bridge, calls } = fakeBridge()
    const res = await speakHandler({ folder: FOLDER, text: 'hello' }, ctxFor(bridge))
    expect(res.isError).toBe(true)
    const err = errorPayload(res)
    expect(err.error).toBe('VOICE_MUTED_FOR_FOLDER')
    // Steerable, per AC-3d: it says what to do, and it does NOT tell the agent to
    // go ask for the global switch (which would not help).
    expect(Array.isArray(err.nextActions)).toBe(true)
    expect(calls).toHaveLength(0)
  })

  it('voice off everywhere refuses with VOICE_DISABLED and a next action', async () => {
    agentPrefs.current = { version: 1, folders: {} }
    const { bridge, calls } = fakeBridge()
    const res = await speakHandler({ folder: FOLDER, text: 'hello' }, ctxFor(bridge))
    expect(res.isError).toBe(true)
    const err = errorPayload(res)
    expect(err.error).toBe('VOICE_DISABLED')
    expect((err.nextActions as unknown[]).length).toBeGreaterThan(0)
    expect(calls).toHaveLength(0)
  })

  it('an explicit per-folder ON speaks under a global OFF, and only there', async () => {
    agentPrefs.current = { version: 1, global: false, folders: { [FOLDER]: true } }
    const { bridge, calls } = fakeBridge()
    const here = await speakHandler({ folder: FOLDER, text: 'here' }, ctxFor(bridge))
    expect(here.isError).toBeFalsy()

    const elsewhere = await speakHandler(
      { folder: '/home/u/other', text: 'there' },
      ctxFor(bridge, { folder: '/home/u/other' })
    )
    expect(elsewhere.isError).toBe(true)
    expect(errorPayload(elsewhere).error).toBe('VOICE_DISABLED')
    expect(calls).toHaveLength(1)
  })
})

describe('AC-4 — over-cap text is truncated, never rejected', () => {
  it('a 2000-character line still speaks, capped and flagged', async () => {
    const { bridge, calls } = fakeBridge()
    const res = await speakHandler({ folder: FOLDER, text: 'word '.repeat(400) }, ctxFor(bridge))

    expect(res.isError).toBeFalsy()
    const ack = payload(res)
    expect(ack.truncated).toBe(true)
    expect(ack.chars as number).toBeLessThanOrEqual(SPEAK_MAX_CHARS)

    const sent = (calls[0].payload as { text: string }).text
    expect(sent.length).toBeLessThanOrEqual(SPEAK_MAX_CHARS)
    expect(sent.endsWith('word')).toBe(true)
  })

  it('a line that only NEEDED whitespace collapsing is not reported as truncated', async () => {
    const { bridge } = fakeBridge()
    const res = await speakHandler({ folder: FOLDER, text: 'two\n\nlines' }, ctxFor(bridge))
    expect(payload(res).truncated).toBe(false)
  })
})

describe('AC-5 — the focus rule is honoured, and reported as a success', () => {
  it("spoken:false with the renderer's reason is an OK ACK, not an error", async () => {
    const { bridge } = fakeBridge({ spoken: false, reason: 'focused' })
    const res = await speakHandler(
      { folder: FOLDER, text: 'you can see this', sessionId: 'sess-1' },
      ctxFor(bridge)
    )
    expect(res.isError).toBeFalsy()
    expect(payload(res)).toMatchObject({ ok: true, spoken: false, reason: 'focused' })
    expect(String(payload(res).hint)).toMatch(/do not retry/i)
  })

  it("engine-off says so in a hint — voice has a SECOND switch this gate doesn't own", async () => {
    // Without this, an agent reading `ok:true` on an ALLOWED folder has no way to
    // learn that the operator's engine master switch is what kept it silent.
    const { bridge } = fakeBridge({ spoken: false, reason: 'engine-off' })
    const res = await speakHandler({ folder: FOLDER, text: 'hi' }, ctxFor(bridge))
    const ack = payload(res)
    expect(ack).toMatchObject({ ok: true, spoken: false, reason: 'engine-off' })
    expect(String(ack.hint)).toMatch(/SECOND switch/)
    expect(String(ack.hint)).toMatch(/notify/)
  })

  it('a reason the renderer never sends carries no invented hint', async () => {
    const { bridge } = fakeBridge({ spoken: false, reason: 'something-new' })
    expect(
      payload(await speakHandler({ folder: FOLDER, text: 'hi' }, ctxFor(bridge)))
    ).not.toHaveProperty('hint')
  })

  it('a renderer FAILURE is an error, never ok:true with the failure tucked inside', async () => {
    // docs/lessons/code-patterns/004: an agent that trusts the top-level `ok`
    // would otherwise believe it had spoken.
    const { bridge } = fakeBridge({ error: 'BAD_ARGS' })
    const res = await speakHandler({ folder: FOLDER, text: 'hi' }, ctxFor(bridge))
    expect(res.isError).toBe(true)
    expect(errorText(res)).toContain('SPEAK_FAILED')
  })

  it('a bridge that rejects (timeout / no window) is an error, not a silent success', async () => {
    const bridge = {
      dispatch: async (): Promise<unknown> => {
        throw new Error('TIMEOUT')
      }
    } as unknown as CommandBridge
    const res = await speakHandler({ folder: FOLDER, text: 'hi' }, ctxFor(bridge))
    expect(res.isError).toBe(true)
    expect(errorText(res)).toContain('DISPATCH_FAILED')
  })
})

describe('the rate limit — one looping agent cannot hold the speakers', () => {
  it(`allows ${SPEAK_RATE_LIMIT} utterances per session, then refuses steerably`, async () => {
    const { bridge, calls } = fakeBridge()
    for (let i = 0; i < SPEAK_RATE_LIMIT; i++) {
      const ok = await speakHandler(
        { folder: FOLDER, text: `line ${i}`, sessionId: 'loop' },
        ctxFor(bridge)
      )
      expect(ok.isError).toBeFalsy()
    }
    const refused = await speakHandler(
      { folder: FOLDER, text: 'and again', sessionId: 'loop' },
      ctxFor(bridge)
    )
    expect(refused.isError).toBe(true)
    expect(errorPayload(refused).error).toBe('SPEAK_RATE_LIMITED')
    expect(calls).toHaveLength(SPEAK_RATE_LIMIT)
  })

  it('the buckets are per session — one loud agent does not silence its peers', async () => {
    const { bridge } = fakeBridge()
    for (let i = 0; i < SPEAK_RATE_LIMIT; i++) {
      await speakHandler({ folder: FOLDER, text: `x${i}`, sessionId: 'loud' }, ctxFor(bridge))
    }
    const other = await speakHandler(
      { folder: FOLDER, text: 'my turn', sessionId: 'quiet' },
      ctxFor(bridge)
    )
    expect(other.isError).toBeFalsy()
  })

  it('the ACK reports how much allowance is left, so an agent can pace itself', async () => {
    const { bridge } = fakeBridge()
    const res = await speakHandler(
      { folder: FOLDER, text: 'first', sessionId: 'paced' },
      ctxFor(bridge)
    )
    expect(payload(res).rateRemaining).toBe(SPEAK_RATE_LIMIT - 1)
  })

  it('a caller with no sessionId shares its folder bucket rather than getting a free one', async () => {
    // The MCP transport has no per-session identity, so an anonymous caller cannot
    // be given a private allowance — it would be an unlimited one in practice.
    const { bridge } = fakeBridge()
    for (let i = 0; i < SPEAK_RATE_LIMIT; i++) {
      await speakHandler({ folder: FOLDER, text: `x${i}` }, ctxFor(bridge))
    }
    const refused = await speakHandler({ folder: FOLDER, text: 'again' }, ctxFor(bridge))
    expect(refused.isError).toBe(true)
    expect(errorPayload(refused).error).toBe('SPEAK_RATE_LIMITED')
  })

  it('a REFUSED gate does not consume allowance', async () => {
    agentPrefs.current = { version: 1, folders: {} }
    const { bridge } = fakeBridge()
    for (let i = 0; i < SPEAK_RATE_LIMIT + 3; i++) {
      const res = await speakHandler({ folder: FOLDER, text: 'x', sessionId: 's' }, ctxFor(bridge))
      expect(errorPayload(res).error).toBe('VOICE_DISABLED')
    }
    agentPrefs.current = { version: 1, global: true, folders: {} }
    const ok = await speakHandler({ folder: FOLDER, text: 'now', sessionId: 's' }, ctxFor(bridge))
    expect(ok.isError).toBeFalsy()
  })
})
