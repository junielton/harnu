import { readFileSync } from 'node:fs'
import { describe, it, expect } from 'vitest'

// gc-ipc.ts and the preload need electron, so the surface is checked from source: the same
// channel names must appear on the main side (handle / send) and in the typed preload API.
const read = (p: string): string => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8')
const ipc = read('src/main/gc/gc-ipc.ts')
const preload = read('src/preload/index.ts')
const index = read('src/main/index.ts')

const channels = (src: string, re: RegExp): string[] =>
  [...src.matchAll(re)].map((m) => m[1]!).sort()

const REQUESTS = [
  'gc:ackFirstReport',
  'gc:clean',
  'gc:jobs',
  'gc:keep',
  'gc:prefs:get',
  'gc:prefs:set',
  'gc:snapshot',
  'gc:unkeep'
]
const EVENTS = ['gc:cycle', 'gc:done', 'gc:progress']

describe('workspace GC IPC surface (AC-10)', () => {
  it('registers exactly the request channels the card names', () => {
    expect(channels(ipc, /ipcMain\.handle\('(gc:[A-Za-z:]+)'/g)).toEqual(REQUESTS)
  })

  it('exposes each request channel in the typed preload', () => {
    expect(channels(preload, /ipcRenderer\.invoke\(\s*'(gc:[A-Za-z:]+)'/g)).toEqual(REQUESTS)
  })

  it('pushes each event from main and subscribes to it in the preload', () => {
    const sent = channels(ipc, /send\('(gc:[A-Za-z:]+)'/g)
    expect(sent).toEqual(EVENTS)
    expect(channels(preload, /subscribe\('(gc:[A-Za-z:]+)'/g)).toEqual(EVENTS)
  })

  it('registers the handlers from main/index.ts on the Reaper control handle', () => {
    expect(index).toContain("import { registerGcHandlers } from './gc/gc-ipc'")
    expect(index).toMatch(/const reaperControl = registerReaperHandlers\(/)
    expect(index).toMatch(/registerGcHandlers\(\(\) => mainWindow, reaperControl, icon\)/)
  })
})
