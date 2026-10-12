/**
 * T460 batch 0 — the dialog-shell ratchet (spec §6.2.6 / §4.2 "Enforcement").
 *
 * Rule: a renderer component that paints its own full-viewport fixed scrim with
 * a raw black colour is a HAND-ROLLED dialog shell. The set of such files may
 * only SHRINK:
 *
 *   - a file NOT in `HAND_ROLLED_SHELLS` must be clean — so a new hand-rolled
 *     dialog fails CI;
 *   - a file IN the list must still be dirty — so migrating a dialog to the
 *     shared `Dialog` FORCES the batch to delete its line from the list.
 *
 * `ui/Dialog.vue` (batch 1) is the one component allowed to own a shell; it is
 * exempt by path and does not exist yet.
 *
 * What the rule sees (hardened after review): a full-viewport fixed layer spelled `fixed inset-0`,
 * `inset-x-0 inset-y-0`, `top-0 right-0 bottom-0 left-0`, or `position: fixed` with `inset: 0` / all
 * four sides 0; combined with a raw black scrim (`rgba(0,0,0,…)`, `rgb(0 0 0 / …)`, `#000…` with
 * alpha, `bg-black/N`) or a translucent token / arbitrary-colour backdrop (`bg-bg/80`,
 * `bg-[#1a1a1f]/50`). BLIND SPOTS: a scrim coloured by a CSS variable the file does not spell, a
 * shell built in a `.ts` render function, and a dialog with no scrim at all — the characterization
 * net's name-based coverage test (`*Dialog` / `*Modal`) is the second net for those.
 *
 * Hub-file rule (spec §7.3.b.3): one entry per line, keyed by component
 * filename, sorted. A batch deletes only its own dialogs' lines, so two
 * batches' edits are different lines and merge without conflict; a sort or a
 * layout violation fails below.
 */
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import {
  hasFixedFullViewport,
  hasRawBlackScrim,
  isHandRolledShell
} from './dialog-surfaces/ratchet-core'

const COMPONENTS = join(__dirname, '..', 'src', 'renderer', 'src', 'components')

/** The only components allowed to own a dialog shell once they exist. */
const SHELL_OWNERS: readonly string[] = ['ui/Dialog.vue']

// ALLOW-LIST:BEGIN — one entry per line, sorted. Only ever delete lines.
const HAND_ROLLED_SHELLS: readonly string[] = [
  'AddFolderDialog.vue',
  'CardCreateModal.vue',
  'CardDetailModal.vue',
  'ClaudeBootDialog.vue',
  'CleanupBulkConfirmDialog.vue',
  'CommandPalette.vue',
  'ContainersRemoveDialog.vue',
  'DehydrateConfirmDialog.vue',
  'HarnuModExternal.vue',
  'ImageLightbox.vue',
  'McpConfirmOverlay.vue',
  'MemoryLocationDialog.vue',
  'MissionBulkCloseConfirmDialog.vue',
  'MissionCloseConfirmDialog.vue',
  'MissionsReviewDialog.vue',
  'NewFolderDialog.vue',
  'NewSessionDialog.vue',
  'NewWorktreeDialog.vue',
  'OpenSubfolderDialog.vue',
  'RemoveWorktreeDialog.vue',
  'RenameFolderDialog.vue',
  'RenameRepoDialog.vue',
  'ReviewPane.vue',
  'RoadmapBoard.vue',
  'SettingsDialog.vue',
  'SweepConfirmDialog.vue'
]
// ALLOW-LIST:END

function vueFiles(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) out.push(...vueFiles(full))
    else if (name.endsWith('.vue')) out.push(relative(COMPONENTS, full).split('\\').join('/'))
  }
  return out.sort()
}

const ALL = vueFiles(COMPONENTS)
const scanned = ALL.filter((f) => !SHELL_OWNERS.includes(f))
const dirty = scanned.filter((f) => isHandRolledShell(readFileSync(join(COMPONENTS, f), 'utf8')))

describe('dialog-shell ratchet — the allow-list', () => {
  it('is sorted and has no duplicates (a sort violation is a merge-conflict magnet)', () => {
    const sorted = [...HAND_ROLLED_SHELLS].sort()
    expect([...HAND_ROLLED_SHELLS]).toEqual(sorted)
    expect(new Set(HAND_ROLLED_SHELLS).size).toBe(HAND_ROLLED_SHELLS.length)
  })

  it('is laid out one entry per line between its markers', () => {
    const src = readFileSync(__filename, 'utf8')
    const block = src.split('// ALLOW-LIST:BEGIN')[1].split('// ALLOW-LIST:END')[0]
    const entryLines = block
      .split('\n')
      .filter((l) => /^\s*'[^']+',?\s*$/.test(l))
      .map((l) => l.trim().replace(/[',]/g, ''))
    expect(entryLines).toEqual([...HAND_ROLLED_SHELLS])
  })

  it('names only files that exist', () => {
    for (const f of HAND_ROLLED_SHELLS) expect(ALL, f).toContain(f)
  })
})

describe('dialog-shell ratchet — the ratchet itself', () => {
  it('no NEW hand-rolled dialog shell: every dirty file is on the allow-list', () => {
    const fresh = dirty.filter((f) => !HAND_ROLLED_SHELLS.includes(f))
    expect(
      fresh,
      `new hand-rolled dialog shell(s) — use components/ui/Dialog.vue (spec §4.2): ${fresh.join(', ')}`
    ).toEqual([])
  })

  it('no STALE entry: every allow-listed file still hand-rolls a shell (delete its line when migrated)', () => {
    const stale = HAND_ROLLED_SHELLS.filter((f) => !dirty.includes(f))
    expect(stale, `already migrated, remove from HAND_ROLLED_SHELLS: ${stale.join(', ')}`).toEqual(
      []
    )
  })
})

describe('dialog-shell ratchet — the detection rule can fail', () => {
  const shell = `<div class="fixed inset-0 flex" style="background: rgba(0, 0, 0, 0.55)"></div>`

  it('flags a hand-rolled shell (inline rgba scrim)', () => {
    expect(isHandRolledShell(shell)).toBe(true)
  })
  it('flags the Tailwind bg-black/N form and either class order', () => {
    expect(isHandRolledShell(`<div class="inset-0 fixed bg-black/40"></div>`)).toBe(true)
  })
  it('flags position: fixed + inset: 0 written as inline style', () => {
    expect(
      isHandRolledShell(`<div style="position: fixed; inset: 0; background: rgba(0,0,0,.5)"></div>`)
    ).toBe(true)
  })
  it.each([
    [
      'top/right/bottom/left classes',
      `<div class="left-0 bottom-0 fixed top-0 right-0 bg-black/50"></div>`
    ],
    ['inset-x + inset-y', `<div class="fixed inset-x-0 inset-y-0 bg-black/50"></div>`],
    [
      'style with four sides',
      `<div style="position: fixed; top: 0; right: 0; bottom: 0; left: 0; background: rgba(0,0,0,.4)"></div>`
    ],
    ['translucent token', `<div class="fixed inset-0 bg-bg/80"></div>`],
    ['translucent arbitrary hex', `<div class="fixed inset-0 bg-[#1a1a1f]/50"></div>`],
    ['hex with alpha', `<div style="position: fixed; inset: 0; background: #00000080"></div>`],
    [
      'space-separated rgb',
      `<div style="position: fixed; inset: 0; background: rgb(0 0 0 / 0.5)"></div>`
    ]
  ])('flags a spelling the first version missed: %s', (_name, src) => {
    expect(isHandRolledShell(src)).toBe(true)
  })
  it('still ignores a fixed layer that is not full-viewport, and a translucent backdrop that is not fixed', () => {
    expect(isHandRolledShell(`<div class="fixed top-0 right-0 bg-black/50"></div>`)).toBe(false)
    expect(isHandRolledShell(`<div class="absolute inset-0 bg-bg/80"></div>`)).toBe(false)
  })
  it('does not flag a fixed overlay with no raw black (the token scrim)', () => {
    expect(isHandRolledShell(`<div class="fixed inset-0 bg-scrim"></div>`)).toBe(false)
    expect(hasFixedFullViewport(`<div class="fixed inset-0 bg-scrim"></div>`)).toBe(true)
  })
  it('does not flag a raw black that is not a full-viewport fixed layer (a shadow)', () => {
    const shadow = `<div class="absolute" style="box-shadow: 0 2px 6px rgba(0, 0, 0, 0.3)"></div>`
    expect(hasRawBlackScrim(shadow)).toBe(true)
    expect(isHandRolledShell(shadow)).toBe(false)
  })
})
