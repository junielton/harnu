// @vitest-environment jsdom
/**
 * T460 batch 0 — the dialog characterization net (spec §6.2.4).
 *
 * Table-driven over the 28 dialog components that can be mounted headlessly. For each one the
 * test MOUNTS the real component (`tests/dialog-surfaces/*`), MEASURES what it does — dispatches
 * Esc from `<body>` and from inside the card, `mousedown` and a bare `click` on the scrim,
 * `mousedown` inside the card, Tab on the last focusable; reads which element holds focus after
 * open, how it signalled "closed", ARIA, and whether the card declares a height cap — and
 * compares the measurement to the row below. The expected values are today's behaviour, and the
 * suite passes on unmodified `main`.
 *
 * HOW DEVIATIONS WORK (the part a migration batch edits). `STANDARD` is what a dialog on the
 * shared `Dialog` primitive does (spec §4.2): Esc closes it and is swallowed, the scrim closes on
 * `mousedown` (never on a bare click), Tab wraps, a height cap exists, and a confirm focuses
 * Cancel first (D7). Every way a surface differs is a deviation id (`DEVIATIONS` below), DERIVED
 * from the measurement and compared, in both directions, with `KNOWN_DEVIATIONS`:
 *
 *   - a measured deviation that is not listed fails — so a regression cannot hide;
 *   - a listed deviation the surface no longer shows fails — so the batch that fixes it MUST
 *     delete its line in the same commit, which is how an intentional delta stays visible.
 *
 * The two inline overlays (`RoadmapBoard` dispatch confirm, `ReviewPane` submit confirm) cannot
 * be mounted cheaply and are listed, with the reason, in `tests/dialog-surfaces/source-facts.ts`;
 * their deviations are read from source — weaker, and stated as such.
 *
 * Hub-file rule (spec §7.3.b.3): `KNOWN_DEVIATIONS` is one entry per line, keyed by component
 * filename, sorted. A batch deletes only its own dialogs' lines.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  installLayoutStubs,
  probe,
  type Measured,
  type SurfaceSpec
} from './dialog-surfaces/harness'
import { SURFACES_A } from './dialog-surfaces/forms-store-driven'
import { SURFACES_B } from './dialog-surfaces/confirms-emit-driven'
import { SURFACES_C } from './dialog-surfaces/special-surfaces'
import {
  INLINE_OVERLAYS,
  inlineDeviations,
  paletteLabelIsHardcoded
} from './dialog-surfaces/source-facts'

// ---- the vocabulary --------------------------------------------------------------------------

/** Every behavioural way a surface may differ from the standard dialog (spec §3.3). */
export const DEVIATIONS = [
  'aria-label-not-i18n', // accessible name is a hard-coded English literal (source-read)
  'esc-focus-dependent', // Esc only fires with focus already inside the scrim
  'esc-not-swallowed', // Esc also reaches a bubbling document listener (a takeover behind sees it)
  'initial-focus-destructive', // a confirm focuses the destructive button instead of Cancel (D7)
  'no-cap', // the card declares no max-height / fixed height
  'no-esc', // Esc does nothing
  'no-scrim-close', // the scrim does not dismiss it at all
  'no-trap', // Tab does not wrap inside the card
  'scrim-click-self' // the scrim closes on a bare click (`click.self`), not on mousedown
] as const
export type Deviation = (typeof DEVIATIONS)[number]

/** What the shared primitive will do for every surface (spec §4.2 "Keyboard"). */
const STANDARD = {
  role: 'dialog',
  ariaModal: 'true',
  esc: 'closes',
  escReachesDocument: false,
  scrimMousedown: true,
  scrimClick: false,
  insideMousedownStaysOpen: true,
  trap: true,
  cap: true
} as const

interface Row {
  /** `labelledby` = an `aria-labelledby` that resolves to the title; `label` = an `aria-label`. */
  accessibleName: Measured['accessibleName']
  /**
   * Which `named` element holds focus right after open — for a confirm this is the STANDARD
   * target (`cancel`, D7); a surface that focuses the destructive button instead carries the
   * `initial-focus-destructive` deviation and is measured as `confirm`.
   */
  initialFocus: string
  /** How the surface signals "closed" (an emit + payload, a store flag, or a local ref). */
  closeSignal: string
}

const ui = (f: string, init: string, name: Row['accessibleName'] = 'labelledby'): Row => ({
  accessibleName: name,
  initialFocus: init,
  closeSignal: f
})
const STORE = 'ui.dialog=null'

/** The 28 mountable components — spec §1.2 "Surface" rows, current behaviour. */
const TABLE: Record<string, Row> = {
  'AddFolderDialog.vue': ui(STORE, 'input'),
  'CardCreateModal.vue': ui('close[[]]', 'input', 'label'),
  'CardDetailModal.vue': ui('close[[]]', 'none', 'label'),
  'ClaudeBootDialog.vue': ui(STORE, 'close'),
  'CleanupBulkConfirmDialog.vue': ui('cancel[]', 'cancel'),
  'CleanupDockerConfirmDialog.vue': ui('cancel[]', 'cancel'),
  'CleanupExhaustDialog.vue': ui('cancel[]', 'cancel'),
  'CleanupGuidedDialog.vue': ui('cancel[]', 'cancel'),
  'CleanupTranscriptsConfirmDialog.vue': ui('cancel[]', 'cancel'),
  'CommandPalette.vue': ui('ui.palette.open=false', 'input', 'label'),
  'ContainersRemoveDialog.vue': ui('close[null]', 'cancel'),
  'DehydrateConfirmDialog.vue': ui('close[false]', 'cancel'),
  'HarnuModExternal.vue': ui('local confirming=false (dialog removed from DOM)', 'cancel'),
  'ImageLightbox.vue': ui('close[[]]', 'none', 'label'),
  'McpConfirmOverlay.vue': ui('', 'dismiss', 'label'),
  'MemoryLocationDialog.vue': ui(STORE, 'close'),
  'MissionBulkCloseConfirmDialog.vue': ui('cancel[]', 'cancel'),
  'MissionCloseConfirmDialog.vue': ui('cancel[]', 'cancel'),
  'MissionsReviewDialog.vue': ui('local open=false (card removed from DOM)', 'cancel'),
  'NewFolderDialog.vue': ui(STORE, 'input'),
  'NewSessionDialog.vue': ui(STORE, 'start'),
  'NewWorktreeDialog.vue': ui(STORE, 'input'),
  'OpenSubfolderDialog.vue': ui(STORE, 'search'),
  'RemoveWorktreeDialog.vue': ui(STORE, 'cancel'),
  'RenameFolderDialog.vue': ui(STORE, 'input'),
  'RenameRepoDialog.vue': ui(STORE, 'input'),
  'SettingsDialog.vue': ui(STORE, 'close'),
  'SweepConfirmDialog.vue': ui('close[false]', 'cancel'),
  'TrustedHostsDialog.vue': ui(STORE, 'input')
}

// KNOWN_DEVIATIONS:BEGIN — one entry per line, keyed by component filename, sorted.
// A batch that fixes a deviation deletes it (or the whole line) in the same commit.
const KNOWN_DEVIATIONS: Record<string, readonly Deviation[]> = {
  'CardCreateModal.vue': ['no-trap', 'scrim-click-self'],
  'CardDetailModal.vue': ['no-trap', 'scrim-click-self'],
  'CleanupBulkConfirmDialog.vue': ['no-cap'],
  'CleanupDockerConfirmDialog.vue': ['no-cap'],
  'CleanupExhaustDialog.vue': ['no-cap'],
  'CleanupGuidedDialog.vue': ['no-cap'],
  'CleanupTranscriptsConfirmDialog.vue': ['no-cap'],
  'CommandPalette.vue': ['aria-label-not-i18n', 'no-trap'],
  'ContainersRemoveDialog.vue': ['no-cap'],
  'DehydrateConfirmDialog.vue': ['initial-focus-destructive'],
  // no-cap: a full-viewport viewer, never capped (D6: it adopts only the scrim/z tokens).
  'ImageLightbox.vue': ['esc-not-swallowed', 'no-cap', 'no-trap', 'scrim-click-self'],
  'McpConfirmOverlay.vue': ['esc-not-swallowed', 'no-esc', 'no-scrim-close'],
  'RemoveWorktreeDialog.vue': ['initial-focus-destructive'],
  'ReviewPane.vue': ['no-cap', 'no-esc', 'no-trap'],
  'RoadmapBoard.vue': ['esc-focus-dependent', 'no-trap', 'scrim-click-self'],
  'SweepConfirmDialog.vue': ['initial-focus-destructive']
}
// KNOWN_DEVIATIONS:END

// ---- the measurement → deviations ------------------------------------------------------------

/** Compare a measurement to the standard and name every difference. Pure. */
export function deriveDeviations(m: Measured, row: Row): Deviation[] {
  const out: Deviation[] = []
  if (!m.trap) out.push('no-trap')
  if (m.esc === 'ignored') out.push('no-esc')
  if (m.esc === 'only-focus-inside') out.push('esc-focus-dependent')
  if (m.escReachesDocument) out.push('esc-not-swallowed')
  if (!m.scrimMousedown && m.scrimClick) out.push('scrim-click-self')
  if (!m.scrimMousedown && !m.scrimClick) out.push('no-scrim-close')
  if (!m.cap) out.push('no-cap')
  if (row.initialFocus === 'cancel' && m.initialFocus === 'confirm') {
    out.push('initial-focus-destructive')
  }
  return out.sort() as Deviation[]
}

// ---- the suite -------------------------------------------------------------------------------

const SPECS: SurfaceSpec[] = [...SURFACES_A, ...SURFACES_B, ...SURFACES_C]
const COMPONENTS = join(__dirname, '..', 'src', 'renderer', 'src', 'components')

let restoreLayout: () => void
beforeAll(() => {
  restoreLayout = installLayoutStubs()
})
afterAll(() => {
  restoreLayout()
})

describe('characterization table — coverage (AC-2)', () => {
  it('has a spec for every row and a row for every spec', () => {
    expect(SPECS.map((s) => s.file).sort()).toEqual(Object.keys(TABLE).sort())
  })

  it('covers every dialog component the repo has: *Dialog / *Modal / the four named overlays', () => {
    const named = [
      'CommandPalette.vue',
      'ImageLightbox.vue',
      'McpConfirmOverlay.vue',
      'HarnuModExternal.vue'
    ]
    const onDisk = readdirSync(COMPONENTS)
      .filter((f) => /(Dialog|Modal)\.vue$/.test(f) || named.includes(f))
      .sort()
    // `ui/` primitives live in a subfolder and are not listed by this top-level read.
    expect(Object.keys(TABLE).sort()).toEqual(onDisk)
    expect(Object.keys(TABLE)).toHaveLength(28)
  })

  it('lists the two inline overlays with a reason instead of mounting them', () => {
    expect(INLINE_OVERLAYS.map((o) => o.file).sort()).toEqual([
      'ReviewPane.vue',
      'RoadmapBoard.vue'
    ])
    for (const o of INLINE_OVERLAYS) expect(o.reason.length, o.file).toBeGreaterThan(40)
  })
})

describe('KNOWN_DEVIATIONS — shape (AC-3)', () => {
  const keys = Object.keys(KNOWN_DEVIATIONS)

  it('is sorted by component filename, with sorted ids and no duplicates', () => {
    expect(keys).toEqual([...keys].sort())
    for (const k of keys) {
      const ids = KNOWN_DEVIATIONS[k]
      expect([...ids], k).toEqual([...ids].sort())
      expect(new Set(ids).size, k).toBe(ids.length)
      for (const id of ids) expect(DEVIATIONS as readonly string[], `${k}: ${id}`).toContain(id)
    }
  })

  it('is laid out one entry per line between its markers', () => {
    const src = readFileSync(__filename, 'utf8')
    const block = src.split('// KNOWN_DEVIATIONS:BEGIN')[1].split('// KNOWN_DEVIATIONS:END')[0]
    const lines = block.split('\n').filter((l) => /^\s*'[A-Za-z]+\.vue':/.test(l))
    expect(lines.map((l) => l.trim().split("'")[1])).toEqual(keys)
  })

  it('names only components that exist (a mounted surface or an inline overlay host)', () => {
    const hosts = INLINE_OVERLAYS.map((o) => o.file)
    for (const k of keys) expect([...Object.keys(TABLE), ...hosts], k).toContain(k)
  })

  it('covers every behavioural deviation family in spec §3.3 at least once', () => {
    const all = new Set(Object.values(KNOWN_DEVIATIONS).flat())
    for (const family of [
      'no-trap', // missing trap
      'no-esc', // missing Esc
      'esc-focus-dependent', // focus-dependent Esc
      'scrim-click-self', // click.self scrim
      'no-cap', // no cap
      'initial-focus-destructive' // destructive-button focus
    ] as const) {
      expect(all.has(family), family).toBe(true)
    }
  })
})

describe('characterization table — mounted surfaces (AC-1, AC-2)', () => {
  for (const spec of SPECS) {
    describe(spec.file, () => {
      let m: Measured
      beforeAll(async () => {
        m = await probe(spec)
      })

      const row = TABLE[spec.file]
      it('is a modal dialog with the table’s accessible name', () => {
        expect(m.role).toBe(STANDARD.role)
        expect(m.ariaModal).toBe(STANDARD.ariaModal)
        expect(m.accessibleName).toBe(row.accessibleName)
      })

      it('closes the way the table says, and only on a dismissal gesture', () => {
        // inside-the-card mousedown must never dismiss — drag-from-inside protection.
        expect(m.insideMousedownStaysOpen).toBe(STANDARD.insideMousedownStaysOpen)
        expect(m.closeSignal).toBe(row.closeSignal)
      })

      it('focuses the table’s element on open', () => {
        const dev = KNOWN_DEVIATIONS[spec.file] ?? []
        const expected = dev.includes('initial-focus-destructive') ? 'confirm' : row.initialFocus
        expect(m.initialFocus).toBe(expected)
      })

      it('shows exactly the deviations KNOWN_DEVIATIONS lists — no more, no fewer (AC-3)', () => {
        const measured: string[] = deriveDeviations(m, row)
        if (spec.file === 'CommandPalette.vue' && paletteLabelIsHardcoded()) {
          measured.push('aria-label-not-i18n')
        }
        expect(measured.sort()).toEqual([...(KNOWN_DEVIATIONS[spec.file] ?? [])])
      })
    })
  }
})

describe('characterization table — inline overlays, read from source (AC-2)', () => {
  for (const o of INLINE_OVERLAYS) {
    it(`${o.file} (${o.surface}) shows exactly the deviations KNOWN_DEVIATIONS lists`, () => {
      expect(inlineDeviations(o)).toEqual([...(KNOWN_DEVIATIONS[o.file] ?? [])])
    })
  }
})

describe('the net can fail — deriveDeviations on a synthetic measurement', () => {
  const clean: Measured = {
    role: 'dialog',
    ariaModal: 'true',
    accessibleName: 'labelledby',
    esc: 'closes',
    escReachesDocument: false,
    scrimMousedown: true,
    scrimClick: false,
    insideMousedownStaysOpen: true,
    trap: true,
    initialFocus: 'cancel',
    closeSignal: STORE,
    cap: true
  }
  const row: Row = ui(STORE, 'cancel')

  it('a standard surface derives nothing', () => {
    expect(deriveDeviations(clean, row)).toEqual([])
  })
  it.each([
    ['no-trap', { trap: false }],
    ['no-esc', { esc: 'ignored' }],
    ['esc-focus-dependent', { esc: 'only-focus-inside' }],
    ['esc-not-swallowed', { escReachesDocument: true }],
    ['scrim-click-self', { scrimMousedown: false, scrimClick: true }],
    ['no-scrim-close', { scrimMousedown: false, scrimClick: false }],
    ['no-cap', { cap: false }],
    ['initial-focus-destructive', { initialFocus: 'confirm' }]
  ] as const)('%s is derived when the surface regresses that way', (id, patch) => {
    expect(deriveDeviations({ ...clean, ...patch } as Measured, row)).toEqual([id])
  })
})
