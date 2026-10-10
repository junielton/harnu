// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { mount } from '@vue/test-utils'
import CleanupBlockPanel from '../src/renderer/src/components/CleanupBlockPanel.vue'
import { i18n } from '@renderer/i18n'
import type { Bucket } from '../src/main/gc/bundle-core'
import type { ReapItem, HydrationInfo } from '../src/preload'
import type { GcOpinion } from '../src/main/gc/gc-wire'
import type { GcBlock } from '../src/renderer/src/lib/gc-model'
import type { BlockJobState, ItemFailure } from '../src/renderer/src/lib/gc-jobs'
import { stepKey } from '../src/renderer/src/components/cleanup-gc-copy'
import { CHANGED_SINCE_CONFIRM, REFUSAL_CODES } from '../src/renderer/src/lib/gc-jobs'
import { MIB, blockOf, reviewReason, modelOf, volume, wt } from './helpers/cleanup-gc-fixtures'

const t = (key: string, named?: Record<string, unknown>): string =>
  (named ? i18n.global.t(key, named) : i18n.global.t(key)) as string

function hydration(over: Partial<HydrationInfo> = {}): HydrationInfo {
  return {
    state: 'hydrated',
    removable: ['node_modules'],
    skipped: [],
    reclaimableBytes: 480_000_000,
    canRehydrate: true,
    rehydrateChanged: [],
    ...over
  }
}

function blockWith(
  bucket: Bucket,
  item: Partial<ReapItem> = {},
  reason = bucket === 'review'
    ? reviewReason('dirty', 'Merged with 1 modified tracked file.')
    : null
): GcBlock {
  return blockOf(
    wt(
      'x',
      bucket,
      1200 * MIB,
      { hydration: hydration(), verdict: 'blocked', ...item },
      {
        reason,
        stackIds: ['s1'],
        ownedVolumes: ['v1'],
        depsBytes: 400 * MIB
      }
    )
  )
}

type Props = {
  state?: BlockJobState | null
  failure?: ItemFailure | null
  dehydrateIdleDays?: number
  hydrationBusy?: 'dehydrating' | 'rehydrating' | null
  opinion?: GcOpinion | null
  asking?: boolean
}

function mountPanel(block: GcBlock, props: Props = {}) {
  return mount(CleanupBlockPanel, {
    props: { block, state: null, failure: null, ...props },
    global: { plugins: [i18n] }
  })
}

const has = (w: ReturnType<typeof mountPanel>, id: string): boolean =>
  w.find(`[data-testid="${id}"]`).exists()

const itemFailure = (over: Partial<ItemFailure> = {}): ItemFailure => ({
  step: 'reprobe',
  error: 'x',
  refusal: null,
  ...over
})

describe('CleanupBlockPanel — Remove is only offered for what main takes', () => {
  const nested = () =>
    blockWith(
      'review',
      {},
      reviewReason(
        'nested-worktree',
        '1 other worktree lives inside this one: .claude/worktrees/spike.'
      )
    )
  const withFacts = (reason: ReturnType<typeof reviewReason>, facts: Record<string, unknown>) =>
    blockOf(wt('x', 'review', 1200 * MIB, {}, { reason, ...facts }))

  it('hides Remove and does not act on R, and says why', async () => {
    const w = mountPanel(nested(), { attachTo: document.body } as never)
    expect(has(w, 'panel-remove')).toBe(false)
    expect(w.get('[data-testid="panel-remove-blocked"]').text()).toBe(
      'Remove is unavailable. This folder holds another worktree or checkout. Remove or move that one first.'
    )
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'r' }))
    expect(w.emitted('remove')).toBeUndefined()
    w.unmount()
  })

  it('a locked worktree gets the same treatment, with the command that unlocks it', () => {
    const locked = withFacts(reviewReason('locked' as never, 'This worktree is locked in git.'), {
      locked: true
    })
    const w = mountPanel(locked)
    expect(has(w, 'panel-remove')).toBe(false)
    expect(w.get('[data-testid="panel-remove-blocked"]').text()).toBe(
      'Remove is unavailable. Git has this worktree locked. Unlock it first.'
    )
    expect(w.get('[data-testid="panel-remove-hint"]').text()).toBe(
      'Run git worktree unlock /w/repo/.claude/worktrees/x'
    )
  })

  it.each([
    [
      'a shared stack',
      reviewReason('shared-stack'),
      { sharedStackIds: ['other'] },
      'Another stack'
    ],
    [
      'an idle session still open',
      reviewReason('open-idle-session'),
      { session: 'open-idle' },
      'A session is still open'
    ],
    [
      'an unknown tip',
      reviewReason('unknown-fate'),
      { localTip: null },
      'could not tell which commit'
    ],
    [
      'an unresolved path',
      reviewReason('path-unresolved'),
      { pathsResolved: false },
      'could not be resolved'
    ]
  ])('%s: no Remove, no R, and the reason', (_name, reason, facts, text) => {
    const w = mountPanel(withFacts(reason, facts), { attachTo: document.body } as never)
    expect(has(w, 'panel-remove')).toBe(false)
    expect(w.get('[data-testid="panel-remove-blocked"]').text()).toContain(text)
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'r' }))
    expect(w.emitted('remove')).toBeUndefined()
    w.unmount()
  })

  it('a detached worktree names the command that removes it by hand', () => {
    const detached = blockOf(
      wt(
        'x',
        'review',
        1200 * MIB,
        { kind: 'detached-worktree', branch: null },
        { reason: reviewReason('detached') }
      )
    )
    const w = mountPanel(detached)
    expect(has(w, 'panel-remove')).toBe(false)
    expect(w.get('[data-testid="panel-remove-hint"]').text()).toContain('git worktree remove')
  })

  it('a worktree Harnu could not look inside gets its own Remove-blocked sentence', () => {
    const unchecked = blockWith(
      'review',
      {},
      reviewReason('check-failed' as never, 'Harnu could not look inside /srv/ws/x.')
    )
    const w = mountPanel(unchecked)
    expect(has(w, 'panel-remove')).toBe(false)
    const text = w.get('[data-testid="panel-remove-blocked"]').text()
    expect(text).toMatch(/could not look inside/)
    expect(text).not.toMatch(/holds another worktree/)
  })

  it.each(['en', 'pt-BR'])(
    '%s: the could-not-look-inside sentence names the real Scan now button',
    (lang) => {
      const locale = i18n.global.locale as unknown as { value: string }
      const original = locale.value
      locale.value = lang
      try {
        const unchecked = blockWith(
          'review',
          {},
          reviewReason('check-failed' as never, 'Harnu could not look inside /srv/ws/x.')
        )
        const text = mountPanel(unchecked).get('[data-testid="panel-remove-blocked"]').text()
        // Whatever the button is called in this language is what the sentence must say.
        expect(text).toContain(i18n.global.t('cleanup.scanNow'))
        expect(text).not.toContain('{')
        if (lang === 'pt-BR') expect(text).not.toContain('Scan now')
      } finally {
        locale.value = original
      }
    }
  )

  it('keeps Keep and the other actions that do not delete the folder', () => {
    const w = mountPanel(nested())
    expect(has(w, 'panel-keep')).toBe(true)
  })

  it('a failed item that main refuses on its facts has nothing to Retry', () => {
    const locked = withFacts(reviewReason('locked' as never), { locked: true })
    const w = mountPanel(locked, {
      failure: itemFailure({
        step: 'reprobe',
        error: 'cannot-unregister',
        refusal: 'cannot-unregister'
      })
    })
    expect(has(w, 'panel-retry')).toBe(false)
  })

  it('a locked item keeps its real reason after a refusal, not "couldn\'t match a registration"', () => {
    const locked = withFacts(reviewReason('locked' as never), { locked: true })
    const w = mountPanel(locked, {
      failure: itemFailure({
        step: 'reprobe',
        error: 'cannot-unregister',
        refusal: 'cannot-unregister'
      })
    })
    const text = w.get('[data-testid="panel-refusal"]').text()
    expect(text).toBe('Git has this worktree locked. Unlock it first.')
    expect(text).not.toContain('single git registration')
  })

  it('without the locked fact, cannot-unregister keeps its own sentence', () => {
    const w = mountPanel(blockWith('review'), {
      failure: itemFailure({
        step: 'reprobe',
        error: 'cannot-unregister',
        refusal: 'cannot-unregister'
      })
    })
    expect(w.get('[data-testid="panel-refusal"]').text()).toContain('single git registration')
  })

  it('every other review reason still offers Remove', () => {
    expect(has(mountPanel(blockWith('review')), 'panel-remove')).toBe(true)
    expect(has(mountPanel(blockWith('review')), 'panel-remove-blocked')).toBe(false)
  })
})

describe('CleanupBlockPanel — a ready item main refused lately', () => {
  const stuck = (count = 1): GcBlock => {
    const b = wt('x', 'ready', 1200 * MIB, { verdict: 'harvestable', blockers: [] })
    b.reprobeRefusal = { code: 'cannot-unregister', count }
    return blockOf(b)
  }

  it('says it was refused and why, and offers Retry instead of Clean now', () => {
    const w = mountPanel(stuck())
    expect(w.get('[data-testid="panel-refused"]').attributes('data-refusal')).toBe(
      'cannot-unregister'
    )
    expect(w.get('[data-testid="panel-refused"]').text()).toContain('The last clean was refused')
    expect(has(w, 'panel-retry')).toBe(true)
    expect(has(w, 'panel-clean-now')).toBe(false)
  })

  it('a demoted one offers neither Remove nor Retry, and names the real reason', () => {
    const b = wt('x', 'review', 1200 * MIB, {}, { reason: reviewReason('cleanup-failed') })
    b.reprobeRefusal = { code: 'cannot-unregister', count: 2 }
    const w = mountPanel(blockOf(b))
    expect(has(w, 'panel-remove')).toBe(false)
    expect(has(w, 'panel-retry')).toBe(false)
    expect(w.get('[data-testid="panel-remove-blocked"]').text()).toContain(
      t('cleanup.gc.removal.reason.cannotUnregister')
    )
    expect(w.get('[data-testid="panel-remove-hint"]').text()).toContain('git worktree list')
    expect(w.get('[data-testid="panel-reason"]').text()).toBe(
      t('cleanup.gc.removal.reason.cannotUnregister')
    )
  })

  it('a demoted item offers Check again, which asks the screen to recheck it', async () => {
    const b = wt('x', 'review', 1200 * MIB, {}, { reason: reviewReason('cleanup-failed') })
    b.reprobeRefusal = { code: 'cannot-unregister', count: 2 }
    const w = mountPanel(blockOf(b))
    expect(w.get('[data-testid="panel-recheck"]').text()).toBe(t('cleanup.gc.panel.recheck'))
    await w.get('[data-testid="panel-recheck"]').trigger('click')
    expect(w.emitted('recheck')).toEqual([['/w/repo::worktree::x']])
  })

  it('a ready item with one refusal has Retry, not Check again; an ordinary review item has neither', () => {
    expect(has(mountPanel(stuck()), 'panel-recheck')).toBe(false)
    expect(has(mountPanel(blockWith('review')), 'panel-recheck')).toBe(false)
  })

  it('a demoted one says how many times, in Needs review', () => {
    const b = wt('x', 'review', 1200 * MIB, {}, { reason: reviewReason('cleanup-failed') })
    b.reprobeRefusal = { code: 'tip-unknown', count: 2 }
    const w = mountPanel(blockOf(b))
    expect(w.get('[data-testid="panel-refused-hint"]').text()).toContain('2 times in a row')
  })
})

describe('CleanupBlockPanel — Clean now follows the same predicate as Remove', () => {
  const readyWith = (facts: Record<string, unknown>): GcBlock =>
    blockOf(wt('x', 'ready', 1200 * MIB, { verdict: 'harvestable', blockers: [] }, facts))

  it('offers Clean now for a ready item main takes', () => {
    expect(has(mountPanel(readyWith({})), 'panel-clean-now')).toBe(true)
  })

  it.each([
    [
      'a scan that could not see Docker',
      { dockerBlind: true },
      'cleanup.gc.removal.reason.scanBlind'
    ],
    ['a locked worktree', { locked: true }, 'cleanup.gc.removal.reason.locked'],
    ['a shared stack', { sharedStackIds: ['o'] }, 'cleanup.gc.removal.reason.sharedStack']
  ])('hides Clean now for %s and says why', (_n, facts, key) => {
    const w = mountPanel(readyWith(facts))
    expect(has(w, 'panel-clean-now')).toBe(false)
    expect(w.get('[data-testid="panel-remove-blocked"]').text()).toBe(
      t('cleanup.gc.panel.cleanUnavailable', { reason: t(key) })
    )
  })
})

describe('CleanupBlockPanel — Docker down', () => {
  it('tells the operator to start Docker, then Retry, and offers Retry', () => {
    const w = mountPanel(blockWith('ready', { verdict: 'harvestable', blockers: [] }), {
      failure: itemFailure({
        step: 'reprobe',
        error: 'docker-unavailable',
        refusal: 'docker-unavailable'
      })
    })
    expect(w.get('[data-testid="panel-refusal"]').text()).toBe(
      'Docker is not running, so Harnu could not check this worktree safely and left it alone. Start Docker, then Retry.'
    )
    expect(has(w, 'panel-retry')).toBe(true)
  })
})

describe('CleanupBlockPanel — actions by bucket and kind', () => {
  it('a ready item offers Clean now and nothing destructive besides', async () => {
    const w = mountPanel(blockWith('ready', { verdict: 'harvestable', blockers: [] }))
    expect(has(w, 'panel-clean-now')).toBe(true)
    for (const id of [
      'panel-remove',
      'panel-keep',
      'panel-ask',
      'panel-dehydrate',
      'panel-retry'
    ]) {
      expect(has(w, id)).toBe(false)
    }
    await w.get('[data-testid="panel-clean-now"]').trigger('click')
    expect(w.emitted('cleanNow')).toHaveLength(1)
  })

  it('a Needs review worktree offers Remove, Dehydrate, Keep and an enabled Ask with its cost tooltip', async () => {
    const w = mountPanel(blockWith('review'))
    for (const id of ['panel-remove', 'panel-dehydrate', 'panel-keep', 'panel-ask']) {
      expect(has(w, id)).toBe(true)
    }
    const ask = w.get('[data-testid="panel-ask"]')
    expect(ask.attributes('disabled')).toBeUndefined()
    expect(ask.attributes('title')).toBe(t('cleanup.gc.opinion.hint'))
    await w.get('[data-testid="panel-remove"]').trigger('click')
    await w.get('[data-testid="panel-keep"]').trigger('click')
    await w.get('[data-testid="panel-dehydrate"]').trigger('click')
    await w.get('[data-testid="panel-ask"]').trigger('click')
    expect(w.emitted('remove')).toHaveLength(1)
    expect(w.emitted('keep')).toHaveLength(1)
    expect(w.emitted('dehydrate')).toHaveLength(1)
    expect(w.emitted('ask')).toEqual([[w.props('block').id]])
    expect(w.emitted('close')).toBeUndefined()
  })

  it('an In use worktree has no destructive action — only Dehydrate once idle', () => {
    const idle = mountPanel(blockWith('in-use', { ageDays: 34 }))
    expect(has(idle, 'panel-remove')).toBe(false)
    expect(has(idle, 'panel-keep')).toBe(false)
    expect(has(idle, 'panel-clean-now')).toBe(false)
    expect(has(idle, 'panel-dehydrate')).toBe(true)

    const fresh = mountPanel(blockWith('in-use', { ageDays: 3 }))
    expect(has(fresh, 'panel-dehydrate')).toBe(false)
    const tuned = mountPanel(blockWith('in-use', { ageDays: 3 }), { dehydrateIdleDays: 2 })
    expect(has(tuned, 'panel-dehydrate')).toBe(true)
  })

  it('an orphan volume names its project, offers Remove only, and warns it cannot be restored', async () => {
    const block = modelOf([], [volume('pg_data', 'old-app', 900 * MIB)]).byId.get('volume:pg_data')!
    const w = mountPanel(block)
    expect(w.get('[data-testid="panel-repo"]').text()).toBe(
      t('cleanup.gc.panel.project', { project: 'old-app' })
    )
    expect(w.get('[data-testid="panel-reason"]').text()).toBe(
      t('cleanup.gc.reason.noKnownWorktree')
    )
    expect(has(w, 'panel-remove')).toBe(true)
    for (const id of ['panel-keep', 'panel-dehydrate', 'panel-rehydrate']) {
      expect(has(w, id)).toBe(false)
    }
    // An orphan volume can be asked about too: the advisor sees its project and size.
    expect(has(w, 'panel-ask')).toBe(true)
    expect(has(w, 'panel-volume-warning')).toBe(true)
    await w.get('[data-testid="panel-close"]').trigger('click')
    expect(w.emitted('close')).toHaveLength(1)
  })

  it("shows what a removal takes with it — never the worktree's volumes, which are kept (D1)", () => {
    const w = mountPanel(blockWith('review'))
    const lines = w.findAll('[data-testid="panel-takes"] li').map((l) => l.text())
    expect(lines).toHaveLength(4) // stack, deps, checkout, branch
    expect(has(w, 'panel-volume-warning')).toBe(false)
    expect(w.get('[data-testid="panel-volumes-kept"]').text()).toBe(
      t('cleanup.gc.panel.volumesKept', { names: 'v1' })
    )
  })

  it('draws the composition bar from deps and checkout, and lists volume names (no volume bytes exist)', () => {
    const w = mountPanel(blockWith('review'))
    expect(has(w, 'panel-composition')).toBe(true)
    expect(w.get('[data-testid="panel-volumes"]').text()).toBe(
      t('cleanup.gc.panel.volumesNoSize', { names: 'v1' })
    )
  })

  it('shows the translated reason with the engine detail as a secondary line', () => {
    const w = mountPanel(blockWith('review'))
    expect(w.get('[data-testid="panel-reason"]').text()).toBe(t('cleanup.gc.reason.dirty'))
    expect(w.get('[data-testid="panel-reason-detail"]').text()).toBe(
      'Merged with 1 modified tracked file.'
    )
  })

  it('while the item is being cleaned it says so and locks every action', () => {
    const w = mountPanel(blockWith('review'), { state: 'busy' })
    expect(has(w, 'panel-busy')).toBe(true)
    for (const id of ['panel-remove', 'panel-keep', 'panel-dehydrate']) {
      expect(w.get(`[data-testid="${id}"]`).attributes('disabled')).toBeDefined()
    }
  })
})

describe('CleanupBlockPanel — a failed item', () => {
  const failure = (over: Partial<ItemFailure> = {}): ItemFailure => ({
    step: 'rm-volumes',
    error: 'volume pg-1 is in use by container pg-1',
    refusal: null,
    ...over
  })
  const failedBlock = () =>
    blockWith('review', {}, reviewReason('cleanup-failed', 'Cleanup stopped at step rm-volumes.'))

  it("says where it stopped, in the engine's own words — and invents no other step", () => {
    const w = mountPanel(failedBlock(), {
      failure: failure({ step: 'drop-deps', error: 'EBUSY: node_modules is in use' })
    })
    expect(w.get('[data-testid="panel-halt"]').text()).toContain(t('cleanup.gc.step.dropDeps'))
    expect(has(w, 'panel-error')).toBe(false)
    expect(w.text()).not.toContain('EBUSY')
    // No per-step history: "archive" is not claimed done, and no volume step appears at all.
    expect(has(w, 'panel-steps')).toBe(false)
    const text = w.text()
    expect(text).not.toContain(t('cleanup.gc.step.archive'))
    expect(text).not.toContain(t('cleanup.gc.step.stopStack'))
    expect(text).not.toMatch(/Remove volumes/i)
  })

  describe('a halted item whose folder is already gone (F0 delta 2)', () => {
    const goneBlock = (branch: string | null = 'feat/x') => {
      const b = wt(
        'x',
        'review',
        1200 * MIB,
        { branch, hydration: hydration(), verdict: 'blocked' },
        {
          reason: reviewReason(
            'cleanup-failed',
            'Cleanup stopped at branch-delete in /w/repo/.claude/worktrees/x.'
          )
        }
      )
      ;(b as unknown as { folderGone: boolean }).folderGone = true
      return blockOf(b)
    }

    it('hides Retry and Remove, and shows the next step with the exact commands', () => {
      const w = mountPanel(goneBlock(), { failure: failure({ step: 'branch-delete' }) })
      expect(has(w, 'panel-retry')).toBe(false)
      expect(has(w, 'panel-remove')).toBe(false)
      const hint = w.get('[data-testid="panel-resume"]').text()
      expect(hint).toContain(t('cleanup.gc.step.branchDelete'))
      expect(hint).toContain('git -C /w/repo worktree prune')
      expect(hint).toContain('git -C /w/repo branch -D feat/x')
      expect(hint).toMatch(/archive refs/)
    })

    it('words it neutrally (the folder may have been deleted by hand) and claims the archive only when it ran', () => {
      const early = goneBlock()
      const b = early.bundle!
      b.reason = { code: 'cleanup-failed', detail: 'Cleanup stopped at drop-deps in /w/repo/x.' }
      const w = mountPanel(blockOf(b), { failure: failure({ step: 'drop-deps' }) })
      const hint = w.get('[data-testid="panel-resume"]').text()
      expect(hint).toMatch(/folder is gone/i)
      expect(hint).not.toMatch(/trashed/i)
      // Nothing was archived: the safe -d (it refuses unmerged commits), never -D, plus the warning.
      expect(hint).toContain('git -C /w/repo branch -d feat/x')
      expect(hint).not.toContain('branch -D')
      expect(hint).toContain(i18n.global.t('cleanup.gc.panel.resumeUnarchived'))
      expect(hint).toMatch(/If git refuses/)
      expect(hint).not.toMatch(/archive refs/)
      // After the archive step the refs exist and the line is shown.
      const late = mountPanel(goneBlock(), { failure: failure({ step: 'branch-delete' }) })
      expect(late.get('[data-testid="panel-resume"]').text()).toMatch(/archive refs/)
      expect(late.get('[data-testid="panel-resume"]').text()).toContain('branch -D')
      expect(late.get('[data-testid="panel-resume"]').text()).not.toMatch(/If git refuses/)
      expect(late.get('[data-testid="panel-resume"]').text()).not.toMatch(/trashed/i)
    })

    it('hides Dehydrate and Rehydrate too, and the D shortcut does nothing', () => {
      // The item still carries a hydration record from the last scan (it was dehydratable), but
      // its folder is gone: there is nothing to dehydrate.
      const w = mountPanel(goneBlock(), { failure: failure(), attachTo: document.body } as never)
      expect(has(w, 'panel-dehydrate')).toBe(false)
      expect(has(w, 'panel-rehydrate')).toBe(false)
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'd' }))
      expect(w.emitted('dehydrate')).toBeUndefined()
      w.unmount()
    })

    it('a halted item whose folder is still there keeps Dehydrate', () => {
      const w = mountPanel(failedBlock(), { failure: failure() })
      expect(has(w, 'panel-dehydrate')).toBe(true)
    })

    it('still offers Keep', () => {
      expect(has(mountPanel(goneBlock(), { failure: failure() }), 'panel-keep')).toBe(true)
    })

    it('says the same in pt-BR, with the commands untouched', () => {
      const locale = i18n.global.locale as unknown as { value: string }
      const original = locale.value
      locale.value = 'pt-BR'
      try {
        const hint = mountPanel(goneBlock(), { failure: failure() })
          .get('[data-testid="panel-resume"]')
          .text()
        expect(hint).toContain('git -C /w/repo worktree prune')
        expect(hint).toContain('git -C /w/repo branch -D feat/x')
        // The pt-BR sentence, read from the locale rather than spelled out here (English gate).
        expect(hint).toContain(i18n.global.t('cleanup.gc.panel.resumeArchive'))
        expect(hint).not.toMatch(/archive refs/)
      } finally {
        locale.value = original
      }
    })

    it('a halted item whose folder is still there keeps Retry and shows no resume text', () => {
      const w = mountPanel(failedBlock(), { failure: failure() })
      expect(has(w, 'panel-retry')).toBe(true)
      expect(has(w, 'panel-resume')).toBe(false)
    })
  })

  it('a pre-flight refusal says nothing was changed, in a human sentence', () => {
    const w = mountPanel(failedBlock(), {
      failure: failure({ step: 'reprobe', error: 'tip-unknown', refusal: 'tip-unknown' })
    })
    expect(w.get('[data-testid="panel-nothing-changed"]').text()).toBe(
      t('cleanup.gc.panel.nothingChanged')
    )
    expect(w.get('[data-testid="panel-refusal"]').text()).toBe(t('cleanup.gc.refusal.tipUnknown'))
    expect(has(w, 'panel-halt')).toBe(false)
  })

  it('a pre-flight halt with an unknown reason still says nothing was changed, in a generic sentence', () => {
    const w = mountPanel(failedBlock(), {
      failure: failure({ step: 'reprobe', error: 'git exploded', refusal: null })
    })
    expect(has(w, 'panel-nothing-changed')).toBe(true)
    expect(w.get('[data-testid="panel-generic"]').text()).toBe(
      'Harnu stopped this item for a safety check.'
    )
  })

  it('a mid-run reason is NOT "nothing was changed": earlier steps may have run', () => {
    const w = mountPanel(failedBlock(), {
      failure: failure({ step: 'drop-deps', error: 'changed-mid-run', refusal: 'changed-mid-run' })
    })
    expect(has(w, 'panel-nothing-changed')).toBe(false)
    expect(w.get('[data-testid="panel-halt"]').text()).toContain(t('cleanup.gc.step.dropDeps'))
    expect(w.get('[data-testid="panel-refusal"]').text()).toBe(
      t('cleanup.gc.refusal.changedMidRun')
    )
  })

  it('offers Retry, Keep and Remove', async () => {
    const w = mountPanel(failedBlock(), { failure: failure() })
    expect(has(w, 'panel-retry')).toBe(true)
    expect(has(w, 'panel-keep')).toBe(true)
    expect(has(w, 'panel-remove')).toBe(true)
    await w.get('[data-testid="panel-retry"]').trigger('click')
    expect(w.emitted('retry')).toHaveLength(1)
  })

  it('never shows a raw error as text: a generic sentence is visible and the raw text only travels with Copy error', async () => {
    const writeText = vi.fn(async () => {})
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    const w = mountPanel(failedBlock(), { failure: failure() })
    expect(has(w, 'panel-error')).toBe(false)
    expect(w.text()).not.toContain('volume pg-1 is in use by container pg-1')
    expect(w.html()).not.toContain('volume pg-1 is in use by container pg-1')
    expect(w.get('[data-testid="panel-generic"]').text()).toBe(
      'Harnu stopped this item for a safety check.'
    )
    await w.get('[data-testid="panel-copy-error"]').trigger('click')
    expect(writeText).toHaveBeenCalledWith('volume pg-1 is in use by container pg-1')
  })

  it('a known refusal gets its sentence and no generic one', () => {
    const w = mountPanel(failedBlock(), {
      failure: failure({ step: 'reprobe', error: 'dirty', refusal: 'dirty' })
    })
    expect(has(w, 'panel-generic')).toBe(false)
    expect(w.get('[data-testid="panel-refusal"]').text()).not.toBe('dirty')
  })

  it('every pipeline step has its own label, so no known step reads as "an unknown step"', () => {
    for (const step of [
      'reprobe',
      'stop-stack',
      'rm-containers',
      'rm-volumes',
      'archive',
      'drop-deps',
      'trash',
      'prune',
      'branch-delete',
      'detach'
    ] as const) {
      expect(stepKey(step), step).not.toBe('cleanup.gc.step.unknown')
      expect(t(stepKey(step)), step).not.toBe('an unknown step')
    }
  })

  it('a changed-since-confirm refusal is stated plainly instead of dumping the error', () => {
    const w = mountPanel(failedBlock(), {
      failure: failure({
        step: 'reprobe',
        error: CHANGED_SINCE_CONFIRM,
        refusal: 'changed-since-confirm'
      })
    })
    expect(w.get('[data-testid="panel-refusal"]').text()).toBe(
      t('cleanup.gc.refusal.changedSinceConfirm')
    )
    expect(has(w, 'panel-error')).toBe(false)
  })

  it.each(REFUSAL_CODES)('the %s refusal gets its own human sentence', (code) => {
    const w = mountPanel(failedBlock(), {
      failure: failure({ step: 'reprobe', error: code, refusal: code })
    })
    const sentence = w.get('[data-testid="panel-refusal"]').text()
    expect(sentence).not.toBe(code)
    expect(sentence).not.toContain('cleanup.gc.refusal')
    expect(has(w, 'panel-error')).toBe(false)
  })
})

// The legality cases of the retired CleanupView row cluster (T250), now decided on the panel.
describe('CleanupBlockPanel — hydration legality', () => {
  it('offers Dehydrate on a detached worktree, with the bytes it frees', () => {
    const w = mountPanel(
      blockWith('review', {
        kind: 'detached-worktree',
        branch: undefined,
        blockers: ['detached-head'],
        path: '/w/repo/.claude/worktrees/det'
      })
    )
    const btn = w.get('[data-testid="panel-dehydrate"]')
    expect(btn.attributes('aria-label')).toBe(
      t('cleanup.a11y.dehydrateSize', { what: '.claude/worktrees/det', size: '480 MB' })
    )
  })

  it('dehydrated and blocked: the "dehydrated" marker and Rehydrate — no Dehydrate', async () => {
    const w = mountPanel(
      blockWith('review', { hydration: hydration({ state: 'dehydrated', removable: [] }) })
    )
    expect(w.get('[data-testid="panel-hydration"]').text()).toBe(t('cleanup.state.dehydrated'))
    expect(has(w, 'panel-rehydrate')).toBe(true)
    expect(has(w, 'panel-dehydrate')).toBe(false)
    await w.get('[data-testid="panel-rehydrate"]').trigger('click')
    expect(w.emitted('rehydrate')).toHaveLength(1)
  })

  it('says "no setup" in the marker and offers no Rehydrate when Harnu cannot rehydrate', () => {
    const w = mountPanel(
      blockWith('review', {
        hydration: hydration({ state: 'dehydrated', removable: [], canRehydrate: false })
      })
    )
    expect(w.get('[data-testid="panel-hydration"]').text()).toBe(
      t('cleanup.state.dehydratedNoRehydrate')
    )
    expect(has(w, 'panel-rehydrate')).toBe(false)
  })

  it('warns in the Dehydrate label when Harnu could not bring the folders back', () => {
    const w = mountPanel(blockWith('review', { hydration: hydration({ canRehydrate: false }) }))
    expect(w.get('[data-testid="panel-dehydrate"]').attributes('aria-label')).toBe(
      t('cleanup.a11y.dehydrateNoSetup', { what: 'feat/x' })
    )
  })

  it('a ready item with dependencies installed is just cleaned — no Dehydrate beside Clean now', () => {
    const w = mountPanel(blockWith('ready', { verdict: 'harvestable', blockers: [] }))
    expect(has(w, 'panel-clean-now')).toBe(true)
    expect(has(w, 'panel-dehydrate')).toBe(false)
  })

  it('names the lockfile a rehydrate rewrote, in the warning tone', () => {
    const w = mountPanel(
      blockWith('review', {
        hydration: hydration({ removable: [], rehydrateChanged: ['package-lock.json'] })
      })
    )
    const m = w.get('[data-testid="panel-hydration"]')
    expect(m.text()).toBe(t('cleanup.state.rehydrateChanged', { file: 'package-lock.json' }))
    expect(m.classes()).toContain('text-warning')
  })

  it('offers nothing to dehydrate on a repo that commits vendor/, and says why in the meta tooltip', () => {
    const w = mountPanel(
      blockWith('review', {
        hydration: hydration({ removable: [], skipped: [{ path: 'vendor', reason: 'tracked' }] })
      })
    )
    expect(has(w, 'panel-dehydrate')).toBe(false)
    const meta = w.get('[data-testid="panel-meta"]')
    expect(meta.attributes('title')).toBe(
      t('cleanup.state.kept', {
        items: `vendor — ${t('cleanup.dehydrateConfirm.skip.tracked')}`
      })
    )
  })

  it('an in-flight dehydrate/rehydrate shows its marker and disables both buttons', () => {
    const busy = mountPanel(blockWith('review'), { hydrationBusy: 'dehydrating' })
    expect(busy.get('[data-testid="panel-hydration"]').text()).toBe(t('cleanup.state.dehydrating'))
    expect(busy.get('[data-testid="panel-dehydrate"]').attributes('disabled')).toBeDefined()
    // Remove stays available: only the two hydration buttons are tied to the operation.
    expect(busy.get('[data-testid="panel-remove"]').attributes('disabled')).toBeUndefined()

    const re = mountPanel(
      blockWith('review', { hydration: hydration({ state: 'dehydrated', removable: [] }) }),
      { hydrationBusy: 'rehydrating' }
    )
    expect(re.get('[data-testid="panel-rehydrate"]').attributes('disabled')).toBeDefined()
  })
})

describe('CleanupBlockPanel — the opinion section', () => {
  const opinion = (over: Partial<GcOpinion> = {}): GcOpinion => ({
    id: 'x',
    verdict: 'safe',
    reason: 'Everything it changed is already on main.',
    evidence: 'the 3 changed files are on main at abc123',
    ...over
  })

  it('shows nothing until the item was asked about', () => {
    expect(has(mountPanel(blockWith('review')), 'panel-opinion')).toBe(false)
  })

  it('shows the verdict, the reason and the evidence', () => {
    const w = mountPanel(blockWith('review'), { opinion: opinion() })
    expect(w.get('[data-testid="panel-opinion"] [data-testid="opinion-chip"]').text()).toBe(
      t('cleanup.gc.opinion.safe')
    )
    expect(w.get('[data-testid="panel-opinion-reason"]').text()).toBe(
      'Everything it changed is already on main.'
    )
    expect(w.get('[data-testid="panel-opinion-evidence"]').text()).toContain(
      'the 3 changed files are on main at abc123'
    )
  })

  it('shows the pending chip and disables Ask while the request is in flight', () => {
    const w = mountPanel(blockWith('review'), { asking: true })
    expect(w.get('[data-testid="opinion-chip"]').attributes('data-state')).toBe('pending')
    expect(w.get('[data-testid="panel-ask"]').attributes('disabled')).toBeDefined()
    expect(has(w, 'panel-opinion-reason')).toBe(false)
  })

  it('a ready item never shows an opinion section', () => {
    const w = mountPanel(blockWith('ready', { verdict: 'harvestable', blockers: [] }), {
      opinion: opinion()
    })
    expect(has(w, 'panel-opinion')).toBe(false)
  })
})

describe('CleanupBlockPanel — Retry follows the bucket', () => {
  const failure = (): ItemFailure => ({ step: 'trash', error: 'EBUSY', refusal: null })

  it('is offered for a failed ready item and for a failed review item', () => {
    expect(has(mountPanel(blockWith('ready'), { failure: failure() }), 'panel-retry')).toBe(true)
    expect(has(mountPanel(blockWith('review'), { failure: failure() }), 'panel-retry')).toBe(true)
  })

  it('is offered for a failed orphan volume (it is a review item)', () => {
    const vol = modelOf([], [volume('pg', 'old-app', 1 * MIB)]).byId.get('volume:pg')!
    expect(has(mountPanel(vol, { failure: failure() }), 'panel-retry')).toBe(true)
  })

  it('is never offered for an in-use item: there is nothing a retry could send', () => {
    expect(has(mountPanel(blockWith('in-use'), { failure: failure() }), 'panel-retry')).toBe(false)
  })
})

describe('CleanupBlockPanel — R / D / K / A on the open panel', () => {
  const press = (key: string, init: KeyboardEventInit = {}, target: EventTarget = window): void => {
    target.dispatchEvent(
      new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init })
    )
  }
  const mounted = (block: GcBlock, props: Props = {}) => {
    const w = mount(CleanupBlockPanel, {
      props: { block, state: null, failure: null, ...props },
      global: { plugins: [i18n] },
      attachTo: document.body
    })
    return w
  }
  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('R removes, K keeps and D dehydrates a review item — the buttons that are shown and enabled', () => {
    const w = mounted(blockWith('review'))
    press('r')
    press('k')
    press('d')
    expect(w.emitted('remove')).toHaveLength(1)
    expect(w.emitted('keep')).toHaveLength(1)
    expect(w.emitted('dehydrate')).toHaveLength(1)
    w.unmount()
  })

  it('upper case works too (caps lock)', () => {
    const w = mounted(blockWith('review'))
    press('R')
    expect(w.emitted('remove')).toHaveLength(1)
    w.unmount()
  })

  it('A asks for an opinion — the button that is shown and enabled — and removes nothing', () => {
    const block = blockWith('review')
    const w = mounted(block)
    press('a')
    press('A')
    expect(w.emitted('ask')).toEqual([[block.id], [block.id]])
    expect(
      Object.keys(w.emitted()).filter((k) => ['remove', 'keep', 'dehydrate'].includes(k))
    ).toEqual([])
    w.unmount()
  })

  it('A does nothing while the opinion is already being asked, or the item is being cleaned', () => {
    const asking = mounted(blockWith('review'), { asking: true })
    press('a')
    expect(asking.emitted('ask')).toBeUndefined()
    asking.unmount()
    const busy = mounted(blockWith('review'), { state: 'busy' })
    press('a')
    expect(busy.emitted('ask')).toBeUndefined()
    busy.unmount()
  })

  it('A does nothing on a ready item, which has no Ask button', () => {
    const w = mounted(blockWith('ready', { verdict: 'harvestable', blockers: [] }))
    press('a')
    expect(w.emitted('ask')).toBeUndefined()
    w.unmount()
  })

  it('A is ignored with a modifier, in a field and under an open dialog, like the other letters', () => {
    const w = mounted(blockWith('review'))
    press('a', { ctrlKey: true })
    const input = document.createElement('input')
    document.body.appendChild(input)
    press('a', {}, input)
    const dialog = document.createElement('div')
    dialog.setAttribute('role', 'dialog')
    dialog.setAttribute('aria-modal', 'true')
    document.body.appendChild(dialog)
    press('a')
    expect(w.emitted('ask')).toBeUndefined()
    w.unmount()
  })

  it('a letter whose button is not shown does nothing (a ready item has no Remove or Keep)', () => {
    const w = mounted(blockWith('ready', { verdict: 'harvestable', blockers: [] }))
    press('r')
    press('k')
    expect(w.emitted('remove')).toBeUndefined()
    expect(w.emitted('keep')).toBeUndefined()
    w.unmount()
  })

  it('a letter whose button is disabled does nothing (the item is being cleaned)', () => {
    const w = mounted(blockWith('review'), { state: 'busy' })
    press('r')
    expect(w.emitted('remove')).toBeUndefined()
    w.unmount()
  })

  it('ignores modifier chords, typing in a field, and an open dialog', () => {
    const w = mounted(blockWith('review'))
    press('r', { ctrlKey: true })
    press('r', { metaKey: true })
    press('r', { altKey: true })
    const input = document.createElement('input')
    document.body.appendChild(input)
    press('r', {}, input)
    const dialog = document.createElement('div')
    dialog.setAttribute('role', 'dialog')
    dialog.setAttribute('aria-modal', 'true')
    document.body.appendChild(dialog)
    press('r')
    expect(w.emitted('remove')).toBeUndefined()
    w.unmount()
  })

  it('stops listening when the panel closes', () => {
    const w = mounted(blockWith('review'))
    w.unmount()
    press('r')
    expect(w.emitted('remove')).toBeUndefined()
  })
})
