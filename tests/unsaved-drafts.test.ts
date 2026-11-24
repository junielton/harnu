// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest'

const ipcOn = vi.fn()
vi.mock('electron', () => ({ ipcMain: { on: (...a: unknown[]) => ipcOn(...a), handle: vi.fn() } }))

import {
  __resetUnsavedDraftsForTests,
  forgetDraft,
  isDraftDirty,
  setDraftDirty,
  unsavedDraftLabels
} from '../src/renderer/src/lib/unsaved-drafts'
import { EventEmitter } from 'node:events'
import {
  clearUnsavedFiles,
  getUnsavedFiles,
  registerUnsavedDraftsIpc,
  setUnsavedFiles,
  watchRendererReset
} from '../src/main/unsaved-drafts'

/**
 * Registry of markdown panes with unsaved edits (renderer) and the list main holds
 * for its quit guard. The renderer pushes labels once per tick through
 * `window.api.unsavedDraftsSet`.
 */
const unsavedDraftsSet = vi.fn()
const entry = {
  paneId: 'h-1',
  filePath: '/repo/.harnu/notes/2026-11-24.md',
  worktreePath: '/home/user/wt'
}

beforeEach(() => {
  __resetUnsavedDraftsForTests()
  unsavedDraftsSet.mockClear()
  ;(window as unknown as { api: unknown }).api = { unsavedDraftsSet }
})

describe('renderer registry', () => {
  it('tracks a dirty pane and labels it by file and worktree basename', () => {
    setDraftDirty(entry, true)
    expect(isDraftDirty('h-1')).toBe(true)
    expect(unsavedDraftLabels()).toEqual(['2026-11-24.md (wt)'])
  })

  it('clears the entry when the pane goes clean', () => {
    setDraftDirty(entry, true)
    setDraftDirty(entry, false)
    expect(isDraftDirty('h-1')).toBe(false)
    expect(unsavedDraftLabels()).toEqual([])
  })

  it('forgetDraft drops an entry and is safe on an unknown id', () => {
    setDraftDirty(entry, true)
    forgetDraft('h-1')
    forgetDraft('nope')
    expect(isDraftDirty('h-1')).toBe(false)
  })

  it('keeps insertion order across panes', () => {
    setDraftDirty(entry, true)
    setDraftDirty({ paneId: 'h-2', filePath: '/a/b.md', worktreePath: '/x/other' }, true)
    expect(unsavedDraftLabels()).toEqual(['2026-11-24.md (wt)', 'b.md (other)'])
  })

  it('coalesces two changes in one tick into one push of the final list', async () => {
    setDraftDirty(entry, true)
    setDraftDirty({ paneId: 'h-2', filePath: '/a/b.md', worktreePath: '/x/other' }, true)
    expect(unsavedDraftsSet).not.toHaveBeenCalled()
    await Promise.resolve()
    expect(unsavedDraftsSet).toHaveBeenCalledTimes(1)
    expect(unsavedDraftsSet).toHaveBeenCalledWith(['2026-11-24.md (wt)', 'b.md (other)'])
  })

  it('does not push for a no-op change', async () => {
    setDraftDirty(entry, false)
    forgetDraft('h-1')
    await Promise.resolve()
    expect(unsavedDraftsSet).not.toHaveBeenCalled()
  })

  it('is a no-op push when window.api is absent', async () => {
    ;(window as unknown as { api?: unknown }).api = undefined
    setDraftDirty(entry, true)
    await Promise.resolve()
    expect(isDraftDirty('h-1')).toBe(true)
  })
})

describe('main holder', () => {
  beforeEach(() => {
    ipcOn.mockClear()
    setUnsavedFiles([])
  })

  it('reflects the last unsavedDrafts:set payload', () => {
    registerUnsavedDraftsIpc()
    expect(ipcOn).toHaveBeenCalledWith('unsavedDrafts:set', expect.any(Function))
    const handler = ipcOn.mock.calls[0][1] as (e: unknown, p: unknown) => void
    handler({}, ['a.md (wt)'])
    expect(getUnsavedFiles()).toEqual(['a.md (wt)'])
    handler({}, [])
    expect(getUnsavedFiles()).toEqual([])
  })

  it('treats junk payloads as an empty list', () => {
    for (const junk of [null, undefined, 'x', 42, { length: 2 }]) {
      setUnsavedFiles(['seed'])
      setUnsavedFiles(junk)
      expect(getUnsavedFiles()).toEqual([])
    }
  })

  it('drops non-strings, caps at 100 entries and trims each to 200 chars', () => {
    setUnsavedFiles(['  ok  ', 7, null, 'x'.repeat(500)])
    expect(getUnsavedFiles()).toEqual(['ok', 'x'.repeat(200)])
    setUnsavedFiles(Array.from({ length: 150 }, (_, i) => `f${i}`))
    expect(getUnsavedFiles()).toHaveLength(100)
  })
})

describe('stale list after a renderer reload or crash', () => {
  beforeEach(() => setUnsavedFiles(['a.md (wt)']))

  it('clearUnsavedFiles empties the held list', () => {
    clearUnsavedFiles()
    expect(getUnsavedFiles()).toEqual([])
  })

  it('clears when the renderer process is gone', () => {
    const wc = new EventEmitter()
    watchRendererReset(wc)
    wc.emit('render-process-gone', {}, { reason: 'crashed' })
    expect(getUnsavedFiles()).toEqual([])
  })

  it('clears when the main frame starts a new document load (reload)', () => {
    const wc = new EventEmitter()
    watchRendererReset(wc)
    wc.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false })
    expect(getUnsavedFiles()).toEqual([])
  })

  it('keeps the list across in-page and sub-frame navigations', () => {
    const wc = new EventEmitter()
    watchRendererReset(wc)
    wc.emit('did-start-navigation', { isMainFrame: true, isSameDocument: true })
    wc.emit('did-start-navigation', { isMainFrame: false, isSameDocument: false })
    expect(getUnsavedFiles()).toEqual(['a.md (wt)'])
  })
})
