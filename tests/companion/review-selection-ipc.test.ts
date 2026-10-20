/**
 * T257 U2a-i — the handlers (`review:selection:send` / `review:selection:compose`): their order of
 * checks, the codes they return, the gesture's reach, and the whole path against a fake mod over a
 * real host core and a real socket.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EnqueueResult } from '../../src/main/companion/command-channel'
import type { CommandCause, EnqueueRefusal } from '../../src/main/companion/command-types'
import {
  REFUSAL_NEXT,
  REVIEW_SELECTION_GESTURE,
  type SelectionCoordinates,
  type SelectionStateEvent
} from '../../src/main/companion/review-selection-core'
import { channelRig } from './support/channel-rig'

const handlers = vi.hoisted(() => new Map<string, (...a: unknown[]) => unknown>())
vi.mock('electron', () => ({
  app: { isPackaged: true, getPath: () => '/tmp' },
  ipcMain: {
    handle: (ch: string, fn: (...a: unknown[]) => unknown) => void handlers.set(ch, fn),
    on: (): void => undefined
  }
}))

import {
  composeSelectionText,
  registerReviewSelectionHandlers,
  sendSelection,
  type SelectionDeps
} from '../../src/main/companion/review-selection-ipc'
import {
  createBandDriver,
  createSelectionTracker
} from '../../src/main/companion/review-selection-tracker'
import type { BindingView } from '../../src/main/companion/session-table'

const REPO = join(__dirname, '../..')
const BASE = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2'
const HEAD = '9f8e7d6c5b4a9f8e7d6c5b4a9f8e7d6c5b4a9f8e'
const SID = '11111111-1111-4111-8111-111111111111'
const CAUSE: CommandCause = { kind: 'operator', gesture: REVIEW_SELECTION_GESTURE }

const selection = (over: Record<string, unknown> = {}): SelectionCoordinates =>
  ({
    id: 'sel_0001',
    subjectType: 'LINE',
    path: 'src/main/speech.ts',
    oldPath: null,
    line: 92,
    side: 'RIGHT',
    startLine: 85,
    startSide: 'RIGHT',
    baseSha: BASE,
    headSha: HEAD,
    prNumber: 250,
    ...over
  }) as SelectionCoordinates

const request = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  folder: '/work/example-web',
  headRef: 'feat/speech',
  base: 'origin/main',
  companionSid: SID,
  selection: selection(),
  ...over
})

const blob = Array.from({ length: 120 }, (_, i) => `  const v${i + 1} = ${i + 1}`).join('\n') + '\n'

const binding = (over: Partial<BindingView> = {}): BindingView =>
  ({ key: 7, sid: SID, trust: 'read-only', state: 'bound', ...over }) as BindingView

interface Fake {
  deps: SelectionDeps
  enqueue: ReturnType<typeof vi.fn>
  track: ReturnType<typeof vi.fn>
  reads: Array<[string, string, string]>
}

function fake(over: Partial<SelectionDeps> = {}): Fake {
  const reads: Array<[string, string, string]> = []
  const enqueue = vi.fn((): EnqueueResult => ({
    ok: true,
    cmd: 'cmd_1',
    n: 3,
    settled: new Promise(() => undefined)
  }))
  const track = vi.fn()
  const deps: SelectionDeps = {
    bindingForSid: () => binding(),
    enqueue: enqueue as never,
    resolveCommit: async (_folder, ref) => (ref === 'origin/main' ? BASE : HEAD),
    readBlob: async (folder, sha, path) => {
      reads.push([folder, sha, path])
      return blob
    },
    noBindingReason: () => 'cli-too-old',
    tracker: { track },
    log: () => undefined,
    ...over
  }
  return { deps, enqueue, track, reads }
}

beforeEach(() => handlers.clear())

describe('registration', () => {
  it('registers exactly the two channels', () => {
    registerReviewSelectionHandlers(() => null)
    expect([...handlers.keys()].sort()).toEqual([
      'review:selection:compose',
      'review:selection:send'
    ])
  })
})

describe('the send', () => {
  it('queues one non-durable context.append, addressed by sid, with the operator cause', async () => {
    const f = fake()
    const res = await sendSelection(request(), CAUSE, f.deps)
    expect(res).toEqual({ ok: true, selectionId: 'sel_0001', cmd: 'cmd_1', n: 3 })
    expect(f.enqueue).toHaveBeenCalledTimes(1)
    const sent = f.enqueue.mock.calls[0][0] as Record<string, unknown>
    expect(sent).toMatchObject({
      sessionKey: null,
      sid: SID,
      name: 'context.append',
      cause: CAUSE
    })
    expect(sent.args).toMatchObject({ key: 'harnu.review-selection', durable: false })
    expect(typeof (sent.args as { text: string }).text).toBe('string')
    expect(Object.keys(sent.args as object).sort()).toEqual(['durable', 'key', 'text'])
    expect(f.track).toHaveBeenCalledTimes(1)
    expect(f.track.mock.calls[0][0]).toMatchObject({
      selectionId: 'sel_0001',
      bindingKey: 7,
      sid: SID,
      cmd: 'cmd_1'
    })
  })

  it('reads the lines with the pinned commit and the right path, and only for a line range', async () => {
    const f = fake()
    await sendSelection(request(), CAUSE, f.deps)
    expect(f.reads).toEqual([['/work/example-web', HEAD, 'src/main/speech.ts']])
    const g = fake()
    await sendSelection(
      request({
        selection: selection({ path: 'b.ts', oldPath: 'a.ts', side: 'LEFT', startSide: 'LEFT' })
      }),
      CAUSE,
      g.deps
    )
    expect(g.reads).toEqual([['/work/example-web', BASE, 'a.ts']])
    const h = fake()
    await sendSelection(
      request({
        selection: selection({
          subjectType: 'FILE',
          line: undefined,
          side: undefined,
          startLine: undefined,
          startSide: undefined
        })
      }),
      CAUSE,
      h.deps
    )
    expect(h.reads).toEqual([])
    expect(h.enqueue).toHaveBeenCalledTimes(1)
  })

  it('compose returns exactly the text the send would carry', async () => {
    const f = fake()
    await sendSelection(request(), CAUSE, f.deps)
    const sentText = (f.enqueue.mock.calls[0][0] as { args: { text: string } }).args.text
    const composed = await composeSelectionText(
      {
        folder: '/work/example-web',
        headRef: 'feat/speech',
        base: 'origin/main',
        selection: selection()
      },
      fake().deps
    )
    expect(composed).toEqual({ ok: true, text: sentText })
    expect(sentText).toContain(' 85 |   const v85 = 85')
  })

  it('compose sends nothing and runs the same head guard', async () => {
    const f = fake({ resolveCommit: async () => 'f'.repeat(40) })
    const res = await composeSelectionText(
      { folder: '/work/example-web', headRef: 'h', base: 'b', selection: selection() },
      f.deps
    )
    expect(res).toMatchObject({ ok: false, refusal: 'head-moved' })
    expect(f.enqueue).not.toHaveBeenCalled()
  })

  it('compose takes no companion and refuses one', async () => {
    const res = await composeSelectionText(request(), fake().deps)
    expect(res).toMatchObject({ ok: false, refusal: 'BAD_ARGS', detail: 'unknown-field' })
  })
})

describe('U2a-i-AC-9 — the binding is the read-only companion, by sid', () => {
  it('a binding that is not read-only is TARGET_DENIED and nothing is read or queued', async () => {
    for (const trust of ['operator', 'agent', 'tick'] as const) {
      const f = fake({ bindingForSid: () => binding({ trust }) })
      const res = await sendSelection(request(), CAUSE, f.deps)
      expect(res).toMatchObject({ ok: false, refusal: 'TARGET_DENIED', next: ['copy'] })
      expect(f.enqueue).not.toHaveBeenCalled()
      expect(f.reads).toEqual([])
    }
  })

  it('no companion open is no-companion, before anything else runs', async () => {
    for (const companionSid of [null, undefined, '']) {
      const f = fake()
      const res = await sendSelection(request({ companionSid }), CAUSE, f.deps)
      expect(res).toMatchObject({ ok: false, refusal: 'no-companion', next: [] })
      expect(f.enqueue).not.toHaveBeenCalled()
    }
  })

  it('a malformed sid is BAD_ARGS', async () => {
    for (const companionSid of [7, 'not a sid!', 'x'.repeat(100)]) {
      const res = await sendSelection(request({ companionSid }), CAUSE, fake().deps)
      expect(res).toMatchObject({ ok: false, refusal: 'BAD_ARGS', detail: 'companion-sid' })
    }
  })

  it('the head guard runs before anything is read or queued', async () => {
    const cases: Array<[Partial<SelectionDeps>, string]> = [
      [
        { resolveCommit: async (_f, ref) => (ref === 'origin/main' ? BASE : 'f'.repeat(40)) },
        'head-moved'
      ],
      [
        { resolveCommit: async (_f, ref) => (ref === 'origin/main' ? 'e'.repeat(40) : HEAD) },
        'base-mismatch'
      ],
      [
        { resolveCommit: async (_f, ref) => (ref === 'origin/main' ? BASE : null) },
        'head-unreadable'
      ],
      [
        { resolveCommit: async (_f, ref) => (ref === 'origin/main' ? null : HEAD) },
        'head-unreadable'
      ]
    ]
    for (const [over, refusal] of cases) {
      const f = fake(over)
      const res = await sendSelection(request(), CAUSE, f.deps)
      expect(res, refusal).toMatchObject({ ok: false, refusal })
      expect(f.reads).toEqual([])
      expect(f.enqueue).not.toHaveBeenCalled()
    }
  })

  it('the head-moved detail is the two short SHAs, nothing else', async () => {
    const f = fake({
      resolveCommit: async (_f, ref) => (ref === 'origin/main' ? BASE : 'f'.repeat(40))
    })
    const res = await sendSelection(request(), CAUSE, f.deps)
    expect(res).toMatchObject({ detail: `${HEAD.slice(0, 7)} → fffffff` })
  })

  it('a selection outside the file, or a blob that cannot be read, is BAD_ARGS', async () => {
    const past = await sendSelection(
      request({ selection: selection({ startLine: 119, line: 121 }) }),
      CAUSE,
      fake().deps
    )
    expect(past).toMatchObject({ ok: false, refusal: 'BAD_ARGS', detail: 'range-out-of-file' })
    const unreadable = await sendSelection(
      request(),
      CAUSE,
      fake({ readBlob: async () => null }).deps
    )
    expect(unreadable).toMatchObject({ ok: false, refusal: 'BAD_ARGS', detail: 'blob-unreadable' })
  })

  it('validation failures are BAD_ARGS and nothing is resolved', async () => {
    const resolve = vi.fn(async () => HEAD)
    const bads: Array<Record<string, unknown>> = [
      request({ selection: { ...selection(), text: 'hi' } }),
      request({ selection: selection({ headSha: 'main' }) }),
      request({ selection: selection({ path: '../x' }) }),
      request({ selection: selection({ startLine: 99 }) }),
      request({ folder: 'relative' }),
      request({ headRef: '--output=/etc/x' }),
      request({ extra: 1 })
    ]
    for (const raw of bads) {
      const res = await sendSelection(raw, CAUSE, fake({ resolveCommit: resolve }).deps)
      expect(res).toMatchObject({ ok: false, refusal: 'BAD_ARGS' })
    }
    for (const raw of [null, 7, 'x', [], undefined]) {
      expect(await sendSelection(raw, CAUSE, fake().deps)).toMatchObject({
        ok: false,
        refusal: 'BAD_ARGS'
      })
    }
    expect(resolve).not.toHaveBeenCalled()
  })
})

describe('U2a-i-AC-10 — nothing is swallowed', () => {
  const ALL: Array<EnqueueRefusal | 'AUDIT_FAILED'> = [
    'NO_BINDING',
    'NO_LEASE',
    'STICKY_LEGACY',
    'HEADLESS',
    'EXTERNAL',
    'FEATURE_OFF',
    'MODE_SHADOW',
    'ORIGIN_DENIED',
    'TARGET_DENIED',
    'FOLDER_BLOCKED',
    'BAD_ARGS',
    'QUEUE_FULL',
    'SID_UNSETTLED',
    'AUDIT_FAILED'
  ]

  it('the list above is the whole type', () => {
    const src = readFileSync(join(REPO, 'src/main/companion/command-types.ts'), 'utf8')
    const body = src.slice(src.indexOf('export type EnqueueRefusal ='))
    const members = [...body.slice(0, body.search(/\n\n/)).matchAll(/'([^']+)'/g)].map((m) => m[1])
    expect(members.sort()).toEqual(ALL.filter((m) => m !== 'AUDIT_FAILED').sort())
  })

  for (const reason of ALL) {
    it(`${reason} comes back as its code with its next steps`, async () => {
      const f = fake({ enqueue: (() => ({ ok: false, reason })) as never })
      const res = await sendSelection(request(), CAUSE, f.deps)
      expect(res).toMatchObject({ ok: false, refusal: reason })
      expect((res as { next: unknown }).next).toEqual(REFUSAL_NEXT[reason])
      expect(f.track).not.toHaveBeenCalled()
    })
  }

  it('NO_BINDING carries the reason the inject decision left (AC-11)', async () => {
    for (const r of [
      'off',
      'cli-too-old',
      'cli-unknown',
      'pre-disclosure',
      'not-claude',
      'unknown'
    ] as const) {
      const f = fake({
        bindingForSid: () => null,
        enqueue: (() => ({ ok: false, reason: 'NO_BINDING' })) as never,
        noBindingReason: () => r
      })
      expect(await sendSelection(request(), CAUSE, f.deps)).toMatchObject({
        ok: false,
        refusal: 'NO_BINDING',
        reason: r
      })
    }
  })

  it('no refusal carries a sentence: every field is a code or a SHA pair', async () => {
    const f = fake({ enqueue: (() => ({ ok: false, reason: 'NO_BINDING' })) as never })
    const res = await sendSelection(request(), CAUSE, f.deps)
    expect(JSON.stringify(res)).toBe(
      '{"ok":false,"refusal":"NO_BINDING","next":["copy","open-mods-settings"],"reason":"cli-too-old"}'
    )
  })
})

describe('U2a-i-AC-8 — the gesture is the operator’s, and only this file builds it', () => {
  const walk = (d: string): string[] =>
    readdirSync(d).flatMap((n) => {
      const p = join(d, n)
      return statSync(p).isDirectory() ? walk(p) : /\.(ts|vue)$/.test(p) ? [p] : []
    })
  const stripComments = (s: string): string =>
    s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  const sources = [...walk(join(REPO, 'src')), ...walk(join(REPO, 'resources/companion/hooks'))]
  const body = (f: string): string => stripComments(readFileSync(f, 'utf8'))

  it('the cause literal is inside the ipcMain.handle callback, in one file', () => {
    const builds = sources.filter((f) =>
      /kind:\s*'operator'\s*,\s*gesture:\s*REVIEW_SELECTION_GESTURE/.test(body(f))
    )
    expect(builds.map((f) => relative(REPO, f))).toEqual([
      'src/main/companion/review-selection-ipc.ts'
    ])
    const src = body(builds[0])
    const at = src.search(/ipcMain\.handle\(\s*'review:selection:send'/)
    expect(at).toBeGreaterThan(-1)
    const end = src.search(/ipcMain\.handle\(\s*'review:selection:compose'/)
    expect(end).toBeGreaterThan(at)
    expect(src.slice(at, end)).toMatch(
      /kind:\s*'operator'\s*,\s*gesture:\s*REVIEW_SELECTION_GESTURE/
    )
  })

  it('the gesture string is written in exactly one file', () => {
    const files = sources.filter((f) => body(f).includes('review.selection.send'))
    expect(files.map((f) => relative(REPO, f))).toEqual([
      'src/main/companion/review-selection-core.ts'
    ])
  })

  it('the channel names appear in no MCP tool definition and nothing under mcp/ reaches them', () => {
    const catalog = readFileSync(join(REPO, 'src/main/mcp/tool-catalog.ts'), 'utf8')
    for (const needle of ['review:selection', 'reviewSelection', 'review-selection']) {
      expect(catalog).not.toContain(needle)
    }
    for (const f of walk(join(REPO, 'src/main/mcp'))) {
      const text = readFileSync(f, 'utf8')
      for (const needle of [
        'review:selection',
        'review-selection',
        'REVIEW_SELECTION_GESTURE',
        'sendSelection',
        'review.selection.send',
        'reviewSelectionBand'
      ]) {
        expect(text, `${relative(REPO, f)} reaches ${needle}`).not.toContain(needle)
      }
    }
  })

  it('no verb or internal cause can reach the send: the handler is the only caller of the row', () => {
    const callers = sources.filter((f) => /\bsendSelection\s*\(/.test(body(f)))
    expect(callers.map((f) => relative(REPO, f))).toEqual([
      'src/main/companion/review-selection-ipc.ts'
    ])
  })

  it('the main-process reads are rev-parse and show, nothing that writes', () => {
    const src = body(join(REPO, 'src/main/companion/review-selection-ipc.ts'))
    const calls = [...src.matchAll(/git\(\s*[a-zA-Z.]+,\s*\[\s*'([a-z-]+)'/g)].map((m) => m[1])
    expect(new Set(calls)).toEqual(new Set(['rev-parse', 'show']))
    for (const verb of [
      'checkout',
      'fetch',
      'reset',
      'commit',
      'push',
      'apply',
      'stash',
      'clean',
      'gc'
    ]) {
      expect(src).not.toMatch(new RegExp(`'${verb}'`))
    }
    expect(src).not.toContain('ptyWrite')
    expect(src).not.toMatch(/\bwriteFile|\bappendFile|\bunlink/)
  })

  it('the renderer payload type has no text field', () => {
    const core = readFileSync(join(REPO, 'src/main/companion/review-selection-core.ts'), 'utf8')
    const iface = /export interface SelectionCoordinates \{[\s\S]*?\n\}/.exec(core)![0]
    expect(iface).not.toMatch(/\btext\b|lineText|content/)
  })
})

describe('U2a-i-AC-8 — the real handler registrations', () => {
  it('the gesture the handler builds is the one the gate row opens', async () => {
    const { checkOrigin } = await import('../../src/main/companion/command-gate-core')
    expect(checkOrigin('context.append', CAUSE, { debug: false }).ok).toBe(true)
  })
})

// ---- a fake mod over a real host core and a real socket -------------------------------------------

const open: { close(): Promise<void> }[] = []
afterEach(async () => {
  for (const r of open.splice(0)) await r.close()
})

const ENABLE = ['sense.identity', 'sense.turn', 'act.channel', 'act.context', 'ui.band']

async function modRig(over: Parameters<typeof channelRig>[0] = {}) {
  const r = await channelRig({
    mode: 'shadow', // the default: O-3 option B has to work here
    trust: 'read-only',
    declared: ENABLE,
    enable: ENABLE,
    ...over
  })
  open.push(r)
  r.core.facade.registerEventTypes(['turn.started', 'turn.completed'])
  const emitted: SelectionStateEvent[] = []
  const tracker = createSelectionTracker({
    host: r.core.facade,
    emit: (e) => void emitted.push(e)
  })
  const bandSent: unknown[] = []
  const driver = createBandDriver({
    debounceMs: 10,
    refreshMs: 60_000,
    send: ({ sid, args }) => {
      bandSent.push(args)
      return r.channel.enqueue({
        sessionKey: null,
        sid,
        name: 'ui.band.set',
        args,
        cause: { kind: 'internal', subsystem: 'reviewSelectionBand' }
      })
    }
  })
  driver.attach(tracker)
  open.push({
    close: async () => {
      driver.dispose()
      tracker.dispose()
    }
  })
  const deps = fake({
    bindingForSid: (sid) => r.core.facade.bindingForSid(sid),
    enqueue: r.channel.enqueue as never,
    tracker
  }).deps
  return { r, emitted, bandSent, deps }
}

const wait = (ms: number): Promise<void> => new Promise((res) => setTimeout(res, ms))
let evSeq = 100
const wire = (t: string, d: Record<string, unknown>, turnId?: string) => ({
  seq: ++evSeq,
  t,
  ts: 1,
  ...(turnId ? { turnId } : {}),
  d
})

describe('against a fake mod: the whole path, in channel mode shadow', () => {
  it('delivers the row, reports delivered, then asked, then answered, with the band alongside', async () => {
    const { r, emitted, deps } = await modRig()
    const { conn } = await r.hello()

    const res = await sendSelection(request(), CAUSE, deps)
    expect(res).toMatchObject({ ok: true, selectionId: 'sel_0001' })

    // the mod polls and finds one non-durable context.append for this key, exactly as composed
    const polled = (await r.poll(conn, { cursor: 0 })).json
    expect(polled.commands).toHaveLength(1)
    const cmd = polled.commands[0]
    expect(cmd.name).toBe('context.append')
    expect(cmd.args).toMatchObject({ key: 'harnu.review-selection', durable: false })
    expect(cmd.args.text).toContain('selection: lines 85-92 of the new file (RIGHT)')
    const composed = await composeSelectionText(
      {
        folder: '/work/example-web',
        headRef: 'feat/speech',
        base: 'origin/main',
        selection: selection()
      },
      deps
    )
    expect(composed).toEqual({ ok: true, text: cmd.args.text })
    expect(emitted.map((e) => e.state)).toEqual(['queued'])

    // the mod reports the result: the row is in the companion's context, no turn has started
    await r.result(conn, { cmd: cmd.cmd, ok: true })
    expect(emitted.map((e) => e.state)).toEqual(['queued', 'delivered'])

    // the operator types a question; the turn completes with an answer
    await r.events(conn, [wire('turn.started', { origin: 'human' }, 'turn-1')])
    expect(emitted.at(-1)!.state).toBe('asked')
    await wait(60) // the band debounce (10 ms) has passed: the line is queued for the mod
    const band = (await r.poll(conn, { cursor: cmd.n })).json.commands
    expect(band).toHaveLength(1)
    expect(band[0]).toMatchObject({ name: 'ui.band.set' })
    expect(band[0].args.parts).toMatchObject({
      lead: '⧉ speech.ts L85–92',
      hint: 'ask your question below'
    })
    expect(band[0].args.link).toBeUndefined()

    await r.events(conn, [
      wire('turn.completed', { reason: 'answer', isAborted: false, durationMs: 5 }, 'turn-1')
    ])
    expect(emitted.map((e) => e.state)).toEqual(['queued', 'delivered', 'asked', 'answered'])
    await wait(60)
    const cleared = (await r.poll(conn, { cursor: band[0].n })).json.commands
    expect(cleared[0]).toMatchObject({ name: 'ui.band.set', args: { line: null } })
  })

  it('every send is audited with the operator gesture and no text', async () => {
    const { r, deps } = await modRig()
    await r.hello()
    await sendSelection(request(), CAUSE, deps)
    const rows = JSON.stringify(r.rows)
    expect(rows).toContain('review.selection.send')
    expect(rows).not.toContain('const v85')
    expect(rows).not.toContain('harnu-context')
  })

  it('a companion that never said hello is NO_BINDING, with the reason from its PTY', async () => {
    const { r, deps } = await modRig()
    void r
    const res = await sendSelection(request(), CAUSE, {
      ...deps,
      noBindingReason: () => 'pre-disclosure'
    })
    expect(res).toMatchObject({ ok: false, refusal: 'NO_BINDING', reason: 'pre-disclosure' })
  })

  it('an operator-owned session passed by sid is TARGET_DENIED and nothing reaches its queue', async () => {
    const { r, deps } = await modRig({ trust: 'operator', pollHoldMs: 50 })
    const { conn } = await r.hello()
    const res = await sendSelection(request(), CAUSE, deps)
    expect(res).toMatchObject({ ok: false, refusal: 'TARGET_DENIED' })
    expect((await r.poll(conn, { cursor: 0 })).json.commands).toEqual([])
  })

  it('a mod not enabled for act.context is FEATURE_OFF', async () => {
    const { r, deps } = await modRig({ enable: ['sense.identity', 'act.channel'] })
    await r.hello()
    expect(await sendSelection(request(), CAUSE, deps)).toMatchObject({
      ok: false,
      refusal: 'FEATURE_OFF'
    })
  })

  it('channel off is FEATURE_OFF; other keys stay MODE_SHADOW in shadow', async () => {
    const { r, deps } = await modRig()
    await r.hello()
    // the review key is admitted (above); the orchestrator key is not, through the same channel
    const other = r.channel.enqueue({
      sessionKey: null,
      sid: SID,
      name: 'context.append',
      args: { key: 'harnu.orchestrator', text: 'x', durable: false },
      cause: CAUSE
    })
    expect(other).toEqual({ ok: false, reason: 'MODE_SHADOW' })
    r.state.mode = 'off'
    expect(await sendSelection(request(), CAUSE, deps)).toMatchObject({
      ok: false,
      refusal: 'FEATURE_OFF'
    })
  })

  it('a lapsed lease is NO_LEASE, a failing audit AUDIT_FAILED, both as codes', async () => {
    const { r, deps } = await modRig()
    await r.hello()
    r.state.auditFails = true
    expect(await sendSelection(request(), CAUSE, deps)).toMatchObject({
      ok: false,
      refusal: 'AUDIT_FAILED'
    })
    r.state.auditFails = false
    r.clock.lease += 25_000
    expect(await sendSelection(request(), CAUSE, deps)).toMatchObject({
      ok: false,
      refusal: 'NO_LEASE'
    })
  })

  it('a result the mod refuses is not-delivered with its code, never delivered', async () => {
    const { r, emitted, deps } = await modRig()
    const { conn } = await r.hello()
    await sendSelection(request(), CAUSE, deps)
    const cmd = (await r.poll(conn, { cursor: 0 })).json.commands[0]
    await r.result(conn, { cmd: cmd.cmd, ok: false, code: 'CMD_UNSUPPORTED', message: 'old mod' })
    await wait(10)
    expect(emitted.map((e) => e.state)).toEqual(['queued', 'not-delivered'])
    expect(emitted.at(-1)).toMatchObject({ code: 'CMD_UNSUPPORTED', next: ['copy'] })
    expect(JSON.stringify(emitted)).not.toContain('old mod')
  })

  it('a /clear in the companion after delivery is cleared, and the band follows to the new sid', async () => {
    const { r, emitted, deps } = await modRig()
    const { conn } = await r.hello()
    await sendSelection(request(), CAUSE, deps)
    const cmd = (await r.poll(conn, { cursor: 0 })).json.commands[0]
    await r.result(conn, { cmd: cmd.cmd, ok: true })
    await r.events(conn, [
      wire('session.rebound', {
        prevSid: SID,
        sid: '22222222-2222-4222-8222-222222222222',
        cause: 'clear'
      })
    ])
    expect(emitted.map((e) => e.state)).toEqual(['queued', 'delivered', 'cleared'])
  })
})
