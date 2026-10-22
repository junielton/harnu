/**
 * T570 (browser pane U3, AC-1…AC-6) — the five reading verbs over fakes: snapshot, screenshot, console,
 * network, wait_for. ACK shapes, refusals and their order, scrubbing, the untrusted-content note, Disconnect,
 * the operator-pane rule, and the lease placeholder for external network capture.
 */
import { describe, it, expect, vi } from 'vitest'
import { createBrowserAccess } from '../src/main/browser/access'
import { createBrowserRegistry } from '../src/main/browser/registry'
import { createPaneReaders } from '../src/main/browser/pane-readers'
import type { AxNode } from '../src/main/browser/snapshot'
import {
  consoleVerb,
  networkVerb,
  screenshotVerb,
  snapshotVerb,
  waitForVerb,
  type BrowserReadDeps,
  type BrowserReadHost,
  type CaptureRequest
} from '../src/main/browser/read-verbs'
import { BROWSER_NOTE, type LivePaneInfo } from '../src/main/browser/verbs-core'
import type { ViewMode } from '../src/main/browser/screenshot-plan'

const FOLDER = '/work/app'

function ax(): AxNode[] {
  return [
    {
      nodeId: '1',
      role: { value: 'RootWebArea' },
      name: { value: 'Home /home/u/secret' },
      childIds: ['2', '3'],
      backendDOMNodeId: 10
    },
    {
      nodeId: '2',
      parentId: '1',
      role: { value: 'button' },
      name: { value: 'Save' },
      backendDOMNodeId: 20
    },
    { nodeId: '3', parentId: '1', role: { value: 'Iframe' }, backendDOMNodeId: 30 }
  ]
}

function rig(
  opts: { openedBy?: 'agent' | 'operator'; url?: string; mode?: ViewMode; writes?: boolean } = {}
) {
  let clock = 1_000
  const live = new Map<string, LivePaneInfo>()
  const registry = createBrowserRegistry(() => clock)
  const access = createBrowserAccess(() => clock)
  const cdpLog: Array<[string, object]> = []
  const captures: CaptureRequest[] = []
  const replies: Record<string, (p: object) => unknown> = {
    'Accessibility.getFullAXTree': () => ({ nodes: ax() }),
    'DOM.getDocument': () => ({ root: { nodeId: 1 } }),
    'DOM.querySelector': (p) => ({
      nodeId: (p as { selector: string }).selector === '#missing' ? 0 : 7
    }),
    'DOM.describeNode': (p) => {
      const q = p as { nodeId?: number; backendNodeId?: number }
      return q.backendNodeId === 30 ? { node: { frameId: 'F2' } } : { node: { backendNodeId: 20 } }
    },
    'Page.getFrameTree': () => ({
      frameTree: {
        frame: { id: 'F1', url: 'http://localhost/' },
        childFrames: [{ frame: { id: 'F2', url: 'https://pay.example.com/x?t=1' } }]
      }
    }),
    'DOM.getBoxModel': () => ({ model: { border: [10, 20, 110, 20, 110, 70, 10, 70] } }),
    'Page.getLayoutMetrics': () => ({
      cssContentSize: { width: 1280, height: 3000 },
      cssVisualViewport: { pageX: 0, pageY: 100 }
    }),
    'Runtime.evaluate': () => ({ result: { value: 'Welcome back' } })
  }
  const readers = createPaneReaders({
    now: () => clock,
    send: async () => undefined,
    scrub: (t) => t,
    setTimer: () => 0,
    clearTimer: () => undefined,
    onCaptureChange: () => undefined
  })
  const host: BrowserReadHost = {
    create: vi.fn(),
    info: (id) => live.get(id),
    navigate: vi.fn(),
    destroy: vi.fn((id) => void live.delete(id)),
    publishFlag: vi.fn(),
    readers: (id) => (live.has(id) ? readers : undefined),
    cdp: async (_id, method, params = {}) => {
      cdpLog.push([method, params])
      const reply = replies[method]
      if (!reply) throw new Error(`no fake for ${method}`)
      return reply(params)
    },
    viewMode: () => opts.mode ?? 'visible',
    deviceMode: () => false,
    capture: vi.fn(async (_id, req) => {
      captures.push(req)
      return {
        data: new Uint8Array([1, 2, 3, 4]),
        mime: req.format === 'jpeg' ? 'image/jpeg' : 'image/png',
        width: 100,
        height: 50,
        clamped: false
      }
    })
  }
  const deps: BrowserReadDeps = {
    now: () => clock,
    newPaneId: () => 'bp-x',
    registry,
    access,
    host,
    writesEnabled: async () => opts.writes ?? true,
    trustedHosts: () => [],
    harnuPorts: () => [41999],
    sessionKnown: () => true,
    showPane: vi.fn(async () => true),
    hidePane: vi.fn(async () => true),
    scrub: (t) => t.replace(/\/home\/u/g, '~'),
    alias: (f) => f.split('/').pop() ?? f,
    folderBlocked: () => false,
    sleep: async (ms) => void (clock += ms),
    saveShot: vi.fn(async (_f, _d, ext) => `.harnu/out/browser/shots/s.${ext}`)
  }
  registry.add({
    paneId: 'bp-1',
    folder: FOLDER,
    name: 'app',
    openedBy: opts.openedBy ?? 'agent',
    partition: opts.openedBy === 'operator' ? 'operator' : 'agent',
    ownerSessionId: null,
    createdAt: 1,
    lastActiveAt: 1,
    seenHosts: new Set(),
    flagged: null
  })
  live.set('bp-1', {
    url: opts.url ?? 'http://localhost:5173/app?token=abc',
    title: 'App',
    loading: false,
    canGoBack: false,
    canGoForward: false
  })
  return { deps, registry, access, host, readers, cdpLog, captures, replies, live }
}

describe('browser_snapshot', () => {
  it('returns the tree with refs, scrubbed text, the common ACK fields and the untrusted note', async () => {
    const { deps } = rig()
    const res = await snapshotVerb({ paneId: 'bp-1' }, deps)
    expect(res).toMatchObject({
      ok: true,
      paneId: 'bp-1',
      url: 'http://localhost:5173/app',
      origin: 'local',
      snapshotId: 1,
      nodes: 3,
      truncated: false,
      note: BROWSER_NOTE
    })
    const text = res.text as string
    expect(text).toContain('- document "Home ~/secret" [ref=s1e1]')
    expect(text).toContain('  - button "Save" [ref=s1e2]')
    expect(text).toContain('  - iframe [pay.example.com] [ref=s1e3]')
  })

  it('reads inside a child frame only with frames:true', async () => {
    const { deps, replies } = rig()
    const inner: AxNode[] = [
      {
        nodeId: 'i1',
        role: { value: 'button' },
        name: { value: 'INNER-BTN' },
        backendDOMNodeId: 99
      }
    ]
    const base = replies['Accessibility.getFullAXTree']!
    replies['Accessibility.getFullAXTree'] = (p) =>
      (p as { frameId?: string }).frameId ? { nodes: inner } : base(p)
    expect((await snapshotVerb({ paneId: 'bp-1' }, deps)).text).not.toContain('INNER-BTN')
    expect((await snapshotVerb({ paneId: 'bp-1', frames: true }, deps)).text).toContain('INNER-BTN')
  })

  it('refs from the snapshot resolve; a navigation kills them', async () => {
    const { deps, readers } = rig()
    await snapshotVerb({ paneId: 'bp-1' }, deps)
    expect(readers.refs.resolve('s1e2')).toEqual({ ok: true, backendNodeId: 20 })
    readers.ingest('Page.frameNavigated', { frame: { id: 'main' } })
    expect(readers.refs.resolve('s1e2')).toEqual({ ok: false, error: 'REF_STALE' })
  })

  it('scopes to a selector, and refuses one that matches nothing', async () => {
    const { deps } = rig()
    expect(await snapshotVerb({ paneId: 'bp-1', selector: '#save' }, deps)).toMatchObject({
      ok: true,
      snapshotId: 1
    })
    expect(await snapshotVerb({ paneId: 'bp-1', selector: '#missing' }, deps)).toMatchObject({
      ok: false,
      error: 'SELECTOR_NOT_FOUND'
    })
  })

  it('answers data:null with a note until the live-panel seam exists, and uses the seam once wired', async () => {
    const { deps } = rig()
    const none = await snapshotVerb({ paneId: 'bp-1', include: ['data'] }, deps)
    expect(none).toMatchObject({ data: null })
    expect(none.dataNote).toBeTruthy()
    deps.pageData = async () => ({ rows: 2 })
    expect(await snapshotVerb({ paneId: 'bp-1', include: ['data'] }, deps)).toMatchObject({
      data: { rows: 2 }
    })
  })

  it('reports a failing accessibility read as a steering refusal', async () => {
    const { deps, replies } = rig()
    replies['Accessibility.getFullAXTree'] = () => {
      throw new Error('Target closed')
    }
    expect(await snapshotVerb({ paneId: 'bp-1' }, deps)).toMatchObject({
      ok: false,
      error: 'PAGE_READ_FAILED'
    })
  })

  it('rejects an out-of-range maxNodes', async () => {
    const { deps } = rig()
    expect(await snapshotVerb({ paneId: 'bp-1', maxNodes: 5000 }, deps)).toMatchObject({
      ok: false,
      error: 'BAD_ARGS'
    })
  })
})

describe('access rules shared by every reading verb', () => {
  const verbs: Array<[string, (d: BrowserReadDeps) => Promise<Record<string, unknown>>]> = [
    ['snapshot', (d) => snapshotVerb({ paneId: 'bp-1' }, d)],
    ['screenshot', (d) => screenshotVerb({ paneId: 'bp-1' }, d)],
    ['console', (d) => consoleVerb({ paneId: 'bp-1' }, d)],
    ['wait_for', (d) => waitForVerb({ paneId: 'bp-1', text: 'x', timeoutMs: 100 }, d)]
  ]

  it.each(verbs)('%s: an unknown pane is PANE_NOT_FOUND', async (_n, run) => {
    const { deps, registry } = rig()
    registry.remove('bp-1')
    expect(await run(deps)).toMatchObject({ ok: false, error: 'PANE_NOT_FOUND' })
  })

  it.each(verbs)('%s: a disconnected pane is BROWSER_DISCONNECTED', async (_n, run) => {
    const { deps, access } = rig()
    access.disconnect('bp-1')
    expect(await run(deps)).toMatchObject({ ok: false, error: 'BROWSER_DISCONNECTED' })
  })

  it.each(verbs)(
    '%s: keeps working with the kill-switch off and while paused (reads are allowed)',
    async (_n, run) => {
      const { deps, access } = rig({ writes: false })
      access.pause('bp-1')
      expect(await run(deps)).toMatchObject({ ok: true })
    }
  )

  it.each(verbs)('%s: a pane the operator opened is BROWSER_READ_NOT_ENABLED', async (_n, run) => {
    const { deps } = rig({ openedBy: 'operator' })
    expect(await run(deps)).toMatchObject({ ok: false, error: 'BROWSER_READ_NOT_ENABLED' })
  })

  it.each(verbs)('%s: carries the fixed untrusted-content note', async (_n, run) => {
    const { deps } = rig()
    expect(await run(deps)).toMatchObject({ note: BROWSER_NOTE })
  })
})

describe('browser_screenshot', () => {
  it('takes a viewport shot and returns the image block with its size', async () => {
    const { deps, captures } = rig()
    const res = await screenshotVerb({ paneId: 'bp-1' }, deps)
    expect(res).toMatchObject({
      ok: true,
      width: 100,
      height: 50,
      bytes: 4,
      format: 'png',
      clamped: false
    })
    expect(res.image).toEqual({
      data: Buffer.from([1, 2, 3, 4]).toString('base64'),
      mimeType: 'image/png'
    })
    expect(captures[0]!.plan).toMatchObject({ method: 'capturePage' })
    expect(captures[0]!.maxDim).toBe(1568)
  })

  it('works on a hidden and on a parked pane through capturePage', async () => {
    for (const mode of ['hidden', 'parked'] as const) {
      const { deps, captures } = rig({ mode })
      expect(await screenshotVerb({ paneId: 'bp-1' }, deps)).toMatchObject({ ok: true })
      expect(captures[0]!.plan.method, mode).toBe('capturePage')
    }
  })

  it('crops to a ref through a CDP clip in document coordinates on a visible pane', async () => {
    const { deps, captures } = rig()
    await snapshotVerb({ paneId: 'bp-1' }, deps)
    await screenshotVerb({ paneId: 'bp-1', ref: 's1e2', format: 'jpeg', quality: 70 }, deps)
    expect(captures[0]).toMatchObject({
      plan: { method: 'cdp', clip: 'element' },
      format: 'jpeg',
      quality: 70,
      documentRect: { x: 10, y: 120, width: 100, height: 50 }
    })
  })

  it('crops a hidden pane from the capture instead of asking CDP', async () => {
    const { deps, captures } = rig({ mode: 'hidden' })
    await screenshotVerb({ paneId: 'bp-1', selector: '#save' }, deps)
    expect(captures[0]).toMatchObject({
      plan: { method: 'capturePage', cropToElement: true },
      viewportRect: { x: 10, y: 20, width: 100, height: 50 }
    })
    expect(captures[0]!.documentRect).toBeUndefined()
  })

  it('fullPage clips the whole page, capped at 8000 px, and says so when the pane is hidden', async () => {
    const tall = rig()
    tall.replies['Page.getLayoutMetrics'] = () => ({
      cssContentSize: { width: 1280, height: 20_000 }
    })
    const res = await screenshotVerb({ paneId: 'bp-1', fullPage: true }, tall.deps)
    expect(tall.captures[0]).toMatchObject({
      documentRect: { x: 0, y: 0, width: 1280, height: 8000 }
    })
    expect(res.clamped).toBe(true)

    const hidden = rig({ mode: 'hidden' })
    const r2 = await screenshotVerb({ paneId: 'bp-1', fullPage: true }, hidden.deps)
    expect(r2.fullPageDowngraded).toBeTruthy()
  })

  it('saves under .harnu/out/browser/shots only when asked', async () => {
    const { deps } = rig()
    expect(await screenshotVerb({ paneId: 'bp-1' }, deps)).not.toHaveProperty('path')
    const saved = await screenshotVerb({ paneId: 'bp-1', save: true }, deps)
    expect(saved.path).toBe('.harnu/out/browser/shots/s.png')
    expect(deps.saveShot).toHaveBeenCalledWith(FOLDER, expect.any(Uint8Array), 'png')
  })

  it('refuses a dead ref, an unknown ref, a missing selector and an invisible element', async () => {
    const { deps, readers, replies } = rig()
    expect(await screenshotVerb({ paneId: 'bp-1', ref: 's1e1' }, deps)).toMatchObject({
      error: 'REF_NOT_FOUND'
    })
    await snapshotVerb({ paneId: 'bp-1' }, deps)
    readers.refs.invalidate()
    expect(await screenshotVerb({ paneId: 'bp-1', ref: 's1e2' }, deps)).toMatchObject({
      error: 'REF_STALE'
    })
    expect(await screenshotVerb({ paneId: 'bp-1', selector: '#missing' }, deps)).toMatchObject({
      error: 'SELECTOR_NOT_FOUND'
    })
    replies['DOM.getBoxModel'] = () => ({ model: { border: [0, 0, 0, 0, 0, 0, 0, 0] } })
    expect(await screenshotVerb({ paneId: 'bp-1', selector: '#zero' }, deps)).toMatchObject({
      error: 'ELEMENT_NOT_VISIBLE'
    })
  })

  it('maps a node that left the document to REF_STALE', async () => {
    const { deps, replies } = rig()
    await snapshotVerb({ paneId: 'bp-1' }, deps)
    replies['DOM.getBoxModel'] = () => {
      throw new Error('Could not compute box model.')
    }
    expect(await screenshotVerb({ paneId: 'bp-1', ref: 's1e2' }, deps)).toMatchObject({
      error: 'REF_STALE'
    })
  })

  it('validates its arguments', async () => {
    const { deps } = rig()
    expect(await screenshotVerb({ paneId: 'bp-1', ref: 'a', selector: 'b' }, deps)).toMatchObject({
      error: 'BAD_ARGS'
    })
    expect(await screenshotVerb({ paneId: 'bp-1', maxDim: 4000 }, deps)).toMatchObject({
      error: 'BAD_ARGS'
    })
    expect(await screenshotVerb({ paneId: 'bp-1', quality: 0 }, deps)).toMatchObject({
      error: 'BAD_ARGS'
    })
    expect(
      await screenshotVerb({ paneId: 'bp-1', fullPage: true, selector: 'a' }, deps)
    ).toMatchObject({ error: 'BAD_ARGS' })
  })

  it('turns a capture failure into a steering refusal', async () => {
    const { deps, host } = rig()
    ;(host.capture as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('the page has not painted yet')
    )
    expect(await screenshotVerb({ paneId: 'bp-1' }, deps)).toMatchObject({
      ok: false,
      error: 'SCREENSHOT_FAILED'
    })
  })
})

describe('browser_console', () => {
  const log = (r: ReturnType<typeof rig>, type: string, text: string) =>
    r.readers.ingest('Runtime.consoleAPICalled', {
      type,
      args: [{ type: 'string', value: text }],
      timestamp: 5
    })

  it('tails, filters by level, scrubs and returns a cursor and droppedEntries', async () => {
    const r = rig()
    log(r, 'log', 'one')
    log(r, 'error', 'failed at /home/u/app.js')
    const all = await consoleVerb({ paneId: 'bp-1' }, r.deps)
    expect(all.entries).toHaveLength(2)
    expect(all).toMatchObject({ droppedEntries: 0, note: BROWSER_NOTE })
    const errs = await consoleVerb({ paneId: 'bp-1', levels: ['error'] }, r.deps)
    expect((errs.entries as Array<{ text: string }>)[0]!.text).toBe('failed at ~/app.js')
  })

  it('continues from a cursor and refuses a stale one', async () => {
    const r = rig()
    log(r, 'log', 'one')
    const first = await consoleVerb({ paneId: 'bp-1' }, r.deps)
    log(r, 'log', 'two')
    const next = await consoleVerb(
      { paneId: 'bp-1', mode: 'since', since: first.cursor as string },
      r.deps
    )
    expect((next.entries as Array<{ text: string }>).map((e) => e.text)).toEqual(['two'])
    expect(
      await consoleVerb({ paneId: 'bp-1', mode: 'since', since: 'k9999' }, r.deps)
    ).toMatchObject({ error: 'CURSOR_EXPIRED' })
  })

  it('validates lines, levels and a since read without a cursor', async () => {
    const { deps } = rig()
    expect(await consoleVerb({ paneId: 'bp-1', lines: 900 }, deps)).toMatchObject({
      error: 'BAD_ARGS'
    })
    expect(await consoleVerb({ paneId: 'bp-1', mode: 'since' }, deps)).toMatchObject({
      error: 'BAD_ARGS'
    })
  })

  it('clear empties the buffer after reading', async () => {
    const r = rig()
    log(r, 'log', 'one')
    await consoleVerb({ paneId: 'bp-1', clear: true }, r.deps)
    expect((await consoleVerb({ paneId: 'bp-1' }, r.deps)).entries).toEqual([])
  })
})

describe('browser_network', () => {
  const req = (r: ReturnType<typeof rig>, id: string, url: string) =>
    r.readers.ingest('Network.requestWillBeSent', {
      requestId: id,
      type: 'XHR',
      request: { url, method: 'GET' }
    })

  it('is off by default: read before start is empty and not active', async () => {
    const r = rig()
    req(r, '1', 'http://localhost/a')
    expect(await networkVerb({ paneId: 'bp-1', action: 'read' }, r.deps)).toMatchObject({
      ok: true,
      active: false,
      entries: []
    })
  })

  it('start → read → stop', async () => {
    const r = rig()
    const started = await networkVerb({ paneId: 'bp-1', action: 'start', maxMinutes: 5 }, r.deps)
    expect(started).toMatchObject({
      ok: true,
      active: true,
      expiresAt: 1_000 + 5 * 60_000,
      bodies: false,
      othersWrote: false
    })
    req(r, '1', 'http://localhost/a?token=zzz')
    const read = await networkVerb({ paneId: 'bp-1', action: 'read' }, r.deps)
    expect(read).toMatchObject({ active: true, note: BROWSER_NOTE })
    expect((read.entries as Array<{ url: string }>)[0]!.url).toBe('http://localhost/a?token=*')
    expect(await networkVerb({ paneId: 'bp-1', action: 'stop' }, r.deps)).toMatchObject({
      active: false
    })
    expect(r.readers.capture.status().active).toBe(false)
  })

  it('refuses a start longer than 30 minutes and a limit over 500', async () => {
    const { deps } = rig()
    expect(
      await networkVerb({ paneId: 'bp-1', action: 'start', maxMinutes: 31 }, deps)
    ).toMatchObject({ error: 'BAD_ARGS' })
    expect(await networkVerb({ paneId: 'bp-1', action: 'read', limit: 501 }, deps)).toMatchObject({
      error: 'BAD_ARGS'
    })
  })

  it('lists the capture in browser_list through captureStatus', async () => {
    const r = rig()
    r.host.captureStatus = () => r.readers.capture.status()
    await networkVerb({ paneId: 'bp-1', action: 'start' }, r.deps)
    expect(r.host.captureStatus('bp-1')).toMatchObject({ active: true })
  })

  it('on an external page start and read are a lease row the handler re-checks (no lease: BROWSER_LEASE_ENDED); stop still works', async () => {
    const r = rig({ url: 'https://example.com/' })
    expect(await networkVerb({ paneId: 'bp-1', action: 'start' }, r.deps)).toMatchObject({
      ok: false,
      error: 'BROWSER_LEASE_ENDED'
    })
    expect(await networkVerb({ paneId: 'bp-1', action: 'read' }, r.deps)).toMatchObject({
      ok: false,
      error: 'BROWSER_LEASE_ENDED'
    })
    expect(await networkVerb({ paneId: 'bp-1', action: 'stop' }, r.deps)).toMatchObject({
      ok: true,
      active: false
    })
  })

  it('refuses an operator pane and a disconnected pane like every other read', async () => {
    expect(
      await networkVerb({ paneId: 'bp-1', action: 'read' }, rig({ openedBy: 'operator' }).deps)
    ).toMatchObject({ error: 'BROWSER_READ_NOT_ENABLED' })
    const r = rig()
    r.access.disconnect('bp-1')
    expect(await networkVerb({ paneId: 'bp-1', action: 'read' }, r.deps)).toMatchObject({
      error: 'BROWSER_DISCONNECTED'
    })
  })
})

describe('browser_network while paused', () => {
  it('lets read and stop through but refuses start', async () => {
    const r = rig()
    await networkVerb({ paneId: 'bp-1', action: 'start' }, r.deps)
    r.access.pause('bp-1')
    expect(await networkVerb({ paneId: 'bp-1', action: 'read' }, r.deps)).toMatchObject({
      ok: true,
      active: true
    })
    expect(await networkVerb({ paneId: 'bp-1', action: 'stop' }, r.deps)).toMatchObject({
      ok: true,
      active: false
    })
    expect(await networkVerb({ paneId: 'bp-1', action: 'start' }, r.deps)).toMatchObject({
      ok: false,
      error: 'BROWSER_PAUSED'
    })
  })
})

describe('browser_wait_for', () => {
  it('needs a condition, and validates the url regex and the timeout', async () => {
    const { deps } = rig()
    expect(await waitForVerb({ paneId: 'bp-1' }, deps)).toMatchObject({ error: 'BAD_ARGS' })
    expect(await waitForVerb({ paneId: 'bp-1', url: '(' }, deps)).toMatchObject({
      error: 'BAD_ARGS'
    })
    expect(await waitForVerb({ paneId: 'bp-1', url: 'a'.repeat(201) }, deps)).toMatchObject({
      error: 'BAD_ARGS'
    })
    expect(
      await waitForVerb({ paneId: 'bp-1', text: 'x', timeoutMs: 999_999 }, deps)
    ).toMatchObject({ error: 'BAD_ARGS' })
    expect(await waitForVerb({ paneId: 'bp-1', networkIdleMs: 5 }, deps)).toMatchObject({
      error: 'BAD_ARGS'
    })
  })

  it('carries the untrusted-content note like every other reading verb', async () => {
    const { deps } = rig()
    const res = await waitForVerb({ paneId: 'bp-1', selector: '#ok' }, deps)
    expect(res).toMatchObject({ untrustedNote: BROWSER_NOTE, note: BROWSER_NOTE })
  })

  it('refuses a url pattern that could backtrack catastrophically', async () => {
    const { deps } = rig()
    expect(await waitForVerb({ paneId: 'bp-1', url: '(a+)+$' }, deps)).toMatchObject({
      error: 'BAD_ARGS'
    })
  })

  it('returns the reason that fired', async () => {
    const { deps } = rig()
    expect(await waitForVerb({ paneId: 'bp-1', selector: '#ok' }, deps)).toMatchObject({
      ok: true,
      wait: { reason: 'selector', match: '#ok' }
    })
    expect(await waitForVerb({ paneId: 'bp-1', text: 'Welcome' }, deps)).toMatchObject({
      wait: { reason: 'text' }
    })
    expect(await waitForVerb({ paneId: 'bp-1', textGone: 'Spinner' }, deps)).toMatchObject({
      wait: { reason: 'textGone' }
    })
  })

  it('shows a url match without the query string', async () => {
    const { deps } = rig()
    const res = await waitForVerb({ paneId: 'bp-1', url: 'app\\?token' }, deps)
    expect(res.wait).toMatchObject({ reason: 'url', match: 'http://localhost:5173/app' })
  })

  it('a timeout is not an error', async () => {
    const { deps } = rig()
    const res = await waitForVerb({ paneId: 'bp-1', selector: '#missing', timeoutMs: 300 }, deps)
    expect(res).toMatchObject({ ok: true, wait: { reason: 'timeout', waitedMs: 300 } })
  })

  it('uses the lightweight idle counter without capture being on', async () => {
    const r = rig()
    expect(r.readers.capture.status().active).toBe(false)
    const res = await waitForVerb({ paneId: 'bp-1', networkIdleMs: 200, timeoutMs: 2_000 }, r.deps)
    expect(res.wait).toMatchObject({ reason: 'networkIdle' })
  })

  it('ends with closed when the pane goes away while waiting', async () => {
    const r = rig()
    r.deps.sleep = async (ms) => {
      r.live.delete('bp-1')
      r.registry.remove('bp-1')
      void ms
    }
    expect(
      (await waitForVerb({ paneId: 'bp-1', selector: '#missing' }, r.deps)).wait
    ).toMatchObject({ reason: 'closed' })
  })

  it('rejects an invalid selector up front instead of timing out', async () => {
    const r = rig()
    r.replies['DOM.querySelector'] = () => {
      throw new Error('DOM.querySelector: SyntaxError: ">>" is not a valid selector')
    }
    expect(await waitForVerb({ paneId: 'bp-1', selector: '>>' }, r.deps)).toMatchObject({
      error: 'BAD_ARGS'
    })
  })
})
