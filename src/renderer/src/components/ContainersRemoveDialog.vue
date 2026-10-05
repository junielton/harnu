<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue'
import { Check, Loader2, TriangleAlert } from 'lucide-vue-next'
import { useNow } from '@vueuse/core'
import { useContainersStore } from '../stores/containers'
import { useFocusTrap } from '../composables/useFocusTrap'
import { useContainersCopy } from './containers-copy'
import { btnClass, formatDisk, isAnonymousVolume, tombstoneKey } from './containers-format'
import type { StackRow } from '../../../preload'

/**
 * Remove confirm (design.md "Containers takeover" → "Remove dialog"; spec
 * `containers-remove-dialog--orphan|--zombie`). The only door to a removal:
 * one stopped stack at a time, containers first, and a volume only when the
 * operator ticks it — the checkbox always opens unchecked. The main process
 * enforces the same tiers again (PRD §7); this dialog is the consent.
 *
 * Follows `SweepConfirmDialog.vue`'s Dialog anatomy: Teleport → overlay →
 * card, focus trap, Esc and a backdrop click cancel. Emits the removal's
 * tombstone key on success so the view can select its Recent entry.
 */
const props = defineProps<{ stack: StackRow }>()
const emit = defineEmits<{ close: [tombstone: string | null] }>()

const store = useContainersStore()
const { t, agoShort, failureText, failureDetail } = useContainersCopy()
const now = useNow({ interval: 60_000 })

const removeVolumes = ref(false)
const running = ref(false)
const attempted = ref(false)

const variant = computed(() => (props.stack.verdict === 'orphan' ? 'orphan' : 'zombie'))
const count = computed(() => props.stack.containers.length)

const body = computed(() => {
  if (props.stack.verdict === 'orphan') {
    return t('containers.dialog.bodyOrphan', count.value, { named: { n: count.value } })
  }
  if (props.stack.kind === 'container') return t('containers.dialog.bodyContainer')
  return t('containers.dialog.bodyZombie', count.value, { named: { n: count.value } })
})

const eligible = computed(() => props.stack.volumes.filter((v) => !v.shared))
const shared = computed(() => props.stack.volumes.filter((v) => v.shared))
const eligibleSize = computed(() => {
  if (eligible.value.some((v) => v.sizeBytes === null)) return t('containers.value.sizeUnknown')
  return formatDisk(eligible.value.reduce((sum, v) => sum + (v.sizeBytes ?? 0), 0))
})

function volumeName(name: string): string {
  return isAnonymousVolume(name) ? t('containers.value.anonymous') : name
}

function exitedText(finishedAt: number | null, state: string): string {
  if (finishedAt === null) return t(`containers.ctrState.${state}`, state)
  return t('containers.dialog.exited', { ago: agoShort(now.value.getTime() - finishedAt) })
}

const failure = computed(() => (attempted.value ? (store.failures[props.stack.id] ?? null) : null))

async function confirm(): Promise<void> {
  if (running.value) return
  running.value = true
  attempted.value = true
  try {
    const result = await store.act({
      verb: 'remove',
      stack: props.stack.id,
      removeVolumes: removeVolumes.value
    })
    if (result?.ok) {
      running.value = false
      emit('close', result.tombstone ? tombstoneKey(result.tombstone) : null)
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
        :data-dsqa="`containers-remove-dialog--${variant}`"
        class="anim-fade-in-scale flex w-[460px] max-w-[90vw] flex-col gap-3.5 rounded-lg border border-border-2 bg-surface px-6 pb-[18px] pt-[22px] text-text shadow-pop"
        role="dialog"
        aria-modal="true"
        aria-labelledby="containers-remove-dialog-title"
        @mousedown.stop
      >
        <div
          id="containers-remove-dialog-title"
          class="text-[15px] font-medium leading-[22px] text-text"
        >
          <i18n-t keypath="containers.dialog.title" scope="global">
            <template #name>
              <span class="font-mono text-[14px]">{{ stack.name }}</span>
            </template>
          </i18n-t>
        </div>
        <p class="m-0 text-[13px] leading-5 text-text-2">{{ body }}</p>

        <div
          class="flex flex-col gap-[5px] rounded border border-border bg-bg px-3 py-2 font-mono text-[11px] text-text-3"
        >
          <div v-for="c in stack.containers" :key="c.id" class="flex justify-between gap-3">
            <span class="truncate">{{ c.name }}</span>
            <span class="shrink-0">{{ exitedText(c.finishedAt, c.state) }}</span>
          </div>
        </div>

        <label
          v-if="eligible.length > 0"
          class="flex cursor-pointer gap-2.5 rounded border border-warning-line bg-warning-soft px-3 py-2.5"
        >
          <span class="relative mt-0.5 h-3.5 w-3.5 shrink-0">
            <input
              v-model="removeVolumes"
              type="checkbox"
              data-testid="containers-remove-volume"
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
              <i18n-t
                v-if="eligible.length === 1"
                keypath="containers.dialog.volumeOne"
                scope="global"
              >
                <template #name>
                  <span class="font-mono text-[11.5px]">{{ volumeName(eligible[0].name) }}</span>
                </template>
                <template #size>{{ eligibleSize }}</template>
              </i18n-t>
              <template v-else>
                {{ t('containers.dialog.volumeMany', { n: eligible.length, size: eligibleSize }) }}
              </template>
            </div>
            <div class="mt-[3px] text-[11px] leading-4 text-warning">
              {{ t('containers.dialog.volumeWarning') }}
            </div>
          </div>
        </label>

        <p v-for="v in shared" :key="v.name" class="m-0 text-[11px] leading-4 text-text-3">
          {{ t('containers.dialog.sharedKept', { name: volumeName(v.name) }) }}
        </p>

        <div
          v-if="failure"
          class="flex items-start gap-2.5 rounded border border-red-line bg-red-soft px-3 py-2.5 text-[12px] leading-[18px] text-text-2"
        >
          <TriangleAlert :size="14" :stroke-width="1.8" class="mt-0.5 shrink-0 text-red" />
          <span>
            {{ failureText(failure) }}
            <span
              v-if="failureDetail(failure)"
              class="mt-1 block font-mono text-[11px] text-text-3"
              >{{ failureDetail(failure) }}</span
            >
          </span>
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
            data-testid="containers-remove-confirm"
            :class="btnClass('danger')"
            :disabled="running"
            @click="confirm()"
          >
            <Loader2 v-if="running" :size="12" :stroke-width="1.8" class="shrink-0 animate-spin" />
            {{
              running
                ? t('containers.dialog.removing')
                : t('containers.dialog.confirm', count, { named: { n: count } })
            }}
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>
