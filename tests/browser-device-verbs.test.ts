/**
 * T572 (browser pane U5, AC-1, AC-4, AC-5, AC-7, AC-8, AC-9) — `browser_emulate`, `browser_upload` and
 * `browser_download` over a fake host: ACK shapes, the plan-rule re-check inside the queue, rollback when the page
 * refuses, the file-input check and the path jail, the one-shot download allowance, the lease and the kill-switch.
 */
import { describe, it, expect, vi } from 'vitest'
import { createBrowserAccess } from '../src/main/browser/access'
import { clickVerb } from '../src/main/browser/act-verbs'
import { createBrowserRegistry } from '../src/main/browser/registry'
import { createPaneReaders } from '../src/main/browser/pane-readers'
import { BrowserLeases } from '../src/main/browser/lease'
import { BrowserWriteQueue } from '../src/main/browser/write-queue'
import {
  downloadVerb,
  emulateVerb,
  uploadVerb,
  type BrowserDeviceDeps,
  type BrowserDeviceHost
} from '../src/main/browser/device-verbs'
import type { ElementProbe } from '../src/main/browser/act-plan'
import { BROWSER_NOTE, type LivePaneInfo } from '../src/main/browser/verbs-core'
import { deviceFromPreset } from '../src/shared/browser-emulation'
import type { DownloadResult } from '../src/main/browser/download-plan'
import type { UploadIo } from '../src/main/browser/upload-plan'

const FOLDER = '/work/app'
const FILE_INPUT = 30
const BUTTON = 31
const PLAIN_INPUT = 32

const probe = (over: Partial<ElementProbe> = {}): ElementProbe => ({
  rect: { x: 10, y: 20, width: 100, height: 40 },
  disabled: false,
  hit: 'self',
  editable: false,
  isSelect: false,
  tag: 'a',
  ...over
})

interface RigOpts {
  openedBy?: 'agent' | 'operator'
  leaseActive?: boolean
  readOptIn?: boolean
  writes?: boolean
  device?: boolean
  applyFails?: boolean
  download?: DownloadResult | Promise<DownloadResult>
  clickProbe?: ElementProbe
  files?: Record<string, number>
  links?: Record<string, string>
  inputAttrs?: string[]
  /** Touch is emulated: clicks must be taps. */
  touch?: boolean
  scale?: number
}

function rig(opts: RigOpts = {}) {
  let clock = 1_000
  const live = new Map<string, LivePaneInfo>()
  const registry = createBrowserRegistry(() => clock)
  const access = createBrowserAccess(() => clock)
  const leases = new BrowserLeases(() => clock)
  const log: Array<[string, Record<string, unknown>]> = []
  const readers = createPaneReaders({
    now: () => clock,
    send: async () => undefined,
    scrub: (t) => t,
    setTimer: () => 0,
    clearTimer: () => undefined,
    onCaptureChange: () => undefined
  })
  readers.refs.commit(
    readers.refs.nextSnapshotId(),
    new Map([
      [1, FILE_INPUT],
      [2, BUTTON],
      [3, PLAIN_INPUT]
    ]),
    new Map([
      [1, 'button|Choose file'],
      [2, 'link|Download report'],
      [3, 'textbox|Name']
    ])
  )
  const objects = new Map<string, number>()
  const cdp = vi.fn(async (_id: string, method: string, params: Record<string, unknown> = {}) => {
    log.push([method, params])
    switch (method) {
      case 'DOM.describeNode': {
        const b = params.backendNodeId as number
        if (b === FILE_INPUT)
          return {
            node: { nodeName: 'INPUT', attributes: ['type', 'file', ...(opts.inputAttrs ?? [])] }
          }
        if (b === PLAIN_INPUT) return { node: { nodeName: 'INPUT', attributes: ['type', 'text'] } }
        return { node: { nodeName: 'A', attributes: ['href', '/r.pdf'] } }
      }
      case 'DOM.setFileInputFiles':
      case 'DOM.scrollIntoViewIfNeeded':
      case 'Input.dispatchMouseEvent':
      case 'Input.dispatchTouchEvent':
      case 'Runtime.releaseObjectGroup':
        return {}
      case 'DOM.resolveNode': {
        const b = params.backendNodeId as number
        objects.set(`obj-${b}`, b)
        return { object: { objectId: `obj-${b}` } }
      }
      case 'Page.getLayoutMetrics':
        return { cssVisualViewport: { clientWidth: 1280, clientHeight: 800 } }
      case 'Accessibility.getPartialAXTree':
        return { nodes: [{ role: { value: 'link' }, name: { value: 'Download report' } }] }
      case 'Runtime.callFunctionOn':
        return { result: { value: opts.clickProbe ?? probe() } }
      default:
        throw new Error(`no fake for ${method}`)
    }
  })
  let zoom = 1
  const arm = { result: Promise.resolve(opts.download as DownloadResult), disarm: vi.fn() }
  const host: BrowserDeviceHost = {
    create: vi.fn(),
    info: (id) => live.get(id),
    navigate: vi.fn(),
    destroy: vi.fn(),
    publishFlag: vi.fn(),
    readers: (id) => (live.has(id) ? readers : undefined),
    cdp: (id, method, params) => cdp(id, method, (params ?? {}) as Record<string, unknown>),
    viewMode: () => 'visible',
    deviceMode: () => false,
    capture: vi.fn(),
    viewToken: () => 'view-1',
    inputScale: () => opts.scale ?? 1,
    touchActive: () => opts.touch === true,
    drive: vi.fn(),
    applyEmulation: vi.fn(async () => {
      if (opts.applyFails) throw new Error('Emulation domain refused')
      return { fitScale: 0.5, reloaded: false }
    }),
    zoomOf: () => (registry.get('bp-1')?.emulation?.device ? 1 : zoom),
    setZoom: vi.fn((_id: string, f: number) => {
      zoom = Math.min(5, Math.max(0.25, f))
      return zoom
    }),
    armDownload: vi.fn(() => arm),
    downloadUrl: vi.fn()
  }
  const fileStat = (p: string) =>
    opts.files?.[p] === undefined ? null : { kind: 'file' as const, size: opts.files[p]! }
  const uploadIo: UploadIo = {
    realpath: async (p) => {
      let cur = p
      for (let i = 0; i < 6 && opts.links?.[cur] !== undefined; i++) cur = opts.links[cur]!
      if (cur !== FOLDER && opts.files?.[cur] === undefined) throw new Error('ENOENT')
      return cur
    },
    stat: async (p) => fileStat(p)
  }
  const deps: BrowserDeviceDeps = {
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
    scrub: (t) => t,
    alias: (f) => f.split('/').pop() ?? f,
    folderBlocked: () => false,
    sleep: async (ms) => void (clock += ms),
    saveShot: vi.fn(),
    leases,
    readOptIn: async () => opts.readOptIn ?? false,
    queue: new BrowserWriteQueue(),
    uploadIo
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
    flagged: null,
    ...(opts.device ? { emulation: { device: deviceFromPreset('phone-m') } } : {})
  })
  live.set('bp-1', {
    url: 'http://localhost:5173/app',
    title: 'App',
    loading: false,
    canGoBack: false,
    canGoForward: false
  })
  if (opts.leaseActive) leases.grant('bp-1', FOLDER, 'view-1')
  return { deps, registry, host, cdp, log, arm }
}

const calls = (log: Array<[string, Record<string, unknown>]>, m: string) =>
  log.filter(([x]) => x === m).map(([, p]) => p)

describe('browser_emulate', () => {
  it('puts a device on the pane, applies it, and reports what is in effect (AC-2, AC-5)', async () => {
    const r = rig()
    const res = await emulateVerb(
      { paneId: 'bp-1', device: 'phone-m', colorScheme: 'dark' },
      r.deps
    )
    expect(res).toMatchObject({
      ok: true,
      paneId: 'bp-1',
      zoom: 1,
      fitScale: 0.5,
      emulation: {
        device: 'phone-m',
        width: 390,
        height: 844,
        dpr: 3,
        mobile: true,
        touch: true,
        colorScheme: 'dark'
      },
      note: BROWSER_NOTE
    })
    // The record on the pane is the one truth the operator's picker reads (AC-5).
    expect(r.registry.get('bp-1')?.emulation).toMatchObject({
      device: { preset: 'phone-m' },
      colorScheme: 'dark'
    })
    expect(r.host.applyEmulation).toHaveBeenCalledWith('bp-1', { reloadForTouch: true })
  })

  it('a zoom-only call sets the zoom and leaves the device settings alone', async () => {
    const r = rig()
    const res = await emulateVerb({ paneId: 'bp-1', zoom: 1.5 }, r.deps)
    expect(res).toMatchObject({ ok: true, zoom: 1.5 })
    expect(r.host.setZoom).toHaveBeenCalledWith('bp-1', 1.5)
    expect(r.host.applyEmulation).not.toHaveBeenCalled()
  })

  it('clamps an extreme zoom to the host’s answer', async () => {
    const r = rig()
    expect(await emulateVerb({ paneId: 'bp-1', zoom: 50 }, r.deps)).toMatchObject({ zoom: 5 })
  })

  it('zoom on a pane that is in device mode is ZOOM_IN_DEVICE_MODE and changes nothing (AC-4)', async () => {
    const r = rig({ device: true })
    const res = await emulateVerb({ paneId: 'bp-1', zoom: 2 }, r.deps)
    expect(res).toMatchObject({ ok: false, error: 'ZOOM_IN_DEVICE_MODE' })
    expect(r.host.setZoom).not.toHaveBeenCalled()
    expect(r.host.applyEmulation).not.toHaveBeenCalled()
    expect(r.registry.get('bp-1')?.emulation?.device?.preset).toBe('phone-m')
  })

  it('device with explicit size args is BAD_ARGS (AC-4)', async () => {
    const r = rig()
    const res = await emulateVerb({ paneId: 'bp-1', device: 'phone-m', width: 500 }, r.deps)
    expect(res).toMatchObject({ ok: false, error: 'BAD_ARGS' })
    expect(r.host.applyEmulation).not.toHaveBeenCalled()
  })

  it('reset clears the record, and zoom may ride along once the device is gone', async () => {
    const r = rig({ device: true })
    const res = await emulateVerb({ paneId: 'bp-1', reset: true, zoom: 1.25 }, r.deps)
    expect(res).toMatchObject({ ok: true, zoom: 1.25, emulation: { device: null, touch: false } })
    expect(r.registry.get('bp-1')?.emulation).toEqual({})
    expect(r.host.applyEmulation).toHaveBeenCalled()
  })

  it('puts the record back when the page refuses, and says so (AC-5: the picker shows the truth)', async () => {
    const r = rig({ applyFails: true })
    const res = await emulateVerb({ paneId: 'bp-1', device: 'tablet' }, r.deps)
    expect(res).toMatchObject({ ok: false, error: 'EMULATION_FAILED' })
    expect(r.registry.get('bp-1')?.emulation).toEqual({})
  })

  it('on an operator pane it needs the lease, and the folder opt-in first (AC-9)', async () => {
    const noOptIn = rig({ openedBy: 'operator' })
    expect(await emulateVerb({ paneId: 'bp-1', device: 'tablet' }, noOptIn.deps)).toMatchObject({
      ok: false,
      error: 'BROWSER_READ_NOT_ENABLED'
    })
    const noLease = rig({ openedBy: 'operator', readOptIn: true })
    expect(await emulateVerb({ paneId: 'bp-1', device: 'tablet' }, noLease.deps)).toMatchObject({
      ok: false,
      error: 'BROWSER_LEASE_ENDED'
    })
    expect(noLease.host.applyEmulation).not.toHaveBeenCalled()
    const leased = rig({ openedBy: 'operator', readOptIn: true, leaseActive: true })
    expect(await emulateVerb({ paneId: 'bp-1', device: 'tablet' }, leased.deps)).toMatchObject({
      ok: true
    })
  })

  it('is refused while the operator switched agent browser control off', async () => {
    const r = rig({ writes: false })
    expect(await emulateVerb({ paneId: 'bp-1', device: 'tablet' }, r.deps)).toMatchObject({
      ok: false,
      error: 'BROWSER_WRITES_DISABLED'
    })
  })
})

describe('browser_upload', () => {
  const files = {
    [`${FOLDER}/a.txt`]: 10,
    [`${FOLDER}/b.txt`]: 20,
    [`${FOLDER}/big.bin`]: 60 * 1024 * 1024
  }

  it('attaches files inside the folder to the file input, by real path (AC-7)', async () => {
    const r = rig({ files, inputAttrs: ['multiple', ''] })
    const res = await uploadVerb({ paneId: 'bp-1', ref: 's1e1', paths: ['a.txt', 'b.txt'] }, r.deps)
    expect(res).toMatchObject({
      ok: true,
      files: [
        { name: 'a.txt', bytes: 10 },
        { name: 'b.txt', bytes: 20 }
      ],
      note: BROWSER_NOTE
    })
    expect(calls(r.log, 'DOM.setFileInputFiles')).toEqual([
      { files: [`${FOLDER}/a.txt`, `${FOLDER}/b.txt`], backendNodeId: FILE_INPUT }
    ])
  })

  it('refuses an element that is not a file input, before looking at any path', async () => {
    const r = rig({ files })
    expect(
      await uploadVerb({ paneId: 'bp-1', ref: 's1e3', paths: ['a.txt'] }, r.deps)
    ).toMatchObject({
      ok: false,
      error: 'NOT_A_FILE_INPUT'
    })
    expect(
      await uploadVerb({ paneId: 'bp-1', ref: 's1e2', paths: ['a.txt'] }, r.deps)
    ).toMatchObject({
      ok: false,
      error: 'NOT_A_FILE_INPUT'
    })
    expect(calls(r.log, 'DOM.setFileInputFiles')).toEqual([])
  })

  it('an unknown ref is REF_NOT_FOUND', async () => {
    const r = rig({ files })
    expect(
      await uploadVerb({ paneId: 'bp-1', ref: 's9e9', paths: ['a.txt'] }, r.deps)
    ).toMatchObject({
      ok: false,
      error: expect.stringMatching(/REF_/)
    })
  })

  it('refuses a path outside the folder and attaches nothing (AC-7)', async () => {
    const r = rig({ files, inputAttrs: ['multiple', ''] })
    const res = await uploadVerb(
      { paneId: 'bp-1', ref: 's1e1', paths: ['a.txt', '../secret.txt'] },
      r.deps
    )
    expect(res).toMatchObject({ ok: false, error: 'UPLOAD_PATH_DENIED' })
    expect(calls(r.log, 'DOM.setFileInputFiles')).toEqual([])
  })

  it('refuses a link out of the folder, and a file over 50 MiB', async () => {
    const link = rig({ files: { '/etc/passwd': 5 }, links: { [`${FOLDER}/n.txt`]: '/etc/passwd' } })
    expect(
      await uploadVerb({ paneId: 'bp-1', ref: 's1e1', paths: ['n.txt'] }, link.deps)
    ).toMatchObject({
      ok: false,
      error: 'UPLOAD_PATH_DENIED'
    })
    const big = rig({ files })
    expect(
      await uploadVerb({ paneId: 'bp-1', ref: 's1e1', paths: ['big.bin'] }, big.deps)
    ).toMatchObject({
      ok: false,
      error: 'UPLOAD_TOO_LARGE'
    })
  })

  it('several files into an input without `multiple` is BAD_ARGS', async () => {
    const r = rig({ files })
    const res = await uploadVerb({ paneId: 'bp-1', ref: 's1e1', paths: ['a.txt', 'b.txt'] }, r.deps)
    expect(res).toMatchObject({ ok: false, error: 'BAD_ARGS' })
    expect(calls(r.log, 'DOM.setFileInputFiles')).toEqual([])
  })

  it('stamps the agent input window and needs the lease on an operator pane (AC-9)', async () => {
    const r = rig({ files, openedBy: 'operator', readOptIn: true })
    expect(
      await uploadVerb({ paneId: 'bp-1', ref: 's1e1', paths: ['a.txt'] }, r.deps)
    ).toMatchObject({
      ok: false,
      error: 'BROWSER_LEASE_ENDED'
    })
    const ok = rig({ files })
    await uploadVerb({ paneId: 'bp-1', ref: 's1e1', paths: ['a.txt'] }, ok.deps)
    expect(ok.registry.lastAgentInputAt('bp-1')).not.toBeNull()
  })
})

describe('browser_download', () => {
  const saved: DownloadResult = {
    ok: true,
    path: '.harnu/out/downloads/r.pdf',
    bytes: 99,
    mime: 'application/pdf',
    name: 'r.pdf'
  }

  it('arms the allowance, downloads a url, and reports the saved file (AC-8)', async () => {
    const r = rig({ download: saved })
    const res = await downloadVerb(
      { paneId: 'bp-1', url: 'https://a.test/r.pdf', name: 'r.pdf', timeoutMs: 5000 },
      r.deps
    )
    expect(res).toMatchObject({
      ok: true,
      path: '.harnu/out/downloads/r.pdf',
      bytes: 99,
      mime: 'application/pdf',
      name: 'r.pdf'
    })
    expect(r.host.armDownload).toHaveBeenCalledWith('bp-1', { name: 'r.pdf', timeoutMs: 5000 })
    expect(r.host.downloadUrl).toHaveBeenCalledWith('bp-1', 'https://a.test/r.pdf')
    expect(r.arm.disarm).toHaveBeenCalled()
  })

  it('arms with the default timeout when none is given', async () => {
    const r = rig({ download: saved })
    await downloadVerb({ paneId: 'bp-1', url: 'https://a.test/r.pdf' }, r.deps)
    expect(r.host.armDownload).toHaveBeenCalledWith('bp-1', { timeoutMs: 15_000 })
  })

  it('by ref, it clicks the element (through the same queue entry) and waits', async () => {
    const r = rig({ download: saved })
    const res = await downloadVerb({ paneId: 'bp-1', ref: 's1e2' }, r.deps)
    expect(res).toMatchObject({ ok: true, name: 'r.pdf' })
    expect(calls(r.log, 'Input.dispatchMouseEvent').map((p) => p.type)).toEqual([
      'mouseMoved',
      'mousePressed',
      'mouseReleased'
    ])
    expect(r.host.downloadUrl).not.toHaveBeenCalled()
  })

  it('a click that cannot land disarms the allowance and refuses (nothing stays armed)', async () => {
    const r = rig({ download: saved, clickProbe: probe({ hit: 'other' }) })
    const res = await downloadVerb({ paneId: 'bp-1', ref: 's1e2' }, r.deps)
    expect(res).toMatchObject({ ok: false, error: 'ELEMENT_OBSCURED' })
    expect(r.arm.disarm).toHaveBeenCalled()
  })

  it('maps each way a download fails to its code', async () => {
    const cases: Array<[DownloadResult, string]> = [
      [{ ok: false, code: 'NO_DOWNLOAD_STARTED', detail: 'none' }, 'NO_DOWNLOAD_STARTED'],
      [{ ok: false, code: 'DOWNLOAD_TOO_LARGE', detail: 'big' }, 'DOWNLOAD_TOO_LARGE'],
      [{ ok: false, code: 'DOWNLOAD_FAILED', detail: 'cut' }, 'DOWNLOAD_FAILED'],
      [{ ok: false, code: 'DOWNLOAD_CANCELLED', detail: 'no' }, 'DOWNLOAD_CANCELLED']
    ]
    for (const [download, error] of cases) {
      const r = rig({ download })
      expect(await downloadVerb({ paneId: 'bp-1', url: 'https://a.test/x' }, r.deps)).toMatchObject(
        {
          ok: false,
          error
        }
      )
    }
  })

  it('needs the lease on an operator pane (AC-9) and is refused with the kill-switch off', async () => {
    const op = rig({ download: saved, openedBy: 'operator', readOptIn: true })
    expect(await downloadVerb({ paneId: 'bp-1', url: 'https://a.test/x' }, op.deps)).toMatchObject({
      ok: false,
      error: 'BROWSER_LEASE_ENDED'
    })
    expect(op.host.armDownload).not.toHaveBeenCalled()
    const off = rig({ download: saved, writes: false })
    expect(await downloadVerb({ paneId: 'bp-1', url: 'https://a.test/x' }, off.deps)).toMatchObject(
      {
        ok: false,
        error: 'BROWSER_WRITES_DISABLED'
      }
    )
  })
})

describe('input while touch is emulated: a click is a tap (AC-6, found live)', () => {
  it('sends touchStart and touchEnd at the view point, never a mouse press', async () => {
    const r = rig({ touch: true, scale: 0.5 })
    const res = await clickVerb({ paneId: 'bp-1', ref: 's1e2' }, r.deps)
    expect(res).toMatchObject({ ok: true, target: { role: 'link', name: 'Download report' } })
    expect(calls(r.log, 'Input.dispatchMouseEvent')).toEqual([])
    const touches = calls(r.log, 'Input.dispatchTouchEvent')
    expect(touches.map((t) => t.type)).toEqual(['touchStart', 'touchEnd'])
    // The box centre is (60, 40) in page px; the fit scale 0.5 makes it (30, 20) in view px (A5).
    expect(touches[0]).toMatchObject({ touchPoints: [{ x: 30, y: 20 }] })
    expect(touches[1]).toMatchObject({ touchPoints: [] })
  })

  it('a double click is two taps', async () => {
    const r = rig({ touch: true })
    await clickVerb({ paneId: 'bp-1', ref: 's1e2', clickCount: 2 }, r.deps)
    expect(calls(r.log, 'Input.dispatchTouchEvent').map((t) => t.type)).toEqual([
      'touchStart',
      'touchEnd',
      'touchStart',
      'touchEnd'
    ])
  })

  it('a right or middle click says it does not exist under touch, and sends nothing', async () => {
    const r = rig({ touch: true })
    const res = await clickVerb({ paneId: 'bp-1', ref: 's1e2', button: 'right' }, r.deps)
    expect(res).toMatchObject({ ok: false, error: 'INPUT_FAILED' })
    expect(JSON.stringify(res)).toContain('touch: false')
    expect(calls(r.log, 'Input.dispatchTouchEvent')).toEqual([])
    expect(calls(r.log, 'Input.dispatchMouseEvent')).toEqual([])
  })

  it('a page without touch keeps real mouse events', async () => {
    const r = rig({ touch: false })
    await clickVerb({ paneId: 'bp-1', ref: 's1e2' }, r.deps)
    expect(calls(r.log, 'Input.dispatchTouchEvent')).toEqual([])
    expect(calls(r.log, 'Input.dispatchMouseEvent').length).toBe(3)
  })
})
