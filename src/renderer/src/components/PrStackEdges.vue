<script setup lang="ts">
/**
 * T198 — the edge layer of the PR Stack Canvas.
 *
 * Edges are anchored to CARD EDGES and recomputed from the live boxes on every
 * frame, which is what makes free dragging safe: the arrow carries the chain,
 * the coordinate never does, so a moved card can not make the graph lie
 * (design.md §6 "PR Stack Canvas").
 */
import { computed } from 'vue'
import type { Edge } from '../../../main/pr-stack-core'

export interface NodeBox {
  x: number
  y: number
  w: number
  h: number
}

const props = defineProps<{
  edges: Edge[]
  boxes: Record<string, NodeBox>
  world: { width: number; height: number }
  /**
   * T387 — Dim mode: ids kept at full strength, or `null` for no filter. An edge
   * is dimmed unless BOTH endpoints match; the base node always counts, since it
   * is the destination, not a PR the filter could exclude.
   */
  matched?: Set<string> | null
}>()

interface DrawnEdge {
  key: string
  d: string
  kind: Edge['kind']
  dim: boolean
}

function isDim(edge: Edge): boolean {
  const m = props.matched
  if (!m) return false
  const keeps = (id: string): boolean => id === 'base' || m.has(id)
  return !(keeps(edge.from) && keeps(edge.to))
}

/**
 * Same-column edges are straight verticals; anything else is a cubic with
 * vertical control handles, so a curve leaves and enters perpendicular to the
 * card and never grazes a neighbour on the way.
 *
 * A `lineage` edge (a PR-less worktree hanging off its `bornFrom` mother)
 * enters the mother's SIDE instead — it is not a merge target, and the
 * difference has to be visible without reading a legend.
 */
const drawn = computed<DrawnEdge[]>(() => {
  const out: DrawnEdge[] = []
  for (const edge of props.edges) {
    const from = props.boxes[edge.from]
    const to = props.boxes[edge.to]
    if (!from || !to) continue

    const sx = from.x + from.w / 2
    const sy = from.y + from.h

    if (edge.kind === 'lineage') {
      const ex = to.x + to.w
      const ey = to.y + to.h / 2
      out.push({
        key: `${edge.from}->${edge.to}`,
        kind: edge.kind,
        dim: isDim(edge),
        d: `M${sx} ${sy} C${sx} ${sy + 80}, ${ex + 90} ${ey - 30}, ${ex + 8} ${ey}`
      })
      continue
    }

    const ex = to.x + to.w / 2
    const ey = to.y
    const d =
      Math.abs(sx - ex) < 1
        ? `M${sx} ${sy} L${ex} ${ey - 6}`
        : `M${sx} ${sy} C${sx} ${sy + Math.max(48, (ey - sy) * 0.6)}, ${ex} ${ey - Math.max(48, (ey - sy) * 0.6)}, ${ex} ${ey - 6}`
    out.push({ key: `${edge.from}->${edge.to}`, kind: edge.kind, d, dim: isDim(edge) })
  }
  return out
})
</script>

<template>
  <svg
    class="pointer-events-none absolute left-0 top-0 overflow-visible"
    :width="world.width"
    :height="world.height"
  >
    <defs>
      <marker
        id="pr-stack-arrow"
        markerWidth="7"
        markerHeight="7"
        refX="5.4"
        refY="3"
        orient="auto"
        markerUnits="userSpaceOnUse"
      >
        <path d="M0 0 L6 3 L0 6 z" class="fill-accent-line" />
      </marker>
      <marker
        id="pr-stack-arrow-lineage"
        markerWidth="7"
        markerHeight="7"
        refX="5.4"
        refY="3"
        orient="auto"
        markerUnits="userSpaceOnUse"
      >
        <path d="M0 0 L6 3 L0 6 z" class="fill-text-4" />
      </marker>
      <marker
        id="pr-stack-arrow-orphan"
        markerWidth="7"
        markerHeight="7"
        refX="5.4"
        refY="3"
        orient="auto"
        markerUnits="userSpaceOnUse"
      >
        <path d="M0 0 L6 3 L0 6 z" class="fill-warning/55" />
      </marker>
    </defs>

    <path
      v-for="edge in drawn"
      :key="edge.key"
      :d="edge.d"
      fill="none"
      stroke-width="1.5"
      :class="{
        'stroke-accent-line': edge.kind === 'merge',
        'stroke-text-4 [stroke-dasharray:3_4]': edge.kind === 'lineage',
        'stroke-warning/55 [stroke-dasharray:5_4]': edge.kind === 'orphan',
        'opacity-40': edge.dim
      }"
      :marker-end="
        edge.kind === 'lineage'
          ? 'url(#pr-stack-arrow-lineage)'
          : edge.kind === 'orphan'
            ? 'url(#pr-stack-arrow-orphan)'
            : 'url(#pr-stack-arrow)'
      "
    />
  </svg>
</template>
