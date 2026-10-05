<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { X, TriangleAlert, House, Check, PackageMinus, Loader2, ShieldCheck } from 'lucide-vue-next'
import { useReaperStore } from '../stores/reaper'
import { useFocusTrap } from '../composables/useFocusTrap'
import { formatBytes } from './system-monitor-format'
import { identText, identTitle } from './cleanup-ident'
import { SKIP_REASON_KEYS } from './cleanup-row'
import type { ReapItem, DehydrateResult, DehydrateSkip } from '../../../preload'

/**
 * Dehydrate confirm (T250, design.md "Dehydrate confirm dialog"). Borrows
 * `SweepConfirmDialog`'s shape — Teleport → overlay-fade backdrop →
 * fade-in-scale card, focus trap, Esc + backdrop close — and none of its copy:
 * a sweep deletes work behind an archive, dehydration deletes only regenerable
 * folders with no net at all, and the dialog has to say exactly that.
 *
 * Three things it is honest about, each its own block: nothing removed is work;
 * nothing goes to the trash (no undo there); a worktree whose manifest has no
 * `setup` cannot be rehydrated by Harnu.
 *
 * One mount serves the per-row Dehydrate button (one item) and the repo-group
 * "Dehydrate N idle" pill (every idle item in the group).
 */
const props = defineProps<{ items: ReapItem[] }>()
const emit = defineEmits<{ close: [success: boolean] }>()

const store = useReaperStore()
const { t } = useI18n()

function dirsText(item: ReapItem): string {
  const dirs = item.hydration?.removable ?? []
  const bytes = item.hydration?.reclaimableBytes ?? null
  const size = bytes !== null ? formatBytes(bytes) : t('cleanup.dehydrateConfirm.sizeUnknown')
  return [...dirs, size].join(' · ')
}

function skipText(skip: DehydrateSkip): string {
  return `${skip.path} — ${t(`cleanup.dehydrateConfirm.skip.${SKIP_REASON_KEYS[skip.reason]}`)}`
}

const noSetupItems = computed(() => props.items.filter((i) => i.hydration?.canRehydrate === false))

// --- Totals --------------------------------------------------------------------
const knownBytes = computed(() =>
  props.items.reduce((sum, i) => sum + (i.hydration?.reclaimableBytes ?? 0), 0)
)
const unmeasured = computed(
  () => props.items.filter((i) => (i.hydration?.reclaimableBytes ?? null) === null).length
)

// --- Confirm / progress -----------------------------------------------------------
const running = ref(false)
const started = ref(false)
const requestError = ref<string | null>(null)
/** Results for THIS dialog's run only — see `SweepConfirmDialog`'s `started`. */
const results = computed<DehydrateResult[]>(() => (started.value ? store.dehydrateProgress : []))
const done = computed(() => started.value && !running.value)
const anyFailed = computed(() => results.value.some((r) => !r.ok))

function resultFor(item: ReapItem): DehydrateResult | undefined {
  return results.value.find((r) => r.itemId === item.id)
}

function failureLines(result: DehydrateResult): string[] {
  const lines: string[] = []
  if (result.error) lines.push(result.error)
  for (const f of result.failed) {
    lines.push(t('cleanup.dehydrateConfirm.failed', { path: f.path, error: f.error }))
  }
  if (result.trackedChanged.length > 0) {
    lines.push(
      t('cleanup.dehydrateConfirm.trackedChanged', { files: result.trackedChanged.join(', ') })
    )
  }
  for (const s of result.skipped) lines.push(skipText(s))
  return lines
}

async function confirm(): Promise<void> {
  if (running.value) return
  running.value = true
  started.value = true
  requestError.value = null
  try {
    await store.dehydrate(props.items.map((i) => i.id))
  } catch (e) {
    requestError.value = e instanceof Error ? e.message : String(e)
  } finally {
    running.value = false
  }
  if (!anyFailed.value && requestError.value === null) close()
}

function close(): void {
  if (running.value) return
  emit('close', done.value && !anyFailed.value && requestError.value === null)
}

// --- Focus trap + backdrop click + keyboard ----------------------------------------
const dialogRef = ref<HTMLElement | null>(null)
const confirmButtonRef = ref<HTMLElement | null>(null)

useFocusTrap({
  active: computed(() => true),
  containerRef: dialogRef,
  initialFocusRef: confirmButtonRef
})

function onBackdropMousedown(e: MouseEvent): void {
  if (e.target === e.currentTarget) close()
}

function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape') {
    e.stopPropagation()
    close()
  }
}

window.addEventListener('keydown', onKeydown, true)
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown, true)
})
</script>

<template>
  <Teleport to="body">
    <div
      class="anim-overlay-fade fixed inset-0 flex items-center justify-center"
      style="background: rgba(0, 0, 0, 0.55); z-index: 60"
      role="presentation"
      @mousedown="onBackdropMousedown"
    >
      <div
        ref="dialogRef"
        class="anim-fade-in-scale flex flex-col border border-border-2 bg-surface text-text"
        style="
          width: min(560px, 90vw);
          max-height: 84vh;
          border-radius: 10px;
          box-shadow: var(--shadow-pop);
        "
        role="dialog"
        aria-modal="true"
        aria-labelledby="dehydrate-confirm-dialog-title"
        data-testid="dehydrate-confirm"
        @mousedown.stop
      >
        <header class="shrink-0 border-b border-border" style="padding: 18px 20px 6px">
          <div class="flex items-start justify-between gap-3">
            <h2
              id="dehydrate-confirm-dialog-title"
              class="text-text"
              style="font-size: 15px; line-height: 22px; font-weight: 500"
            >
              {{ t('cleanup.dehydrateConfirm.title', { count: items.length }, items.length) }}
            </h2>
            <button
              class="flex shrink-0 items-center justify-center rounded text-text-3 transition hover:bg-surface-2 hover:text-text"
              style="width: 24px; height: 24px"
              :disabled="running"
              :aria-label="t('cleanup.dehydrateConfirm.close')"
              @click="close()"
            >
              <X :size="14" :stroke-width="1.5" />
            </button>
          </div>
          <p class="text-text-3" style="font-size: 12px; margin: 5px 0 12px; line-height: 1.5">
            {{ t('cleanup.dehydrateConfirm.subtitle') }}
          </p>
        </header>

        <div class="scrollable flex-1 overflow-y-auto" style="padding: 12px 20px">
          <div class="flex flex-col gap-1.5">
            <div
              v-for="item in items"
              :key="item.id"
              class="rounded-sm border border-border bg-surface-2 px-2.5 py-[7px] text-[12px]"
            >
              <div class="flex items-center gap-2.5">
                <House :size="12" :stroke-width="1.6" class="shrink-0 text-text-4" />
                <span
                  class="truncate font-mono text-[11.5px] text-text"
                  :title="identTitle(item)"
                  >{{ identText(item) }}</span
                >
                <span class="ml-auto shrink-0 font-mono text-[10.5px] text-text-4">{{
                  dirsText(item)
                }}</span>
                <template v-if="resultFor(item)">
                  <Check
                    v-if="resultFor(item)!.ok"
                    :size="13"
                    :stroke-width="2"
                    class="shrink-0 text-green"
                  />
                  <TriangleAlert v-else :size="13" :stroke-width="2" class="shrink-0 text-red" />
                </template>
              </div>
              <p
                v-if="item.hydration?.canRehydrate === false"
                class="mt-1 pl-[22px] text-[11px] leading-relaxed text-warning"
              >
                {{ t('cleanup.dehydrateConfirm.noSetup') }}
              </p>
              <template v-if="item.hydration && item.hydration.skipped.length > 0">
                <p class="mt-1 pl-[22px] text-[10.5px] font-medium text-text-3">
                  {{ t('cleanup.dehydrateConfirm.keptTitle') }}
                </p>
                <ul class="pl-[22px]">
                  <li
                    v-for="skip in item.hydration.skipped"
                    :key="`${item.id}-${skip.path}`"
                    class="truncate font-mono text-[10.5px] text-text-3"
                    :title="skipText(skip)"
                  >
                    {{ skipText(skip) }}
                  </li>
                </ul>
              </template>
            </div>
          </div>

          <!-- Honest on point 1: nothing removed is work. Neutral chrome — this
               is the guarantee, not a hazard. -->
          <div class="mt-2 rounded border border-border bg-surface-2 px-3 py-2.5">
            <div class="flex items-start gap-2.5">
              <ShieldCheck :size="13" :stroke-width="1.8" class="mt-[1px] shrink-0 text-text-3" />
              <div class="text-[11.5px] leading-relaxed text-text-2">
                <span class="font-medium text-text">{{
                  t('cleanup.dehydrateConfirm.regenerableTitle')
                }}</span>
                <p class="mt-0.5 text-text-3">
                  {{ t('cleanup.dehydrateConfirm.regenerableBody') }}
                </p>
                <p class="mt-1 text-text-3">{{ t('cleanup.dehydrateConfirm.rehydrateNote') }}</p>
              </div>
            </div>
          </div>

          <!-- Honest on point 2: no trash, so no undo there. Warning chrome — the
               same `border-warning/35 bg-warning/8` block the sweep dialog's
               remote warning uses. -->
          <div
            class="mt-2 flex items-start gap-2.5 rounded border border-warning/35 bg-warning/8 px-3 py-2.5"
          >
            <TriangleAlert :size="13" :stroke-width="2" class="mt-[1px] shrink-0 text-warning" />
            <div class="text-[11.5px] leading-relaxed text-text-2">
              <span class="font-medium text-warning">{{
                t('cleanup.dehydrateConfirm.permanentTitle')
              }}</span>
              <p class="mt-0.5">{{ t('cleanup.dehydrateConfirm.permanentBody') }}</p>
              <!-- Honest on point 3, restated at batch level so it survives a
                   long list: which of these Harnu cannot bring back. -->
              <p v-if="noSetupItems.length > 0" class="mt-1 font-medium text-warning">
                {{
                  t(
                    'cleanup.dehydrateConfirm.noSetupCount',
                    { count: noSetupItems.length },
                    noSetupItems.length
                  )
                }}
              </p>
            </div>
          </div>

          <div
            v-if="requestError"
            class="mt-2.5 rounded-sm border border-red/35 bg-red-soft px-2.5 py-2 text-[11px] text-red"
          >
            {{ requestError }}
          </div>

          <div v-if="done && anyFailed" class="mt-2.5 flex flex-col gap-1.5">
            <div
              v-for="item in items.filter((i) => resultFor(i) && !resultFor(i)!.ok)"
              :key="`err-${item.id}`"
              class="rounded-sm border border-red/35 bg-red-soft px-2.5 py-2 text-[11px] text-red"
            >
              <span class="font-mono">{{ identText(item) }}</span>
              <ul class="mt-0.5">
                <li v-for="(line, i) in failureLines(resultFor(item)!)" :key="i">{{ line }}</li>
              </ul>
            </div>
          </div>
        </div>

        <footer
          class="flex shrink-0 items-center justify-between border-t border-border"
          style="padding: 14px 20px 18px"
        >
          <span class="text-[11.5px] text-text-3">
            <i18n-t
              :keypath="
                unmeasured > 0
                  ? 'cleanup.dehydrateConfirm.totalsUnknown'
                  : 'cleanup.dehydrateConfirm.totals'
              "
              scope="global"
            >
              <template #worktrees>
                <b class="text-text">{{ items.length }}</b>
              </template>
              <template #size>
                <b class="text-text">{{ formatBytes(knownBytes) }}</b>
              </template>
              <template #unknown>
                <b class="text-text">{{ unmeasured }}</b>
              </template>
            </i18n-t>
          </span>
          <span class="flex items-center gap-2">
            <button
              class="border border-border bg-transparent text-text-2 transition hover:text-text"
              style="
                padding: 7px 14px;
                font-size: 12.5px;
                font-weight: 500;
                border-radius: 5px;
                height: 28px;
              "
              :disabled="running"
              @click="close()"
            >
              {{
                done ? t('cleanup.dehydrateConfirm.close') : t('cleanup.dehydrateConfirm.cancel')
              }}
            </button>
            <button
              v-if="!done"
              ref="confirmButtonRef"
              class="inline-flex items-center bg-accent-soft text-accent transition hover:opacity-80"
              style="
                gap: 6px;
                padding: 7px 14px;
                font-size: 12.5px;
                font-weight: 500;
                border-radius: 5px;
                border: none;
                height: 28px;
              "
              :style="{ opacity: running ? 0.4 : 1, cursor: running ? 'not-allowed' : 'pointer' }"
              :disabled="running"
              @click="confirm()"
            >
              <Loader2
                v-if="running"
                :size="13"
                :stroke-width="1.8"
                class="shrink-0 animate-spin"
              />
              <PackageMinus v-else :size="13" :stroke-width="1.8" />
              {{ t('cleanup.dehydrateConfirm.confirm') }}
            </button>
          </span>
        </footer>
      </div>
    </div>
  </Teleport>
</template>
