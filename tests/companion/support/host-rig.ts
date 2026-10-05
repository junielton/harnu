import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { createCompanionHost, type HostCoreDeps } from '../../../src/main/companion/host-core'
import type { CompanionMode } from '../../../src/main/companion/mode'
import type { CompanionServer, StartOptions } from '../../../src/main/companion/server'
import { shortTmp } from './client'

/** A controllable stand-in for the mode seam (`mode.ts` is module-global). */
export function fakeMode(initial: CompanionMode = 'off'): {
  mode: HostCoreDeps['mode']
  set: (m: CompanionMode) => void
} {
  let current = initial
  const listeners = new Set<() => void>()
  return {
    mode: {
      getMode: () => current,
      listenerWanted: () => current !== 'off',
      hydrate: async () => undefined,
      onChange: (fn) => {
        listeners.add(fn)
        return () => void listeners.delete(fn)
      }
    },
    set: (m) => {
      current = m
      for (const l of [...listeners]) l()
    }
  }
}

export const tick = (ms = 30): Promise<void> => new Promise((r) => setTimeout(r, ms))

export function stubServer(over: Partial<CompanionServer> = {}): CompanionServer {
  return {
    transport: 'unix',
    bootId: 'b_stub',
    startedAt: 1_790_000_000_000,
    endpoint: {
      v: 1,
      transport: 'unix',
      socketPath: '/tmp/x/c.sock',
      token: 'stub-endpoint-token',
      bootId: 'b_stub',
      protoMin: 1,
      protoMax: 1,
      writtenAt: 1
    },
    stop: async () => undefined,
    ...over
  }
}

export { createCompanionHost, mkdirSync, join, shortTmp }
export type { StartOptions }
