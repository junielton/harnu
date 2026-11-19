/**
 * Mission dropdown · S-3 — the rules of the tree that are not drawing (design.md §6 "Mission dropdown" →
 * "What it draws" 3 and "Keyboard and focus").
 *
 * Pure like `mission-pane-view.ts`, which still builds the tree (`buildPaneTree`): the dropdown READS the
 * server's states, counts and current milestone and computes none of them. What this module adds is two
 * rules of its own: how many running steps an open milestone shows before "{n} more steps", and what each
 * key does on the tree's rows.
 */
import {
  milestoneGlyph,
  stepGlyph,
  type GlyphKind,
  type PaneMilestoneRow,
  type PaneStepRow,
  type PaneTree
} from './mission-pane-view'

// ---- the state glyphs --------------------------------------------------------------------------------

/** The three levels of the tree a glyph can mark. */
export type DotKind = 'milestone' | 'step' | 'criterion'

/** What a glyph draws: the pane's five, plus the criterion's two (an empty box, a settled one). */
export type DotGlyph = GlyphKind | 'box' | 'settled'

/** The glyph for a level's state. A blocked step draws the flag in place of its own glyph. */
export function glyphOf(kind: DotKind, state: string, blocked = false): DotGlyph {
  if (kind === 'milestone') return milestoneGlyph(state)
  if (kind === 'step') return stepGlyph(state, blocked)
  return state === 'settled' ? 'settled' : 'box'
}

/**
 * The key of the label (`missionDropdown.state.<kind>.<key>`). A state this build does not know reads as the
 * level's first one (Not started, To do, Not settled yet) rather than as a raw key.
 */
export function stateKeyOf(kind: DotKind, state: string, blocked = false): string {
  if (kind === 'criterion') return state === 'settled' ? 'settled' : 'open'
  if (kind === 'step') {
    if (blocked) return 'blocked'
    return ['running', 'waiting-review', 'done'].includes(state) ? state : 'todo'
  }
  return ['in-progress', 'waiting-review', 'done'].includes(state) ? state : 'not-started'
}

/** At most this many running steps show in an open milestone; the rest fold behind "{n} more steps". */
export const RUNNING_SHOWN = 3

/**
 * Re-group one milestone for the dropdown: the steps the operator owes first (never cut: an owed item is
 * never hidden behind a fold with no count), then at most {@link RUNNING_SHOWN} running steps, and every
 * other step behind the fold, in plan order. A step is in exactly one place.
 */
function capMilestone<T extends { shown: PaneStepRow[]; folded: PaneStepRow[] }>(
  m: T,
  position: ReadonlyMap<string, number>
): T {
  const all = [...m.shown, ...m.folded]
  const owed = all.filter((s) => s.needsYou)
  const running = all.filter((s) => !s.needsYou && s.state === 'running')
  const rest = all.filter((s) => !s.needsYou && s.state !== 'running')
  const folded = [...running.slice(RUNNING_SHOWN), ...rest].sort(
    (a, b) => (position.get(a.id) ?? 0) - (position.get(b.id) ?? 0)
  )
  return { ...m, shown: [...owed, ...running.slice(0, RUNNING_SHOWN)], folded }
}

/**
 * The pane's tree with the dropdown's cap on running steps inside each milestone. `planOrder` is the step ids
 * in plan order (`detail.steps`), so the steps behind the fold read in the order of the plan.
 *
 * A mission with no milestones draws its steps as one list, unchanged (the pane's rule: a small task IS its
 * timeline), and optional milestones keep their one collapsed line.
 */
export function capRunning(tree: PaneTree, planOrder: readonly string[]): PaneTree {
  const position = new Map(planOrder.map((id, i) => [id, i]))
  const cap = (m: PaneMilestoneRow): PaneMilestoneRow => capMilestone(m, position)
  return {
    milestones: tree.milestones.map(cap),
    optional: tree.optional.map(cap),
    loose: tree.loose
  }
}

/** One visible row of the tree, in the order it is drawn: what a key needs to know about it. */
export interface TreeRow {
  id: string
  /** The row it sits under (a step's milestone), or `null` for a top-level row. */
  parentId: string | null
  /** Whether it is open (its children are drawn). */
  open: boolean
}

/** What a key does: move focus to a row, or open or close one. `null` when the key does nothing here. */
export type TreeAction = { focus: string } | { toggle: string } | null

/**
 * The WAI-ARIA tree keys on the visible rows (design.md §6 "Keyboard and focus"): Up and Down move between
 * them; Right opens a closed row and, on an open one, moves into its first child; Left closes an open row
 * and, on a closed one, moves out to its parent; Home and End jump to the first and the last; Enter and Space
 * toggle. Every row of this tree can open (a milestone shows its steps, a step its criteria).
 */
export function treeKeyAction(rows: readonly TreeRow[], from: string, key: string): TreeAction {
  const at = rows.findIndex((r) => r.id === from)
  if (at < 0) return null
  const row = rows[at]
  switch (key) {
    case 'ArrowDown':
      return at < rows.length - 1 ? { focus: rows[at + 1].id } : null
    case 'ArrowUp':
      return at > 0 ? { focus: rows[at - 1].id } : null
    case 'Home':
      return { focus: rows[0].id }
    case 'End':
      return { focus: rows[rows.length - 1].id }
    case 'ArrowRight': {
      if (!row.open) return { toggle: row.id }
      const next = rows[at + 1]
      return next && next.parentId === row.id ? { focus: next.id } : null
    }
    case 'ArrowLeft':
      if (row.open) return { toggle: row.id }
      return row.parentId !== null ? { focus: row.parentId } : null
    case 'Enter':
    case ' ':
      return { toggle: row.id }
    default:
      return null
  }
}
