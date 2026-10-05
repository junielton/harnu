<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { Check, Loader2, TriangleAlert } from 'lucide-vue-next'
import { useContainersStore } from '../stores/containers'
import { useFocusTrap } from '../composables/useFocusTrap'
import { useContainersCopy } from './containers-copy'
import {
  btnClass,
  formatDisk,
  isAnonymousVolume,
  sweepPlan,
  sweepProgress,
  sweepTargets,
  tombstoneKey
} from './containers-format'
import type { SweepPlan } from './containers-format'
import type { ContainersActErrorCode, StackRow } from '../../../preload'

/**
 * Clean-up confirm (design.md "Containers takeover" → "Clean-up dialog"; spec
 * `containers-sweep-dialog`). The only door to a sweep (T341): ONE dialog for
 * the whole "Needs you" list, stating what it takes before it takes it, with
 * the volumes opt-in and always unchecked when it opens.
 *
 * It never picks the targets — main does, from its own tier table (T340). What
 * is listed here is the same set the renderer mirrors for display, narrowed to
 * the stacks the operator left ticked (T342), and the confirm sends it back as an
 * ASSERTION (BUG-137): main re-scans at act time,
 * so a set that moved in between refuses the whole sweep and the operator
 * confirms the new list, rather than losing something never on screen.
 *
 * The list is read ONCE, at open (BUG-139). A background scan landing while the
 * dialog sits open never rewrites it silently: the dialog refreshes AND says so,
 * and waits for a fresh confirm. What the operator confirms is what they read.
 *
 * Follows `ContainersRemoveDialog.vue`'s Dialog anatomy: Teleport → overlay →
 * card, focus trap, Esc and a backdrop click cancel. Emits the sweep's
 * tombstone key on success so the view can select its Recent entry.
 */
/**
 * The WHOLE snapshot: the plan needs the stacks outside the sweep to know which
 * volumes survive it. `selected` is the operator's ticked ids (T342) — omitted
 * means every eligible stack, which is the one-click clean-up this dialog has
 * always shown. An unticked eligible stack is a survivor here, so a volume it
 * shares with a ticked one is kept and named.
 */
const props = defineProps<{ stacks: StackRow[]; selected?: string[] | null }>()
const emit = defineEmits<{ close: [tombstone: string | null] }>()

const store = useContainersStore()
const { t, refusalReason } = useContainersCopy()

const removeVolumes = ref(false)
const running = ref(false)
// The dialog covers the hero's own "Cleaning… N of M", so it carries the count.
const progress = computed(() => sweepProgress(store.pending?.stacks ?? [], store.stacks))

/**
 * The narrowing the confirm has to carry, for the plan currently frozen below:
 * the ticked ids when the operator left a stack out, and null when they did not
 * — a sweep of everything eligible sends no `only` at all, so the untouched
 * one-click flow reaches main byte-identical to before (T342).
 *
 * Derived from the same `stacks` read the plan is, never from a later one: main
 * intersects `only` with its own fresh set, and a stale narrowing would silently
 * disagree with the disclosure beside it.
 */
function narrowingFor(stacks: StackRow[], p: SweepPlan): string[] | null {
  return p.stacks.length < sweepTargets(stacks).length ? p.stacks.map((s) => s.id) : null
}

/**
 * The list the operator is reading, frozen at open (BUG-139) — deliberately not
 * a computed over the live prop. Only {@link refreeze} replaces it, and it never
 * does so without a note saying the list moved.
 */
const plan = ref<SweepPlan>(sweepPlan(props.stacks, props.selected ?? null))
const onlyIds = ref<string[] | null>(narrowingFor(props.stacks, plan.value))
const stackCount = computed(() => plan.value.stacks.length)
const volumeSize = computed(() =>
  plan.value.volumeBytes === null
    ? t('containers.value.sizeUnknown')
    : formatDisk(plan.value.volumeBytes)
)

function volumeName(name: string): string {
  return isAnonymousVolume(name) ? t('containers.value.anonymous') : name
}

/**
 * A sweep that did not fully succeed: a headline saying how many stacks it
 * cleaned, and one row per stack it did not, with its reason. The stacks that
 * succeeded are gone from the next scan, so nothing hides them (AC-6).
 */
const problem = ref<{ headline: string; rows: Array<{ name: string; reason: string }> } | null>(
  null
)

/** Two plans are the same offer when every part the dialog shows is the same. */
function samePlan(a: SweepPlan, b: SweepPlan): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

/**
 * Re-read the sweep from the current snapshot. Returns whether the offer moved,
 * so the caller can say so — the freeze is only worth having if nothing swaps
 * the list in quietly. A moved offer re-arms the volume checkbox unchecked: the
 * tick was consent for the list that just changed, not for this one.
 */
function refreeze(): boolean {
  const fresh = sweepPlan(props.stacks, props.selected ?? null)
  // The narrowing tracks the scan even when the offer is unchanged: a newly
  // eligible stack the operator never ticked widens MAIN's set without changing
  // anything on screen, and `only` is what keeps it out of the sweep.
  onlyIds.value = narrowingFor(props.stacks, fresh)
  if (samePlan(fresh, plan.value)) return false
  plan.value = fresh
  removeVolumes.value = false
  return true
}

/**
 * A snapshot landing while the operator reads the dialog. Not while the sweep
 * runs — a sweep eats its own list, and stacks leaving the scan then are the
 * work, not the machine moving — and not over a note that is already up, which
 * would hide what a partial sweep failed to do. `sync` so the order against
 * {@link confirm}'s own headline is the code's, not the scheduler's.
 */
watch(
  () => props.stacks,
  () => {
    if (running.value || problem.value) return
    if (refreeze()) problem.value = { headline: t('containers.sweepDialog.moved'), rows: [] }
  },
  { flush: 'sync' }
)

function nameOf(id: string): string {
  return props.stacks.find((s) => s.id === id)?.name ?? id
}

function reasonOf(r: { error?: string | null; message?: string | null }): string {
  if (r.error === 'DOCKER_FAILED' && r.message?.trim()) return r.message.trim()
  return refusalReason((r.error as ContainersActErrorCode | undefined) ?? null)
}

async function confirm(): Promise<void> {
  if (running.value) return
  running.value = true
  const total = stackCount.value
  try {
    const result = await store.act({
      verb: 'sweep',
      removeVolumes: removeVolumes.value,
      // The narrowing, when there is one: main intersects it with its own set, so
      // it can only ever take a stack OUT of the sweep (T342). Kept separate from
      // the disclosure below on purpose — one field doing both would let the
      // assertion decide what gets deleted.
      ...(onlyIds.value ? { only: [...onlyIds.value] } : {}),
      // Exactly what this dialog is showing right now. Main still picks its own
      // targets; this is the promise it checks them against (BUG-137).
      disclosed: { stacks: plan.value.stacks.map((s) => s.id), volumes: plan.value.volumes }
    })
    if (result?.ok) {
      emit('close', result.tombstone ? tombstoneKey(result.tombstone) : null)
      return
    }
    if (result?.error === 'SWEEP_SET_CHANGED') {
      // Nothing was deleted. Pull the fresh snapshot so the list below is the
      // one main would act on, and wait for a new confirm — never retry.
      await store.scanNow().catch(() => undefined)
      // Re-freeze on what main would act on now, so the next confirm discloses
      // what is on screen (BUG-139). The refusal's own copy is the one that
      // stands: it is the only one that can say nothing was deleted.
      refreeze()
      problem.value = { headline: t('containers.sweepDialog.changed'), rows: [] }
      return
    }
    if (!result || result.error) {
      // The request itself never ran — another action is in flight, or main
      // refused it outright. No stack was swept.
      problem.value = {
        headline: t('containers.failed.request', { reason: refusalReason(result?.error ?? null) }),
        rows: []
      }
      return
    }
    const failed = result.results.filter((r) => !r.ok)
    problem.value = {
      headline: t('containers.sweepDialog.partial', total, {
        named: { done: total - failed.length, total }
      }),
      rows: failed.map((r) => ({ name: nameOf(r.stack), reason: reasonOf(r) }))
    }
  } finally {
    running.value = false
  }
}

function cancel(): void {
  if (running.value) return
  emit('close', null)
}

const dialogRef = ref<HTMLElement | null>(null)
const cancelRef = ref<HTMLElement | null>(null)
useFocusTrap({
  active: computed(() => true),
  containerRef: dialogRef,
  initialFocusRef: cancelRef
})

function onBackdropMousedown(e: MouseEvent): void {
  if (e.target === e.currentTarget) cancel()
}

function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape') {
    // Esc cancels the dialog only, never the takeover behind it.
    e.stopPropagation()
    cancel()
  }
}
window.addEventListener('keydown', onKeydown, true)
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown, true))
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
        data-dsqa="containers-sweep-dialog"
        class="anim-fade-in-scale flex w-[520px] max-w-[90vw] flex-col gap-3.5 rounded-lg border border-border-2 bg-surface px-6 pb-[18px] pt-[22px] text-text shadow-pop"
        role="dialog"
        aria-modal="true"
        aria-labelledby="containers-sweep-dialog-title"
        @mousedown.stop
      >
        <div
          id="containers-sweep-dialog-title"
          class="text-[15px] font-medium leading-[22px] text-text"
        >
          {{ t('containers.sweepDialog.title', stackCount, { named: { n: stackCount } }) }}
        </div>
        <p class="m-0 text-[13px] leading-5 text-text-2">
          {{ t('containers.sweepDialog.body', plan.containers, { named: { n: plan.containers } }) }}
        </p>

        <div
          class="flex max-h-[168px] flex-col gap-[5px] overflow-y-auto rounded border border-border bg-bg px-3 py-2 font-mono text-[11px] text-text-3"
        >
          <div
            v-for="s in plan.stacks"
            :key="s.id"
            :data-sweep-stack="s.id"
            class="flex justify-between gap-3"
          >
            <span class="truncate">{{ s.name }}</span>
            <span class="shrink-0">{{
              t('containers.sweepDialog.stackContainers', s.containers, {
                named: { n: s.containers }
              })
            }}</span>
          </div>
        </div>

        <label
          v-if="plan.volumes.length > 0"
          class="flex cursor-pointer gap-2.5 rounded border border-warning-line bg-warning-soft px-3 py-2.5"
        >
          <span class="relative mt-0.5 h-3.5 w-3.5 shrink-0">
            <input
              v-model="removeVolumes"
              type="checkbox"
              data-testid="containers-sweep-volumes"
              class="absolute inset-0 m-0 h-3.5 w-3.5 cursor-pointer appearance-none rounded-[3px] border border-border-2 bg-surface checked:border-warning checked:bg-warning disabled:cursor-not-allowed"
              :disabled="running"
            />
            <Check
              v-if="removeVolumes"
              :size="10"
              :stroke-width="3"
              class="pointer-events-none absolute left-0.5 top-0.5 text-bg"
            />
          </span>
          <div>
            <div class="text-[12px] text-text">
              {{
                t('containers.sweepDialog.volumes', plan.volumes.length, {
                  named: { n: plan.volumes.length, size: volumeSize }
                })
              }}
            </div>
            <div class="mt-[3px] text-[11px] leading-4 text-warning">
              {{ t('containers.dialog.volumeWarning') }}
            </div>
          </div>
        </label>

        <p
          v-for="name in plan.keptVolumes"
          :key="name"
          class="m-0 text-[11px] leading-4 text-text-3"
        >
          {{ t('containers.dialog.sharedKept', { name: volumeName(name) }) }}
        </p>

        <div
          v-if="problem"
          data-testid="containers-sweep-problem"
          class="flex items-start gap-2.5 rounded border border-red-line bg-red-soft px-3 py-2.5 text-[12px] leading-[18px] text-text-2"
        >
          <TriangleAlert :size="14" :stroke-width="1.8" class="mt-0.5 shrink-0 text-red" />
          <div class="min-w-0">
            <div>{{ problem.headline }}</div>
            <div
              v-for="f in problem.rows"
              :key="f.name"
              class="mt-1 truncate font-mono text-[11px] text-text-3"
            >
              {{ t('containers.sweepDialog.failedStack', { name: f.name, reason: f.reason }) }}
            </div>
          </div>
        </div>

        <div class="flex justify-end gap-2 pt-1">
          <button
            ref="cancelRef"
            type="button"
            :class="btnClass('ghost')"
            :disabled="running"
            @click="cancel()"
          >
            {{ t('containers.dialog.cancel') }}
          </button>
          <button
            type="button"
            data-testid="containers-sweep-confirm"
            :class="btnClass('danger')"
            :disabled="running"
            @click="confirm()"
          >
            <Loader2 v-if="running" :size="12" :stroke-width="1.8" class="shrink-0 animate-spin" />
            {{
              running
                ? t('containers.sweeping', { done: progress.done, total: progress.total })
                : t('containers.dialog.confirm', plan.containers, {
                    named: { n: plan.containers }
                  })
            }}
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>
