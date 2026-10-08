<script setup lang="ts">
import { computed, nextTick, ref, type ComponentPublicInstance } from 'vue'
import { useI18n } from 'vue-i18n'
import { useElementSize } from '@vueuse/core'
import {
  Check,
  CircleCheck,
  CircleHelp,
  ChevronLeft,
  ListChecks,
  Lock,
  TriangleAlert
} from 'lucide-vue-next'
import type { Bucket } from '../../../main/gc/bundle-core'
import { floorShares, foldSmall, squarify, type Rect } from '../lib/gc-treemap'
import { isCheckable, type GcBlock, type GcModel, type RepoRegion } from '../lib/gc-model'
import type { BlockJobState } from '../lib/gc-jobs'
import { formatBytes } from './system-monitor-format'
import { reasonKey, ticketParts } from './cleanup-gc-copy'
import SegmentedControl from './ui/SegmentedControl.vue'

/**
 * The disk-first treemap (design.md "Workspace GC — unified Cleanup / Treemap"). Area = bytes; repo →
 * bucket group → worktree block. Pure presentation over `GcModel`: the store owns the model, the
 * fade timing and the selection, this component only lays it out and reports what was clicked.
 *
 * Geometry is computed in pixels from the measured canvas width (a fixed 372/520px height) and
 * emitted as percentages, so a resize between measures never tears the layout.
 */

const MIB = 1024 ** 2
const REGION_HEAD = 28
const GROUP_HEAD = 22
const OVERVIEW_H = 372
const DRILLED_H = 520
const FALLBACK_W = 1000

const props = defineProps<{
  model: GcModel
  blockState: (id: string) => BlockJobState | null
  checked: ReadonlySet<string>
  selectedId: string | null
  linkedId: string | null
  /** First-cycle report-only: ready blocks are "planned, not done" and take a dashed border. */
  planned: boolean
  drillRepo: string | null
}>()

const emit = defineEmits<{
  select: [id: string]
  toggle: [id: string]
  selectAllInRepo: [repoPath: string]
  drill: [repoPath: string | null]
  openAggregate: [ids: string[], bucket: Bucket]
}>()

const { t } = useI18n()

const canvasEl = ref<HTMLElement | null>(null)
const { width } = useElementSize(canvasEl)
const canvasW = computed(() => (width.value > 0 ? width.value : FALLBACK_W))
const canvasH = computed(() => (props.drillRepo ? DRILLED_H : OVERVIEW_H))

type Filter = 'all' | Bucket
const bucketFilter = ref<Filter>('all')

// ---- layout ------------------------------------------------------------------------------------

interface CellLayout {
  key: string
  block: GcBlock | null
  /** An "N smaller" aggregate: the folded blocks. */
  folded: GcBlock[]
  bucket: Bucket
  bytes: number
  style: Record<string, string>
  cx: number
  cy: number
}
interface GroupLayout {
  bucket: Bucket
  count: number
  style: Record<string, string>
  cells: CellLayout[]
}
interface RegionLayout {
  region: RepoRegion
  style: Record<string, string>
  groups: GroupLayout[]
}

const pct = (v: number, of: number): string => `${of > 0 ? (v / of) * 100 : 0}%`
function styleOf(r: Rect, w: number, h: number): Record<string, string> {
  return { left: pct(r.x, w), top: pct(r.y, h), width: pct(r.w, w), height: pct(r.h, h) }
}

const threshold = computed(() => (props.drillRepo ? 256 : 330) * MIB)

const layout = computed<RegionLayout[]>(() => {
  const regions = props.drillRepo
    ? props.model.regions.filter((r) => r.repoPath === props.drillRepo)
    : props.model.regions
  if (regions.length === 0) return []
  const W = canvasW.value
  const H = canvasH.value
  const shares = floorShares(
    regions.map((r) => r.bytes),
    0.12
  )
  const placed = new Map(
    squarify(
      regions.map((r, i) => ({ id: r.repoPath, value: shares[i] })),
      { x: 0, y: 0, w: W, h: H }
    ).map((p) => [p.id, p.rect])
  )

  return regions.flatMap((region): RegionLayout[] => {
    const R = placed.get(region.repoPath)
    if (!R) return []
    const bodyW = Math.max(R.w - 2, 0)
    const bodyH = Math.max(R.h - REGION_HEAD - 2, 0)
    const groups = region.groups.filter(
      (g) => bucketFilter.value === 'all' || g.bucket === bucketFilter.value
    )
    const gShares = floorShares(
      groups.map((g) => g.bytes),
      0.15
    )
    const gPlaced = new Map(
      squarify(
        groups.map((g, i) => ({ id: g.bucket, value: gShares[i] })),
        { x: 0, y: 0, w: bodyW, h: bodyH }
      ).map((p) => [p.id, p.rect])
    )

    const groupLayouts = groups.flatMap((g): GroupLayout[] => {
      const G = gPlaced.get(g.bucket)
      if (!G) return []
      const gw = Math.max(G.w - 4, 0)
      const gh = Math.max(G.h - GROUP_HEAD - 4, 0)
      // A zero-byte block would be an unclickable sliver; 1 byte folds it into the aggregate.
      const items = g.blocks.map((b) => ({ id: b.id, value: Math.max(b.bytes, 1) }))
      const { kept, folded } = foldSmall(items, threshold.value)
      const byId = new Map(g.blocks.map((b) => [b.id, b]))
      const foldedBlocks = folded.map((f) => byId.get(f.id)!).filter(Boolean)
      const all = [...kept]
      const aggKey = `agg:${region.repoPath}:${g.bucket}`
      if (foldedBlocks.length > 0) {
        all.push({
          id: aggKey,
          value: Math.max(
            folded.reduce((a, f) => a + f.value, 0),
            threshold.value
          )
        })
      }
      const cells = squarify(all, { x: 0, y: 0, w: gw, h: gh }).map((p): CellLayout => {
        const isAgg = p.id === aggKey
        const block = isAgg ? null : (byId.get(p.id) ?? null)
        return {
          key: p.id,
          block,
          folded: isAgg ? foldedBlocks : [],
          bucket: g.bucket,
          bytes: isAgg ? foldedBlocks.reduce((a, b) => a + b.bytes, 0) : (block?.bytes ?? 0),
          style: styleOf(p.rect, gw, gh),
          // Centre in canvas coordinates, for arrow-key neighbours.
          cx: R.x + 1 + G.x + 2 + p.rect.x + p.rect.w / 2,
          cy: R.y + REGION_HEAD + G.y + GROUP_HEAD + 2 + p.rect.y + p.rect.h / 2
        }
      })
      return [{ bucket: g.bucket, count: g.blocks.length, style: styleOf(G, bodyW, bodyH), cells }]
    })

    return [{ region, style: styleOf(R, W, H), groups: groupLayouts }]
  })
})

const navCells = computed(() => layout.value.flatMap((r) => r.groups.flatMap((g) => g.cells)))

// ---- presentation helpers ----------------------------------------------------------------------

const BUCKET_ICON = { ready: CircleCheck, review: CircleHelp, 'in-use': Lock } as const

const BORDER_CLASS: Record<Bucket, string> = {
  ready: 'border-green-line',
  review: 'border-warning-line',
  'in-use': 'border-border-2'
}
const FILL_CLASS: Record<Bucket, string> = {
  ready: 'bg-green-soft',
  review: 'bg-warning-soft tm-hatch',
  'in-use': 'bg-surface-2'
}
const INK_CLASS: Record<Bucket, string> = {
  ready: 'text-green',
  review: 'text-warning',
  'in-use': 'text-text-3'
}

const bucketWord = (b: Bucket): string => t(`cleanup.gc.bucket.${b}`)
const sizeOf = (bytes: number, has = true): string => (has ? formatBytes(bytes) : '—')

function blockClasses(b: GcBlock): string[] {
  const st = props.blockState(b.id)
  const checked = props.checked.has(b.id)
  const selected = props.selectedId === b.id
  const linked = props.linkedId === b.id
  const cls = ['tm-block']
  const border =
    checked || selected
      ? 'border-accent ring-1 ring-accent'
      : st === 'failed'
        ? 'border-red-line'
        : st === 'busy'
          ? 'border-accent-line'
          : BORDER_CLASS[b.bucket]
  const fill = st === 'busy' ? 'bg-accent-soft' : FILL_CLASS[b.bucket]
  cls.push(border, fill, b.bucket === 'in-use' ? 'text-text-3' : 'text-text-2')
  if (st === 'done') cls.push('is-done', 'opacity-45', 'border-dashed')
  if (st === 'busy') cls.push('is-busy')
  if (st === 'failed') cls.push('is-failed')
  if (checked) cls.push('is-checked')
  if (selected) cls.push('is-selected')
  if (linked && !checked && !selected) cls.push('is-linked', 'ring-1', 'ring-text-2')
  if (props.planned && b.bucket === 'ready') cls.push('is-planned', 'border-dashed')
  return cls
}

function stateWord(st: BlockJobState | null): string | null {
  return st ? t(`cleanup.gc.map.state.${st}`) : null
}

function blockLabel(b: GcBlock): string {
  const size = sizeOf(b.bytes, b.hasBytes)
  const word = stateWord(props.blockState(b.id))
  return word
    ? t('cleanup.gc.map.blockLabelState', {
        name: b.name,
        bucket: bucketWord(b.bucket),
        size,
        state: word
      })
    : t('cleanup.gc.map.blockLabel', { name: b.name, bucket: bucketWord(b.bucket), size })
}

function blockTitle(b: GcBlock): string {
  return [
    b.name,
    b.repoLabel ?? '',
    sizeOf(b.bytes, b.hasBytes),
    t(reasonKey(b.reasonCode, b.bucket === 'ready'))
  ]
    .filter(Boolean)
    .join('\n')
}

// ---- interaction -------------------------------------------------------------------------------

const refs = new Map<string, HTMLElement>()
function setRef(key: string, el: Element | ComponentPublicInstance | null): void {
  if (el instanceof HTMLElement) refs.set(key, el)
  else refs.delete(key)
}

type Dir = 'left' | 'right' | 'up' | 'down'
const KEY_DIR: Record<string, Dir> = {
  ArrowLeft: 'left',
  ArrowRight: 'right',
  ArrowUp: 'up',
  ArrowDown: 'down'
}

/** The nearest cell strictly in the pressed direction; off-axis distance counts double. */
function neighbour(fromKey: string, dir: Dir): string | null {
  const from = navCells.value.find((c) => c.key === fromKey)
  if (!from) return null
  let best: { key: string; score: number } | null = null
  for (const c of navCells.value) {
    if (c.key === fromKey) continue
    const dx = c.cx - from.cx
    const dy = c.cy - from.cy
    const along = dir === 'right' ? dx : dir === 'left' ? -dx : dir === 'down' ? dy : -dy
    if (along <= 0.5) continue
    const across = dir === 'left' || dir === 'right' ? Math.abs(dy) : Math.abs(dx)
    const score = along + across * 2
    if (!best || score < best.score) best = { key: c.key, score }
  }
  return best?.key ?? null
}

async function focusCell(key: string): Promise<void> {
  await nextTick()
  refs.get(key)?.focus()
}

function onBlockClick(e: MouseEvent, b: GcBlock): void {
  if (props.blockState(b.id) === 'done') return
  if (e.shiftKey) {
    if (isCheckable(b)) emit('toggle', b.id)
    return
  }
  emit('select', b.id)
}

function onKey(e: KeyboardEvent, key: string, b: GcBlock | null): void {
  if (e.key === ' ' && b) {
    // Space toggles a Needs review block (the keyboard twin of Shift+click) and opens any other.
    e.preventDefault()
    if (isCheckable(b)) emit('toggle', b.id)
    else emit('select', b.id)
    return
  }
  const dir = KEY_DIR[e.key]
  if (!dir) return
  e.preventDefault()
  const next = neighbour(key, dir)
  if (next) void focusCell(next)
}

const filterOptions = computed(() => [
  { value: 'all', label: t('cleanup.gc.map.filterAll') },
  { value: 'ready', label: bucketWord('ready') },
  { value: 'review', label: bucketWord('review') },
  { value: 'in-use', label: bucketWord('in-use') }
])

const drilledRegion = computed(() =>
  props.drillRepo ? props.model.regions.find((r) => r.repoPath === props.drillRepo) : null
)
const BUCKETS: Bucket[] = ['ready', 'review', 'in-use']
</script>

<template>
  <div data-testid="treemap" :aria-label="t('cleanup.gc.map.canvasLabel')" role="group">
    <p
      v-if="!model.hasBytes"
      class="rounded border border-border bg-surface px-4 py-6 text-center text-[12px] text-text-3"
      data-testid="treemap-no-bytes"
    >
      {{ t('cleanup.gc.map.noBytes') }}
    </p>

    <template v-else>
      <!-- Drilled-in breadcrumb + bucket filter (design.md "Treemap"). -->
      <div v-if="drillRepo" class="mb-2 flex items-center gap-3" data-testid="treemap-crumb">
        <button
          type="button"
          class="inline-flex items-center gap-1 rounded-sm border border-border bg-transparent px-2.5 py-1 text-[12px] font-medium text-text-2 transition hover:bg-surface-2"
          data-testid="treemap-back"
          @click="emit('drill', null)"
        >
          <ChevronLeft :size="13" :stroke-width="1.8" />
          {{ t('cleanup.gc.map.drillBack') }}
        </button>
        <span class="text-[12.5px] font-semibold text-text-2">{{ drilledRegion?.label }}</span>
        <SegmentedControl
          v-model="bucketFilter"
          class="ml-auto"
          size="sm"
          :options="filterOptions"
          :aria-label="t('cleanup.gc.map.filterLabel')"
        />
      </div>

      <p v-if="layout.length === 0" class="py-8 text-center text-[12px] text-text-3">
        {{ t('cleanup.gc.map.empty') }}
      </p>

      <div
        ref="canvasEl"
        class="relative overflow-hidden"
        :style="{ height: canvasH + 'px' }"
        data-testid="treemap-canvas"
      >
        <section
          v-for="r in layout"
          :key="r.region.repoPath"
          class="tm-region absolute overflow-hidden rounded border border-border bg-surface"
          :style="r.style"
          data-testid="treemap-region"
        >
          <header
            class="flex items-center gap-2.5 overflow-hidden whitespace-nowrap border-b border-border px-3"
            :style="{ height: REGION_HEAD + 'px' }"
          >
            <button
              type="button"
              class="min-w-0 truncate text-[12.5px] font-semibold text-text-2 transition hover:text-text"
              :aria-label="t('cleanup.gc.map.drillRepo', { repo: r.region.label })"
              data-testid="treemap-repo"
              @click="emit('drill', r.region.repoPath)"
            >
              {{ r.region.label }}
            </button>
            <span class="tm-rmeta shrink-0 text-[11px] text-text-4">
              {{
                t(
                  'cleanup.gc.map.repoMeta',
                  { count: r.region.worktrees, size: formatBytes(r.region.bytes) },
                  r.region.worktrees
                )
              }}
            </span>
            <span class="ml-auto flex shrink-0 items-center gap-1">
              <template v-for="b in BUCKETS" :key="b">
                <span
                  v-if="r.region.counts[b] > 0"
                  class="tm-badge inline-flex items-center gap-1 rounded-full border px-2 text-[11px] leading-4"
                  :class="{
                    'border-green-line bg-green-soft text-green': b === 'ready',
                    'border-warning-line bg-warning-soft text-warning': b === 'review',
                    'border-border bg-surface text-text-3': b === 'in-use'
                  }"
                  :title="`${bucketWord(b)}: ${r.region.counts[b]}`"
                  :data-testid="`treemap-count-${b}`"
                >
                  <component :is="BUCKET_ICON[b]" :size="10" :stroke-width="1.8" />
                  {{ r.region.counts[b] }}
                </span>
              </template>
              <template v-if="r.region.counts.review > 0">
                <button
                  type="button"
                  class="tm-sel-label ml-1 text-[11px] text-text-2 transition hover:text-text"
                  :aria-label="t('cleanup.gc.map.selectAllAria', { repo: r.region.label })"
                  data-testid="treemap-select-all"
                  @click="emit('selectAllInRepo', r.region.repoPath)"
                >
                  {{ t('cleanup.gc.map.selectAll') }}
                </button>
                <button
                  type="button"
                  class="tm-sel-icon h-[22px] w-[22px] items-center justify-center rounded-sm text-text-2 transition hover:bg-surface-2"
                  :aria-label="t('cleanup.gc.map.selectAllAria', { repo: r.region.label })"
                  :title="t('cleanup.gc.map.selectAll')"
                  data-testid="treemap-select-all-icon"
                  @click="emit('selectAllInRepo', r.region.repoPath)"
                >
                  <ListChecks :size="13" :stroke-width="1.7" />
                </button>
              </template>
            </span>
          </header>

          <div class="relative" :style="{ height: `calc(100% - ${REGION_HEAD}px)` }">
            <div
              v-for="g in r.groups"
              :key="g.bucket"
              class="absolute"
              :style="g.style"
              :data-testid="`treemap-group-${g.bucket}`"
            >
              <div class="absolute flex flex-col" style="inset: 2px">
                <div
                  class="flex items-center gap-1.5 overflow-hidden whitespace-nowrap px-1"
                  :class="INK_CLASS[g.bucket]"
                  :style="{ height: GROUP_HEAD + 'px' }"
                >
                  <component :is="BUCKET_ICON[g.bucket]" :size="12" :stroke-width="1.7" />
                  <span class="text-[10.5px] font-medium uppercase tracking-[0.07em]">
                    {{ t(`cleanup.gc.bucket.header.${g.bucket}`) }}
                  </span>
                  <span class="ml-auto text-[11px] text-text-3">{{ g.count }}</span>
                </div>
                <div class="relative flex-1">
                  <div v-for="c in g.cells" :key="c.key" class="tm-cell absolute" :style="c.style">
                    <!-- "N smaller" aggregate -->
                    <button
                      v-if="!c.block"
                      :ref="(el) => setRef(c.key, el)"
                      type="button"
                      class="tm-block tm-agg border border-dotted"
                      :class="[BORDER_CLASS[c.bucket], FILL_CLASS[c.bucket]]"
                      :aria-label="
                        t('cleanup.gc.map.aggregateLabel', {
                          count: c.folded.length,
                          bucket: bucketWord(c.bucket),
                          size: formatBytes(c.bytes)
                        })
                      "
                      :title="t('cleanup.gc.map.aggregate', { count: c.folded.length })"
                      data-testid="treemap-aggregate"
                      @click="
                        emit(
                          'openAggregate',
                          c.folded.map((b) => b.id),
                          c.bucket
                        )
                      "
                      @keydown="onKey($event, c.key, null)"
                    >
                      <span class="tm-b-agg-name">{{
                        t('cleanup.gc.map.aggregate', { count: c.folded.length })
                      }}</span>
                      <span class="tm-b-size" :class="INK_CLASS[c.bucket]">{{
                        formatBytes(c.bytes)
                      }}</span>
                    </button>

                    <!-- a worktree block -->
                    <button
                      v-else
                      :ref="(el) => setRef(c.key, el)"
                      type="button"
                      :class="blockClasses(c.block)"
                      :aria-pressed="checked.has(c.block.id)"
                      :aria-label="blockLabel(c.block)"
                      :title="blockTitle(c.block)"
                      :data-block-id="c.block.id"
                      :data-bucket="c.block.bucket"
                      :data-state="blockState(c.block.id) ?? 'rest'"
                      data-testid="treemap-block"
                      @click="onBlockClick($event, c.block)"
                      @keydown="onKey($event, c.key, c.block)"
                    >
                      <span class="tm-b-head">
                        <TriangleAlert
                          v-if="blockState(c.block.id) === 'failed'"
                          class="tm-b-ico text-red"
                          :size="11"
                          :stroke-width="1.8"
                        />
                        <component
                          :is="BUCKET_ICON[c.block.bucket]"
                          v-else
                          class="tm-b-ico"
                          :class="INK_CLASS[c.block.bucket]"
                          :size="11"
                          :stroke-width="1.8"
                        />
                        <span class="tm-b-name">{{ c.block.name }}</span>
                        <span class="tm-b-short">{{
                          ticketParts(c.block.name, c.block.branch)?.short ?? c.block.name
                        }}</span>
                        <span class="tm-b-tiny">{{
                          ticketParts(c.block.name, c.block.branch)?.tiny ?? ''
                        }}</span>
                      </span>
                      <span
                        class="tm-b-size"
                        :class="
                          blockState(c.block.id) === 'failed'
                            ? 'text-red'
                            : INK_CLASS[c.block.bucket]
                        "
                      >
                        {{ sizeOf(c.block.bytes, c.block.hasBytes) }}
                      </span>
                      <span
                        v-if="blockState(c.block.id) === 'done'"
                        class="tm-b-freed inline-flex items-center gap-[3px] text-[11px] text-text-3"
                        data-testid="treemap-freed"
                      >
                        <Check :size="10" :stroke-width="2" />{{ t('cleanup.gc.map.freed') }}
                      </span>
                      <span
                        v-if="blockState(c.block.id) === 'busy'"
                        class="tm-pdot"
                        data-testid="treemap-busy-dot"
                      />
                      <span
                        v-if="blockState(c.block.id) === 'busy'"
                        class="tm-b-prog"
                        data-testid="treemap-busy-bar"
                        ><i
                      /></span>
                      <span
                        v-if="checked.has(c.block.id)"
                        class="tm-b-check"
                        data-testid="treemap-check"
                        aria-hidden="true"
                      >
                        <Check :size="11" :stroke-width="2.4" />
                      </span>
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>
      </div>
    </template>
  </div>
</template>

<style scoped>
.tm-region {
  container: tmregion / inline-size;
}
.tm-sel-icon {
  display: none;
}
@container tmregion (max-width: 300px) {
  .tm-sel-label {
    display: none;
  }
  .tm-sel-icon {
    display: inline-flex;
  }
}
@container tmregion (max-width: 200px) {
  .tm-rmeta {
    display: none;
  }
}

.tm-cell {
  container-type: size;
}
.tm-block {
  position: absolute;
  inset: 2px;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 2px;
  overflow: hidden;
  padding: 4px 6px;
  text-align: left;
  border-width: 1px;
  border-style: solid;
  border-radius: 3px;
  cursor: pointer;
  transition:
    background var(--dur-fast) var(--ease),
    box-shadow var(--dur-fast) var(--ease),
    opacity var(--dur-slow) var(--ease);
}
.tm-block.is-done {
  cursor: default;
}
.tm-agg {
  border-style: dotted;
}
.tm-b-agg-name {
  font-size: 11px;
  line-height: 14px;
  font-style: italic;
  white-space: nowrap;
}
.tm-hatch:not(.is-busy) {
  background-image: repeating-linear-gradient(
    135deg,
    transparent 0 4px,
    var(--color-warning-soft) 4px 8px
  );
}
.tm-b-head {
  display: flex;
  align-items: center;
  gap: 4px;
  min-width: 0;
  max-width: 100%;
}
.tm-b-ico {
  flex: none;
}
.tm-b-name,
.tm-b-short,
.tm-b-tiny,
.tm-b-size {
  overflow: hidden;
  font-size: 11px;
  line-height: 14px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tm-b-short,
.tm-b-tiny {
  display: none;
}
.tm-b-check {
  position: absolute;
  top: 3px;
  right: 3px;
  display: inline-flex;
  width: 16px;
  height: 16px;
  align-items: center;
  justify-content: center;
  border-radius: 3px;
  background: var(--color-accent);
  color: var(--color-accent-ink);
}
.tm-pdot {
  position: absolute;
  top: 6px;
  right: 6px;
  width: 6px;
  height: 6px;
  border-radius: 999px;
  background: var(--color-accent);
  box-shadow: 0 0 0 3px var(--color-accent-soft);
}
.tm-b-prog {
  position: absolute;
  right: 6px;
  bottom: 4px;
  left: 6px;
  height: 2px;
  overflow: hidden;
  border-radius: 999px;
  background: var(--color-border);
}
.tm-b-prog i {
  display: block;
  width: 40%;
  height: 100%;
  background: var(--color-accent);
}

/* Label ladder: full name → ticket id → #id → size only → icon only. */
@container (max-width: 150px) {
  .tm-b-name {
    display: none;
  }
  .tm-b-short {
    display: inline;
  }
}
@container (max-width: 88px) {
  .tm-b-short {
    display: none;
  }
  .tm-b-tiny {
    display: inline;
  }
}
@container (max-width: 60px) {
  .tm-b-head {
    display: none;
  }
  .tm-block {
    padding: 2px;
  }
}
@container (max-height: 30px) {
  .tm-b-name,
  .tm-b-short,
  .tm-b-tiny,
  .tm-b-freed {
    display: none;
  }
}
@container (max-width: 34px) {
  .tm-b-head {
    display: flex;
  }
  .tm-b-name,
  .tm-b-short,
  .tm-b-tiny,
  .tm-b-size,
  .tm-b-freed,
  .tm-b-agg-name {
    display: none;
  }
}
@container (max-height: 24px) {
  .tm-b-size,
  .tm-b-freed {
    display: none;
  }
  .tm-b-head {
    display: flex;
  }
}
</style>
