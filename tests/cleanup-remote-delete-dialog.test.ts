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
import {
  remoteDeleteCandidate,
  remoteDeleteOffered
} from '../src/renderer/src/lib/gc-remote-delete'
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

const GOOD = {
  remote: 'origin',
  remoteSha: 'a'.repeat(40),
  remoteMatchesLocal: true,
  openPr: false,
  ghProtected: false
}
/** A bundle the remote delete may take: a merged PR (the facts the probe found travel apart). */
const mergedOpts = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  fate: { fate: 'merged', signal: 'gh-merged', strong: true },
  ...over
})

describe('the renderer offers exactly what main honours', () => {
  const merged = { fate: 'merged' as const, signal: 'gh-merged' as const, strong: true }
  type Case = readonly [string, object, object, typeof POLICY, typeof GOOD | undefined]
  const cases: Case[] = [
    ['strong merge by a merged PR, remote verified', {}, {}, POLICY, GOOD],
    ['kill switch on', {}, {}, { ...POLICY, neverDeleteRemote: true }, GOOD],
    ['protected branch', { branch: 'develop' }, {}, POLICY, GOOD],
    ['remote branch already gone', {}, {}, POLICY, { ...GOOD, remoteSha: null } as never],
    ['an open PR uses the branch', {}, {}, POLICY, { ...GOOD, openPr: true } as never],
    ['the open-PR check failed', {}, {}, POLICY, { ...GOOD, openPr: null } as never],
    ['GitHub protects it', {}, {}, POLICY, { ...GOOD, ghProtected: true } as never],
    ['no upstream remote', {}, {}, POLICY, { ...GOOD, remote: null } as never],
    ['the remote moved', {}, {}, POLICY, { ...GOOD, remoteMatchesLocal: false } as never],
    ['nothing was probed', {}, {}, POLICY, undefined],
    [
      'merged only as an ancestor of main',
      {},
      { fate: { ...merged, signal: 'ancestor' } },
      POLICY,
      GOOD
    ],
    ['weak signal', {}, { fate: { ...merged, strong: false } }, POLICY, GOOD],
    [
      'not merged',
      {},
      { fate: { fate: 'closed-unmerged', signal: null, strong: false } },
      POLICY,
      GOOD
    ]
  ]
  const blockOf = (itemOver: object, bundleOver: object) => {
    const b = wt('x', 'review', MIB, { needsRemoteDelete: true, branch: 'feat/x', ...itemOver }, {
      reason: reviewReason('dirty'),
      ...mergedOpts(),
      ...bundleOver
    } as never)
    return { b, block: modelOf([b]).blocks[0]! }
  }

  it.each(cases)('%s', (_name, itemOver, bundleOver, policy, facts) => {
    const { b, block } = blockOf(itemOver, bundleOver)
    expect(remoteDeleteOffered(block, policy, facts)).toBe(
      remoteDeleteRefusal(b, policy, facts) === null
    )
  })

  it('offers it for the first case and for none of the others (the table is not vacuous)', () => {
    const offered = cases.map(([, itemOver, bundleOver, policy, facts]) => {
      const { block } = blockOf(itemOver, bundleOver)
      return remoteDeleteOffered(block, policy, facts)
    })
    expect(offered).toEqual([true, ...Array(cases.length - 1).fill(false)])
  })

  it('never offers anything while the policy is unknown (fail closed)', () => {
    const { block } = blockOf({}, {})
    expect(remoteDeleteOffered(block, null, GOOD)).toBe(false)
  })

  it('only a merged-PR branch is worth probing at all', () => {
    expect(remoteDeleteCandidate(blockOf({}, {}).block, POLICY)).toBe(true)
    expect(
      remoteDeleteCandidate(blockOf({}, { fate: { ...merged, signal: 'ancestor' } }).block, POLICY)
    ).toBe(false)
    expect(
      remoteDeleteCandidate(blockOf({}, {}).block, { ...POLICY, neverDeleteRemote: true })
    ).toBe(false)
  })
})

describe('dialogRows marks the eligible rows', () => {
  it('only a strongly merged branch whose remote copy was verified', () => {
    const m = modelOf([
      wt('a', 'ready', MIB, { needsRemoteDelete: true, branch: 'feat/a' }, mergedOpts() as never),
      wt('b', 'ready', MIB, { needsRemoteDelete: true, branch: 'feat/b' }, mergedOpts() as never)
    ])
    const [a, b] = m.blocks.map((x) => x.id)
    const rows = dialogRows(m, [a!, b!], POLICY, { [a!]: GOOD, [b!]: { ...GOOD, openPr: true } })
    expect(rows.map((r) => [r.name, r.remoteEligible])).toEqual([
      ['a', true],
      ['b', false]
    ])
    // Nothing probed (the dialog is still checking), or no policy: nothing is eligible.
    expect(dialogRows(m, [a!, b!], POLICY).every((r) => !r.remoteEligible)).toBe(true)
    expect(dialogRows(m, [a!, b!]).every((r) => !r.remoteEligible)).toBe(true)
  })
})

describe('withRemoteDelete builds the request', () => {
  it('adds the ids of the eligible rows only, and survives a structured clone', () => {
    const m = modelOf([
      wt('a', 'ready', MIB, { needsRemoteDelete: true, branch: 'feat/a' }, mergedOpts() as never),
      wt('b', 'ready', MIB, { needsRemoteDelete: true, branch: 'feat/b' }, mergedOpts() as never)
    ])
    const ids = m.blocks.map((b) => b.id)
    const req = cleanRequestFor(m, ids, 'ready')
    const rows = dialogRows(m, req.ids, POLICY, {
      [ids[0]!]: GOOD,
      [ids[1]!]: { ...GOOD, ghProtected: true }
    })
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

  it('while the remote is being asked it says so, and draws no box', async () => {
    wrapper = mount(CleanupBulkConfirmDialog, {
      props: { rows: [row({ remoteEligible: false })], mode: 'ready', remoteChecking: true },
      global: { plugins: [i18n] },
      attachTo: document.body
    })
    await flushPromises()
    expect(
      document.body.querySelector('[data-testid="bulk-remote-checking"]')!.textContent
    ).toContain(t('cleanup.gc.confirm.remote.checking'))
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

describe('the done summary names a remote branch that stayed', () => {
  it('a clean whose remote delete failed is a warning that carries the error', async () => {
    const { doneSummary } = await import('../src/renderer/src/lib/gc-jobs')
    const done = {
      jobId: 'j',
      kind: 'manual',
      results: [
        {
          id: 'a',
          ok: true,
          haltedAt: null,
          freedBytes: 5,
          remoteDelete: { branch: 'feat/a', ok: false, error: 'remote rejected' }
        },
        {
          id: 'b',
          ok: true,
          haltedAt: null,
          freedBytes: 5,
          remoteDelete: { branch: 'feat/b', ok: true }
        }
      ],
      freedBytes: 10,
      error: null
    } as unknown as Parameters<typeof doneSummary>[0]
    const s = doneSummary(done)
    expect(s.tone).toBe('warning')
    expect(s.cleaned).toBe(2)
    expect(s.remoteLeft).toEqual({ count: 1, error: 'remote rejected' })
  })
  it('a clean whose remote delete worked stays a plain success', async () => {
    const { doneSummary } = await import('../src/renderer/src/lib/gc-jobs')
    const s = doneSummary({
      jobId: 'j',
      kind: 'manual',
      results: [
        {
          id: 'b',
          ok: true,
          haltedAt: null,
          freedBytes: 5,
          remoteDelete: { branch: 'x', ok: true }
        }
      ],
      freedBytes: 5,
      error: null
    } as unknown as Parameters<typeof doneSummary>[0])
    expect(s.tone).toBe('success')
    expect(s.remoteLeft).toBeNull()
  })
})
