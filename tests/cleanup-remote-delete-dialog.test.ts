// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils'
import CleanupBulkConfirmDialog from '../src/renderer/src/components/CleanupBulkConfirmDialog.vue'
import { i18n } from '@renderer/i18n'
import {
  cleanRequestFor,
  dialogRows,
  withRemoteDelete,
  type DialogRow
} from '../src/renderer/src/lib/gc-model'
import { remoteDeleteOffered } from '../src/renderer/src/lib/gc-remote-delete'
import { remoteDeleteRefusal } from '../src/main/gc/gc-remote-delete'
import { MIB, modelOf, reviewReason, wt } from './helpers/cleanup-gc-fixtures'

/**
 * AC-D5, the remove confirm: "Also delete the branch on the remote" (default off). It appears only
 * when at least one row's branch is merged by strong proof, still exists on the remote and is not
 * protected, and what it sends is the ids of exactly those rows.
 */

const POLICY = { neverDeleteRemote: false, protectedBranches: ['main', 'develop'] }
const t = (key: string, named?: Record<string, unknown>): string =>
  (named ? i18n.global.t(key, named) : i18n.global.t(key)) as string

describe('the renderer offers exactly what main honours', () => {
  const merged = { fate: 'merged' as const, signal: 'ancestor' as const, strong: true }
  const cases = [
    ['strong merge, remote branch present', {}, {}, POLICY],
    ['kill switch on', {}, {}, { ...POLICY, neverDeleteRemote: true }],
    ['protected branch', { branch: 'develop' }, {}, POLICY],
    ['remote branch already gone', { needsRemoteDelete: false }, {}, POLICY],
    ['weak signal', {}, { fate: { ...merged, strong: false } }, POLICY],
    ['not merged', {}, { fate: { fate: 'closed-unmerged', signal: null, strong: false } }, POLICY]
  ] as const

  it.each(cases)('%s', (_name, itemOver, bundleOver, policy) => {
    const b = wt(
      'x',
      'review',
      MIB,
      { needsRemoteDelete: true, branch: 'feat/x', ...itemOver },
      { reason: reviewReason('dirty'), ...bundleOver }
    )
    const block = modelOf([b]).blocks[0]!
    expect(remoteDeleteOffered(block, policy)).toBe(remoteDeleteRefusal(b, policy) === null)
  })

  it('never offers anything while the policy is unknown (fail closed) or for a volume', () => {
    const b = wt('x', 'review', MIB, { needsRemoteDelete: true }, { reason: reviewReason('dirty') })
    expect(remoteDeleteOffered(modelOf([b]).blocks[0]!, null)).toBe(false)
  })
})

describe('dialogRows marks the eligible rows', () => {
  it('only a strongly merged branch with a remote copy', () => {
    const m = modelOf([
      wt('a', 'ready', MIB, { needsRemoteDelete: true, branch: 'feat/a' }),
      wt('b', 'ready', MIB, { needsRemoteDelete: false, branch: 'feat/b' })
    ])
    const ids = m.blocks.map((b) => b.id)
    const rows = dialogRows(m, ids, POLICY)
    expect(rows.map((r) => [r.name, r.remoteEligible])).toEqual([
      ['a', true],
      ['b', false]
    ])
    // Without a policy nothing is eligible.
    expect(dialogRows(m, ids).every((r) => !r.remoteEligible)).toBe(true)
  })
})

describe('withRemoteDelete builds the request', () => {
  it('adds the ids of the eligible rows only, and survives a structured clone', () => {
    const m = modelOf([
      wt('a', 'ready', MIB, { needsRemoteDelete: true, branch: 'feat/a' }),
      wt('b', 'ready', MIB, { needsRemoteDelete: false, branch: 'feat/b' })
    ])
    const ids = m.blocks.map((b) => b.id)
    const req = cleanRequestFor(m, ids, 'ready')
    const rows = dialogRows(m, req.ids, POLICY)
    const sent = structuredClone(withRemoteDelete(req, rows, true))
    expect(sent.options.deleteRemote).toEqual([ids[0]])
    expect(withRemoteDelete(req, rows, false).options.deleteRemote).toBeUndefined()
    expect(req.options.deleteRemote).toBeUndefined()
  })
})

describe('the dialog checkbox', () => {
  let wrapper: VueWrapper | null = null
  afterEach(() => {
    wrapper?.unmount()
    wrapper = null
    document.body.innerHTML = ''
  })
  const row = (over: Partial<DialogRow> = {}): DialogRow => ({
    id: 'r1',
    kind: 'worktree',
    repo: 'www',
    name: 'PROJ-41-feature',
    branch: 'feat/proj-41',
    bytes: 1000,
    chips: ['checkout', 'branch'],
    stackCount: 0,
    reasonCode: null,
    reasonDetail: null,
    project: null,
    risk: false,
    remoteEligible: true,
    ...over
  })
  async function open(rows: DialogRow[], mode: 'ready' | 'review' = 'ready'): Promise<VueWrapper> {
    wrapper = mount(CleanupBulkConfirmDialog, {
      props: { rows, mode },
      global: { plugins: [i18n] },
      attachTo: document.body
    })
    await flushPromises()
    return wrapper
  }
  const box = (): HTMLInputElement | null =>
    document.body.querySelector<HTMLInputElement>('[data-testid="bulk-remote-delete"]')

  it('is off by default and says what it does', async () => {
    await open([row()])
    expect(box()).not.toBeNull()
    expect(box()!.checked).toBe(false)
    expect(document.body.textContent).toContain(t('cleanup.gc.confirm.remote.label'))
  })

  it('is absent when no row qualifies (and for volume rows)', async () => {
    await open([row({ remoteEligible: false }), row({ id: 'v', kind: 'volume', branch: null })])
    expect(box()).toBeNull()
  })

  it('says how many of the rows it covers when only some qualify', async () => {
    await open([row(), row({ id: 'r2', remoteEligible: false })], 'review')
    expect(document.body.querySelector('[data-testid="bulk-remote-count"]')!.textContent).toContain(
      t('cleanup.gc.confirm.remote.some', { n: 1, total: 2 })
    )
  })

  it('confirm carries the choice: false by default, true once ticked', async () => {
    const w = await open([row()])
    document.body.querySelector<HTMLElement>('[data-testid="bulk-confirm"]')!.click()
    await flushPromises()
    expect(w.emitted('confirm')![0]).toEqual([{ deleteRemote: false }])
    box()!.click()
    await flushPromises()
    expect(box()!.checked).toBe(true)
    document.body.querySelector<HTMLElement>('[data-testid="bulk-confirm"]')!.click()
    await flushPromises()
    expect(w.emitted('confirm')![1]).toEqual([{ deleteRemote: true }])
  })
})
