/**
 * Campaign map board layout (T607, campaign chapter 4c — design.md §6 "Campaign map"; mockup
 * `screens/v6--map.html`). A pure function from a campaign's chapters, the SERVER's chapter
 * states and its current range to the geometry the takeover draws: tile positions, docked side
 * chapters with their stems, and routed dependency arrows.
 *
 * Geometry only. Nothing here counts anything for display — states and the current range arrive
 * from `CampaignProgress`, and the board's numbers (headline, counts, radiant) are printed from
 * `progress` by the component. The constants are the mockup's own board grid (the one place the
 * design allows off-scale pixels: a fixed canvas of 4 × 164 + 3 × 36 + the return lane).
 *
 * Layout. Required chapters sit in PLAN ORDER on a 4-column grid, reading left to right then
 * down. Arrows are the chapters' dependencies: a chapter that consumes a token gets an arrow from
 * each earlier required chapter that produces it (`token`), and a chapter that unlocks on another
 * chapter gets one from it (`unlocks`) — the same two rules `computeCampaignProgress` locks by.
 * A chapter nothing explicit enters follows the plan order from the previous required chapter
 * (`sequence`), so the board always reads as one quest line. A dependency on a chapter with no
 * tile (a side chapter, an unknown id) draws nothing.
 */
import type { Chapter } from '../../../main/campaign-core'
import type { ChapterState } from '../../../main/campaign-progress'

export const MAP_COLS = 4
export const MAP_TILE_W = 164
export const MAP_TILE_H = 96
export const MAP_GAP_X = 36
/** Vertical space between one row's last dock and the next row's tiles; the arrow channel is its middle. */
export const MAP_ROW_GAP = 40
/** Room above row 0 for the "You are here" label and the channel over the first row. */
export const MAP_PAD_TOP = 24
export const MAP_PAD_BOTTOM = 24
/** Width of the lane right of the last column that a wrapping arrow leaves through. */
export const MAP_LANE = 20
export const MAP_DOCK_H = 20
/** Distance from one dock's top to the next (a 4px gap). */
export const MAP_DOCK_STEP = 24
/** Gap between a tile's bottom and its first dock. */
export const MAP_DOCK_TOP = 8

const PITCH_X = MAP_TILE_W + MAP_GAP_X

export interface MapTile {
  chapterId: string
  ordinal: number
  col: number
  row: number
  x: number
  y: number
  w: number
  h: number
  state: ChapterState
  /** The chapter is inside the server's current range. */
  current: boolean
}

/** A side chapter docked under the tile of the chapter it was discovered from. */
export interface MapDock {
  chapterId: string
  originId: string
  x: number
  y: number
  w: number
  h: number
  state: ChapterState
}

/** The dashed stem joining a tile to its docks. */
export interface MapStem {
  originId: string
  x: number
  y: number
  h: number
}

export type MapEdgeKind = 'ok' | 'cur' | 'lock' | 'plain'
export type MapEdgeVia = 'token' | 'unlocks' | 'sequence'

export interface MapEdge {
  from: string
  to: string
  via: MapEdgeVia
  kind: MapEdgeKind
  /** SVG path data in board coordinates; the arrowhead is the path's end marker. */
  d: string
}

export interface MapLayout {
  tiles: MapTile[]
  docks: MapDock[]
  stems: MapStem[]
  edges: MapEdge[]
  /** Side chapters that name no resolvable origin tile; they are listed, not drawn on the board. */
  undocked: string[]
  width: number
  height: number
}

function edgeKind(fromState: ChapterState, toState: ChapterState, toCurrent: boolean): MapEdgeKind {
  if (toState === 'locked') return 'lock'
  if (toCurrent) return 'cur'
  if (fromState === 'done') return 'ok'
  return 'plain'
}

export function layoutCampaignMap(
  chapters: readonly Chapter[],
  states: Readonly<Record<string, ChapterState>>,
  currentIds: readonly string[]
): MapLayout {
  const required = chapters.filter((c) => c.required)
  const side = chapters.filter((c) => !c.required)
  const current = new Set(currentIds)
  const stateOf = (id: string): ChapterState => states[id] ?? 'todo'

  // Docks first: how many sit under each required chapter sizes the rows.
  const requiredIds = new Set(required.map((c) => c.id))
  const docksByOrigin = new Map<string, Chapter[]>()
  const undocked: string[] = []
  for (const c of side) {
    const origin = c.discoveredFrom?.chapterId
    if (origin && requiredIds.has(origin)) {
      docksByOrigin.set(origin, [...(docksByOrigin.get(origin) ?? []), c])
    } else {
      undocked.push(c.id)
    }
  }

  const rows = Math.ceil(required.length / MAP_COLS)
  const dockBlock = (n: number): number => (n > 0 ? MAP_DOCK_TOP + n * MAP_DOCK_STEP : 0)
  const rowTop: number[] = []
  let top = MAP_PAD_TOP
  for (let r = 0; r < rows; r++) {
    rowTop.push(top)
    const most = Math.max(
      0,
      ...required
        .slice(r * MAP_COLS, (r + 1) * MAP_COLS)
        .map((c) => docksByOrigin.get(c.id)?.length ?? 0)
    )
    top += MAP_TILE_H + dockBlock(most) + MAP_ROW_GAP
  }

  const tiles: MapTile[] = required.map((c, i) => {
    const col = i % MAP_COLS
    const row = Math.floor(i / MAP_COLS)
    return {
      chapterId: c.id,
      ordinal: c.ordinal,
      col,
      row,
      x: col * PITCH_X,
      y: rowTop[row],
      w: MAP_TILE_W,
      h: MAP_TILE_H,
      state: stateOf(c.id),
      current: current.has(c.id)
    }
  })
  const tileOf = new Map(tiles.map((t) => [t.chapterId, t] as const))

  const docks: MapDock[] = []
  const stems: MapStem[] = []
  for (const [originId, list] of docksByOrigin) {
    const origin = tileOf.get(originId)!
    list.forEach((c, k) =>
      docks.push({
        chapterId: c.id,
        originId,
        x: origin.x,
        y: origin.y + MAP_TILE_H + MAP_DOCK_TOP + k * MAP_DOCK_STEP,
        w: MAP_TILE_W,
        h: MAP_DOCK_H,
        state: stateOf(c.id)
      })
    )
    stems.push({
      originId,
      x: origin.x + 10,
      y: origin.y + MAP_TILE_H,
      h: MAP_DOCK_TOP + list.length * MAP_DOCK_STEP - (MAP_DOCK_STEP - MAP_DOCK_H)
    })
  }
  // Docks and stems read in board order (row-major by origin), not Map insertion order.
  const order = (id: string): number => required.findIndex((c) => c.id === id)
  docks.sort((a, b) => order(a.originId) - order(b.originId))
  stems.sort((a, b) => order(a.originId) - order(b.originId))

  // Edges, per target chapter in plan order: explicit dependencies, else the plan order.
  const cols = Math.min(MAP_COLS, Math.max(tiles.length, 1))
  const edges: MapEdge[] = []
  required.forEach((c, i) => {
    const incoming: Array<{ from: string; via: MapEdgeVia }> = []
    const add = (from: string, via: MapEdgeVia): void => {
      if (from !== c.id && tileOf.has(from) && !incoming.some((e) => e.from === from)) {
        incoming.push({ from, via })
      }
    }
    for (const token of c.consumes ?? []) {
      for (const p of required.slice(0, i)) {
        if ((p.produces ?? []).includes(token)) add(p.id, 'token')
      }
    }
    if (c.unlocks?.kind === 'chapter') add(c.unlocks.ref, 'unlocks')
    if (incoming.length === 0 && i > 0) incoming.push({ from: required[i - 1].id, via: 'sequence' })
    // Source order follows the plan so the list reads the same however the tokens were declared.
    incoming.sort((a, b) => order(a.from) - order(b.from))
    for (const e of incoming) {
      const from = tileOf.get(e.from)!
      const to = tileOf.get(c.id)!
      edges.push({
        from: e.from,
        to: c.id,
        via: e.via,
        kind: edgeKind(from.state, to.state, to.current),
        d: edgePath(from, to, rowTop, cols)
      })
    }
  })

  const lastRowTop = rowTop[rows - 1] ?? MAP_PAD_TOP
  const lastRowDocks = Math.max(
    0,
    ...required.slice((rows - 1) * MAP_COLS).map((c) => docksByOrigin.get(c.id)?.length ?? 0)
  )
  return {
    tiles,
    docks,
    stems,
    edges,
    undocked,
    width: cols * MAP_TILE_W + (cols - 1) * MAP_GAP_X + MAP_LANE,
    height: lastRowTop + MAP_TILE_H + dockBlock(lastRowDocks) + MAP_PAD_BOTTOM
  }
}

/** An arrow's path. Neighbours in a row go straight; everything else goes out through the gutter. */
function edgePath(from: MapTile, to: MapTile, rowTop: readonly number[], cols: number): string {
  const cy = from.y + MAP_TILE_H / 2
  const sx = from.x + MAP_TILE_W
  if (from.row === to.row && to.col === from.col + 1) {
    return `M${sx},${cy} H${to.x - 2}`
  }
  const lastCol = from.col === cols - 1
  // The gutter right of the source (half its width), or the return lane after the last column.
  const lane = sx + (lastCol ? 16 : MAP_GAP_X / 2)
  const channel = rowTop[to.row] - MAP_ROW_GAP / 2
  return `M${sx},${cy} H${lane} V${channel} H${to.x + MAP_TILE_W / 2} V${to.y - 2}`
}

/** What a locked chapter waits for — the chapters and the tokens its lock names. */
export interface MapWaits {
  /** Ordinals of the chapters it unlocks on that are not done. */
  chapters: number[]
  /** Tokens it consumes whose earlier producers are not all done. */
  tokens: string[]
}

/**
 * The same two rules `computeCampaignProgress` locks by (`consumes` of an earlier producer that is
 * not done; `unlocks: { kind: 'chapter' }` on a chapter that is not done), read back as words for
 * the tile's sub-line. It never decides WHETHER a chapter is locked — that is the server's state.
 */
export function waitsFor(
  chapter: Chapter,
  chapters: readonly Chapter[],
  states: Readonly<Record<string, ChapterState>>
): MapWaits {
  const i = chapters.findIndex((c) => c.id === chapter.id)
  const notDone = (id: string): boolean => (states[id] ?? 'todo') !== 'done'
  const tokens = (chapter.consumes ?? []).filter((token) =>
    chapters
      .slice(0, Math.max(i, 0))
      .some((p) => (p.produces ?? []).includes(token) && notDone(p.id))
  )
  const ref =
    chapter.unlocks?.kind === 'chapter'
      ? chapters.find((c) => c.id === chapter.unlocks!.ref)
      : undefined
  return {
    chapters: ref && notDone(ref.id) ? [ref.ordinal] : [],
    tokens
  }
}
