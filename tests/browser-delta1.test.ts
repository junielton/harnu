/**
 * T569 delta 1 — the smaller verified findings: the agent-input history the emit gate reads (F5), the boot tracker
 * behind `set_data` pushes (F3), `pagePath` following the page (F4), the plan-level content rules (F6), the panel
 * write ordering (F7), and the jail corners (F8).
 */
import { describe, expect, it, vi } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { createBrowserRegistry, AGENT_INPUT_HISTORY_MS } from '../src/main/browser/registry'
import { createBootTracker } from '../src/main/browser/page-boot'
import {
  folderIdOf,
  isDeniedPagePath,
  isInsideFolder,
  jailResolve,
  pagePathForUrl,
  buildPageUrl,
  type JailFs,
  type PageFolder
} from '../src/main/browser/page-url'
import { checkBrowserContent, checkOpenPathLexically } from '../src/main/browser/content-check'
import { shapeBrowserDenial } from '../src/main/browser/browser-hints'
import { shapeDenial } from '../src/main/mcp/deny-hint'
import { planToolCall } from '../src/main/mcp/plan-tool-call'
import { buildPlanInput } from '../src/main/mcp/plan-input'
import { createBrowserAccess } from '../src/main/browser/access'
import { openVerb, type BrowserHost, type BrowserVerbDeps } from '../src/main/browser/verbs-core'

describe('F5 — the registry keeps agent input runs for the emit gate', () => {
  it('records runs, closes them FIFO and reports in-flight', () => {
    let t = 1000
    const reg = createBrowserRegistry(() => t)
    reg.beginAgentInput('p')
    t = 1100
    reg.beginAgentInput('p')
    t = 1200
    reg.endAgentInput('p')
    expect(reg.agentInput('p')).toEqual({
      inFlight: true,
      at: 1200,
      intervals: [
        { start: 1000, end: 1200 },
        { start: 1100, end: null }
      ]
    })
    t = 1300
    reg.endAgentInput('p')
    expect(reg.agentInput('p').inFlight).toBe(false)
  })

  it('forgets runs older than the history window, and a closed pane', () => {
    let t = 0
    const reg = createBrowserRegistry(() => t)
    reg.beginAgentInput('p')
    reg.endAgentInput('p')
    t = AGENT_INPUT_HISTORY_MS + 1
    expect(reg.agentInput('p').intervals).toEqual([])
    reg.beginAgentInput('p')
    reg.remove('p')
    expect(reg.agentInput('p')).toEqual({ inFlight: false, at: null, intervals: [] })
  })
})

describe('F3 — a pane is pushed to only while its document has booted', () => {
  it('booted from the preload’s getData until the next navigation starts', () => {
    const boot = createBootTracker()
    expect(boot.isBooted('p')).toBe(false)
    boot.markBooted('p')
    expect(boot.isBooted('p')).toBe(true)
    boot.markNavigating('p')
    expect(boot.isBooted('p')).toBe(false)
    boot.markBooted('p')
    boot.forget('p')
    expect(boot.isBooted('p')).toBe(false)
  })
})

describe('F4 — pagePath follows the page', () => {
  const id = 'f0123456789ab'
  it('names the file of a page URL and nothing else', () => {
    expect(pagePathForUrl(`harnu-page://${id}/docs/a%20b.html`)).toBe('docs/a b.html')
    expect(pagePathForUrl(`harnu-page://${id}/`)).toBeNull()
    expect(pagePathForUrl('https://example.com/docs/a.html')).toBeNull()
    expect(pagePathForUrl('about:blank')).toBeNull()
    expect(pagePathForUrl('')).toBeNull()
  })
  it('dedupe sees the new file once the record is updated', () => {
    const reg = createBrowserRegistry(() => 0)
    reg.add({
      paneId: 'p',
      folder: '/w',
      name: 'n',
      openedBy: 'agent',
      partition: 'agent',
      ownerSessionId: null,
      createdAt: 0,
      lastActiveAt: 0,
      seenHosts: new Set(),
      flagged: null,
      pagePath: 'a.html'
    })
    expect(reg.findPagePane('/w', 'a.html')?.paneId).toBe('p')
    reg.get('p')!.pagePath = pagePathForUrl(`harnu-page://${id}/b.html`)
    expect(reg.findPagePane('/w', 'a.html')).toBeUndefined()
    expect(reg.findPagePane('/w', 'b.html')?.paneId).toBe('p')
    reg.get('p')!.pagePath = pagePathForUrl('https://example.com/')
    expect(reg.findPagePane('/w', 'b.html')).toBeUndefined()
  })
})

describe('F6 — content refusals judged at plan level, before any confirm', () => {
  it('patch: every mode but remove needs html', () => {
    for (const mode of ['inner', 'outer', 'append', 'prepend']) {
      expect(checkBrowserContent('browser_patch', { selector: '#a', mode })).toMatchObject({
        code: 'BAD_ARGS'
      })
      expect(checkBrowserContent('browser_patch', { selector: '#a', mode, html: '' })).toBeNull()
    }
    expect(checkBrowserContent('browser_patch', { selector: '#a', mode: 'remove' })).toBeNull()
  })

  it('open: html needs a name; url with path or html is not "exactly one"; a harnu-page url is refused', () => {
    expect(checkBrowserContent('browser_open', { folder: '/w', html: '<p>' })).toMatchObject({
      code: 'BAD_ARGS'
    })
    expect(
      checkBrowserContent('browser_open', { folder: '/w', html: '<p>', name: '   ' })
    ).toMatchObject({ code: 'BAD_ARGS' })
    expect(
      checkBrowserContent('browser_open', { folder: '/w', url: 'http://a.test', path: 'a.html' })
    ).toMatchObject({ code: 'BAD_ARGS', detail: expect.stringContaining('exactly one') })
    expect(
      checkBrowserContent('browser_open', {
        folder: '/w',
        url: 'http://a.test',
        html: '<p>',
        name: 'p'
      })
    ).toMatchObject({ code: 'BAD_ARGS' })
    expect(
      checkBrowserContent('browser_open', {
        folder: '/w',
        url: 'harnu-page://f0123456789ab/a.html'
      })
    ).toMatchObject({ code: 'BAD_ARGS' })
  })

  it.each([
    ['a NUL', 'docs/a\0.html', 'bad-path'],
    ['a relative escape', '../outside.html', 'escape'],
    ['a deeper relative escape', 'docs/../../outside.html', 'escape'],
    ['.git', '.git/config', 'denied-path'],
    ['a nested .git', 'sub/.git/HEAD', 'denied-path'],
    ['.harnu/memory', '.harnu/memory/hot.md', 'denied-path'],
    ['a NESTED .harnu/memory', 'sub/.harnu/memory/hot.md', 'denied-path'],
    ['an absolute path under .git', '/w/app/.git/config', 'denied-path']
  ])('open path: refuses %s lexically', (_label, rawPath, reason) => {
    expect(checkOpenPathLexically('/w/app', rawPath)).toMatchObject({
      code: 'PATH_NOT_ALLOWED',
      jailReason: reason
    })
    expect(checkBrowserContent('browser_open', { folder: '/w/app', path: rawPath })).toMatchObject({
      code: 'PATH_NOT_ALLOWED'
    })
  })

  it('open path: lets through what only realpath can judge, and ordinary files', () => {
    expect(checkOpenPathLexically('/w/app', 'docs/a.html')).toBeNull()
    expect(checkOpenPathLexically('/w/app', '/w/app/docs/a.html')).toBeNull()
    expect(checkOpenPathLexically('/w/app', '..foo.html')).toBeNull() // an ordinary name, not a climb
    expect(checkOpenPathLexically('/w/app', 'a/..bar/b.html')).toBeNull()
    // Absolute and outside as spelled: the verb realpaths both sides (the folder may be a symlink).
    expect(checkOpenPathLexically('/w/app', '/elsewhere/a.html')).toBeNull()
  })

  const policy = (ask: boolean) => ({
    serverEnabled: true,
    ask,
    denyFolders: [],
    knownRoots: ['/work']
  })
  const gate = { pane: undefined, writesEnabled: true }

  it('is a plan-level deny that never confirms (ask mode) and keeps its reason', () => {
    for (const args of [
      { path: '../x.html' },
      { path: '.git/config' },
      { html: '<p>' },
      { url: 'http://a.test', path: 'a.html' }
    ]) {
      const p = planToolCall({
        tool: 'browser_open',
        input: buildPlanInput('browser_open', { folder: '/work/app', ...args }, '/work/app'),
        policy: policy(true),
        now: 1,
        browser: gate
      })
      expect(p).toMatchObject({ verdict: 'deny', shouldConfirm: false, shouldDispatch: false })
    }
    const p = planToolCall({
      tool: 'browser_open',
      input: buildPlanInput(
        'browser_open',
        { folder: '/work/app', path: '.git/config' },
        '/work/app'
      ),
      policy: policy(true),
      now: 1,
      browser: gate
    })
    expect(p.auditRecord.result).toBe('PATH_NOT_ALLOWED: denied-path')
    expect(shapeDenial(p.auditRecord.result, { folder: '/work/app' })).toMatchObject({
      error: 'PATH_NOT_ALLOWED',
      message: expect.stringContaining('denied-path')
    })
  })

  it('PAGE_NOT_READY has a steering hint', () => {
    expect(shapeBrowserDenial('PAGE_NOT_READY')).toMatchObject({
      error: 'PAGE_NOT_READY',
      nextActions: [expect.objectContaining({ do: expect.stringContaining('Wait') })]
    })
  })
})

describe('F7 — the panel file is written only after every refusal has had its say', () => {
  function rig(over: Partial<BrowserVerbDeps> = {}) {
    const live = new Map<string, { url: string }>()
    let seq = 0
    const host = {
      create: vi.fn(
        ({ paneId, url }: { paneId: string; url: string }) => void live.set(paneId, { url })
      ),
      info: (id: string) => {
        const l = live.get(id)
        return l && { url: l.url, title: '', loading: false, canGoBack: false, canGoForward: false }
      },
      navigate: vi.fn(),
      destroy: vi.fn(),
      publishFlag: vi.fn()
    } as unknown as BrowserHost
    const registry = createBrowserRegistry(() => 1)
    const writePanel = vi.fn(async (_f: string, slug: string) => ({
      ok: true as const,
      relPath: `.harnu/out/panels/${slug}.html`
    }))
    const deps = {
      now: () => 1,
      newPaneId: () => `bp-${++seq}`,
      registry,
      access: createBrowserAccess(() => 1),
      host,
      writesEnabled: async () => true,
      trustedHosts: () => [],
      harnuPorts: () => [],
      sessionKnown: () => true,
      showPane: vi.fn(async () => true),
      hidePane: vi.fn(async () => true),
      scrub: (t: string) => t,
      alias: (f: string) => f,
      folderBlocked: () => false,
      pages: {
        folderFor: async (folder: string) => ({ folder, realFolder: folder }),
        fs: {
          realpath: async (p: string) => p,
          stat: async () => ({ isFile: () => true, isDirectory: () => false, size: 5 })
        },
        locate: async () => null,
        state: {} as never,
        pushData: () => 0,
        runPatch: async () => null,
        writePanel,
        urlFor: (real: string, rel: string) => buildPageUrl(folderIdOf(real), rel)
      },
      ...over
    } as unknown as BrowserVerbDeps
    return { deps, writePanel, registry }
  }

  it('PANE_LIMIT refuses BEFORE anything is written', async () => {
    const r = rig()
    for (let i = 0; i < 4; i++) {
      expect(
        await openVerb({ folder: '/w', html: `<p>${i}</p>`, name: `p${i}` }, r.deps)
      ).toMatchObject({ ok: true })
    }
    r.writePanel.mockClear()
    expect(await openVerb({ folder: '/w', html: '<p/>', name: 'fifth' }, r.deps)).toMatchObject({
      ok: false,
      error: 'PANE_LIMIT'
    })
    expect(r.writePanel).not.toHaveBeenCalled()
  })

  it('but rewriting the file a pane already shows is allowed at the cap (that is the update path)', async () => {
    const r = rig()
    for (let i = 0; i < 4; i++)
      await openVerb({ folder: '/w', html: `<p>${i}</p>`, name: `p${i}` }, r.deps)
    r.writePanel.mockClear()
    expect(await openVerb({ folder: '/w', html: '<p>v2</p>', name: 'p1' }, r.deps)).toMatchObject({
      ok: true,
      reused: true
    })
    expect(r.writePanel).toHaveBeenCalledTimes(1)
  })

  it('a panel directory that escapes the folder is PATH_NOT_ALLOWED and opens nothing', async () => {
    const r = rig()
    r.writePanel.mockResolvedValueOnce({ ok: false, reason: 'escape' } as never)
    expect(await openVerb({ folder: '/w', html: '<p/>', name: 'x' }, r.deps)).toMatchObject({
      ok: false,
      error: 'PATH_NOT_ALLOWED'
    })
    expect(r.deps.host.create).not.toHaveBeenCalled()
  })

  it('an invalid call (no name, too large) never writes', async () => {
    const r = rig()
    await openVerb({ folder: '/w', html: '<p/>' }, r.deps)
    await openVerb({ folder: '/w', html: 'x'.repeat(300_000), name: 'big' }, r.deps)
    expect(r.writePanel).not.toHaveBeenCalled()
  })
})

describe('F8 — jail corners', () => {
  let root: string
  const withTree = async (
    run: (folder: PageFolder, fsx: JailFs) => Promise<void>
  ): Promise<void> => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'harnu-delta1-')))
    try {
      fs.mkdirSync(path.join(root, 'sub', '.harnu', 'memory'), { recursive: true })
      fs.writeFileSync(path.join(root, 'sub', '.harnu', 'memory', 'hot.md'), 'm')
      fs.writeFileSync(path.join(root, '..foo.html'), 'ok')
      fs.mkdirSync(path.join(root, '..dir'))
      fs.writeFileSync(path.join(root, '..dir', 'x.html'), 'ok')
      await run(
        { folder: root, realFolder: root },
        {
          realpath: (p) => fs.promises.realpath(p),
          stat: (p) => fs.promises.stat(p)
        }
      )
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  }
  const req = (folder: PageFolder, fsx: JailFs, rel: string) =>
    jailResolve({
      url: buildPageUrl(folderIdOf(folder.realFolder), rel),
      folders: new Map([[folderIdOf(folder.realFolder), folder]]),
      isBlocked: () => false,
      fs: fsx
    })

  it('denies .harnu/memory at ANY depth', async () => {
    expect(isDeniedPagePath(['sub', '.harnu', 'memory', 'hot.md'])).toBe(true)
    expect(isDeniedPagePath(['.harnu', 'out', 'panels', 'a.html'])).toBe(false)
    await withTree(async (folder, fsx) => {
      expect(await req(folder, fsx, 'sub/.harnu/memory/hot.md')).toMatchObject({
        ok: false,
        reason: 'denied-path'
      })
    })
  })

  it('does not refuse a file or directory named like `..foo`', async () => {
    await withTree(async (folder, fsx) => {
      expect(await req(folder, fsx, '..foo.html')).toMatchObject({ ok: true })
      expect(await req(folder, fsx, '..dir/x.html')).toMatchObject({ ok: true })
    })
    expect(isInsideFolder('/w', '/w/..foo')).toBe(true)
    expect(isInsideFolder('/w', '/w/..')).toBe(false)
    expect(isInsideFolder('/w', '/w/../x')).toBe(false)
    expect(isInsideFolder('/w', '/w')).toBe(false)
    expect(isInsideFolder('/w', '/other/x')).toBe(false)
  })
})
