// @vitest-environment jsdom
// "No dead ends" (unit B) on the assembled Cleanup screen, against a stubbed `window.api`: a selection
// Remove cannot take says why inline, each cause opens its guided dialog, the dialog asks main for the
// facts (`gc:guide`) and its confirm is ONE `gc:clean` job carrying each item's prep.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import CleanupView from '../src/renderer/src/components/CleanupView.vue'
import { i18n } from '@renderer/i18n'
import { useUiStore } from '../src/renderer/src/stores/ui'
import { defaultGcPrefs } from '../src/main/gc/gc-prefs'
import type { GcGuidance, GcSnapshot } from '../src/main/gc/gc-wire'
import { ipcFn } from './helpers/ipc-clone'
import { GIB, MIB, reviewReason, snapshotOf, wt } from './helpers/cleanup-gc-fixtures'

const guidance = (id: string, over: Partial<GcGuidance> = {}): GcGuidance => ({
  id,
  lock: null,
  sessions: null,
  stacks: [],
  unreadable: null,
  docker: null,
  ...over
})

const locked = (name: string) =>
  wt(name, 'review', GIB, {}, { reason: reviewReason('locked' as never), locked: true })
const detached = (name: string) =>
  wt(
    name,
    'review',
    GIB,
    { kind: 'detached-worktree', branch: null },
    { reason: reviewReason('unknown-fate') }
  )
const idOf = (name: string): string => `/w/repo::worktree::${name}`

function snap(bundles: ReturnType<typeof wt>[]): GcSnapshot {
  return {
    ...snapshotOf(bundles),
    prefs: { ...defaultGcPrefs(), autopilot: true, firstReportAcknowledged: true }
  }
}

interface Api {
  gcSnapshot: ReturnType<typeof vi.fn>
  gcClean: ReturnType<typeof vi.fn>
  gcGuide: ReturnType<typeof vi.fn>
  gcUnkeep: ReturnType<typeof vi.fn>
  reaperScan: ReturnType<typeof vi.fn>
}

function install(
  first: GcSnapshot,
  guides: Record<string, GcGuidance | Error> = {},
  over: Partial<Api> = {}
): Api {
  const api = {
    gcSnapshot: ipcFn(async () => first),
    gcClean: ipcFn(async () => ({ jobId: 'j1', queued: false })),
    gcGuide: ipcFn(async (id: string) => {
      const g = guides[id]
      if (g instanceof Error) throw g
      return g ?? guidance(id)
    }),
    gcUnkeep: ipcFn(async () => defaultGcPrefs()),
    reaperScan: ipcFn(async () => ({ scannedAt: Date.now(), repos: [] })),
    ...over
  }
  const full = {
    ...api,
    gcKeep: ipcFn(async () => defaultGcPrefs()),
    gcJobs: ipcFn(async () => []),
    gcRecheck: ipcFn(async (id: string) => ({ id, outcome: 'cleared' })),
    gcPrefs: ipcFn(async () => first.prefs),
    onGcProgress: () => () => {},
    onGcDone: () => () => {},
    onGcCycle: () => () => {},
    reaperSnapshot: ipcFn(async () => ({ scannedAt: Date.now(), repos: [] })),
    reaperJournal: ipcFn(async () => []),
    reaperPrefs: ipcFn(async () => ({ dehydrateIdleDays: 7 }))
  }
  ;(window as unknown as { api: unknown }).api = new Proxy(full, {
    get: (t: Record<string, unknown>, k: string) => (k in t ? t[k] : () => () => {})
  })
  return api as Api
}

let wrapper: VueWrapper | null = null
async function mountView(): Promise<VueWrapper> {
  const slot = document.createElement('span')
  slot.id = 'takeover-shell-icon'
  document.body.appendChild(slot)
  wrapper = mount(CleanupView, { global: { plugins: [i18n] }, attachTo: document.body })
  await flushPromises()
  return wrapper
}
beforeEach(() => setActivePinia(createPinia()))
afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  document.body.innerHTML = ''
})

const el = <T extends HTMLElement = HTMLElement>(id: string): T | null =>
  document.body.querySelector<T>(`[data-testid="${id}"]`)
const text = (id: string): string => el(id)?.textContent?.replace(/\s+/g, ' ').trim() ?? ''
async function click(id: string): Promise<void> {
  el(id)!.click()
  await flushPromises()
}
async function tickAll(): Promise<void> {
  for (const c of document.body.querySelectorAll<HTMLInputElement>(
    '[data-testid="review-check"]'
  )) {
    c.checked = true
    c.dispatchEvent(new Event('change', { bubbles: true }))
  }
  await flushPromises()
}
const toasts = (): string[] => useUiStore().toasts.map((t) => t.title)

describe('the selection bar says why Remove is unavailable (AC-B1, AC-B8)', () => {
  it('names the cause and the count inline, and promotes the manual way out for a detached worktree', async () => {
    install(snap([detached('d1'), detached('d2'), detached('d3')]))
    await mountView()
    await tickAll()
    expect(text('sel-why')).toBe("3 can't be removed: 3 detached (no branch)")
    expect((el('sel-remove') as HTMLButtonElement).disabled).toBe(true)
  })
})

describe('Unlock and remove (AC-B3)', () => {
  it('asks main for the facts, shows the lock reason, and sends ONE job with the unlock prep', async () => {
    const api = install(snap([locked('l1'), locked('l2')]), {
      [idOf('l1')]: guidance(idOf('l1'), { lock: { reason: 'portable disk' } }),
      [idOf('l2')]: guidance(idOf('l2'), { lock: { reason: null } })
    })
    await mountView()
    await tickAll()
    expect(text('sel-why')).toBe("2 can't be removed: 2 locked in git")
    await click('sel-guide-locked')

    expect(el('guided-dialog')).not.toBeNull()
    expect(api.gcGuide.mock.calls.map((c) => c[0]).sort()).toEqual([idOf('l1'), idOf('l2')])
    expect(text('guided-dialog')).toContain('portable disk')

    await click('guided-confirm')
    expect(api.gcClean).toHaveBeenCalledTimes(1)
    const [ids, opts] = api.gcClean.mock.calls[0]
    expect([...ids].sort()).toEqual([idOf('l1'), idOf('l2')])
    expect(opts.confirmed).toEqual(ids)
    expect(Object.keys(opts.expected).sort()).toEqual([...ids].sort())
    expect(opts.prepare).toEqual({
      [idOf('l1')]: { kind: 'unlock' },
      [idOf('l2')]: { kind: 'unlock' }
    })
    expect(el('guided-dialog')).toBeNull()
  })

  it('cannot confirm facts it could not read', async () => {
    const api = install(snap([locked('l1')]), { [idOf('l1')]: new Error('boom') })
    await mountView()
    await tickAll()
    await click('sel-guide-locked')
    expect(el('guided-load-error')).not.toBeNull()
    expect((el('guided-confirm') as HTMLButtonElement).disabled).toBe(true)
    expect(api.gcClean).not.toHaveBeenCalled()
  })

  it('shows a pending state until main accepts the job, then closes (AC-B9)', async () => {
    let accept!: (v: unknown) => void
    const api = install(
      snap([locked('l1')]),
      { [idOf('l1')]: guidance(idOf('l1'), { lock: { reason: null } }) },
      {
        gcClean: ipcFn(() => new Promise((res) => (accept = res as (v: unknown) => void))) as never
      }
    )
    await mountView()
    await tickAll()
    await click('sel-guide-locked')
    await click('guided-confirm')
    expect(el('guided-pending')).not.toBeNull()
    expect((el('guided-confirm') as HTMLButtonElement).disabled).toBe(true)
    accept({ jobId: 'j', queued: false })
    await flushPromises()
    expect(el('guided-dialog')).toBeNull()
    expect(api.gcClean).toHaveBeenCalledTimes(1)
  })

  it('a rejected job keeps the dialog and says why in a toast (AC-B9)', async () => {
    install(
      snap([locked('l1')]),
      { [idOf('l1')]: guidance(idOf('l1'), { lock: { reason: null } }) },
      { gcClean: ipcFn(async () => Promise.reject(new Error('queue is gone'))) as never }
    )
    await mountView()
    await tickAll()
    await click('sel-guide-locked')
    await click('guided-confirm')
    expect(el('guided-dialog')).not.toBeNull()
    expect(el('guided-pending')).toBeNull()
    expect(toasts().length).toBeGreaterThan(0)
  })
})

describe('unlock sends only the rows that are still locked (delta 1)', () => {
  it('a row git no longer lists as locked is left out of the request, and the dialog says so', async () => {
    const api = install(snap([locked('l1'), locked('l2')]), {
      [idOf('l1')]: guidance(idOf('l1'), { lock: { reason: 'usb' } }),
      [idOf('l2')]: guidance(idOf('l2'), { lock: null })
    })
    await mountView()
    await tickAll()
    await click('sel-guide-locked')
    expect(text('guided-dialog')).toContain('no longer locked')
    await click('guided-confirm')
    const [ids, opts] = api.gcClean.mock.calls[0]
    expect(ids).toEqual([idOf('l1')])
    expect(Object.keys(opts.expected)).toEqual([idOf('l1')])
    expect(Object.keys(opts.prepare)).toEqual([idOf('l1')])
  })
})

describe('Dehydrate does what its label counts (delta 1)', () => {
  const withDeps = (name: string, branch: string, over: Record<string, unknown> = {}) =>
    wt(
      name,
      'review',
      GIB,
      {
        branch,
        hydration: {
          state: 'hydrated',
          removable: ['node_modules'],
          skipped: [],
          reclaimableBytes: 100 * MIB,
          canRehydrate: true,
          rehydrateChanged: []
        } as never
      },
      { depsBytes: 100 * MIB, ...over }
    )

  it('the button counts the refused items’ deps and dehydrates exactly those, not the removable one', async () => {
    const lockedItem = withDeps('l1', 'feat/refused-one', {
      reason: reviewReason('locked' as never),
      locked: true
    })
    const removable = withDeps('p1', 'feat/removable-one', { reason: reviewReason('dirty') })
    install(snap([lockedItem, removable]))
    await mountView()
    await tickAll()
    expect(text('sel-dehydrate')).toContain('105 MB')
    await click('sel-dehydrate')
    const dialog = text('dehydrate-confirm')
    expect(dialog).toContain('refused-one')
    expect(dialog).not.toContain('removable-one')
  })
})

describe('Close session and remove (AC-B4)', () => {
  it('sends the close-session prep for an idle session and never for a working one', async () => {
    const idle = wt(
      's1',
      'review',
      GIB,
      {},
      {
        reason: reviewReason('open-idle-session'),
        session: 'open-idle'
      }
    )
    const busy = wt(
      's2',
      'review',
      GIB,
      {},
      {
        reason: reviewReason('open-idle-session'),
        session: 'open-idle'
      }
    )
    const api = install(snap([idle, busy]), {
      [idOf('s1')]: guidance(idOf('s1'), { sessions: { idle: 1, busy: 0, userOpened: 0 } }),
      [idOf('s2')]: guidance(idOf('s2'), { sessions: { idle: 1, busy: 1, userOpened: 0 } })
    })
    await mountView()
    await tickAll()
    await click('sel-guide-session-open')
    // One item has a working session: the whole action waits until that is not so.
    expect((el('guided-confirm') as HTMLButtonElement).disabled).toBe(true)
    expect(text('guided-dialog')).toContain('working or waiting')
    await click('guided-confirm')
    expect(api.gcClean).not.toHaveBeenCalled()
  })
})

describe('a shared Docker stack (AC-B5)', () => {
  const shared = wt(
    'x1',
    'review',
    GIB,
    {},
    {
      reason: reviewReason('shared-stack'),
      sharedStackIds: ['web']
    }
  )
  const g = (binds: boolean) =>
    guidance(idOf('x1'), {
      stacks: [
        {
          id: 'web',
          name: 'web',
          otherFolders: ['/ws/org/proj/www'],
          bindsThisFolder: binds,
          containers: 2
        }
      ]
    })

  it('stop: sends the stop-stack prep naming that stack', async () => {
    const api = install(snap([shared]), { [idOf('x1')]: g(false) })
    await mountView()
    await tickAll()
    await click('sel-guide-shared-stack')
    expect(text('guided-dialog')).toContain('/ws/org/proj/www')
    await click('guided-confirm')
    expect(api.gcClean.mock.calls[0][1].prepare).toEqual({
      [idOf('x1')]: { kind: 'stop-stack', stackIds: ['web'] }
    })
  })

  it('leave: sends the leave-stack prep when the stack does not use the folder', async () => {
    const api = install(snap([shared]), { [idOf('x1')]: g(false) })
    await mountView()
    await tickAll()
    await click('sel-guide-shared-stack')
    ;(
      document.body.querySelector('[data-testid="guided-choice-leave"] input') as HTMLInputElement
    ).click()
    await flushPromises()
    await click('guided-confirm')
    expect(api.gcClean.mock.calls[0][1].prepare).toEqual({
      [idOf('x1')]: { kind: 'leave-stack', stackIds: ['web'] }
    })
  })

  it('leaving is not offered when the stack uses the folder', async () => {
    install(snap([shared]), { [idOf('x1')]: g(true) })
    await mountView()
    await tickAll()
    await click('sel-guide-shared-stack')
    expect(el('guided-choice-leave')).toBeNull()
  })
})

describe('an unreadable folder (AC-B6)', () => {
  const unreadable = wt(
    'u1',
    'review',
    GIB,
    {},
    {
      reason: reviewReason('check-failed'),
      nestedWorktrees: undefined as never
    }
  )
  const bad = guidance(idOf('u1'), {
    unreadable: {
      path: '/w/repo/.claude/worktrees/u1/private',
      owner: 'root',
      fixCommand: 'sudo chown -R $USER /w/repo/.claude/worktrees/u1/private'
    }
  })

  it('shows the exact path and the fix, and Check again rescans and reads the facts again', async () => {
    const api = install(snap([unreadable]), { [idOf('u1')]: bad })
    await mountView()
    await tickAll()
    await click('sel-guide-check-failed')
    expect(text('guided-unreadable')).toContain('/w/repo/.claude/worktrees/u1/private')
    expect(text('guided-fix')).toContain('sudo chown -R $USER')
    const before = api.gcGuide.mock.calls.length
    await click('guided-recheck')
    expect(api.reaperScan).toHaveBeenCalled()
    expect(api.gcGuide.mock.calls.length).toBeGreaterThan(before)
    expect(api.gcClean).not.toHaveBeenCalled()
  })
})

describe('Docker was not running at scan time (AC-B7)', () => {
  it('offers Scan again, which rescans and says it did', async () => {
    const blind = wt('b1', 'review', GIB, {}, { reason: reviewReason('dirty'), dockerBlind: true })
    const api = install(snap([blind]), {
      [idOf('b1')]: guidance(idOf('b1'), { docker: { hint: 'open -a Docker' } })
    })
    await mountView()
    await tickAll()
    await click('sel-guide-scan-blind')
    expect(text('guided-docker-hint')).toBe('open -a Docker')
    await click('guided-scan')
    expect(api.reaperScan).toHaveBeenCalled()
    expect(el('guided-dialog')).toBeNull()
    expect(toasts().length).toBeGreaterThan(0)
  })
})

describe('stacked causes: one combined action (delta 2)', () => {
  const stackG = (id: string, over: Partial<GcGuidance> = {}) =>
    guidance(id, {
      lock: { reason: 'usb' },
      stacks: [
        {
          id: 'web',
          name: 'web',
          otherFolders: ['/ws/org/proj/other'],
          bindsThisFolder: false,
          containers: 2,
          containerNames: ['ctr-web-1', 'ctr-web-2'],
          stopBlocked: null
        }
      ],
      ...over
    })
  const both = () =>
    wt(
      'x1',
      'review',
      GIB,
      {},
      {
        reason: reviewReason('shared-stack'),
        sharedStackIds: ['web'],
        locked: true
      }
    )

  it('the bar names both causes and offers ONE action', async () => {
    install(snap([both()]), { [idOf('x1')]: stackG(idOf('x1')) })
    await mountView()
    await tickAll()
    expect(text('sel-why')).toBe("1 can't be removed: 1 locked in git + shared Docker stack")
    expect(el('sel-guide-combined')).not.toBeNull()
  })

  it('shared stack + lock: one job carrying BOTH preps', async () => {
    const api = install(snap([both()]), { [idOf('x1')]: stackG(idOf('x1')) })
    await mountView()
    await tickAll()
    await click('sel-guide-combined')
    expect(text('guided-steps')).toContain('Unlock')
    await click('guided-confirm')
    expect(api.gcClean).toHaveBeenCalledTimes(1)
    const [ids, opts] = api.gcClean.mock.calls[0]
    expect(ids).toEqual([idOf('x1')])
    const preps = [opts.prepare[idOf('x1')]].flat()
    expect(preps).toEqual(
      expect.arrayContaining([{ kind: 'unlock' }, { kind: 'stop-stack', stackIds: ['web'] }])
    )
    expect(preps).toHaveLength(2)
  })

  it('session + lock: unlock and close the session in one job', async () => {
    const b = wt(
      'x2',
      'review',
      GIB,
      {},
      {
        reason: reviewReason('open-idle-session'),
        session: 'open-idle',
        locked: true
      }
    )
    const api = install(snap([b]), {
      [idOf('x2')]: guidance(idOf('x2'), {
        lock: { reason: null },
        sessions: { idle: 1, busy: 0, userOpened: 0 }
      })
    })
    await mountView()
    await tickAll()
    expect(text('sel-why')).toContain('locked in git + session open')
    await click('sel-guide-combined')
    await click('guided-confirm')
    const preps = [api.gcClean.mock.calls[0][1].prepare[idOf('x2')]].flat()
    expect(preps).toEqual(expect.arrayContaining([{ kind: 'unlock' }, { kind: 'close-session' }]))
  })

  it('a cause no prep can fix is the one shown, not a combined action', async () => {
    const b = wt(
      'x3',
      'review',
      GIB,
      {},
      {
        reason: reviewReason('shared-stack'),
        sharedStackIds: ['web'],
        locked: true,
        keep: true
      }
    )
    install(snap([b]), {})
    await mountView()
    await tickAll()
    expect(el('sel-guide-combined')).toBeNull()
    expect(text('sel-why')).toContain('marked Keep')
  })

  it('the panel offers the same combined action', async () => {
    const api = install(snap([both()]), { [idOf('x1')]: stackG(idOf('x1')) })
    await mountView()
    ;(
      document.body.querySelector(
        '[data-testid="treemap-block"][data-bucket="review"]'
      ) as HTMLElement
    ).click()
    await flushPromises()
    expect(text('panel-guide')).toBe('Unlock, stop stack and remove…')
    await click('panel-guide')
    await click('guided-confirm')
    expect(api.gcClean).toHaveBeenCalledTimes(1)
  })
})

describe('removing a Keep mark and scanning again are never silent (delta 2)', () => {
  const keptSnap = () => {
    const k1 = wt('k1', 'review', GIB, {}, { reason: reviewReason('dirty') })
    const k2 = wt('k2', 'review', GIB, {}, { reason: reviewReason('dirty') })
    const s = snap([k1, k2])
    s.prefs = { ...s.prefs, keep: { [idOf('k1')]: 'open', [idOf('k2')]: 'open' } } as never
    return s
  }

  it('the Keep mark comes off, and an Undo toast puts it back', async () => {
    const api = install(keptSnap(), {}, {})
    ;(window as unknown as { api: Record<string, unknown> }).api.gcKeep = ipcFn(async () =>
      defaultGcPrefs()
    )
    await mountView()
    await tickAll()
    await click('sel-guide-kept')
    expect(api.gcUnkeep.mock.calls.map((c) => c[0]).sort()).toEqual([idOf('k1'), idOf('k2')])
    const undo = useUiStore().toasts.find((t) => t.action)
    expect(undo?.action?.label).toBe('Undo')
    undo!.action!.handler()
    await flushPromises()
    const keep = (window as unknown as { api: { gcKeep: { mock: { calls: unknown[][] } } } }).api
      .gcKeep
    expect(keep.mock.calls.map((c) => c[0]).sort()).toEqual([idOf('k1'), idOf('k2')])
  })

  it('the group is disabled while the unmark runs, so a second click cannot repeat it', async () => {
    let release!: () => void
    const gate = new Promise<void>((res) => (release = res))
    const api = install(
      keptSnap(),
      {},
      {
        gcUnkeep: ipcFn(async () => (await gate, defaultGcPrefs())) as never
      }
    )
    await mountView()
    await tickAll()
    await click('sel-guide-kept')
    expect((el('sel-guide-kept') as HTMLButtonElement).disabled).toBe(true)
    await click('sel-guide-kept')
    // The first mark is still being taken off; the second click started nothing.
    expect(api.gcUnkeep).toHaveBeenCalledTimes(1)
    release()
    await flushPromises()
    expect(api.gcUnkeep).toHaveBeenCalledTimes(2) // one each for k1 and k2, no repeats
    // Done: the group is usable again.
    expect((el('sel-guide-kept') as HTMLButtonElement).disabled).toBe(false)
  })

  it('Scan again is disabled while it runs', async () => {
    let release!: () => void
    const gate = new Promise<void>((res) => (release = res))
    const blind = wt('b1', 'review', GIB, {}, { reason: reviewReason('dirty'), dockerBlind: true })
    const api = install(
      snap([blind]),
      {
        [idOf('b1')]: guidance(idOf('b1'), { docker: { hint: null } })
      },
      {
        reaperScan: ipcFn(async () => (await gate, { scannedAt: Date.now(), repos: [] })) as never
      }
    )
    await mountView()
    await tickAll()
    await click('sel-guide-scan-blind')
    await click('guided-scan')
    expect((el('guided-scan') as HTMLButtonElement).disabled).toBe(true)
    release()
    await flushPromises()
    expect(api.reaperScan).toHaveBeenCalledTimes(1)
  })
})

describe('the panel opens the same guided actions', () => {
  it('Unlock and remove from the panel of one locked worktree', async () => {
    const api = install(snap([locked('l1')]), {
      [idOf('l1')]: guidance(idOf('l1'), { lock: { reason: 'x' } })
    })
    await mountView()
    ;(
      document.body.querySelector(
        '[data-testid="treemap-block"][data-bucket="review"]'
      ) as HTMLElement
    ).click()
    await flushPromises()
    await click('panel-guide')
    expect(el('guided-dialog')).not.toBeNull()
    await click('guided-confirm')
    expect(api.gcClean.mock.calls[0][0]).toEqual([idOf('l1')])
  })

  it('a Keep mark: one click removes it, and a toast says so (AC-B9)', async () => {
    const kept = wt('k1', 'review', GIB, {}, { reason: reviewReason('dirty') })
    const s = snap([kept])
    s.prefs = { ...s.prefs, keep: { [idOf('k1')]: 'open' } } as never
    const api = install(s)
    await mountView()
    ;(
      document.body.querySelector(
        '[data-testid="treemap-block"][data-bucket="review"]'
      ) as HTMLElement
    ).click()
    await flushPromises()
    await click('panel-guide')
    expect(api.gcUnkeep).toHaveBeenCalledWith(idOf('k1'))
    expect(toasts().length).toBeGreaterThan(0)
  })
})

void MIB
