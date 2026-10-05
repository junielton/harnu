// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { setActivePinia, createPinia } from 'pinia'
import SweepConfirmDialog from '../src/renderer/src/components/SweepConfirmDialog.vue'
import { useReaperStore } from '../src/renderer/src/stores/reaper'
import { i18n } from '@renderer/i18n'
import type { ReapItem } from '../src/preload'

/**
 * BUG-75 AC-3 — untracked files stopped forcing a `blocked` verdict, so a
 * harvestable worktree can now carry content that lives in no commit. The
 * confirm dialog is where that stops being a surprise: it must name EVERY
 * untracked path before anything is deleted. Before this card, `grep -c
 * untracked` returned 0 across the whole sweep path — nothing enumerated what
 * would be lost.
 */
function item(over: Partial<ReapItem> = {}): ReapItem {
  return {
    id: 'i1',
    repoPath: '/repo',
    kind: 'worktree',
    branch: 'feat/x',
    path: '/repo/.claude/worktrees/feat-x',
    hidden: false,
    ageDays: 30,
    diskBytes: null,
    checkpoints: [],
    blockers: [],
    needsRemoteDelete: false,
    untracked: [],
    justifiedBy: 'gh-merged',
    verdict: 'harvestable',
    ...over
  } as unknown as ReapItem
}

beforeEach(async () => {
  const api = {
    reaperSweep: vi.fn(async () => []),
    reaperClean: vi.fn(async () => ({ itemId: 'i1', ok: true, steps: [] })),
    reaperSnapshot: vi.fn(async () => null),
    reaperJournal: vi.fn(async () => []),
    onReaperProgress: () => () => {}
  }
  ;(window as unknown as { api: unknown }).api = new Proxy(api, {
    get: (t: Record<string, unknown>, k: string) => (k in t ? t[k] : () => () => {})
  })
  setActivePinia(createPinia())
  await useReaperStore().init()
})

function mountDialog(items: ReapItem[]) {
  return mount(SweepConfirmDialog, {
    props: { items },
    global: { plugins: [i18n], stubs: { teleport: true } }
  })
}

describe('SweepConfirmDialog — untracked disclosure (AC-3)', () => {
  it('names every untracked path before acting', () => {
    const paths = ['docs/adr/0013-draft.md', 'scratch/notes.md', 'my file with spaces.txt']
    const w = mountDialog([item({ untracked: paths })])
    const text = w.text()
    for (const p of paths) expect(text).toContain(p)
    w.unmount()
  })

  it('says what happens to them — archived to the wip ref, ignored paths excluded', () => {
    const w = mountDialog([item({ untracked: ['notes.md'] })])
    expect(w.text()).toContain('Untracked files go with the folder')
    expect(w.text()).toContain('wip ref')
    expect(w.text()).toContain('.gitignore')
    w.unmount()
  })

  it('attributes each path to its own item in a multi-item sweep', () => {
    const w = mountDialog([
      item({ id: 'i1', branch: 'feat/a', untracked: ['a-only.md'] }),
      item({ id: 'i2', branch: 'feat/b', untracked: ['b-only.md'] })
    ])
    const html = w.html()
    expect(html).toContain('a-only.md')
    expect(html).toContain('b-only.md')
    // Both branch labels render, so a path is never orphaned from its worktree.
    expect(html).toContain('feat/a')
    expect(html).toContain('feat/b')
    w.unmount()
  })

  it('renders nothing at all when no item carries untracked paths', () => {
    const w = mountDialog([item({ untracked: [] })])
    expect(w.text()).not.toContain('Untracked files go with the folder')
    w.unmount()
  })

  it('does not truncate a long list — every path is named, never a "+N more"', () => {
    const paths = Array.from({ length: 25 }, (_, i) => `scratch/file-${i}.txt`)
    const w = mountDialog([item({ untracked: paths })])
    const text = w.text()
    for (const p of paths) expect(text).toContain(p)
    w.unmount()
  })
})
