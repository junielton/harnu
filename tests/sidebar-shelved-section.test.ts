// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import { setActivePinia, createPinia } from 'pinia'
import { i18n } from '@renderer/i18n'
import SidebarShelvedSection from '../src/renderer/src/components/SidebarShelvedSection.vue'
import { useSessionsStore } from '../src/renderer/src/stores/sessions'
import { useUiStore } from '../src/renderer/src/stores/ui'
import type { Folder, Session } from '../src/renderer/src/stores/sessions'
import type { FolderGroup, ShelvedMember } from '../src/renderer/src/stores/folder-zones'

// U2.3b — the Shelved section of a repo group (design.md §6). Neutral vocabulary only.

const REPO = '/home/u/org/api-gateway'
const session = (id: string, summary: string): Session =>
  ({
    sessionId: id,
    summary,
    firstPrompt: '',
    created: '2026-01-01T00:00:00.000Z',
    modified: '2026-01-01T00:00:00.000Z',
    status: 'idle',
    isSidechain: false,
    resumable: true,
    bridged: false,
    synthetic: false,
    isShellTerminal: false
  }) as Session

const member = (
  id: string,
  label: string,
  days: number,
  sessions: Session[]
): ShelvedMember<Session> => ({
  id,
  label,
  branch: label,
  worktreePath: `${REPO}/.claude/worktrees/${label}`,
  repoPath: REPO,
  days,
  sessions
})

const group = (shelved: ShelvedMember<Session>[]): FolderGroup<Folder> =>
  ({
    kind: 'folder-group',
    source: 'repo',
    id: `${REPO}/.git`,
    key: `repo:${REPO}/.git`,
    label: 'api-gateway',
    derivedLabel: 'api-gateway',
    expanded: true,
    folders: [],
    shelved
  }) as unknown as FolderGroup<Folder>

let wrapper: VueWrapper | null = null
const MEMBERS = (): ShelvedMember<Session>[] => [
  member('a', 'PROJ-231-auth-refresh', 9, [
    session('a1', 'Refresh-token rotation'),
    session('a2', 'Fix the flaky auth test')
  ]),
  member('b', 'PROJ-347-wave-1', 14, [session('b1', 'Wave 1 — extract config')])
]

function mountSection(members = MEMBERS()): {
  w: VueWrapper
  store: ReturnType<typeof useSessionsStore>
} {
  const store = useSessionsStore()
  wrapper = mount(SidebarShelvedSection, {
    props: { group: group(members) },
    global: { plugins: [i18n] },
    attachTo: document.body
  })
  return { w: wrapper, store }
}

describe('SidebarShelvedSection', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    localStorage.clear()
  })
  afterEach(() => {
    wrapper?.unmount()
    wrapper = null
    document.body.innerHTML = ''
  })

  it('AC-2: collapsed by default — one "Shelved · N" disclosure row, no worktree rows', () => {
    const { w } = mountSection()
    const disclosure = w.find('[data-sidebar-row^="shelved:"]')
    expect(disclosure.exists()).toBe(true)
    expect(disclosure.text()).toBe('Shelved·2')
    expect(disclosure.attributes('aria-expanded')).toBe('false')
    expect(w.findAll('[data-shelved-id]')).toHaveLength(0)
  })

  it('AC-2: opens on click and lists compact dimmed rows with the archive glyph and the days', async () => {
    const { w } = mountSection()
    await w.find('[data-sidebar-row^="shelved:"]').trigger('click')
    expect(w.find('[data-sidebar-row^="shelved:"]').attributes('aria-expanded')).toBe('true')
    const rows = w.findAll('[data-shelved-id]')
    expect(rows).toHaveLength(2)
    const first = rows[0].find('[role="button"]')
    // Variant B: the branch is the label, the meta is "{days} d", content dimmed to 0.62.
    expect(first.text()).toContain('PROJ-231-auth-refresh')
    expect(first.text()).toContain('9 d')
    expect(first.find('svg.lucide-archive').exists()).toBe(true)
    const dimmed = first.find('span.flex.min-w-0')
    expect(dimmed.attributes('style')).toContain('opacity: 0.62')
    // Compact single line (24 px Comfortable), at the folder indent.
    expect(first.attributes('style')).toContain('height: 24px')
    expect(first.attributes('style')).toContain('padding: 0px 12px 0px 28px')
  })

  it('the row height and the indent follow the sidebar density', async () => {
    const { w, store } = mountSection()
    store.sidebarDensity = 'compact'
    await w.find('[data-sidebar-row^="shelved:"]').trigger('click')
    const row = w.find('[data-shelved-id] [role="button"]')
    expect(row.attributes('style')).toContain('height: 22px')
    store.sidebarDensity = 'comfortable'
    await w.vm.$nextTick()
    expect(w.find('[data-shelved-id] [role="button"]').attributes('style')).toContain(
      'height: 24px'
    )
  })

  it('AC-2: clicking a worktree row looks, it never restores', async () => {
    const { w, store } = mountSection()
    const restore = vi.spyOn(store, 'restoreShelvedWorktree').mockResolvedValue(true)
    await w.find('[data-sidebar-row^="shelved:"]').trigger('click')
    await w.find('[data-shelved-id="a"] [role="button"]').trigger('click')
    expect(w.findAll('[data-session-id]').map((r) => r.attributes('data-session-id'))).toEqual([
      'a1',
      'a2'
    ])
    expect(restore).not.toHaveBeenCalled()
  })

  it('AC-3: clicking a session restores that worktree and resumes that session', async () => {
    const { w, store } = mountSection()
    const restore = vi.spyOn(store, 'restoreShelvedWorktree').mockResolvedValue(true)
    await w.find('[data-sidebar-row^="shelved:"]').trigger('click')
    await w.find('[data-shelved-id="a"] [role="button"]').trigger('click')
    await w.find('[data-session-id="a2"]').trigger('click')
    expect(restore).toHaveBeenCalledTimes(1)
    expect(restore.mock.calls[0][0].id).toBe('a')
    expect(restore.mock.calls[0][1]).toBe('a2')
    // The session row explains itself.
    expect(w.find('[data-session-id="a2"]').attributes('title')).toBe(
      'Resume — restores the worktree first'
    )
  })

  it('AC-3: the hover action restores the worktree without resuming anything', async () => {
    const { w, store } = mountSection()
    const restore = vi.spyOn(store, 'restoreShelvedWorktree').mockResolvedValue(true)
    await w.find('[data-sidebar-row^="shelved:"]').trigger('click')
    await w.find('[data-shelved-id="b"] [aria-label="Restore worktree"]').trigger('click')
    expect(restore.mock.calls[0][0].id).toBe('b')
    expect(restore.mock.calls[0][1]).toBeNull()
    // The click did not also toggle the row.
    expect(w.findAll('[data-session-id]')).toHaveLength(0)
  })

  it('AC-3: while restoring the row un-dims, reads "restoring…" and the clicked session is selected', async () => {
    const { w, store } = mountSection()
    await w.find('[data-sidebar-row^="shelved:"]').trigger('click')
    await w.find('[data-shelved-id="a"] [role="button"]').trigger('click')
    store.shelvedRestoring = new Map([['a', 'a1']])
    await w.vm.$nextTick()
    const row = w.find('[data-shelved-id="a"] [role="button"]')
    expect(row.attributes('data-restoring')).toBe('true')
    expect(row.text()).toContain('restoring…')
    expect(row.text()).not.toContain('9 d')
    expect(row.find('span.flex.min-w-0').attributes('style')).toContain('opacity: 1')
    expect(row.find('svg.lucide-archive-restore').classes()).toContain('anim-shimmer-dot')
    const clicked = w.find('[data-session-id="a1"]')
    expect(clicked.attributes('data-selected')).toBe('true')
    // The other session is not selected, and a second click on it is ignored while restoring.
    expect(w.find('[data-session-id="a2"]').attributes('data-selected')).toBeUndefined()
    const restore = vi.spyOn(store, 'restoreShelvedWorktree').mockResolvedValue(true)
    await w.find('[data-session-id="a2"]').trigger('click')
    expect(restore).not.toHaveBeenCalled()
  })

  it('AC-3: the context menu has exactly Restore worktree and Open in Cleanup', async () => {
    const { w, store } = mountSection()
    const restore = vi.spyOn(store, 'restoreShelvedWorktree').mockResolvedValue(true)
    const openCleanup = vi.spyOn(useUiStore(), 'openCleanup')
    await w.find('[data-sidebar-row^="shelved:"]').trigger('click')
    await w.find('[data-shelved-id="a"] [role="button"]').trigger('contextmenu')
    const items = Array.from(document.body.querySelectorAll('[role="menuitem"]'))
    expect(items.map((i) => i.textContent?.trim())).toEqual(['Restore worktree', 'Open in Cleanup'])

    ;(items[1] as HTMLElement).click()
    await w.vm.$nextTick()
    expect(openCleanup).toHaveBeenCalledWith(REPO)
    expect(document.body.querySelector('[role="menu"]')).toBeNull()

    await w.find('[data-shelved-id="b"] [role="button"]').trigger('contextmenu')
    ;(document.body.querySelectorAll('[role="menuitem"]')[0] as HTMLElement).click()
    expect(restore.mock.calls[0][0].id).toBe('b')
    expect(restore.mock.calls[0][1]).toBeNull()
  })

  it('renders nothing when the group has no shelved worktree', () => {
    const { w } = mountSection([])
    expect(w.find('[data-shelved-section]').exists()).toBe(false)
  })

  it('a detached worktree is labelled by its folder and says the work is in the archive', async () => {
    const detached: ShelvedMember<Session> = {
      ...member('d', 'spike-cache', 41, []),
      branch: null
    }
    const { w } = mountSection([detached])
    await w.find('[data-sidebar-row^="shelved:"]').trigger('click')
    const row = w.find('[data-shelved-id="d"] [role="button"]')
    expect(row.text()).toContain('spike-cache')
    expect(row.attributes('title')).toContain('work kept in the archive')
  })

  it('the tooltips pluralise: today, one day, many days', async () => {
    const { w } = mountSection([
      member('t0', 'a', 0, []),
      member('t1', 'b', 1, []),
      member('t9', 'c', 9, [])
    ])
    await w.find('[data-sidebar-row^="shelved:"]').trigger('click')
    const title = (id: string): string | undefined =>
      w.find(`[data-shelved-id="${id}"] [role="button"]`).attributes('title')
    expect(title('t0')).toBe('Shelved today · branch a kept')
    expect(title('t1')).toBe('Shelved 1 day ago · branch b kept')
    expect(title('t9')).toBe('Shelved 9 days ago · branch c kept')
    expect(w.find('[data-sidebar-row^="shelved:"]').attributes('title')).toBe(
      '3 shelved worktrees — branches and sessions kept'
    )
  })
})
