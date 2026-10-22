/**
 * Guest preload of the browser pane (T564 U1/U2, spec §3.3). It runs sandboxed with `contextIsolation: true`
 * inside every page a browser pane loads, in an isolated world that shares the DOM but not JS globals.
 *
 * It must never import the app preload (`./index`): the guest has no `window.api`. It does, and only does:
 *
 *  1. boot the point-and-comment overlay (`./overlay`, T564 U6) into a closed shadow root, in every origin class;
 *  2. IF AND ONLY IF `location.protocol === 'harnu-page:'`, expose the `harnu` page API (spec §5.3) through
 *     `contextBridge.exposeInMainWorld`. A `local` or `external` page gets no API at all (decision 10);
 *  3. talk to main over a PRIVATE channel set that main accepts only from this guest's own `webContents`, and
 *     for `emit` only from a top frame that is one of our pages.
 *
 * The channel names are duplicated here on purpose: a sandboxed preload cannot import main code.
 */
import { contextBridge, ipcRenderer, webFrame } from 'electron'
import { bootOverlay } from './overlay'
import { isActivatingKey } from '../shared/browser-activation'

const CHANNEL_GET_DATA = 'harnu:page:getData'
const CHANNEL_EMIT = 'harnu:page:emit'
const CHANNEL_DATA = 'harnu:page:data'

/** `emit` caps (spec §5.4); main enforces them again, this only saves the IPC for an obviously oversized one. */
const EMIT_TYPE_MAX_CHARS = 64
const EMIT_PAYLOAD_MAX_BYTES = 8 * 1024

interface PageBootstrap {
  data: unknown
  rev: number
  pane: { id: string; name: string }
}

type DataListener = (data: unknown, rev: number) => void

function bootHarnuApi(): void {
  // Synchronous on purpose: `getData()` must answer at DOMContentLoaded, before the page's own scripts run.
  const boot = ipcRenderer.sendSync(CHANNEL_GET_DATA) as PageBootstrap | null
  if (!boot) return

  let current: { data: unknown; rev: number } = { data: boot.data, rev: boot.rev }
  const listeners = new Set<DataListener>()
  ipcRenderer.on(CHANNEL_DATA, (_event, msg: { data: unknown; rev: number }) => {
    current = { data: msg.data, rev: msg.rev }
    for (const listener of [...listeners]) {
      try {
        // contextBridge copies the value across the world boundary (structured clone): the page never
        // receives a live reference into this world.
        listener(msg.data, msg.rev)
      } catch {
        /* a throwing page callback must not stop the others */
      }
    }
  })

  // The last TRUSTED key or pointer press this page saw: the gate's condition 4 needs to know which kind of
  // input made the user activation. A page-dispatched event is `isTrusted: false` and never counts.
  let lastActivation: 'key' | 'pointer' | null = null
  /** Epoch ms of that trusted event (`timeOrigin + timeStamp`): main refuses an emit an agent input overlapped (F5). */
  let lastActivationAt: number | null = null
  const noteActivation = (kind: 'key' | 'pointer', e: Event): void => {
    if (!e.isTrusted) return
    lastActivation = kind
    lastActivationAt = performance.timeOrigin + e.timeStamp
  }
  // Chromium's user activation comes from keys that type or act, not from Escape or a modifier on its own: those must
  // not move the anchor main measures an agent run against (they would make a real click look older or newer).
  window.addEventListener(
    'keydown',
    (e) => {
      if (isActivatingKey((e as KeyboardEvent).key)) noteActivation('key', e)
    },
    true
  )
  window.addEventListener('pointerdown', (e) => noteActivation('pointer', e), true)

  contextBridge.exposeInMainWorld('harnu', {
    getData: (): unknown => current.data,
    onData: (cb: DataListener): (() => void) => {
      if (typeof cb !== 'function') return () => undefined
      listeners.add(cb)
      return () => void listeners.delete(cb)
    },
    emit: (event: { type?: unknown; payload?: unknown }): void => {
      const type = event?.type
      if (typeof type !== 'string' || type.length === 0 || type.length > EMIT_TYPE_MAX_CHARS) {
        console.warn('harnu.emit: `type` must be a string of 1 to 64 characters')
        return
      }
      let tooLarge = false
      try {
        const json = JSON.stringify(event.payload)
        tooLarge = json !== undefined && json.length > EMIT_PAYLOAD_MAX_BYTES
      } catch {
        console.warn('harnu.emit: `payload` must be JSON-serialisable')
        return
      }
      if (tooLarge) console.warn('harnu.emit: `payload` is over 8 KiB and was dropped')
      ipcRenderer.send(CHANNEL_EMIT, {
        type,
        ...(tooLarge ? { tooLarge: true } : { payload: event.payload }),
        active: navigator.userActivation?.isActive === true,
        by: lastActivation,
        activationAt: lastActivationAt
      })
    },
    pane: { id: boot.pane.id, name: boot.pane.name }
  })
}

if (location.protocol === 'harnu-page:') bootHarnuApi()

// The overlay's own half of the private channels lives in `./overlay` (spec §8.2). Top frame only: a sub-frame is
// the page's own business, and main accepts the overlay channels only from the top frame anyway.
if (window === window.top) {
  bootOverlay({
    win: window,
    doc: document,
    ipc: {
      invoke: (channel, ...args) => ipcRenderer.invoke(channel, ...args),
      send: (channel, ...args) => ipcRenderer.send(channel, ...args),
      on: (channel, listener) =>
        void ipcRenderer.on(channel, (event, ...args) => listener(event, ...args))
    },
    world: webFrame
  })
}
