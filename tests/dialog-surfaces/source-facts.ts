/**
 * T460 batch 0 — what can be said about the two INLINE overlays and the Command palette
 * label from component SOURCE, because jsdom cannot mount them cheaply (spec §6.2.5).
 *
 * `RoadmapBoard.vue` (1504 lines) and `ReviewPane.vue` (1373 lines) each host one dialog as an
 * inline `<Teleport>` block. Mounting either needs the whole board / PR-review world, so the
 * dispatch overlay has NO behavioural test today and the review confirm only has
 * `review-pane-contract.test.ts` (role, copy, dismiss keeps prose). This module reads the block's
 * source text and reports which known deviations (§3.3) it still shows. It is weaker than a
 * mounted probe and says so: it cannot fail on a behaviour change that keeps the same markup.
 * Batch 6 owns the human check for the dispatch overlay (spec §6.2.5, §6.5).
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const COMPONENTS = join(__dirname, '..', '..', 'src', 'renderer', 'src', 'components')

export const read = (file: string): string => readFileSync(join(COMPONENTS, file), 'utf8')

/** The `<Teleport>…</Teleport>` block that contains `anchor`, or null. */
export function teleportBlock(source: string, anchor: string): string | null {
  const at = source.indexOf(anchor)
  if (at === -1) return null
  const start = source.lastIndexOf('<Teleport', at)
  const end = source.indexOf('</Teleport>', at)
  if (start === -1 || end === -1) return null
  return source.slice(start, end + '</Teleport>'.length)
}

export interface InlineOverlay {
  /** The host component file. */
  file: string
  /** Which surface inside it. */
  surface: string
  /** Text that identifies the overlay's block in the source. */
  anchor: string
  /** Why it is not mounted (spec §6.2.5). */
  reason: string
}

export const INLINE_OVERLAYS: readonly InlineOverlay[] = [
  {
    file: 'RoadmapBoard.vue',
    surface: 'dispatch confirm',
    anchor: 'v-if="dispatchConfirm"',
    reason:
      'Not characterizable without mounting the 1504-line board and its roadmap store; no behavioural test exists. Batch 6 verifies it live (spec §6.2.5, §6.5).'
  },
  {
    file: 'ReviewPane.vue',
    surface: 'submit confirm',
    anchor: 'v-if="pendingVerdict"',
    reason:
      'Needs a PR in the review pane (1373 lines). Already pinned by review-pane-contract.test.ts (T244 AC-3: role, copy, dismiss keeps prose).'
  }
]

/** The deviation ids (see the table in the characterization test) an inline overlay's SOURCE still shows. */
export function inlineDeviations(o: InlineOverlay): string[] {
  const source = read(o.file)
  const block = teleportBlock(source, o.anchor)
  if (!block) throw new Error(`${o.file}: overlay block "${o.anchor}" not found`)
  const out: string[] = []

  // Trap: the whole host file never calls useFocusTrap (it hosts exactly this one overlay).
  if (!/useFocusTrap\(/.test(source)) out.push('no-trap')

  // Esc: wired on the scrim element only (needs focus inside it) → focus-dependent;
  // not wired at all → none. A window-level listener tied to the overlay would be standard.
  const escOnScrim = /@keydown\.esc\b/.test(block)
  const escWindow =
    /addEventListener\(\s*['"]keydown['"]/.test(source) &&
    /Escape/.test(source) &&
    new RegExp(`Escape[\\s\\S]{0,400}${o.anchor.replace(/[^\w]/g, '.')}`).test(source)
  if (escOnScrim && !escWindow) out.push('esc-focus-dependent')
  else if (!escOnScrim && !/Escape/.test(source)) out.push('no-esc')

  // Scrim: a click-self handler instead of mousedown-on-target.
  if (/@click\.self\b/.test(block)) out.push('scrim-click-self')

  // Cap: the card declares no max-height (Tailwind or inline).
  const roleAt = block.indexOf('role="dialog"')
  const card = block.slice(Math.max(0, roleAt - 400), roleAt)
  if (!/max-h-|max-height/.test(card)) out.push('no-cap')

  return out.sort()
}

/** `CommandPalette.vue` hard-codes its accessible name in English instead of using i18n (spec §3.3, §8.6). */
export function paletteLabelIsHardcoded(): boolean {
  return /aria-label="Command palette"/.test(read('CommandPalette.vue'))
}
