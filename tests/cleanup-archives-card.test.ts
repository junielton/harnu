// @vitest-environment jsdom
// AC-C1 / AC-C3 (UI): the Archives card, the in-the-trash strip and the confirm dialog.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { i18n } from '@renderer/i18n'
import CleanupArchivesCard from '../src/renderer/src/components/CleanupArchivesCard.vue'
import CleanupTrashCard from '../src/renderer/src/components/CleanupTrashCard.vue'
import CleanupExhaustDialog from '../src/renderer/src/components/CleanupExhaustDialog.vue'
import { buildArchivesCard, groupArchiveRefs, withFolders } from '../src/main/gc/archives-core'

const NOW = Date.parse('2026-10-12T12:00:00Z')
const sha = (c: string): string => c.repeat(40)
const REPO = '/ws/org/proj/www'

function card(bytes: number | null = 2_000_000) {
  const entries = withFolders(
    groupArchiveRefs(REPO, [
      { ref: 'refs/archive/feat/login/20260801T000000Z/tip', sha: sha('a'), at: 0 },
      { ref: 'refs/archive/feat/login/20260801T000000Z/wip', sha: sha('b'), at: 0 },
      { ref: 'refs/archive/feat/new/20261010T000000Z/tip', sha: sha('c'), at: 0 },
      { ref: 'refs/archive/detached/20261011T000000Z/tip', sha: sha('d'), at: 0 }
    ]),
    [
      {
        archiveTipRef: 'refs/archive/feat/login/20260801T000000Z/tip',
        archiveWipRef: 'refs/archive/feat/login/20260801T000000Z/wip',
        trashedPath: '/ws/org/proj/worktrees/wt-login'
      }
    ]
  )
  return buildArchivesCard(
    [{ repoPath: REPO, entries, bytes }],
    { keepDays: 30, autoExpire: false },
    NOW
  )
}

const mountCard = (c = card()) =>
  mount(CleanupArchivesCard, { props: { archives: c, now: NOW }, global: { plugins: [i18n] } })

afterEach(() => vi.restoreAllMocks())

describe('CleanupArchivesCard', () => {
  it('says how many archives and an ESTIMATED size (≈), per card and per repo', () => {
    const w = mountCard()
    expect(w.get('[data-testid="archives-sub"]').text()).toBe('3 archives · ≈ 2 MB')
    expect(w.get('[data-testid="archives-repo-sub"]').text()).toBe('3 archives · ≈ 2 MB')
    expect(w.get('[data-testid="archives-repo"]').text()).toContain('www')
  })

  it('drops the size, never invents one, when git could not say', () => {
    const w = mountCard(card(null))
    expect(w.get('[data-testid="archives-sub"]').text()).toBe('3 archives')
    expect(w.get('[data-testid="archives-sub"]').text()).not.toContain('≈')
  })

  it('browse: each archive shows its source, date, tip SHA and whether it has a working state', async () => {
    const w = mountCard()
    expect(w.find('[data-testid="archive-row"]').exists()).toBe(false)
    await w.get('[data-testid="archives-repo-toggle"]').trigger('click')
    const rows = w.findAll('[data-testid="archive-row"]')
    expect(rows).toHaveLength(3)
    const bySource = (kind: string) =>
      rows.find((r) => r.get('[data-testid="archive-source"]').attributes('data-source') === kind)!
    // The folder the journal remembers wins over the branch.
    const folder = bySource('folder')
    expect(folder.get('[data-testid="archive-source"]').text()).toBe('wt-login')
    expect(folder.text()).toContain('feat/login')
    expect(folder.get('[data-testid="archive-tip"]').text()).toBe(`tip ${'a'.repeat(7)}`)
    expect(folder.find('[data-testid="archive-wip"]').exists()).toBe(true)
    expect(folder.find('[data-testid="archive-expired"]').exists()).toBe(true)
    // A branch with no remembered folder.
    const branch = bySource('branch')
    expect(branch.get('[data-testid="archive-source"]').text()).toBe('feat/new')
    expect(branch.find('[data-testid="archive-wip"]').exists()).toBe(false)
    expect(branch.find('[data-testid="archive-expired"]').exists()).toBe(false)
    // A detached one says so.
    expect(bySource('detached').get('[data-testid="archive-source"]').text()).toBe('detached')
  })

  it('copies the restore command, and a second one for the working state', async () => {
    const writeText = vi.fn(async () => undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    const w = mountCard()
    await w.get('[data-testid="archives-repo-toggle"]').trigger('click')
    const folderRow = w
      .findAll('[data-testid="archive-row"]')
      .find((r) => r.text().includes('wt-login'))!
    await folderRow.get('[data-testid="archive-copy"]').trigger('click')
    expect(writeText).toHaveBeenLastCalledWith(`git branch feat/login ${sha('a')}`)
    await folderRow.get('[data-testid="archive-copy-wip"]').trigger('click')
    expect(writeText).toHaveBeenLastCalledWith(
      `git worktree add --detach ../restored-${'b'.repeat(7)} ${sha('b')}`
    )
  })

  it('offers to delete what is past the retention, and hands the dialog exactly those entries', async () => {
    const w = mountCard()
    const btn = w.get('[data-testid="archives-delete-older"]')
    expect(btn.text()).toBe('Delete 1 older than 30 days…')
    await btn.trigger('click')
    const [group, entries] = w.emitted('delete')![0] as [
      { repoPath: string },
      Array<{ branch: string }>
    ]
    expect(group.repoPath).toBe(REPO)
    expect(entries.map((e) => e.branch)).toEqual(['feat/login'])
  })

  it('has no delete button when nothing has expired', () => {
    const fresh = buildArchivesCard(
      [
        {
          repoPath: REPO,
          entries: groupArchiveRefs(REPO, [
            { ref: 'refs/archive/x/20261010T000000Z/tip', sha: sha('a'), at: 0 }
          ]),
          bytes: 1
        }
      ],
      { keepDays: 30, autoExpire: false },
      NOW
    )
    expect(mountCard(fresh).find('[data-testid="archives-delete-older"]').exists()).toBe(false)
  })

  it('"Run git gc now…" asks for its own confirm through an event, running nothing itself', async () => {
    const w = mountCard()
    await w.get('[data-testid="archives-gc"]').trigger('click')
    expect(w.emitted('gc')).toHaveLength(1)
    expect(w.emitted('delete')).toBeUndefined()
  })

  it('says deleting frees disk only after git gc, and states the retention', () => {
    const note = mountCard().get('[data-testid="archives-note"]').text()
    expect(note).toContain("git's next gc")
    expect(note).toContain('Archives older than 30 days: 1')
  })
})

describe('CleanupTrashCard', () => {
  it('names what Harnu moved to the trash and offers to empty exactly that', async () => {
    const w = mount(CleanupTrashCard, {
      props: {
        trash: {
          inTrashBytes: 3_000_000_000,
          inTrashCount: 2,
          canEmpty: true,
          location: '~/.local/share/Trash'
        }
      },
      global: { plugins: [i18n] }
    })
    expect(w.get('[data-testid="trash-strip"]').text()).toBe(
      '3.00 GB in the trash · 2 folders Harnu moved there'
    )
    const btn = w.get('[data-testid="trash-empty"]')
    expect(btn.text()).toBe('Empty what Harnu moved to the trash (3.00 GB)')
    await btn.trigger('click')
    expect(w.emitted('empty')).toHaveLength(1)
  })

  it("where Harnu cannot tell its items from the user's it draws no button and says where the trash is", () => {
    const w = mount(CleanupTrashCard, {
      props: {
        trash: { inTrashBytes: 1_000_000, inTrashCount: 1, canEmpty: false, location: '~/.Trash' }
      },
      global: { plugins: [i18n] }
    })
    expect(w.find('[data-testid="trash-empty"]').exists()).toBe(false)
    expect(w.get('[data-testid="trash-cant-empty"]').text()).toContain('~/.Trash')
  })
})

describe('CleanupExhaustDialog', () => {
  const entries = card().repos[0]!.entries.slice(0, 2)

  it('delete: lists what will be deleted, warns that git frees the space on its next gc, focus on Cancel', async () => {
    const w = mount(CleanupExhaustDialog, {
      props: { mode: 'delete', entries, repo: 'www' },
      global: { plugins: [i18n] },
      attachTo: document.body
    })
    expect(document.body.querySelector('[data-testid="exhaust-dialog"]')).toBeTruthy()
    expect(document.body.querySelectorAll('[data-testid="exhaust-row"]')).toHaveLength(2)
    expect(document.body.querySelector('[data-testid="exhaust-warning"]')!.textContent).toContain(
      'next gc'
    )
    expect(
      document.body.querySelector('[data-testid="exhaust-confirm"]')!.textContent!.trim()
    ).toBe('Delete 2 archives')
    await new Promise((r) => setTimeout(r, 0))
    expect(document.activeElement).toBe(
      document.body.querySelector('[data-testid="exhaust-cancel"]')
    )
    w.unmount()
  })

  it('confirm and Cancel emit; Esc cancels', async () => {
    const w = mount(CleanupExhaustDialog, {
      props: { mode: 'trash', trashCount: 2, trashBytes: 3_000_000_000 },
      global: { plugins: [i18n] },
      attachTo: document.body
    })
    expect(document.body.querySelector('[data-testid="exhaust-dialog"]')!.textContent).toContain(
      'Anything else in your trash stays'
    )
    ;(document.body.querySelector('[data-testid="exhaust-confirm"]') as HTMLElement).click()
    expect(w.emitted('confirm')).toHaveLength(1)
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    expect(w.emitted('cancel')).toHaveLength(1)
    w.unmount()
  })

  it('gc: names the repo and warns about concurrent git writers', () => {
    const w = mount(CleanupExhaustDialog, {
      props: { mode: 'gc', repo: 'www' },
      global: { plugins: [i18n] },
      attachTo: document.body
    })
    const text = document.body.querySelector('[data-testid="exhaust-dialog"]')!.textContent!
    expect(text).toContain('Run git gc in www?')
    expect(text).toContain('another git command is writing')
    w.unmount()
  })
})
