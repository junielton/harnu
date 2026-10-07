// @vitest-environment jsdom
/**
 * T389 P4W1 — Settings → Mods, mounted over a stubbed preload. The pane is a read-only
 * disclosure: rows and neutral "can …" chips, the policy banner, the blind spots stated
 * in place — and never a switch for anyone's mod.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import ModsAuditPane from '../src/renderer/src/components/ModsAuditPane.vue'
import { useSessionsStore } from '../src/renderer/src/stores/sessions'
import { i18n } from '@renderer/i18n'
import type { ModAnalysis, ModRow, ModsAuditView } from '../src/preload'

function analysis(over: Partial<ModAnalysis> = {}): ModAnalysis {
  return {
    status: 'ok',
    hasModule: true,
    hash: 'abcdef0123456789'.repeat(4),
    hashKind: 'content',
    analysedAt: 1_760_000_000_000,
    cliVersion: '2.1.289',
    hooks: [{ file: './register.ts', event: 'tool.call', matcher: 'tool=Bash', opaque: false }],
    calls: [{ file: './register.ts', op: 'ui.status', via: 'helper, other' }],
    env: { reads: ['HOME'], writes: [] },
    state: { reads: [], writes: [], foreignUnchecked: [] },
    unparsed: ['./register.ts calls: next.to:append'],
    errors: [],
    warnings: [],
    capabilities: ['tool-calls', 'env'],
    ...over
  }
}

function row(name: string, over: Partial<ModRow> = {}): ModRow {
  return {
    key: `skills-dir\u0000${name}\u0000/mods/${name}`,
    name,
    source: 'skills-dir',
    root: `/mods/${name}`,
    enabled: null,
    loadsInFolder: 'unknown',
    analysis: analysis(),
    ...over
  }
}

function view(rows: ModRow[], over: Partial<ModsAuditView> = {}): ModsAuditView {
  return {
    cli: { path: '/bin/claude', version: '2.1.289' },
    policy: 'unknown',
    rows,
    withoutModule: 0,
    installedUnreadable: false,
    safeMode: false,
    listedAt: 1,
    ...over
  }
}

let rowListener: ((r: ModRow) => void) | null
let list: ReturnType<typeof vi.fn>
let analyse: ReturnType<typeof vi.fn>
let reveal: ReturnType<typeof vi.fn>

async function mountPane(v: ModsAuditView, selectFolder = false): Promise<VueWrapper> {
  setActivePinia(createPinia())
  if (selectFolder) {
    const s = useSessionsStore()
    s.folders = [
      {
        path: '/work/proj',
        alias: 'proj',
        sessions: [{ sessionId: 's1' }]
      }
    ] as never
    s.selectedId = 's1'
  }
  rowListener = null
  list = vi.fn(async () => v)
  // Electron structured-clones what crosses IPC: a reactive Proxy would throw here
  analyse = vi.fn(async (req: unknown) => {
    structuredClone(req)
    return { queued: 1 }
  })
  reveal = vi.fn(async () => '')
  ;(window as unknown as { api: unknown }).api = {
    modsAuditList: list,
    modsAuditAnalyse: analyse,
    onModsAuditRow: (cb: (r: ModRow) => void) => {
      rowListener = cb
      return () => {
        rowListener = null
      }
    },
    showItemInFolder: reveal
  }
  const w = mount(ModsAuditPane, { global: { plugins: [i18n] }, attachTo: document.body })
  await flushPromises()
  return w
}

beforeEach(() => {
  document.body.innerHTML = ''
})

const rowsOf = (w: VueWrapper): ReturnType<VueWrapper['findAll']> =>
  w.findAll('[data-testid="mods-row"]')

describe('ModsAuditPane', () => {
  it('lists rows with neutral chips, the Default badge only', async () => {
    const w = await mountPane(
      view([row('alpha'), row('beta', { analysis: analysis({ capabilities: ['process'] }) })])
    )
    expect(rowsOf(w).map((r) => r.find('span.font-mono').text())).toEqual(['alpha', 'beta'])
    const chips = w.findAll('[data-cap]')
    expect(chips.map((c) => c.text())).toEqual([
      'can rewrite or block tool calls',
      'can read environment variables',
      'can run processes'
    ])
    // Default badge: surface bg, text-3, border — never accent, warning or danger
    for (const chip of chips) {
      expect(chip.classes()).toEqual(
        expect.arrayContaining(['bg-surface', 'text-text-3', 'border-border'])
      )
      expect(chip.classes().join(' ')).not.toMatch(/accent|warning|red|green/)
    }
    expect(w.text()).toContain('Mods run unsandboxed')
    expect(w.text()).toContain('Not shown: where data goes')
    expect(w.text()).toContain('allowManagedModsOnly')
  })

  it('shows the Harnu mod as row 1 with its own label, and no row without it', async () => {
    const companion = row('harnu-companion', {
      key: 'harnu\u0000harnu-companion\u0000/stage/c',
      source: 'harnu',
      root: '/stage/c',
      version: '0.1.0',
      enabled: true,
      loadsInFolder: 'yes'
    })
    const w = await mountPane(view([companion, row('alpha')]))
    const first = rowsOf(w)[0]!
    expect(first.attributes('data-source')).toBe('harnu')
    expect(first.find('[data-testid="mods-source"]').text()).toBe('Harnu mod · 0.1.0')
    expect(first.text()).toContain('harnu-companion')

    // LV-P4W1-b: absent companion, absent row, no placeholder
    const w2 = await mountPane(view([row('alpha')]))
    expect(w2.findAll('[data-source="harnu"]')).toHaveLength(0)
    expect(w2.text()).not.toContain('harnu-companion')
  })

  it('has no switch, checkbox or install control for anyone’s mod', async () => {
    const w = await mountPane(view([row('alpha')]))
    expect(w.findAll('[role="switch"]')).toHaveLength(0)
    expect(w.findAll('input')).toHaveLength(0)
    const buttons = w.findAll('button').map((b) => b.text() + (b.attributes('aria-label') ?? ''))
    expect(buttons.join('|')).not.toMatch(/enable|disable|install|uninstall|allow|block/i)
  })

  it('never words a mod as a verdict', async () => {
    const w = await mountPane(
      view([row('alpha', { loadsInFolder: 'unknown' })], {
        policy: 'off-here',
        installedUnreadable: true
      })
    )
    await w.get('button[aria-expanded]').trigger('click')
    expect(w.text()).not.toMatch(/\b(safe|verified|trusted|secure|malicious|approved)\b/i)
  })

  it('states the unknown load approval of a skills-folder mod', async () => {
    const w = await mountPane(view([row('alpha')]))
    expect(w.text()).toContain('Harnu cannot tell whether this one is allowed to load.')
  })

  it('shows the CLI-not-found state with no rows', async () => {
    const w = await mountPane(view([], { cli: { path: null, version: null } }))
    expect(w.get('[data-testid="mods-no-cli"]').text()).toContain('Claude Code CLI not found')
    expect(rowsOf(w)).toHaveLength(0)
    expect(analyse).not.toHaveBeenCalled()
    expect((w.get('button').element as HTMLButtonElement).disabled).toBe(true)
  })

  it('shows the policy banner and still lists the rows', async () => {
    const w = await mountPane(view([row('alpha')], { policy: 'off-here' }))
    expect(w.get('[data-testid="mods-policy-banner"]').text()).toBe(
      'Turned off by a setting or by your organization’s policy.'
    )
    expect(rowsOf(w)).toHaveLength(1)
    const w2 = await mountPane(view([row('alpha')], { policy: 'off-remote' }))
    expect(w2.get('[data-testid="mods-policy-banner"]').text()).toContain('turned off remotely')
    // the probe could not tell: no banner
    const w3 = await mountPane(view([row('alpha')], { policy: 'unknown' }))
    expect(w3.find('[data-testid="mods-policy-banner"]').exists()).toBe(false)
    const w4 = await mountPane(view([row('alpha')], { policy: 'loads' }))
    expect(w4.find('[data-testid="mods-policy-banner"]').exists()).toBe(false)
  })

  it('hints when the folder starts sessions with --safe-mode', async () => {
    const w = await mountPane(view([row('alpha')], { safeMode: true }), true)
    expect(w.text()).toContain('--safe-mode')
    expect(w.text()).toContain('no mod loads there')
  })

  it('queues unanalysed rows and fills them in as events arrive', async () => {
    const pending = row('alpha', { analysis: null })
    const w = await mountPane(view([pending]))
    expect(analyse).toHaveBeenCalledWith({ folder: null, force: false })
    expect(w.text()).toContain('Analysing…')
    expect(w.findAll('[data-cap]')).toHaveLength(0)

    rowListener!({ ...pending, analysis: analysis({ capabilities: ['network'] }) })
    await flushPromises()
    expect(w.text()).not.toContain('Analysing…')
    expect(w.findAll('[data-cap]').map((c) => c.text())).toEqual(['can use the network'])
  })

  it('moves a plugin without a mod out of the list into the count line', async () => {
    const pending = row('alpha', { analysis: null })
    const w = await mountPane(view([pending, row('beta')], { withoutModule: 2 }))
    expect(w.get('[data-testid="mods-without-module"]').text()).toBe(
      '2 plugins without a mod are not listed.'
    )
    rowListener!({ ...pending, analysis: analysis({ hasModule: false, capabilities: [] }) })
    await flushPromises()
    expect(rowsOf(w).map((r) => r.find('span.font-mono').text())).toEqual(['beta'])
    expect(w.get('[data-testid="mods-without-module"]').text()).toBe(
      '3 plugins without a mod are not listed.'
    )
    // singular
    const w2 = await mountPane(view([row('beta')], { withoutModule: 1 }))
    expect(w2.get('[data-testid="mods-without-module"]').text()).toBe(
      '1 plugin without a mod is not listed.'
    )
  })

  it('one failed row keeps the others’ chips, and Retry re-runs it by key', async () => {
    const bad = row('bad', {
      analysis: analysis({ status: 'failed', capabilities: [], hooks: [], calls: [] })
    })
    const w = await mountPane(view([bad, row('good')]))
    const rows = rowsOf(w)
    expect(rows[0]!.text()).toContain('Could not analyse this mod.')
    expect(rows[1]!.findAll('[data-cap]').length).toBeGreaterThan(0)
    const retry = rows[0]!.findAll('button').find((b) => b.text() === 'Retry')!
    await retry.trigger('click')
    expect(analyse).toHaveBeenLastCalledWith({ folder: null, keys: [bad.key], force: true })
    expect(rows[0]!.text()).toContain('Analysing…')
  })

  it('refresh forces a re-read of every row', async () => {
    const w = await mountPane(view([row('alpha'), row('beta')]))
    expect(analyse).not.toHaveBeenCalled() // everything was cached
    await w
      .findAll('button')
      .find((b) => b.text() === 'Refresh')!
      .trigger('click')
    await flushPromises()
    expect(list).toHaveBeenCalledTimes(2)
    expect(analyse).toHaveBeenCalledWith({ folder: null, force: true })
  })

  it('expands to the declared facts, the path and the owner of the mod', async () => {
    const w = await mountPane(
      view([
        row('alpha', {
          source: 'installed',
          id: 'alpha@mk',
          scope: 'user',
          version: '1.2.3',
          changed: undefined
        } as never)
      ])
    )
    const r = rowsOf(w)[0]!
    expect(r.find('[data-testid="mods-source"]').text()).toBe('installed · user · 1.2.3')
    expect(r.find('[data-testid="mods-details"]').exists()).toBe(false)
    await r.get('button[aria-expanded]').trigger('click')
    const d = r.get('[data-testid="mods-details"]').text()
    expect(d).toContain('tool.call{tool=Bash}')
    expect(d).toContain('ui.status')
    expect(d).toContain('via helper, other')
    expect(d).toContain('HOME')
    expect(d).toContain('./register.ts calls: next.to:append') // unparsed, verbatim
    expect(d).toContain('/mods/alpha')
    expect(d).toContain('abcdef01 · Last analysed')
    expect(d).toContain('/plugin')
    expect(d).toContain('claude plugin disable alpha@mk')
    await r
      .findAll('button')
      .find((b) => b.text() === 'Reveal folder')!
      .trigger('click')
    expect(reveal).toHaveBeenCalledWith('/mods/alpha')
  })

  it('says when a mod changed since the previous read', async () => {
    const w = await mountPane(
      view([row('alpha', { analysis: analysis({ changedSince: 1_759_000_000_000 }) })])
    )
    expect(w.text()).toMatch(/Changed since .+\./)
  })

  it('scopes to the selected session’s folder and lists it by key', async () => {
    const w = await mountPane(view([row('alpha')]), true)
    expect(list).toHaveBeenLastCalledWith(null)
    const pill = w.findAll('[role="radio"]').find((b) => b.text() === 'proj')!
    await pill.trigger('click')
    await flushPromises()
    expect(list).toHaveBeenLastCalledWith('/work/proj')

    // nothing selected: the folder pill is disabled and says why
    const w2 = await mountPane(view([row('alpha')]))
    expect(w2.text()).toContain('Select a session to list the mods its project can load.')
    const disabled = w2.findAll('[role="radio"]').find((b) => b.text() === 'This project')!
    expect(
      disabled.attributes('disabled') !== undefined ||
        disabled.attributes('aria-disabled') === 'true'
    ).toBe(true)
  })

  it('drops events for rows it is not showing', async () => {
    const w = await mountPane(view([row('alpha')]))
    rowListener!(row('stranger'))
    await flushPromises()
    expect(rowsOf(w)).toHaveLength(1)
  })

  it('unsubscribes when it unmounts', async () => {
    const w = await mountPane(view([row('alpha')]))
    expect(rowListener).not.toBeNull()
    w.unmount()
    expect(rowListener).toBeNull()
  })

  it('keeps the settings region for the Harnu mod switches, empty and invisible', async () => {
    const w = await mountPane(view([row('alpha')]))
    const region = w.get('#mods-companion')
    expect(region.element.childElementCount).toBe(0)
    expect(region.classes()).toContain('empty:hidden')
  })
})
