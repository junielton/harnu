<script setup lang="ts">
import { computed, onBeforeUnmount, ref, type ComponentPublicInstance } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  Copy,
  Loader2,
  Lock,
  RotateCcw,
  ScanSearch,
  Trash2,
  TriangleAlert,
  X
} from 'lucide-vue-next'
import Button from './ui/Button.vue'
import { useFocusTrap } from '../composables/useFocusTrap'
import type { GcGuidance } from '../../../main/gc/gc-wire'

/**
 * The guided dialog of Cleanup ("No dead ends", design.md "Workspace GC — unified Cleanup"). Where Remove
 * is refused, this says why with the facts main read just now (`gc:guide`) and offers the one action that
 * clears the cause. The actions that end in a removal confirm and run as one `gc:clean` job; the two that
 * only fix a cause outside Harnu (an unreadable folder, Docker down) end in Check again / Scan again.
 * Focus starts on Cancel, never on a confirm.
 */
export type GuidedDialogAction =
  'unlock-remove' | 'close-session-remove' | 'shared-stack' | 'fix-unreadable' | 'docker-down'

export interface GuidedRow {
  id: string
  title: string
  sub?: string
}

const props = withDefaults(
  defineProps<{
    action: GuidedDialogAction
    rows: GuidedRow[]
    /** Per item id; null while main is still being asked. */
    guidance: Record<string, GcGuidance> | null
    loadError?: boolean
    /** The action is running: the confirm waits. */
    pending?: boolean
    /** What the dialog showed moved underneath it: the confirm stays disabled until it is reopened. */
    stale?: boolean
  }>(),
  { loadError: false, pending: false, stale: false }
)
const emit = defineEmits<{
  confirm: [choice: 'stop' | 'leave' | null]
  cancel: []
  recheck: []
  scan: []
}>()
const { t } = useI18n()

const TITLE: Record<GuidedDialogAction, string> = {
  'unlock-remove': 'unlockRemove',
  'close-session-remove': 'closeSession',
  'shared-stack': 'sharedStack',
  'fix-unreadable': 'fixUnreadable',
  'docker-down': 'dockerDown'
}
const title = computed(() => t(`cleanup.gc.guided.title.${TITLE[props.action]}`))
const subtitle = computed(() => t(`cleanup.gc.guided.subtitle.${TITLE[props.action]}`))

const facts = computed(() => props.rows.map((r) => ({ row: r, g: props.guidance?.[r.id] ?? null })))
const ready = computed(() => props.guidance !== null && !props.loadError)

// ---- shared stacks: a choice ----------------------------------------------------------------------
const picked = ref<'stop' | 'leave'>('stop')
const allStacks = computed(() => facts.value.flatMap(({ g }) => g?.stacks ?? []))
/** Stopping is off the table for the main checkout's stack and for one another folder is using. */
const stopBlocks = computed(() => [
  ...new Set(
    allStacks.value.map((s) => s.stopBlocked).filter((x): x is NonNullable<typeof x> => !!x)
  )
])
const canStop = computed(() => stopBlocks.value.length === 0)
const choice = computed<'stop' | 'leave'>({
  get: () => (picked.value === 'stop' && !canStop.value ? 'leave' : picked.value),
  set: (v) => (picked.value = v)
})
const stacksUseFolder = computed(() =>
  facts.value.some(({ g }) => g?.stacks.some((s) => s.bindsThisFolder))
)
const canLeave = computed(() => !stacksUseFolder.value)
/** A stack that is gone leaves nothing to stop or leave: the operator scans again. */
const everyStackThere = computed(() => facts.value.every(({ g }) => (g?.stacks.length ?? 0) > 0))

// ---- what each action needs before it can go ------------------------------------------------------
const canGo = computed(() => {
  if (!ready.value) return false
  const f = facts.value
  switch (props.action) {
    case 'unlock-remove':
      return f.some(({ g }) => g?.lock != null)
    case 'close-session-remove':
      return f.every(({ g }) => !!g?.sessions && g.sessions.busy === 0 && g.sessions.idle > 0)
    case 'shared-stack':
      return everyStackThere.value && (choice.value === 'stop' ? canStop.value : canLeave.value)
    default:
      return false
  }
})
const hasConfirm = computed(
  () => props.action !== 'fix-unreadable' && props.action !== 'docker-down'
)
const disabled = computed(() => !canGo.value || props.pending || props.stale)

const confirmLabel = computed(() => {
  switch (props.action) {
    case 'unlock-remove':
      return t('cleanup.gc.guided.confirm.unlock')
    case 'close-session-remove':
      return t('cleanup.gc.guided.confirm.closeSession')
    default:
      return t(`cleanup.gc.guided.confirm.${choice.value}`)
  }
})
function onConfirm(): void {
  if (disabled.value) return
  emit('confirm', props.action === 'shared-stack' ? choice.value : null)
}

// ---- unreadable: copy the fix ---------------------------------------------------------------------
const copied = ref(false)
let copiedTimer: ReturnType<typeof setTimeout> | null = null
async function copyFix(cmd: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(cmd)
    copied.value = true
    if (copiedTimer) clearTimeout(copiedTimer)
    copiedTimer = setTimeout(() => (copied.value = false), 1500)
  } catch {
    // clipboard unavailable: the command is still selectable on screen
  }
}
onBeforeUnmount(() => {
  if (copiedTimer) clearTimeout(copiedTimer)
})

// ---- focus, keyboard ------------------------------------------------------------------------------
const dialogRef = ref<HTMLElement | null>(null)
const cancelEl = ref<HTMLElement | null>(null)
function setCancel(c: Element | ComponentPublicInstance | null): void {
  cancelEl.value = c ? ((c as ComponentPublicInstance).$el ?? (c as Element)) : null
}
useFocusTrap({ active: computed(() => true), containerRef: dialogRef, initialFocusRef: cancelEl })

function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape') {
    // Esc closes the dialog only, never the takeover behind it.
    e.stopPropagation()
    emit('cancel')
  }
}
window.addEventListener('keydown', onKeydown, true)
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown, true))

function onBackdropMousedown(e: MouseEvent): void {
  if (e.target === e.currentTarget) emit('cancel')
}
</script>

<template>
  <Teleport to="body">
    <div
      class="anim-overlay-fade fixed inset-0 flex items-start justify-center overflow-y-auto pt-18"
      style="background: rgba(0, 0, 0, 0.55); z-index: 60"
      role="presentation"
      @mousedown="onBackdropMousedown"
    >
      <div
        ref="dialogRef"
        class="anim-fade-in-scale mb-6 flex w-(--gc-dialog-w) flex-col rounded-lg border border-border-2 bg-surface text-text shadow-pop"
        role="dialog"
        aria-modal="true"
        aria-labelledby="cleanup-guided-dialog-title"
        data-testid="guided-dialog"
        :data-action="action"
        @mousedown.stop
      >
        <div class="flex items-start gap-3 px-5 pb-2 pt-4">
          <div class="min-w-0 flex-1">
            <div id="cleanup-guided-dialog-title" class="text-subtitle font-medium text-text">
              {{ title }}
            </div>
            <p class="m-0 mt-0.5 text-ui text-text-2">{{ subtitle }}</p>
          </div>
          <Button
            variant="ghost"
            size="icon"
            :aria-label="t('cleanup.gc.guided.close')"
            :title="t('cleanup.gc.guided.close')"
            data-testid="guided-close"
            @click="emit('cancel')"
          >
            <X :size="14" :stroke-width="1.7" />
          </Button>
        </div>

        <p
          v-if="props.guidance === null && !loadError"
          class="mx-5 mb-3 mt-1 flex items-center gap-2 text-ui text-text-3"
          data-testid="guided-loading"
        >
          <Loader2 :size="14" :stroke-width="1.7" class="animate-spin" aria-hidden="true" />
          {{ t('cleanup.gc.guided.loading') }}
        </p>
        <p
          v-else-if="loadError"
          class="mx-5 mb-3 mt-1 flex items-start gap-2 text-ui text-warning"
          role="alert"
          data-testid="guided-load-error"
        >
          <TriangleAlert
            :size="14"
            :stroke-width="1.6"
            class="mt-0.5 shrink-0"
            aria-hidden="true"
          />
          {{ t('cleanup.gc.guided.loadError') }}
        </p>

        <div
          class="scrollable mx-5 flex max-h-(--fv-rail-list-max-h) flex-col gap-2 overflow-y-auto pr-1"
          role="list"
          data-testid="guided-list"
        >
          <div
            v-for="{ row, g } in facts"
            :key="row.id"
            role="listitem"
            class="flex shrink-0 flex-col gap-1.5 rounded-sm border border-border bg-surface-2 px-2.5 py-2"
            data-testid="guided-row"
          >
            <span class="truncate font-mono text-ui text-text">{{ row.title }}</span>
            <span v-if="row.sub" class="truncate font-mono text-caption text-text-4">{{
              row.sub
            }}</span>

            <template v-if="g">
              <!-- AC-B3: the lock and the reason git recorded -->
              <p
                v-if="action === 'unlock-remove'"
                class="m-0 flex items-start gap-1.5 text-ui text-text-2"
                data-testid="guided-lock"
              >
                <Lock :size="13" :stroke-width="1.6" class="mt-0.5 shrink-0 text-warning" />
                <span v-if="g.lock?.reason">{{
                  t('cleanup.gc.guided.lock.reason', { reason: g.lock.reason })
                }}</span>
                <span v-else-if="g.lock">{{ t('cleanup.gc.guided.lock.none') }}</span>
                <span v-else>{{ t('cleanup.gc.guided.lock.gone') }}</span>
              </p>

              <!-- AC-B4: the idle sessions it would close, or why it will not -->
              <p
                v-else-if="action === 'close-session-remove'"
                class="m-0 text-ui text-text-2"
                data-testid="guided-sessions"
              >
                <template v-if="!g.sessions || (g.sessions.idle === 0 && g.sessions.busy === 0)">{{
                  t('cleanup.gc.guided.sessions.foreign')
                }}</template>
                <template v-else-if="g.sessions.busy > 0">{{
                  t('cleanup.gc.guided.sessions.busy')
                }}</template>
                <template v-else>{{
                  t('cleanup.gc.guided.sessions.idle', g.sessions.idle, {
                    named: { n: g.sessions.idle }
                  })
                }}</template>
              </p>

              <!-- AC-B5: each stack, and who else uses it -->
              <div
                v-else-if="action === 'shared-stack'"
                class="flex flex-col gap-1"
                data-testid="guided-stack"
              >
                <p v-if="g.stacks.length === 0" class="m-0 text-ui text-text-2">
                  {{ t('cleanup.gc.guided.stack.none') }}
                </p>
                <p v-for="s in g.stacks" :key="s.id" class="m-0 text-ui text-text-2">
                  {{
                    t('cleanup.gc.guided.stack.runs', {
                      name: s.name,
                      folders: s.otherFolders.join(', ')
                    })
                  }}
                  <span v-if="s.bindsThisFolder" class="text-warning">{{
                    t('cleanup.gc.guided.stack.uses')
                  }}</span>
                </p>
              </div>

              <!-- AC-B6: the exact path, its owner, and the command that fixes it -->
              <div
                v-else-if="action === 'fix-unreadable'"
                class="flex flex-col gap-1.5"
                data-testid="guided-unreadable"
              >
                <template v-if="g.unreadable">
                  <p class="m-0 break-all text-ui text-text-2">
                    {{ t('cleanup.gc.guided.unreadable.where', { path: g.unreadable.path }) }}
                    {{
                      g.unreadable.owner
                        ? t('cleanup.gc.guided.unreadable.owner', { owner: g.unreadable.owner })
                        : t('cleanup.gc.guided.unreadable.ownerUnknown')
                    }}
                  </p>
                  <p class="m-0 text-caption text-text-3">
                    {{ t('cleanup.gc.guided.unreadable.fix') }}
                  </p>
                  <div class="flex items-start gap-2">
                    <code
                      class="min-w-0 flex-1 select-all break-all rounded-sm border border-border bg-bg px-2 py-1 font-mono text-caption text-text-2"
                      data-testid="guided-fix"
                      >{{ g.unreadable.fixCommand }}</code
                    >
                    <button
                      type="button"
                      class="inline-flex shrink-0 items-center gap-1 rounded-sm border border-border bg-bg px-2 py-0.75 text-eyebrow text-text-3 transition hover:border-border-2 hover:text-text-2"
                      data-testid="guided-copy"
                      @click="copyFix(g.unreadable.fixCommand)"
                    >
                      <Copy :size="10" :stroke-width="1.7" />
                      {{ copied ? t('cleanup.gc.guided.copied') : t('cleanup.gc.guided.copy') }}
                    </button>
                  </div>
                </template>
                <p v-else class="m-0 text-ui text-green" data-testid="guided-unreadable-ok">
                  {{ t('cleanup.gc.guided.unreadable.ok') }}
                </p>
              </div>

              <!-- AC-B7: Docker was down at scan time -->
              <div
                v-else-if="action === 'docker-down'"
                class="flex flex-col gap-1.5"
                data-testid="guided-docker"
              >
                <p class="m-0 text-ui text-text-2">{{ t('cleanup.gc.guided.docker.down') }}</p>
                <template v-if="g.docker?.hint">
                  <p class="m-0 text-caption text-text-3">
                    {{ t('cleanup.gc.guided.docker.start') }}
                  </p>
                  <code
                    class="select-all rounded-sm border border-border bg-bg px-2 py-1 font-mono text-caption text-text-2"
                    data-testid="guided-docker-hint"
                    >{{ g.docker.hint }}</code
                  >
                </template>
                <p v-else class="m-0 text-caption text-text-3" data-testid="guided-docker-app">
                  {{ t('cleanup.gc.guided.docker.app') }}
                </p>
              </div>
            </template>
          </div>
        </div>

        <!-- AC-B5: the choice -->
        <fieldset
          v-if="action === 'shared-stack' && ready"
          class="mx-5 mt-3 flex flex-col gap-2 border-0 p-0"
          data-testid="guided-choices"
        >
          <label
            v-if="canStop"
            class="flex cursor-pointer items-start gap-2 rounded-sm border border-border bg-surface-2 px-2.5 py-2"
            data-testid="guided-choice-stop"
          >
            <input v-model="choice" type="radio" value="stop" class="mt-1" name="guided-choice" />
            <span class="flex flex-col gap-0.5">
              <b class="text-ui font-medium text-text">{{ t('cleanup.gc.guided.choice.stop') }}</b>
              <span class="text-caption text-text-3">{{
                t('cleanup.gc.guided.choice.stopBody', {
                  names: allStacks.flatMap((s) => s.containerNames).join(', ')
                })
              }}</span>
            </span>
          </label>
          <label
            v-if="canLeave"
            class="flex cursor-pointer items-start gap-2 rounded-sm border border-border bg-surface-2 px-2.5 py-2"
            data-testid="guided-choice-leave"
          >
            <input v-model="choice" type="radio" value="leave" class="mt-1" name="guided-choice" />
            <span class="flex flex-col gap-0.5">
              <b class="text-ui font-medium text-text">{{ t('cleanup.gc.guided.choice.leave') }}</b>
              <span class="text-caption text-text-3">{{
                t('cleanup.gc.guided.choice.leaveBody')
              }}</span>
            </span>
          </label>
          <p
            v-if="!canStop"
            class="m-0 text-caption text-text-3"
            data-testid="guided-stop-unavailable"
          >
            {{ stopBlocks.map((b) => t(`cleanup.gc.guided.choice.stopBlocked.${b}`)).join(' ') }}
          </p>
          <p
            v-if="!canLeave"
            class="m-0 text-caption text-text-3"
            data-testid="guided-leave-unavailable"
          >
            {{ t('cleanup.gc.guided.choice.leaveUnavailable') }}
          </p>
        </fieldset>

        <p
          v-if="stale"
          class="mx-5 mt-3 flex items-start gap-2 text-ui text-warning"
          role="alert"
          data-testid="guided-stale"
        >
          <TriangleAlert
            :size="14"
            :stroke-width="1.6"
            class="mt-0.5 shrink-0"
            aria-hidden="true"
          />
          {{ t('cleanup.gc.guided.stale') }}
        </p>

        <div class="mt-3 flex items-center gap-2 border-t border-border px-5 py-3">
          <span
            v-if="pending"
            class="mr-auto flex items-center gap-1.5 text-ui text-accent"
            data-testid="guided-pending"
          >
            <Loader2 :size="14" :stroke-width="1.7" class="animate-spin" aria-hidden="true" />
            {{ t('cleanup.gc.guided.pending') }}
          </span>
          <span v-else class="mr-auto" />
          <Button
            :ref="setCancel"
            variant="ghost"
            data-testid="guided-cancel"
            @click="emit('cancel')"
          >
            {{ t('cleanup.gc.guided.cancel') }}
          </Button>
          <Button
            v-if="action === 'fix-unreadable'"
            variant="soft"
            :disabled="pending"
            data-testid="guided-recheck"
            @click="emit('recheck')"
          >
            <RotateCcw :size="14" :stroke-width="1.6" class="shrink-0" />
            {{ t('cleanup.gc.guided.recheck') }}
          </Button>
          <Button
            v-if="action === 'docker-down'"
            variant="soft"
            :disabled="pending"
            data-testid="guided-scan"
            @click="emit('scan')"
          >
            <ScanSearch :size="14" :stroke-width="1.6" class="shrink-0" />
            {{ t('cleanup.gc.guided.scan') }}
          </Button>
          <Button
            v-if="hasConfirm"
            variant="danger"
            :disabled="disabled"
            data-testid="guided-confirm"
            @click="onConfirm"
          >
            <Trash2 :size="14" :stroke-width="1.6" class="shrink-0" />
            {{ confirmLabel }}
          </Button>
        </div>
      </div>
    </div>
  </Teleport>
</template>
