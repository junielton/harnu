// @vitest-environment jsdom
// Delta 3: what a clean that did not finish left behind, as persistent notices Cleanup shows until the
// operator answers: containers are never started on Harnu's own initiative.
import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import CleanupRecoveryNotices from '../src/renderer/src/components/CleanupRecoveryNotices.vue'
import { i18n } from '@renderer/i18n'
import type { GcRecoveryItem } from '../src/main/gc/gc-wire'

const item = (over: Partial<GcRecoveryItem> = {}): GcRecoveryItem => ({
  id: 'n1',
  state: 'notice',
  kind: 'stop-stack',
  notice: 'stack-stopped',
  path: '/r/wt',
  detail: 'web-1, web-2',
  announced: true,
  ...over
})
const mountIt = (items: GcRecoveryItem[]) =>
  mount(CleanupRecoveryNotices, { props: { items }, global: { plugins: [i18n] } })

describe('CleanupRecoveryNotices', () => {
  it('shows nothing when there is nothing to answer', () => {
    expect(mountIt([]).find('[data-testid="recovery-notices"]').exists()).toBe(false)
  })

  it('an interrupted stack stop names the containers and offers Start again / Leave stopped', async () => {
    const w = mountIt([item()])
    const text = w.get('[data-testid="recovery-notice"]').text()
    expect(text).toContain('web-1, web-2')
    expect(text).toContain("didn't finish")
    expect(w.get('[data-testid="recovery-start"]').text()).toBe('Start again')
    expect(w.get('[data-testid="recovery-dismiss"]').text()).toBe('Leave stopped')
    await w.get('[data-testid="recovery-start"]').trigger('click')
    await w.get('[data-testid="recovery-dismiss"]').trigger('click')
    expect(w.emitted('answer')).toEqual([
      ['n1', 'start'],
      ['n1', 'dismiss']
    ])
  })

  it('no Start again when the folders are gone: the reason, and only Dismiss (delta 4)', () => {
    const w = mountIt([
      item({
        canStart: false,
        cannotStart: 'its folder is gone (/ws/infra); starting it would recreate empty folders'
      })
    ])
    expect(w.find('[data-testid="recovery-start"]').exists()).toBe(false)
    expect(w.get('[data-testid="recovery-notice"]').text()).toContain('recreate empty folders')
    expect(w.get('[data-testid="recovery-dismiss"]').text()).toBe('Leave stopped')
  })

  it('a lock that was not put back says why and offers Lock again / Dismiss', async () => {
    const w = mountIt([item({ id: 'l1', kind: 'unlock', notice: 'lock-skipped', detail: '' })])
    expect(w.get('[data-testid="recovery-notice"]').text()).toContain('/r/wt')
    expect(w.get('[data-testid="recovery-notice"]').text()).toContain('not the same worktree')
    expect(w.get('[data-testid="recovery-lock"]').text()).toBe('Lock again')
    expect(w.get('[data-testid="recovery-dismiss"]').text()).toBe('Dismiss')
    await w.get('[data-testid="recovery-lock"]').trigger('click')
    expect(w.emitted('answer')).toEqual([['l1', 'lock']])
  })

  it('after the check fails again, the button becomes "Lock this worktree anyway" and names the mismatch (delta 4)', async () => {
    const w = mountIt([
      item({
        id: 'l3',
        kind: 'unlock',
        notice: 'lock-skipped',
        mismatch: 'the admin directory is a different one'
      })
    ])
    expect(w.find('[data-testid="recovery-lock"]').exists()).toBe(false)
    expect(w.get('[data-testid="recovery-notice"]').text()).toContain(
      'the admin directory is a different one'
    )
    const anyway = w.get('[data-testid="recovery-lock-anyway"]')
    expect(anyway.text()).toBe('Lock this worktree anyway')
    await anyway.trigger('click')
    expect(w.emitted('answer')).toEqual([['l3', 'lock-anyway']])
  })

  it('a lock that failed to go back says the LOCK failed, with what git said (delta 4)', () => {
    const w = mountIt([
      item({ id: 'l2', kind: 'unlock', notice: 'lock-failed', detail: 'git is gone' })
    ])
    const text = w.get('[data-testid="recovery-notice"]').text()
    expect(text).toContain('git is gone')
    expect(text).toContain('could not lock it again')
    expect(text).not.toContain('not the same worktree')
    expect(w.get('[data-testid="recovery-lock"]').text()).toBe('Lock again')
  })

  it('containers that no longer exist are one dismissable notice, with nothing to start', async () => {
    const w = mountIt([item({ id: 'g1', notice: 'containers-gone' })])
    expect(w.find('[data-testid="recovery-start"]').exists()).toBe(false)
    expect(w.get('[data-testid="recovery-dismiss"]').text()).toBe('Dismiss')
  })

  it('lists every notice, each with its own answers', () => {
    const w = mountIt([item(), item({ id: 'n2', detail: 'db-1' })])
    expect(w.findAll('[data-testid="recovery-notice"]')).toHaveLength(2)
  })
})
