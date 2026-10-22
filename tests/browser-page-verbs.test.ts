/**
 * T569 (browser pane U2, AC-6, AC-7, AC-10, AC-11) — `browser_set_data`, `browser_patch` and the `path` / `html`
 * forms of `browser_open`, over fakes for the view and a REAL temporary folder for the files; plus the plan-level
 * ordering of the content refusals (spec §6.3) and the Scheduler allowlist (decision 25).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'node:fs'
import { promises as fsp } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { createBrowserAccess, gateBrowserOp } from '../src/main/browser/access'
import { createBrowserRegistry } from '../src/main/browser/registry'
import { createPageStateStore } from '../src/main/browser/page-state'
import { buildPageUrl, folderIdOf } from '../src/main/browser/page-url'
import { checkBrowserContent } from '../src/main/browser/content-check'
import { MAX_PANEL_HTML_BYTES } from '../src/main/browser/page-content'
import { panelSlug, patchVerb, setDataVerb } from '../src/main/browser/page-verbs'
import {
  openVerb,
  type BrowserHost,
  type BrowserVerbDeps,
  type LivePaneInfo
} from '../src/main/browser/verbs-core'
import { planToolCall } from '../src/main/mcp/plan-tool-call'
import { buildPlanInput } from '../src/main/mcp/plan-input'
import { OBSERVE_MCP_ALLOW, OBSERVE_MCP_DENY } from '../src/main/scheduler-core'

let root: string
const clock = 1_000

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'harnu-page-verbs-')))
  fs.mkdirSync(path.join(root, 'docs'), { recursive: true })
  fs.writeFileSync(path.join(root, 'docs', 'board.html'), '<h1>board</h1>')
  fs.mkdirSync(path.join(root, '.git'))
  fs.writeFileSync(path.join(root, '.git', 'config'), 'x')
})
afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

function rig(over: Partial<BrowserVerbDeps> = {}) {
  const live = new Map<string, LivePaneInfo>()
  let seq = 0
  const host: BrowserHost = {
    create: vi.fn(({ paneId, url }) => {
      live.set(paneId, { url, title: '', loading: false, canGoBack: false, canGoForward: false })
    }),
    info: (id) => live.get(id),
    navigate: vi.fn(),
    destroy: vi.fn((id) => void live.delete(id)),
    publishFlag: vi.fn()
  }
  const registry = createBrowserRegistry(() => clock)
  const access = createBrowserAccess(() => clock)
  const state = createPageStateStore({
    now: () => clock,
    fs: {
      readFile: (f) => fsp.readFile(f, 'utf8'),
      readFileSync: (f) => fs.readFileSync(f, 'utf8'),
      writeAtomic: async (f, body) => {
        await fsp.mkdir(path.dirname(f), { recursive: true })
        await fsp.writeFile(f, body)
      }
    }
  })
  const pushed: Array<[string, string, number]> = []
  const patchResult = { current: { matched: 2, applied: 2 } as unknown }
  const deps: BrowserVerbDeps = {
    now: () => clock,
    newPaneId: () => `bp-${++seq}`,
    registry,
    access,
    host,
    writesEnabled: async () => true,
    trustedHosts: () => [],
    harnuPorts: () => [],
    sessionKnown: (id) => id === 'sess-1',
    showPane: vi.fn(async () => true),
    hidePane: vi.fn(async () => true),
    scrub: (t) => t,
    alias: (f) => path.basename(f),
    folderBlocked: () => false,
    pages: {
      folderFor: async (folder) => ({ folder, realFolder: fs.realpathSync(folder) }),
      fs: { realpath: (p) => fsp.realpath(p), stat: (p) => fsp.stat(p) },
      locate: async (liveUrl) => {
        const m = /^harnu-page:\/\/f([0-9a-f]{12})\/(.+)$/.exec(liveUrl)
        return m && m[1] === folderIdOf(root)
          ? { folder: root, relPath: decodeURIComponent(m[2]!) }
          : null
      },
      state,
      pushData: (folder, rel, st) => (pushed.push([folder, rel, st.rev]), 1),
      runPatch: vi.fn(async () => patchResult.current as never),
      writePanel: vi.fn(async (folder: string, slug: string, html: string) => {
        const rel = `.harnu/out/panels/${slug}.html`
        await fsp.mkdir(path.join(folder, '.harnu', 'out', 'panels'), { recursive: true })
        await fsp.writeFile(path.join(folder, rel), html)
        return { ok: true as const, relPath: rel }
      }),
      urlFor: (real, rel) => buildPageUrl(folderIdOf(real), rel)
    },
    ...over
  }
  return { deps, host, registry, access, live, pushed, patchResult }
}

/** Open a page pane for docs/board.html and return its id. */
async function openBoard(r: ReturnType<typeof rig>): Promise<string> {
  const res = await openVerb({ folder: root, path: 'docs/board.html' }, r.deps)
  expect(res).toMatchObject({ ok: true, origin: 'page' })
  return res.paneId as string
}

describe('browser_open({ path }) and ({ html, name }) (AC-10)', () => {
  it('opens a page pane on a jailed file and acks with the shared fields', async () => {
    const r = rig()
    const res = await openVerb(
      { folder: root, path: 'docs/board.html', ownerSessionId: 'sess-1' },
      r.deps
    )
    expect(res).toMatchObject({
      ok: true,
      paneId: 'bp-1',
      origin: 'page',
      reused: false,
      openedBy: 'agent',
      ownerSessionId: 'sess-1',
      path: 'docs/board.html',
      flagged: false
    })
    expect(res.url).toBe(buildPageUrl(folderIdOf(root), 'docs/board.html'))
    expect(r.host.create).toHaveBeenCalledWith(expect.objectContaining({ partition: 'agent' }))
    expect(r.registry.get('bp-1')).toMatchObject({
      pagePath: 'docs/board.html',
      allowNetwork: false
    })
    expect(r.deps.showPane).toHaveBeenCalledWith(
      expect.objectContaining({ pagePath: 'docs/board.html' })
    )
  })

  it('accepts an absolute path inside the folder', async () => {
    const r = rig()
    expect(
      await openVerb({ folder: root, path: path.join(root, 'docs', 'board.html') }, r.deps)
    ).toMatchObject({ ok: true })
  })

  it('dedupes on the file: a second open reuses the pane', async () => {
    const r = rig()
    const first = await openBoard(r)
    const second = await openVerb({ folder: root, path: './docs/board.html' }, r.deps)
    expect(second).toMatchObject({ ok: true, paneId: first, reused: true })
    expect(r.host.create).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['outside the folder', '../outside.html', 'escape'],
    ['.git', '.git/config', 'denied-path'],
    ['a NUL', 'docs/a\0.html', 'bad-path']
  ])('refuses a path %s with PATH_NOT_ALLOWED', async (_l, p, reason) => {
    const r = rig()
    const res = await openVerb({ folder: root, path: p }, r.deps)
    expect(res).toMatchObject({ ok: false, error: 'PATH_NOT_ALLOWED' })
    expect(String(res.message)).toContain(reason)
    expect(r.host.create).not.toHaveBeenCalled()
  })

  it('refuses a missing file as BAD_ARGS and an unknown folder as PATH_NOT_ALLOWED', async () => {
    const r = rig()
    expect(await openVerb({ folder: root, path: 'nope.html' }, r.deps)).toMatchObject({
      ok: false,
      error: 'BAD_ARGS'
    })
    const none = rig({ pages: { ...r.deps.pages, folderFor: async () => null } })
    expect(await openVerb({ folder: root, path: 'docs/board.html' }, none.deps)).toMatchObject({
      ok: false,
      error: 'PATH_NOT_ALLOWED'
    })
  })

  it('writes .harnu/out/panels/<slug>.html for { html, name } and opens it', async () => {
    const r = rig()
    const res = await openVerb(
      { folder: root, html: '<p>hello</p>', name: 'Sprint Status!' },
      r.deps
    )
    expect(res).toMatchObject({
      ok: true,
      origin: 'page',
      path: '.harnu/out/panels/sprint-status.html',
      reused: false
    })
    expect(fs.readFileSync(path.join(root, '.harnu/out/panels/sprint-status.html'), 'utf8')).toBe(
      '<p>hello</p>'
    )
    // Same name again rewrites the file and reuses the pane (the watcher reloads it).
    const again = await openVerb(
      { folder: root, html: '<p>v2</p>', name: 'Sprint Status!' },
      r.deps
    )
    expect(again).toMatchObject({ ok: true, reused: true, paneId: res.paneId })
    expect(fs.readFileSync(path.join(root, '.harnu/out/panels/sprint-status.html'), 'utf8')).toBe(
      '<p>v2</p>'
    )
  })

  it('refuses html without a name, and html over 256 KiB', async () => {
    const r = rig()
    expect(await openVerb({ folder: root, html: '<p/>' }, r.deps)).toMatchObject({
      ok: false,
      error: 'BAD_ARGS'
    })
    expect(
      await openVerb(
        { folder: root, html: 'x'.repeat(MAX_PANEL_HTML_BYTES + 1), name: 'big' },
        r.deps
      )
    ).toMatchObject({ ok: false, error: 'HTML_TOO_LARGE' })
    expect(fs.existsSync(path.join(root, '.harnu/out/panels/big.html'))).toBe(false)
  })

  it('counts a page pane toward the 4-per-folder cap', async () => {
    const r = rig()
    for (let i = 0; i < 4; i++) {
      expect(
        await openVerb({ folder: root, html: `<p>${i}</p>`, name: `p${i}` }, r.deps)
      ).toMatchObject({ ok: true })
    }
    expect(await openVerb({ folder: root, html: '<p/>', name: 'fifth' }, r.deps)).toMatchObject({
      ok: false,
      error: 'PANE_LIMIT'
    })
  })

  it('slugs names safely', () => {
    expect(panelSlug('Sprint Status!')).toBe('sprint-status')
    expect(panelSlug('../../etc/passwd')).toBe('etc-passwd')
    expect(panelSlug('ÁÉ café')).toBe('ae-cafe')
    expect(panelSlug('!!!')).toBe('panel')
    expect(panelSlug('x'.repeat(200)).length).toBeLessThanOrEqual(60)
  })
})

describe('browser_set_data (AC-6)', () => {
  it('stores the state, bumps rev and reports delivered/persisted', async () => {
    const r = rig()
    const paneId = await openBoard(r)
    const res = await setDataVerb({ paneId, data: { count: 3 } }, r.deps)
    expect(res).toMatchObject({
      ok: true,
      paneId,
      origin: 'page',
      rev: 1,
      delivered: true,
      persisted: true
    })
    expect(res.bytes).toBe(JSON.stringify({ count: 3 }).length)
    expect(r.pushed).toEqual([[root, 'docs/board.html', 1]])
    const merged = await setDataVerb({ paneId, data: { extra: true }, merge: true }, r.deps)
    expect(merged).toMatchObject({ ok: true, rev: 2 })
    expect((await r.deps.pages.state.read(root, 'docs/board.html')).data).toEqual({
      count: 3,
      extra: true
    })
  })

  it('delivered is false when no loaded page took it, but the value is persisted', async () => {
    const r = rig()
    const paneId = await openBoard(r)
    r.deps.pages.pushData = () => 0
    expect(await setDataVerb({ paneId, data: 1 }, r.deps)).toMatchObject({
      ok: true,
      delivered: false,
      persisted: true
    })
  })

  it('refuses REV_CONFLICT and DATA_TOO_LARGE with nothing written', async () => {
    const r = rig()
    const paneId = await openBoard(r)
    await setDataVerb({ paneId, data: 1 }, r.deps)
    expect(await setDataVerb({ paneId, data: 2, expectRev: 0 }, r.deps)).toMatchObject({
      ok: false,
      error: 'REV_CONFLICT'
    })
    expect(await setDataVerb({ paneId, data: 'x'.repeat(300_000) }, r.deps)).toMatchObject({
      ok: false,
      error: 'DATA_TOO_LARGE'
    })
    expect((await r.deps.pages.state.read(root, 'docs/board.html')).data).toBe(1)
  })

  it('requires data and a non-negative integer expectRev', async () => {
    const r = rig()
    const paneId = await openBoard(r)
    expect(await setDataVerb({ paneId }, r.deps)).toMatchObject({ ok: false, error: 'BAD_ARGS' })
    expect(await setDataVerb({ paneId, data: 1, expectRev: -1 }, r.deps)).toMatchObject({
      ok: false,
      error: 'BAD_ARGS'
    })
    expect(await setDataVerb({ paneId, data: null }, r.deps)).toMatchObject({ ok: true })
  })

  it('refuses NOT_A_PAGE_PANE on a local, an external and a blank pane', async () => {
    const r = rig()
    for (const url of ['http://localhost:5173/', 'https://example.com/', 'about:blank']) {
      const open = await openVerb({ folder: root, url }, r.deps)
      const res = await setDataVerb({ paneId: open.paneId as string, data: 1 }, r.deps)
      expect(res).toMatchObject({ ok: false, error: 'NOT_A_PAGE_PANE' })
    }
  })

  it('reads the class from the LIVE url: a page pane that navigated away is no longer a page pane', async () => {
    const r = rig()
    const paneId = await openBoard(r)
    r.live.set(paneId, { ...r.live.get(paneId)!, url: 'https://evil.example/' })
    expect(await setDataVerb({ paneId, data: 1 }, r.deps)).toMatchObject({
      ok: false,
      error: 'NOT_A_PAGE_PANE'
    })
  })

  it('honours Disconnect, Pause and the kill-switch', async () => {
    const r = rig()
    const paneId = await openBoard(r)
    r.access.pause(paneId)
    expect(await setDataVerb({ paneId, data: 1 }, r.deps)).toMatchObject({
      ok: false,
      error: 'BROWSER_PAUSED'
    })
    r.access.resume(paneId)
    const off = rig({ writesEnabled: async () => false })
    const p2 = await (async () => {
      // the kill-switch also blocks opening, so open through a working rig and share the registry
      const open = await openVerb({ folder: root, path: 'docs/board.html' }, r.deps)
      return open.paneId as string
    })()
    off.deps.registry.add(r.registry.get(p2)!)
    off.live.set(p2, r.live.get(p2)!)
    ;(off.deps.host as { info: BrowserHost['info'] }).info = (id) => r.live.get(id)
    expect(await setDataVerb({ paneId: p2, data: 1 }, off.deps)).toMatchObject({
      ok: false,
      error: 'BROWSER_WRITES_DISABLED'
    })
    r.access.disconnect(paneId)
    expect(await setDataVerb({ paneId, data: 1 }, r.deps)).toMatchObject({
      ok: false,
      error: 'BROWSER_DISCONNECTED'
    })
  })

  it('works on an OPERATOR-opened page pane with no lease (spec §7.1 live-panel row)', async () => {
    const r = rig()
    const url = buildPageUrl(folderIdOf(root), 'docs/board.html')
    r.registry.add({
      paneId: 'op-1',
      folder: root,
      name: 'op',
      openedBy: 'operator',
      partition: 'operator',
      ownerSessionId: null,
      createdAt: 1,
      lastActiveAt: 1,
      seenHosts: new Set(),
      flagged: null
    })
    r.live.set('op-1', { url, title: '', loading: false, canGoBack: false, canGoForward: false })
    expect(await setDataVerb({ paneId: 'op-1', data: { a: 1 } }, r.deps)).toMatchObject({
      ok: true,
      rev: 1
    })
  })
})

describe('browser_patch (AC-7)', () => {
  it('applies a patch and reports matched/applied', async () => {
    const r = rig()
    const paneId = await openBoard(r)
    const res = await patchVerb({ paneId, selector: '#n', mode: 'inner', html: '<b>4</b>' }, r.deps)
    expect(res).toMatchObject({ ok: true, paneId, origin: 'page', matched: 2, applied: 2 })
    expect(r.deps.pages.runPatch).toHaveBeenCalledWith(
      paneId,
      expect.stringContaining('querySelectorAll')
    )
  })

  it('refuses zero matches and a bad selector as SELECTOR_NOT_FOUND', async () => {
    const r = rig()
    const paneId = await openBoard(r)
    r.patchResult.current = { matched: 0, applied: 0 }
    expect(await patchVerb({ paneId, selector: '.none', mode: 'remove' }, r.deps)).toMatchObject({
      ok: false,
      error: 'SELECTOR_NOT_FOUND'
    })
    r.patchResult.current = { matched: 0, applied: 0, badSelector: 'bad' }
    expect(await patchVerb({ paneId, selector: '[[', mode: 'remove' }, r.deps)).toMatchObject({
      ok: false,
      error: 'SELECTOR_NOT_FOUND'
    })
    // A page that never became ready is NOT a selector that matched nothing (F8).
    r.patchResult.current = null
    expect(await patchVerb({ paneId, selector: '#a', mode: 'remove' }, r.deps)).toMatchObject({
      ok: false,
      error: 'PAGE_NOT_READY'
    })
  })

  it('validates mode, selector and html (64 KiB cap)', async () => {
    const r = rig()
    const paneId = await openBoard(r)
    expect(
      await patchVerb({ paneId, selector: '', mode: 'inner', html: 'x' }, r.deps)
    ).toMatchObject({ ok: false, error: 'BAD_ARGS' })
    expect(
      await patchVerb({ paneId, selector: '#a', mode: 'swap', html: 'x' }, r.deps)
    ).toMatchObject({ ok: false, error: 'BAD_ARGS' })
    expect(await patchVerb({ paneId, selector: '#a', mode: 'inner' }, r.deps)).toMatchObject({
      ok: false,
      error: 'BAD_ARGS'
    })
    expect(await patchVerb({ paneId, selector: '#a', mode: 'remove' }, r.deps)).toMatchObject({
      ok: true
    })
    expect(
      await patchVerb(
        { paneId, selector: '#a', mode: 'inner', html: 'x'.repeat(65 * 1024) },
        r.deps
      )
    ).toMatchObject({ ok: false, error: 'HTML_TOO_LARGE' })
  })

  it('refuses NOT_A_PAGE_PANE on a local or external pane, before touching the page', async () => {
    const r = rig()
    for (const url of ['http://localhost:3000/', 'https://example.com/']) {
      const open = await openVerb({ folder: root, url }, r.deps)
      expect(
        await patchVerb({ paneId: open.paneId as string, selector: 'a', mode: 'remove' }, r.deps)
      ).toMatchObject({
        ok: false,
        error: 'NOT_A_PAGE_PANE'
      })
    }
    expect(r.deps.pages.runPatch).not.toHaveBeenCalled()
  })
})

describe('plan-level ordering of the content refusals (spec §6.3)', () => {
  const policy = (ask: boolean) => ({
    serverEnabled: true,
    ask,
    denyFolders: [],
    knownRoots: ['/work']
  })
  const page = {
    openedBy: 'agent' as const,
    originClass: 'page' as const,
    disconnected: false,
    paused: false
  }
  const plan = (
    op: 'browser_set_data' | 'browser_patch',
    args: Record<string, unknown>,
    browser: Parameters<typeof planToolCall>[0]['browser'],
    ask: boolean
  ) =>
    planToolCall({
      tool: op,
      input: buildPlanInput(op, args, '/work/app'),
      policy: policy(ask),
      now: 1,
      browser
    })

  it('a size refusal is a deny that never confirms, free and ask mode alike, and beats the kill-switch', () => {
    const big = { paneId: 'bp-1', data: 'x'.repeat(300_000) }
    expect(checkBrowserContent('browser_set_data', big)?.code).toBe('DATA_TOO_LARGE')
    for (const ask of [false, true]) {
      for (const writesEnabled of [true, false]) {
        const p = plan('browser_set_data', big, { pane: page, writesEnabled }, ask)
        expect(p).toMatchObject({ verdict: 'deny', shouldConfirm: false, shouldDispatch: false })
        expect(p.auditRecord.result).toBe('DATA_TOO_LARGE')
      }
    }
  })

  it('NOT_A_PAGE_PANE is a deny that never confirms in ask mode, and also beats the kill-switch', () => {
    const external = { ...page, originClass: 'external' as const }
    for (const op of ['browser_set_data', 'browser_patch'] as const) {
      const p = plan(
        op,
        { paneId: 'bp-1', data: 1, selector: 'a', mode: 'remove' },
        { pane: external, writesEnabled: false },
        true
      )
      expect(p).toMatchObject({ verdict: 'deny', shouldConfirm: false })
      expect(p.auditRecord.result).toBe('NOT_A_PAGE_PANE')
    }
  })

  it('an acceptable call on a page pane is allowed in free mode and confirmed in ask mode', () => {
    expect(
      plan(
        'browser_patch',
        { paneId: 'bp-1', selector: 'a', mode: 'remove' },
        { pane: page, writesEnabled: true },
        false
      )
    ).toMatchObject({ verdict: 'allow', shouldDispatch: true })
    expect(
      plan(
        'browser_patch',
        { paneId: 'bp-1', selector: 'a', mode: 'remove' },
        { pane: page, writesEnabled: true },
        true
      )
    ).toMatchObject({ verdict: 'confirm', shouldConfirm: true })
  })

  it('checkBrowserContent measures bytes and ignores other verbs', () => {
    expect(checkBrowserContent('browser_patch', { html: 'é'.repeat(33_000) })?.code).toBe(
      'HTML_TOO_LARGE'
    )
    expect(
      checkBrowserContent('browser_open', { html: 'x'.repeat(MAX_PANEL_HTML_BYTES + 1), name: 'p' })
        ?.code
    ).toBe('HTML_TOO_LARGE')
    expect(checkBrowserContent('browser_open', { url: 'http://x' })).toBeNull()
    expect(checkBrowserContent('browser_close', { html: 'x'.repeat(10_000_000) })).toBeNull()
    const cyclic: Record<string, unknown> = {}
    cyclic.c = cyclic
    expect(checkBrowserContent('browser_set_data', { data: cyclic })).toBeNull()
  })

  it('the gate itself orders: pane, Disconnect, page class, content, kill-switch', () => {
    const external = { ...page, originClass: 'external' as const }
    expect(gateBrowserOp('browser_patch', { pane: undefined, writesEnabled: false })).toBe(
      'PANE_NOT_FOUND'
    )
    expect(
      gateBrowserOp('browser_patch', {
        pane: { ...external, disconnected: true },
        writesEnabled: true
      })
    ).toBe('BROWSER_DISCONNECTED')
    expect(
      gateBrowserOp('browser_patch', {
        pane: external,
        writesEnabled: false,
        args: { html: 'x'.repeat(300_000) }
      })
    ).toBe('NOT_A_PAGE_PANE')
    expect(
      gateBrowserOp('browser_patch', {
        pane: page,
        writesEnabled: false,
        args: { html: 'x'.repeat(300_000) }
      })
    ).toBe('HTML_TOO_LARGE')
    expect(gateBrowserOp('browser_patch', { pane: page, writesEnabled: false })).toBe(
      'BROWSER_WRITES_DISABLED'
    )
  })
})

describe('the Scheduler observe allowlist (AC-11)', () => {
  it('allows set_data and patch (and the read verbs of U3), never the opening or acting ones, under both prefixes', () => {
    for (const prefix of ['mcp__harnu__', 'mcp__capy__']) {
      expect(OBSERVE_MCP_ALLOW).toContain(`${prefix}browser_set_data`)
      expect(OBSERVE_MCP_ALLOW).toContain(`${prefix}browser_patch`)
      for (const verb of ['open', 'navigate', 'close']) {
        expect(OBSERVE_MCP_ALLOW).not.toContain(`${prefix}browser_${verb}`)
        expect(OBSERVE_MCP_DENY).toContain(`${prefix}browser_${verb}`)
      }
      expect(OBSERVE_MCP_DENY).not.toContain(`${prefix}browser_set_data`)
    }
  })

  it('an observe worker still cannot patch a non-page pane: the verbs refuse for every caller', async () => {
    const r = rig()
    const open = await openVerb({ folder: root, url: 'https://example.com/' }, r.deps)
    expect(
      await patchVerb({ paneId: open.paneId as string, selector: 'a', mode: 'remove' }, r.deps)
    ).toMatchObject({ error: 'NOT_A_PAGE_PANE' })
    expect(await setDataVerb({ paneId: open.paneId as string, data: 1 }, r.deps)).toMatchObject({
      error: 'NOT_A_PAGE_PANE'
    })
  })
})
