/**
 * Owner attribution for the main-process stall monitor (T697, P9: a stall names its owner).
 *
 * `withOwner(name, kind, fn)` times a synchronous segment and records it in the shared span ring;
 * a stall asks the ring which owner overlapped it the most. Two instruments install it everywhere
 * without touching a call site: `wrapIpcMain` (every IPC handler and listener runs as
 * `ipc:<channel>`) and `patchSetInterval` (every interval callback runs as `timer:<name>`, the
 * periodic jobs). Anything else that is not wrapped (an event emitter, a promise continuation, a
 * `setTimeout`) is named by the sampled stack instead (`stall-watchdog.ts`).
 *
 * Pure node: no electron import (the ipcMain is passed in), so it is unit-tested directly.
 */

import { performance } from 'node:perf_hooks'
import { createSpanRing, type OwnerKind } from './stall-core'

/** The one ring every wrapper writes to and the stall monitor reads. */
export const spans = createSpanRing()

/**
 * Runs `fn`, records how long its synchronous part took under `owner`. An async function's
 * continuation after its first `await` is not covered: the sampled stack names those.
 */
export function withOwner<T>(owner: string, kind: OwnerKind, fn: () => T): T {
  const start = performance.now()
  try {
    return fn()
  } finally {
    spans.record(owner, kind, start, performance.now())
  }
}

// ---- ipcMain -------------------------------------------------------------------------------

type Listener = (...args: never[]) => unknown

/** The part of electron's `ipcMain` that registers and removes handlers. */
export interface IpcMainLike {
  handle(channel: string, listener: Listener): unknown
  handleOnce(channel: string, listener: Listener): unknown
  on(channel: string, listener: Listener): unknown
  once(channel: string, listener: Listener): unknown
  off(channel: string, listener: Listener): unknown
  removeListener(channel: string, listener: Listener): unknown
}

/**
 * Wraps every handler registered through `ipcMain` from now on so it runs as `ipc:<channel>`.
 * Listeners registered earlier are untouched. `off`/`removeListener` still find a wrapped listener
 * by the function the caller passed. Returns the undo.
 */
export function wrapIpcMain(ipc: IpcMainLike): () => void {
  const wrapped = new WeakMap<Listener, Listener>()
  const originals: Partial<Record<keyof IpcMainLike, unknown>> = {}

  const wrapFor = (channel: string, listener: Listener): Listener => {
    const existing = wrapped.get(listener)
    if (existing) return existing
    const w = function (this: unknown, ...args: never[]): unknown {
      return withOwner(`ipc:${channel}`, 'ipc', () => listener.apply(this, args))
    } as Listener
    wrapped.set(listener, w)
    return w
  }

  for (const method of ['handle', 'handleOnce', 'on', 'once'] as const) {
    const original = ipc[method].bind(ipc) as (c: string, l: Listener) => unknown
    originals[method] = ipc[method]
    ipc[method] = ((channel: string, listener: Listener) =>
      original(channel, wrapFor(channel, listener))) as never
  }
  for (const method of ['off', 'removeListener'] as const) {
    const original = ipc[method].bind(ipc) as (c: string, l: Listener) => unknown
    originals[method] = ipc[method]
    ipc[method] = ((channel: string, listener: Listener) =>
      original(channel, wrapped.get(listener) ?? listener)) as never
  }

  return () => {
    for (const [k, v] of Object.entries(originals)) {
      ;(ipc as unknown as Record<string, unknown>)[k] = v
    }
  }
}

// ---- timers --------------------------------------------------------------------------------

/** `file.ts:12` of the first stack frame that is not this module, or `null`. */
export function callsiteOf(stack: string | undefined): string | null {
  if (!stack) return null
  for (const line of stack.split('\n').slice(1)) {
    if (line.includes('stall-owner')) continue
    const m = /\(?([^()\s]+?):(\d+):\d+\)?\s*$/.exec(line)
    if (!m) continue
    const file = m[1].split(/[\\/]/).pop() ?? m[1]
    return `${file}:${m[2]}`
  }
  return null
}

/** `timer:<function name> (<file:line>)`, whichever parts are known. */
export function timerOwnerName(handler: { name?: string }, callsite: string | null): string {
  const fn = handler.name && handler.name !== 'anonymous' ? handler.name : ''
  if (fn && callsite) return `timer:${fn} (${callsite})`
  return `timer:${fn || callsite || 'anonymous'}`
}

/**
 * Makes every `setInterval` callback run as `timer:<name>`. Intervals are created rarely and live
 * long (they are the periodic jobs), so capturing the creation site once per interval costs nothing
 * measurable. `setTimeout` is left alone on purpose: it is created by the thousand per second.
 */
export function patchSetInterval(target: { setInterval: typeof setInterval }): () => void {
  const original = target.setInterval
  const patched = function (this: unknown, handler: unknown, ...rest: unknown[]) {
    if (typeof handler !== 'function') {
      return (original as (...a: unknown[]) => unknown).call(this, handler, ...rest)
    }
    const probe: { stack?: string } = {}
    Error.captureStackTrace(probe, patched)
    const name = timerOwnerName(handler, callsiteOf(probe.stack))
    return (original as (...a: unknown[]) => unknown).call(
      this,
      function (this: unknown, ...args: unknown[]) {
        return withOwner(name, 'timer', () =>
          (handler as (...a: unknown[]) => unknown).apply(this, args)
        )
      },
      ...rest
    )
  } as unknown as typeof setInterval
  target.setInterval = patched
  return () => {
    target.setInterval = original
  }
}
