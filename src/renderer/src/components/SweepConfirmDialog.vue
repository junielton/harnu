<script setup lang="ts">
import { computed, onBeforeUnmount, ref, type Component } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  X,
  Trash2,
  TriangleAlert,
  House,
  GitBranch,
  Archive,
  Cloud,
  Check,
  FileQuestion,
  Loader2
} from 'lucide-vue-next'
import { useReaperStore } from '../stores/reaper'
import { useFocusTrap } from '../composables/useFocusTrap'
import { formatBytes } from './system-monitor-format'
import { identText, identTitle } from './cleanup-ident'
import ToggleSwitch from './ui/ToggleSwitch.vue'
import type { ReapItem, ReapItemKind, CleanResult } from '../../../preload'

/**
 * Sweep confirm — the single destructive-action gate for the Reaper cleanup
 * engine (plan Task 10, `docs/plans/2026-07-15-reaper-cleanup.md`). Visual
 * contract: `docs/specs/2026-07-17-reaper-cleanup/spec.html`
 * (`sweep-confirm-dialog`). Follows `RemoveWorktreeDialog.vue`'s Dialog
 * anatomy (design.md §6 "Dialog"): Teleport → overlay-fade backdrop →
 * fade-in-scale card → header/body/footer, focus trap, Esc + backdrop close.
 *
 * `CleanupView` mounts this for BOTH entry points — the toolbar Sweep button
 * (all currently-harvestable items) and a per-item trash click (a single-item
 * `items` array) — so there is exactly one confirm path, never a divergent
 * shortcut for the single-item case.
 */
const props = defineProps<{ items: ReapItem[] }>()
const emit = defineEmits<{ close: [success: boolean] }>()

const store = useReaperStore()
const { t } = useI18n()

const KIND_ICON: Record<ReapItemKind, Component> = {
  worktree: House,
  'local-branch': GitBranch,
  'hidden-folder': Archive,
  'remote-branch': Cloud,
  'detached-worktree': House
}

const KIND_WHAT_KEYS: Record<ReapItemKind, string> = {
  worktree: 'worktree',
  'local-branch': 'localBranch',
  'hidden-folder': 'hiddenFolder',
  'remote-branch': 'remoteBranch',
  // Unreachable: a detached worktree is never harvestable, so it never reaches
  // this dialog. Present only because the map must be total over ReapItemKind.
  'detached-worktree': 'detachedWorktree'
}

function kindIcon(kind: ReapItemKind): Component {
  return KIND_ICON[kind]
}

function whatText(item: ReapItem): string {
  const what = t(`cleanup.sweepConfirm.what.${KIND_WHAT_KEYS[item.kind]}`)
  return item.diskBytes !== null ? `${what} · ${formatBytes(item.diskBytes)}` : what
}

// --- Totals (dialog.foot "totals" line) -------------------------------------
// worktrees = folder-backed items (trashed); branches = every item (each
// harvestable item always carries an associated branch delete step).
const worktreeCount = computed(
  () => props.items.filter((i) => i.kind === 'worktree' || i.kind === 'hidden-folder').length
)
const branchCount = computed(() => props.items.length)
const totalBytes = computed(() => props.items.reduce((sum, i) => sum + (i.diskBytes ?? 0), 0))

// --- Untracked disclosure (BUG-75) -------------------------------------------
// Untracked files stopped forcing a `blocked` verdict, so a harvestable item can
// now carry content that lives in no commit. This block is the compensation:
// nothing about a sweep may be a surprise, so every untracked path is named
// here — grouped by item, never truncated, never collapsed to a count.
const untrackedGroups = computed(() =>
  props.items
    .filter((i) => i.untracked.length > 0)
    .map((i) => ({ id: i.id, label: identText(i), title: identTitle(i), paths: i.untracked }))
)
const hasUntracked = computed(() => untrackedGroups.value.length > 0)

// --- Remote opt-in (OFF by default) ------------------------------------------
const remoteOptIn = ref(false)
const remoteItems = computed(() => props.items.filter((i) => i.needsRemoteDelete))
const hasRemote = computed(() => remoteItems.value.length > 0)

// --- Confirm / progress -------------------------------------------------------
const running = ref(false)
const singleResult = ref<CleanResult | null>(null)
/**
 * A rejected `reaperClean`/`reaperSweep` call (e.g. the main process refuses
 * a stale item id after the snapshot changed underneath the dialog) — distinct
 * from a per-item `CleanStepResult` failure, which still resolves normally.
 */
const requestError = ref<string | null>(null)
/**
 * Whether THIS dialog instance has run a sweep. `store.progress` is
 * process-wide and only cleared when the next sweep starts, so a dialog
 * reopened after a completed sweep would otherwise read the previous run's
 * results — rendering itself already "done" (items pre-ticked, Sweep button
 * gone) before the user had confirmed anything.
 */
const started = ref(false)
const isSingle = computed(() => props.items.length === 1)
const results = computed<CleanResult[]>(() => {
  if (!started.value) return []
  return isSingle.value ? (singleResult.value ? [singleResult.value] : []) : store.progress
})
const done = computed(() => started.value && !running.value)
const anyFailed = computed(() => results.value.some((r) => !r.ok))

function resultFor(item: ReapItem): CleanResult | undefined {
  return results.value.find((r) => r.itemId === item.id)
}

function failedSteps(result: CleanResult): string {
  return result.steps
    .filter((s) => !s.ok && !s.skipped)
    .map((s) => t('cleanup.sweepConfirm.stepFailed', { step: s.id, error: s.error ?? '' }))
    .join('; ')
}

async function confirm(): Promise<void> {
  if (running.value) return
  running.value = true
  started.value = true
  requestError.value = null
  try {
    if (isSingle.value) {
      singleResult.value = await store.cleanItem(props.items[0].id, remoteOptIn.value)
    } else {
      await store.sweepItems(
        props.items.map((i) => i.id),
        remoteOptIn.value
      )
    }
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

// --- Focus trap + backdrop click + keyboard --------------------------------
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
        aria-labelledby="sweep-confirm-dialog-title"
        @mousedown.stop
      >
        <!-- Header -->
        <header class="shrink-0 border-b border-border" style="padding: 18px 20px 6px">
          <div class="flex items-start justify-between gap-3">
            <h2
              id="sweep-confirm-dialog-title"
              class="text-text"
              style="font-size: 15px; line-height: 22px; font-weight: 500"
            >
              {{ t('cleanup.sweepConfirm.title', { count: items.length }) }}
            </h2>
            <button
              class="flex shrink-0 items-center justify-center rounded text-text-3 transition hover:bg-surface-2 hover:text-text"
              style="width: 24px; height: 24px"
              :disabled="running"
              :aria-label="t('cleanup.sweepConfirm.close')"
              @click="close()"
            >
              <X :size="14" :stroke-width="1.5" />
            </button>
          </div>
          <p class="text-text-3" style="font-size: 12px; margin: 5px 0 12px; line-height: 1.5">
            {{ t('cleanup.sweepConfirm.subtitle') }}
          </p>
        </header>

        <!-- Body -->
        <div class="scrollable flex-1 overflow-y-auto" style="padding: 12px 20px">
          <div class="flex flex-col gap-1.5">
            <div
              v-for="item in items"
              :key="item.id"
              class="flex items-center gap-2.5 rounded-sm border border-border bg-surface-2 px-2.5 py-[7px] text-[12px]"
            >
              <component
                :is="kindIcon(item.kind)"
                :size="12"
                :stroke-width="1.6"
                class="shrink-0 text-text-4"
              />
              <span class="truncate font-mono text-[11.5px] text-text" :title="identTitle(item)">{{
                identText(item)
              }}</span>
              <span class="ml-auto shrink-0 text-[10.5px] text-text-4">{{ whatText(item) }}</span>
              <template v-if="resultFor(item)">
                <Check
                  v-if="resultFor(item)!.ok"
                  :size="13"
                  :stroke-width="2"
                  class="shrink-0 text-green"
                  :title="t('cleanup.verdict.harvestable')"
                />
                <TriangleAlert
                  v-else
                  :size="13"
                  :stroke-width="2"
                  class="shrink-0 text-red"
                  :title="failedSteps(resultFor(item)!)"
                />
              </template>
            </div>
          </div>

          <!-- Remote warning block (bg-warning/8 border-warning/35 — opacity
               modifiers on the existing `--warning` token; design.md line
               2208 already documents this exact idiom, no new token needed). -->
          <div
            v-if="hasRemote"
            class="mt-2 flex items-start gap-2.5 rounded border border-warning/35 bg-warning/8 px-3 py-2.5"
          >
            <TriangleAlert :size="13" :stroke-width="2" class="mt-[1px] shrink-0 text-warning" />
            <div class="text-[11.5px] leading-relaxed text-text-2">
              {{ t('cleanup.sweepConfirm.remoteWarning', { count: remoteItems.length }) }}
              <label class="mt-1.5 flex cursor-pointer items-center gap-2 font-medium text-warning">
                <ToggleSwitch
                  v-model="remoteOptIn"
                  :disabled="running"
                  :aria-label="
                    t('cleanup.sweepConfirm.remoteToggle', { count: remoteItems.length })
                  "
                />
                {{ t('cleanup.sweepConfirm.remoteToggle', { count: remoteItems.length }) }}
              </label>
            </div>
          </div>

          <!-- Untracked disclosure (BUG-75) — the paths that go with the
               folder, named in full before anything is deleted. Neutral
               chrome, not a warning: this is preserved work, not a hazard. -->
          <div
            v-if="hasUntracked"
            class="mt-2 rounded border border-border bg-surface-2 px-3 py-2.5"
          >
            <div class="flex items-start gap-2.5">
              <FileQuestion :size="13" :stroke-width="1.8" class="mt-[1px] shrink-0 text-text-3" />
              <div class="text-[11.5px] leading-relaxed text-text-2">
                <span class="font-medium text-text">{{
                  t('cleanup.sweepConfirm.untrackedTitle')
                }}</span>
                <p class="mt-0.5 text-text-3">{{ t('cleanup.sweepConfirm.untrackedBody') }}</p>
              </div>
            </div>
            <div
              v-for="group in untrackedGroups"
              :key="`untracked-${group.id}`"
              class="mt-2 pl-[23px]"
            >
              <div class="truncate font-mono text-[10.5px] text-text-4" :title="group.title">
                {{ group.label }}
              </div>
              <ul class="mt-1 flex flex-col gap-0.5">
                <li
                  v-for="path in group.paths"
                  :key="`${group.id}-${path}`"
                  class="truncate font-mono text-[11px] text-text-2"
                  :title="path"
                >
                  {{ path }}
                </li>
              </ul>
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
              <span class="font-mono">{{ identText(item) }}</span> —
              {{ failedSteps(resultFor(item)!) }}
            </div>
          </div>
        </div>

        <!-- Footer -->
        <footer
          class="flex shrink-0 items-center justify-between border-t border-border"
          style="padding: 14px 20px 18px"
        >
          <span class="text-[11.5px] text-text-3">
            <i18n-t keypath="cleanup.sweepConfirm.totals" scope="global">
              <template #worktrees>
                <b class="text-text">{{ worktreeCount }}</b>
              </template>
              <template #branches>
                <b class="text-text">{{ branchCount }}</b>
              </template>
              <template #size>
                <b class="text-text">{{ formatBytes(totalBytes) }}</b>
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
              {{ done ? t('cleanup.sweepConfirm.close') : t('cleanup.sweepConfirm.cancel') }}
            </button>
            <button
              v-if="!done"
              ref="confirmButtonRef"
              class="inline-flex items-center bg-red-soft text-red transition hover:opacity-80"
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
              <Trash2 v-else :size="13" :stroke-width="1.8" />
              {{ t('cleanup.sweepConfirm.confirm') }}
            </button>
          </span>
        </footer>
      </div>
    </div>
  </Teleport>
</template>
