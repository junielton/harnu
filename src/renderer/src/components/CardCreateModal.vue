<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { X } from 'lucide-vue-next'
import SegmentedControl from './ui/SegmentedControl.vue'
import { KIND_FILTERS } from '../lib/board-filters'
import { useRoadmapStore } from '../stores/roadmap'
import { useUiStore } from '../stores/ui'
import type { RoadmapWriteCode } from '../../../preload'

/**
 * Create-mode dossier (T80 S2 PR3, design.md §6 "Create mode") — the board's
 * `+ New card`. A sibling of `CardDetailModal` rather than a branch inside it:
 * there is no `RoadmapCard` yet, so the header/body/footer are purpose-built
 * instead of threading a `creating` flag through the already-dense detail
 * template. Same modal chrome (Teleport, overlay, frame classes).
 *
 * Status is fixed Backlog (never an input, §0/T96 invariant — the card is
 * always born there). Kind/complexity replace the header's read-mode chips as
 * segmented pickers. The body is ONE raw textarea (same visual treatment as
 * the detail modal's edit-mode textarea) seeded with the selected kind's
 * delegation-packet template — the SAME template `create_card` seeds
 * (`roadmap:cardTemplates`, `resources/board-templates/<kind>.md`) — reseeded
 * on kind change ONLY while the operator hasn't diverged the body (dirty
 * check): editing first "locks" the body, so switching kind afterward no
 * longer clobbers work in progress.
 */

const emit = defineEmits<{
  close: []
  created: [slug: string]
}>()

const { t } = useI18n()
const roadmap = useRoadmapStore()
const ui = useUiStore()

const KIND_OPTIONS = KIND_FILTERS.map((k) => ({ value: k, label: k }))
const COMPLEXITY_VALUES = ['trivial', 'simple', 'standard', 'complex'] as const
const COMPLEXITY_OPTIONS = COMPLEXITY_VALUES.map((c) => ({ value: c, label: c }))

// Defaults mirror the canonical mockup's own default-selected pills (first
// kind option, the "standard" tier) — a reasonable starting point, not a
// meaningful product default; the operator picks before typing a word.
const kind = ref<string>(KIND_FILTERS[0])
const complexity = ref<string>('standard')
const title = ref('')
const body = ref('')
const titleInputRef = ref<HTMLInputElement | null>(null)
const submitting = ref(false)

let templates: Record<string, string> = {}
/** The kind the current `body` was last seeded for (`null` before templates load). */
const seededFor = ref<string | null>(null)

/** Dirty once a title exists or the body no longer matches the last-seeded template. */
const dirty = computed(
  () =>
    Boolean(title.value.trim()) ||
    body.value !== (seededFor.value !== null ? (templates[seededFor.value] ?? '') : '')
)

function reseed(next: string): void {
  body.value = templates[next] ?? ''
  seededFor.value = next
}

watch(kind, (next) => {
  // Reseed only while the body still matches what was last seeded — an
  // operator-edited body is left alone (the dirty check above, mirrored here).
  if (seededFor.value === null || body.value === (templates[seededFor.value] ?? '')) {
    reseed(next)
  }
})

function writeError(code: RoadmapWriteCode): string {
  return t(`roadmap.dispatch.error.${code}`)
}

function withDiscardGuard(proceed: () => void): void {
  if (!dirty.value) {
    proceed()
    return
  }
  ui.pushToast({
    kind: 'warning',
    title: t('markdownPane.unsaved.title'),
    timeoutMs: 0,
    action: { label: t('markdownPane.unsaved.discard'), handler: proceed }
  })
}

function attemptClose(): void {
  withDiscardGuard(() => emit('close'))
}

async function submit(): Promise<void> {
  const trimmed = title.value.trim()
  if (!trimmed || submitting.value) return
  submitting.value = true
  try {
    const res = await roadmap.createCard({
      title: trimmed,
      kind: kind.value,
      complexity: complexity.value,
      body: body.value
    })
    if (!res.ok) {
      ui.pushToast({ kind: 'danger', title: writeError(res.code) })
      return
    }
    emit('created', res.slug)
  } finally {
    submitting.value = false
  }
}

function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape') {
    e.stopPropagation()
    attemptClose()
  }
}

onMounted(async () => {
  window.addEventListener('keydown', onKeydown, true)
  templates = await roadmap.cardTemplates()
  reseed(kind.value)
  void nextTick(() => titleInputRef.value?.focus())
})
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown, true))
</script>

<template>
  <Teleport to="body">
    <div
      class="anim-overlay-fade fixed inset-0 z-[65] flex items-center justify-center bg-black/40"
      @click.self="attemptClose"
    >
      <div
        class="anim-fade-in-scale flex max-h-[88vh] w-[min(760px,94vw)] flex-col overflow-hidden rounded-lg border border-border bg-bg shadow-pop"
        role="dialog"
        aria-modal="true"
        :aria-label="$t('roadmap.create.title')"
      >
        <!-- Header: status chip fixed Backlog + kind/tier segmented pickers + close -->
        <div class="flex shrink-0 flex-wrap items-center gap-2 px-3.5 pt-3">
          <span
            class="inline-flex items-center gap-1.5 rounded-full border border-border-2 bg-surface-2 px-2 py-0.5 text-[11px] text-text-2"
          >
            <span class="h-1.5 w-1.5 rounded-full border border-text-4" />
            {{ $t('roadmap.columns.backlog') }}
          </span>
          <SegmentedControl
            v-model="kind"
            :options="KIND_OPTIONS"
            size="sm"
            :aria-label="$t('roadmap.create.kindLabel')"
          />
          <SegmentedControl
            v-model="complexity"
            :options="COMPLEXITY_OPTIONS"
            size="sm"
            :aria-label="$t('roadmap.create.tierLabel')"
          />
          <span class="flex-1" />
          <button
            class="flex shrink-0 items-center justify-center rounded p-1 text-text-4 transition hover:bg-surface-2 hover:text-text-2"
            :title="$t('roadmap.detail.close')"
            :aria-label="$t('roadmap.detail.close')"
            @click="attemptClose"
          >
            <X :size="14" :stroke-width="1.7" />
          </button>
        </div>

        <!-- Body: title input (underline) + one raw textarea (seeded with the kind template) -->
        <div class="scrollable min-h-0 flex-1 overflow-y-auto px-[18px] pb-5 pt-2">
          <input
            ref="titleInputRef"
            v-model="title"
            type="text"
            :placeholder="$t('roadmap.create.titlePlaceholder')"
            class="mb-[18px] mt-1.5 w-full border-b border-border-2 bg-transparent text-[16px] font-medium leading-snug text-text outline-none focus:border-accent-line"
          />
          <textarea
            v-model="body"
            spellcheck="false"
            class="min-h-[320px] w-full rounded-md border border-border-2 bg-surface p-2.5 font-mono text-[12px] leading-relaxed text-text-2 outline-none transition focus:border-accent-line"
          />
        </div>

        <!-- Footer: "Born in Backlog…" hint + Cancel + Create card -->
        <div
          class="flex shrink-0 items-center gap-2.5 border-t border-border bg-sidebar px-3.5 py-2.5"
        >
          <span class="text-[10.5px] text-text-4">{{ $t('roadmap.create.hint') }}</span>
          <span class="flex-1" />
          <button
            class="rounded-sm border border-border-2 bg-surface-2 px-2.5 py-1 text-[11px] text-text-2 transition hover:border-text-4 hover:text-text"
            @click="attemptClose"
          >
            {{ $t('roadmap.detail.cancel') }}
          </button>
          <button
            class="inline-flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-[12px] font-medium text-accent-ink transition hover:brightness-110 disabled:opacity-50"
            :disabled="!title.trim() || submitting"
            @click="submit"
          >
            {{ $t('roadmap.create.submit') }}
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>
