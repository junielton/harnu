<script setup lang="ts">
/**
 * Missions review dialog (BUG-173 S5, spec §3.5 — design.md §6 "Mission
 * progress" → Missions review dialog). "Missions that need you": every open
 * mission that owes the operator something, in three groups, and the one bulk
 * action Harnu offers — close the finished ones **as delivered**.
 *
 * Mounted once in `App.vue` and opened by `missions.reviewRequest` (the Activity
 * entry's "Review all" and an orphan row), so it works with no session selected:
 * its only writes are the operator's end door, which takes `root` + `missionId`.
 * The primary button never closes anything itself — it opens
 * {@link MissionBulkCloseConfirmDialog}, the only path to the doors.
 *
 * Selection is local. The ready group starts selected, the finished group does
 * not (nobody verified its end), and the others have no checkbox at all. A poll
 * can drop a mission from the selection but never adds one.
 */
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { Check, TriangleAlert, X } from 'lucide-vue-next'
import { useFocusTrap } from '../composables/useFocusTrap'
import {
  bulkCloseReason,
  endWarningHeading,
  endWarnings,
  groupReviewMissions,
  headlineText,
  isBulkCloseable,
  readyIds
} from '../lib/mission-view'
import { firstOwed } from '../lib/mission-cue'
import { useMissionsStore } from '../stores/missions'
import { useSessionsStore } from '../stores/sessions'
import { useUiStore } from '../stores/ui'
import type { MissionDoor, MissionView } from '../../../main/mission-ipc'
import { progressHeadline } from '../../../main/mission-progress'
import Button from './ui/Button.vue'
import MissionBulkCloseConfirmDialog, {
  type BulkCloseItem
} from './MissionBulkCloseConfirmDialog.vue'

const { t } = useI18n()
const missions = useMissionsStore()
const sessions = useSessionsStore()
const ui = useUiStore()

const open = ref(false)
/** The mission the request named: scrolled into view and highlighted until the operator acts. */
const focusId = ref<string | null>(null)
const selected = ref<Set<string>>(new Set())
const confirming = ref(false)
/** The views the confirm was opened with — what the operator reads is what is closed. */
const snapshot = ref<MissionView[]>([])
const progress = ref<{ done: number; total: number } | null>(null)

const dialogRef = ref<HTMLElement | null>(null)
const closeRef = ref<InstanceType<typeof Button> | null>(null)
const closeEl = computed<HTMLElement | null>(() => (closeRef.value?.$el as HTMLElement) ?? null)

const groups = computed(() => groupReviewMissions(missions.views))
const total = computed(
  () => groups.value.ready.length + groups.value.finished.length + groups.value.other.length
)
const selectedCount = computed(() => selected.value.size)
const allReadySelected = computed(
  () =>
    groups.value.ready.length > 0 &&
    groups.value.ready.every((v) => selected.value.has(v.mission.id))
)
const busy = computed(() => progress.value !== null)

// The nested confirm owns focus and Tab while it is open.
useFocusTrap({
  active: computed(() => open.value && !confirming.value),
  containerRef: dialogRef,
  initialFocusRef: closeEl
})

function owed(v: MissionView): string {
  // What the first owed item is, in words — the same line the Activity row prints.
  const item = firstOwed(v)
  switch (item?.kind) {
    case 'blocker':
      return item.reason
    case 'rescope':
      return t('mission.state.rescopePending')
    case 'close':
      return t('mission.state.delivered')
    case 'checks':
      return t(
        'mission.you.checks',
        { count: item.count, steps: stepTitles(v, item.stepIds) },
        item.count
      )
    case 'human-steps':
      return t(
        'mission.you.humanSteps',
        { steps: stepTitles(v, item.stepIds) },
        item.stepIds.length
      )
    case 'review-import':
      return t('mission.you.reviewImport')
    default:
      // Nothing owed (a finished mission nobody asked to close): say where it stands.
      return item === null
        ? headlineText(t, progressHeadline(v.progress))
        : t('mission.state.needsYou')
  }
}

function stepTitles(v: MissionView, ids: readonly string[]): string {
  return ids.map((id) => v.mission.steps.find((s) => s.id === id)?.title || id).join(', ')
}

function isSelected(id: string): boolean {
  return selected.value.has(id)
}

function toggle(id: string): void {
  focusId.value = null
  const next = new Set(selected.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  selected.value = next
}

function toggleAllReady(): void {
  focusId.value = null
  const ids = readyIds(groups.value)
  const next = new Set(selected.value)
  if (allReadySelected.value) for (const id of ids) next.delete(id)
  else for (const id of ids) next.add(id)
  selected.value = next
}

/** A poll may remove a mission from the selection; it never adds one. */
watch(groups, (g) => {
  if (selected.value.size === 0) return
  const closeable = new Set([...g.ready, ...g.finished].map((v) => v.mission.id))
  const next = new Set([...selected.value].filter((id) => closeable.has(id)))
  if (next.size !== selected.value.size) selected.value = next
})

function scrollToFocus(): void {
  const id = focusId.value
  if (!id) return
  const rows = dialogRef.value?.querySelectorAll<HTMLElement>('[data-test="review-row"]') ?? []
  for (const row of rows) if (row.dataset.missionId === id) row.scrollIntoView({ block: 'nearest' })
}

function show(missionId: string | null): void {
  open.value = true
  confirming.value = false
  progress.value = null
  focusId.value = missionId
  selected.value = new Set(readyIds(groups.value))
  void nextTick(scrollToFocus)
}

function dismiss(): void {
  if (busy.value) return
  open.value = false
  confirming.value = false
  focusId.value = null
}

watch(
  () => missions.reviewRequest,
  (req) => {
    if (!req) return
    const claimed = missions.consumeReviewRequest()
    if (claimed) show(claimed.missionId)
  },
  { immediate: true }
)

/** An `other` row: select the owner, then ask its pill to open the mission, like an Activity row. */
function ownerLoaded(v: MissionView): boolean {
  return sessions.findSessionById(v.mission.owner.sessionId) !== null
}

function openMission(v: MissionView): void {
  if (!ownerLoaded(v) || !sessions.activateSession(v.mission.owner.sessionId)) return
  ui.openNavigableView('mission', { missionId: v.mission.id })
  dismiss()
}

const confirmItems = computed<BulkCloseItem[]>(() =>
  snapshot.value.map((v) => ({ id: v.mission.id, title: v.title, warnings: endWarnings(v) }))
)

function openConfirm(): void {
  if (selectedCount.value === 0) return
  const pick = (v: MissionView): boolean => isBulkCloseable(v) && selected.value.has(v.mission.id)
  snapshot.value = [...groups.value.ready, ...groups.value.finished].filter(pick)
  if (snapshot.value.length === 0) return
  focusId.value = null
  confirming.value = true
}

async function runBulk(text: string): Promise<void> {
  const reason = bulkCloseReason(text)
  const doors = snapshot.value.map((v): Extract<MissionDoor, { door: 'end' }> => ({
    door: 'end',
    root: v.root,
    missionId: v.mission.id,
    closedAs: 'delivered',
    reason
  }))
  progress.value = { done: 0, total: doors.length }
  const res = await missions.runDoors(doors, (done, all) => (progress.value = { done, total: all }))
  progress.value = null
  confirming.value = false
  if (res.failed.length === 0) {
    ui.pushToast({
      kind: 'success',
      title: t('mission.bulk.done', { count: res.closed }, res.closed)
    })
    if (total.value === 0) open.value = false
  } else {
    ui.pushToast({
      kind: 'danger',
      title: t('mission.bulk.partial', { failed: res.failed.length, total: doors.length }),
      description: [...new Set(res.failed.map((f) => f.error))].join(' · ')
    })
  }
}

function onBackdropMousedown(e: MouseEvent): void {
  if (e.target === e.currentTarget && !confirming.value) dismiss()
}

function onKeydown(e: KeyboardEvent): void {
  // The confirm's own capture listener takes this Esc first; leave the review open.
  if (e.key !== 'Escape' || confirming.value) return
  e.stopPropagation()
  dismiss()
}

watch(open, (isOpen) => {
  if (isOpen) window.addEventListener('keydown', onKeydown, true)
  else window.removeEventListener('keydown', onKeydown, true)
})
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown, true))
</script>

<template>
  <Teleport to="body">
    <div
      v-if="open"
      class="anim-overlay-fade fixed inset-0 flex items-center justify-center"
      style="background: rgba(0, 0, 0, 0.55); z-index: 60"
      role="presentation"
      @mousedown="onBackdropMousedown"
    >
      <div
        ref="dialogRef"
        class="anim-fade-in-scale flex flex-col border border-border-2 bg-surface text-text"
        style="
          width: min(560px, 92vw);
          max-height: 80vh;
          border-radius: 9px;
          box-shadow: var(--shadow-pop);
        "
        role="dialog"
        aria-modal="true"
        aria-labelledby="missions-review-title"
        data-test="missions-review"
        @mousedown.stop
      >
        <header
          class="flex shrink-0 items-center justify-between border-b border-border"
          style="padding: 14px 18px 10px"
        >
          <h2
            id="missions-review-title"
            class="text-text"
            style="font-size: 13.5px; line-height: 20px; font-weight: 600"
          >
            {{ t('mission.review.title') }}
          </h2>
          <button
            class="flex items-center justify-center rounded text-text-3 transition hover:bg-surface-2 hover:text-text"
            style="width: 24px; height: 24px"
            :aria-label="t('mission.review.dismiss')"
            :disabled="busy"
            data-test="review-dismiss"
            @click="dismiss"
          >
            <X :size="14" :stroke-width="1.5" />
          </button>
        </header>

        <div class="shrink-0 border-b border-border" style="padding: 10px 18px">
          <p class="text-text-3" style="font-size: 12px; line-height: 17px">
            {{ t('mission.review.intro') }}
          </p>
          <div class="flex items-center justify-between" style="margin-top: 8px; font-size: 11.5px">
            <label
              v-if="groups.ready.length"
              class="flex cursor-pointer items-center text-text-2"
              style="gap: 6px"
            >
              <input
                type="checkbox"
                style="accent-color: var(--color-accent)"
                :checked="allReadySelected"
                :disabled="busy"
                data-test="review-select-all"
                @change="toggleAllReady"
              />
              {{ t('mission.review.selectAllReady') }}
            </label>
            <span v-else />
            <span
              class="tabular-nums text-text-3"
              style="font-size: 11px"
              data-test="review-count"
              >{{ t('mission.review.selected', { count: selectedCount }, selectedCount) }}</span
            >
          </div>
        </div>

        <div class="scrollable min-h-0 flex-1 overflow-y-auto" style="padding: 6px 18px 12px">
          <p
            v-if="total === 0"
            class="text-text-3"
            style="padding: 14px 0; font-size: 12.5px"
            data-test="review-empty"
          >
            {{ t('mission.review.empty') }}
          </p>

          <template v-for="g in ['ready', 'finished', 'other'] as const" :key="g">
            <section v-if="groups[g].length" :data-test="`review-group-${g}`">
              <h3
                class="text-text-3 uppercase"
                style="
                  font-size: 9.5px;
                  font-weight: 700;
                  letter-spacing: 0.06em;
                  padding: 10px 0 4px;
                "
              >
                {{ t(`mission.review.groups.${g}`) }}
              </h3>
              <p
                v-if="g === 'finished'"
                class="text-text-4"
                style="font-size: 11px; line-height: 15px; padding-bottom: 4px"
              >
                {{ t('mission.review.groups.finishedHint') }}
              </p>
              <ul style="margin: 0; padding: 0; list-style: none">
                <li
                  v-for="v in groups[g]"
                  :key="v.mission.id"
                  class="rounded-sm border-t border-border"
                  :class="
                    focusId === v.mission.id
                      ? 'border border-accent-line bg-accent-soft'
                      : 'border-transparent'
                  "
                  :style="{ padding: focusId === v.mission.id ? '7px 8px' : '7px 0' }"
                  data-test="review-row"
                  :data-mission-id="v.mission.id"
                  :data-focused="focusId === v.mission.id ? 'true' : undefined"
                >
                  <div class="flex items-center" style="gap: 8px">
                    <input
                      v-if="g !== 'other'"
                      type="checkbox"
                      class="shrink-0"
                      style="accent-color: var(--color-accent)"
                      :checked="isSelected(v.mission.id)"
                      :disabled="busy"
                      :aria-label="t('mission.cue.itemAria', { title: v.title })"
                      data-test="review-check"
                      @change="toggle(v.mission.id)"
                    />
                    <span class="min-w-0 flex-1">
                      <span
                        class="block truncate text-text"
                        style="font-size: 12px; font-weight: 500"
                        >{{ v.title }}</span
                      >
                      <span class="block truncate text-text-3" style="font-size: 11px">{{
                        owed(v)
                      }}</span>
                    </span>
                    <Button
                      v-if="g === 'other'"
                      variant="ghost"
                      :disabled="busy || !ownerLoaded(v)"
                      :title="ownerLoaded(v) ? undefined : t('mission.review.ownerMissing')"
                      data-test="review-open"
                      @click="openMission(v)"
                    >
                      {{ t('mission.review.openMission') }}
                    </Button>
                  </div>
                  <div
                    v-if="g === 'finished' && endWarnings(v).length"
                    class="flex items-start text-warning"
                    style="gap: 5px; margin-top: 4px; font-size: 11px; line-height: 15px"
                    data-test="review-row-warnings"
                  >
                    <TriangleAlert :size="12" :stroke-width="1.8" class="mt-0.5 shrink-0" />
                    <ul class="min-w-0 flex-1" style="margin: 0; padding: 0; list-style: none">
                      <li v-for="w in endWarnings(v)" :key="w.kind">
                        <span class="block" style="font-weight: 500">{{
                          endWarningHeading(t, w)
                        }}</span>
                        <span
                          v-for="(line, i) in w.items"
                          :key="i"
                          class="block break-words text-text-3"
                          >{{ line.step
                          }}<template v-if="line.label"> — {{ line.label }}</template></span
                        >
                      </li>
                    </ul>
                  </div>
                </li>
              </ul>
            </section>
          </template>
        </div>

        <footer
          class="flex shrink-0 items-center justify-end border-t border-border"
          style="padding: 12px 18px; gap: 8px"
        >
          <Button ref="closeRef" variant="ghost" :disabled="busy" @click="dismiss">
            {{ t('mission.end.cancel') }}
          </Button>
          <Button
            variant="success"
            :disabled="selectedCount === 0 || busy"
            data-test="review-close-selected"
            @click="openConfirm"
          >
            <Check :size="14" :stroke-width="1.8" />{{
              t('mission.review.closeSelected', { count: selectedCount }, selectedCount)
            }}
          </Button>
        </footer>
      </div>

      <MissionBulkCloseConfirmDialog
        v-if="confirming"
        :items="confirmItems"
        :busy="busy"
        :progress="progress"
        @cancel="confirming = false"
        @confirm="runBulk"
      />
    </div>
  </Teleport>
</template>
