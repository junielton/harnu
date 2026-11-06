// @vitest-environment jsdom
// U2.3a AC-3 / AC-5 (UI): the Shelved card of the Cleanup screen — one Restore click per shelved
// worktree, and a failure that always says what to do next.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { i18n } from '@renderer/i18n'
import CleanupShelvedCard from '../src/renderer/src/components/CleanupShelvedCard.vue'
import type { ShelvedEntry } from '../src/main/gc/shelve-store'

const NOW = Date.parse('2026-11-05T12:00:00Z')

const entry = (over: Partial<ShelvedEntry> = {}): ShelvedEntry => ({
  id: '/ws/org/proj/www::worktree::/ws/org/proj/trees/feat-x',
  repoPath: '/ws/org/proj/www',
  worktreePath: '/ws/org/proj/trees/feat-x',
  branch: 'feat/x',
  headSha: 'a'.repeat(40),
  namespace: 'refs/archive/feat/x/20261101T100000Z',
  shelvedAt: NOW - 3_600_000,
  idleDays: 9,
  reason: 'Shelved `feat/x` — idle 9 d, branch kept',
  freedBytes: 2_000_000,
  ...over
})

const mountCard = (props: Record<string, unknown> = {}) =>
  mount(CleanupShelvedCard, {
    props: { shelved: [entry()], now: NOW, ...props },
    global: { plugins: [i18n] }
  })

afterEach(() => vi.restoreAllMocks())

describe('CleanupShelvedCard', () => {
  it('draws nothing when no worktree is shelved', () => {
    const w = mountCard({ shelved: [] })
    expect(w.find('[data-testid="shelved-card"]').exists()).toBe(false)
  })

  it('lists each shelved worktree with its folder, branch, idle days and the freed size', () => {
    const w = mountCard({
      shelved: [entry(), entry({ id: 'b', worktreePath: '/t/other', branch: null })]
    })
    const rows = w.findAll('[data-testid="shelved-row"]')
    expect(rows).toHaveLength(2)
    expect(rows[0].text()).toContain('feat-x')
    expect(rows[0].text()).toContain('feat/x')
    expect(rows[0].text()).toContain('9')
    expect(rows[0].text()).toContain('2 MB')
    expect(rows[1].text()).toContain('other')
    expect(rows[1].text().toLowerCase()).toContain('detached')
  })

  it('Restore is one click and asks the screen to restore that entry', async () => {
    const w = mountCard()
    await w.get('[data-testid="shelved-restore"]').trigger('click')
    expect(w.emitted('restore')).toEqual([[entry().id]])
  })

  it('a busy entry cannot be clicked twice and says it is restoring', () => {
    const w = mountCard({ busyIds: new Set([entry().id]) })
    const btn = w.get('[data-testid="shelved-restore"]')
    expect(btn.attributes('disabled')).toBeDefined()
    expect(btn.text().toLowerCase()).toContain('restoring')
  })

  it('a failure stays under its row with a next step, and the button stays available', () => {
    const w = mountCard({
      failures: new Map([[entry().id, { reason: 'repo-busy', message: 'busy' }]])
    })
    const fail = w.get('[data-testid="shelved-failure"]')
    expect(fail.text().toLowerCase()).toContain('try again')
    expect(w.get('[data-testid="shelved-restore"]').attributes('disabled')).toBeUndefined()
  })

  it('every failure reason names a way out (no dead end)', () => {
    const reasons = [
      'repo-busy',
      'in-use',
      'record-missing',
      'archive-unverified',
      'move-aside-failed',
      'path-exists',
      'worktree-add-failed',
      'apply-failed',
      'snapshot-failed',
      'verification-failed'
    ]
    for (const reason of reasons) {
      const w = mountCard({ failures: new Map([[entry().id, { reason, message: 'm' }]]) })
      const text = w.get('[data-testid="shelved-failure"]').text()
      expect(text.length, reason).toBeGreaterThan(20)
      expect(text, reason).not.toMatch(/^cleanup\./)
    }
  })

  it('a lost record still offers the command that makes a fresh worktree on the kept branch', async () => {
    const write = vi.fn(async () => undefined)
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: write },
      configurable: true
    })
    const w = mountCard({
      failures: new Map([[entry().id, { reason: 'record-missing', message: 'gone' }]])
    })
    const copy = w.get('[data-testid="shelved-copy-command"]')
    expect(copy.attributes('title')).toBe(
      'git -C /ws/org/proj/www worktree add /ws/org/proj/trees/feat-x feat/x'
    )
    await copy.trigger('click')
    expect(write).toHaveBeenCalledWith(
      'git -C /ws/org/proj/www worktree add /ws/org/proj/trees/feat-x feat/x'
    )
  })

  it('shell-quotes a hostile path in that command', () => {
    const w = mountCard({
      shelved: [entry({ worktreePath: "/t/it's here", branch: 'feat/x' })],
      failures: new Map([[entry().id, { reason: 'record-missing', message: 'gone' }]])
    })
    expect(w.get('[data-testid="shelved-copy-command"]').attributes('title')).toContain(
      `'/t/it'\\''s here'`
    )
  })
})
