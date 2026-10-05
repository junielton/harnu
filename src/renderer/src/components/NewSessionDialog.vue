<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { X, ChevronRight } from 'lucide-vue-next'
import { useI18n } from 'vue-i18n'
import { useUiStore } from '../stores/ui'
import { useSessionsStore } from '../stores/sessions'
import { useClaudeBootStore } from '../stores/claudeBoot'
import { useFocusTrap } from '../composables/useFocusTrap'
import ClaudeBootForm from './ClaudeBootForm.vue'
import type { ClaudeBootConfig } from '../../../preload'

/**
 * New session launch dialog (design.md §6 — New session). Clicking "+ New
 * session" opens this instead of spawning immediately: a small confirm modal
 * (Cancel / Start) with an **Advanced** disclosure that reveals the full
 * `ClaudeBootForm` (scope `session`). Whatever the user sets here is a one-shot
 * launch override layered on top of the global + per-folder Claude Boot config
 * (session wins) — passed to `createNewSession` and forwarded to the spawn, not
 * persisted. Start is default-focused so Enter launches.
 */

const ui = useUiStore()
const sessions = useSessionsStore()
const boot = useClaudeBootStore()
const { t } = useI18n()

const isOpen = computed(() => ui.dialog === 'newSession')
const folderPath = computed(() => ui.newSessionPath ?? '')
const folderName = computed(() => {
  const p = folderPath.value.replace(/[/\\]+$/, '')
  return p.split(/[/\\]/).pop() || p
})

const config = ref<ClaudeBootConfig>({})
// Resolved global ⊕ folder config this session inherits — shown as the
// effective pre-fill in the form (not stored on the session). Read main-side
// (single source of truth — T57 #2) and kept reactive (T57 #4).
const inherited = ref<ClaudeBootConfig>({})
const advancedOpen = ref(false)

async function refreshInherited(): Promise<void> {
  inherited.value = await boot.getResolved(folderPath.value)
}

function start(): void {
  const path = folderPath.value
  ui.closeDialog()
  if (path) sessions.createNewSession(path, config.value)
}

function cancel(): void {
  ui.closeDialog()
}

const dialogRef = ref<HTMLElement | null>(null)
const startButtonRef = ref<HTMLElement | null>(null)
useFocusTrap({ active: isOpen, containerRef: dialogRef, initialFocusRef: startButtonRef })

function onBackdropMousedown(e: MouseEvent): void {
  if (e.target === e.currentTarget) cancel()
}
function onKeydown(e: KeyboardEvent): void {
  if (!isOpen.value) return
  if (e.key === 'Escape') {
    e.stopPropagation()
    cancel()
  }
}

watch(isOpen, async (open) => {
  if (open) {
    // Reset to a clean launch every time the dialog opens.
    config.value = {}
    advancedOpen.value = false
    await refreshInherited()
    window.addEventListener('keydown', onKeydown, true)
  } else {
    window.removeEventListener('keydown', onKeydown, true)
  }
})

// Live inheritance (T57 #4): re-resolve global ⊕ folder when the global config
// changes in-app while the dialog is open, so the inherited pre-fill stays fresh.
watch(
  () => boot.global,
  () => {
    if (isOpen.value) void refreshInherited()
  },
  { deep: true }
)

onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown, true))
</script>

<template>
  <Teleport to="body">
    <div
      v-if="isOpen"
      class="anim-overlay-fade fixed inset-0 flex items-center justify-center"
      style="background: rgba(0, 0, 0, 0.55); z-index: 60"
      role="presentation"
      @mousedown="onBackdropMousedown"
    >
      <div
        ref="dialogRef"
        class="anim-fade-in-scale flex flex-col border border-border-2 bg-surface text-text"
        style="
          width: min(540px, 90vw);
          max-height: 84vh;
          border-radius: 9px;
          box-shadow: var(--shadow-pop);
        "
        role="dialog"
        aria-modal="true"
        aria-labelledby="new-session-dialog-title"
        @mousedown.stop
      >
        <!-- Header -->
        <header
          class="flex shrink-0 items-start justify-between border-b border-border"
          style="padding: 14px 18px 10px"
        >
          <div style="min-width: 0">
            <h2
              id="new-session-dialog-title"
              class="text-text"
              style="font-size: 13.5px; line-height: 20px; font-weight: 600"
            >
              {{ t('newSession.title') }}
            </h2>
            <div
              class="truncate font-mono text-text-4"
              style="font-size: 11px; margin-top: 2px"
              :title="folderPath"
            >
              {{ folderName }}
            </div>
          </div>
          <button
            class="flex shrink-0 items-center justify-center rounded text-text-3 transition hover:bg-surface-2 hover:text-text"
            style="width: 24px; height: 24px; margin-left: 12px"
            type="button"
            :aria-label="t('newSession.cancel')"
            @click="cancel()"
          >
            <X :size="14" :stroke-width="1.5" />
          </button>
        </header>

        <!-- Body -->
        <div class="scrollable flex-1 overflow-y-auto" style="padding: 14px 18px">
          <p class="text-text-3" style="font-size: 12px; line-height: 1.5; margin-bottom: 14px">
            {{ t('newSession.intro', { folder: folderName }) }}
          </p>

          <!-- Advanced disclosure -->
          <button
            type="button"
            class="flex w-full items-center text-left text-text-2 transition hover:text-text"
            style="gap: 7px; font-size: 12px; font-weight: 500"
            :aria-expanded="advancedOpen"
            @click="advancedOpen = !advancedOpen"
          >
            <ChevronRight
              :size="13"
              :stroke-width="1.8"
              class="shrink-0 transition-transform"
              :style="{
                transform: advancedOpen ? 'rotate(90deg)' : 'rotate(0deg)',
                transitionDuration: 'var(--dur)',
                transitionTimingFunction: 'var(--ease)'
              }"
            />
            <span>{{ t('newSession.advanced') }}</span>
          </button>

          <div v-if="advancedOpen" style="margin-top: 14px">
            <ClaudeBootForm v-model="config" :inherited="inherited" scope="session" />
          </div>
        </div>

        <!-- Footer -->
        <footer
          class="flex shrink-0 items-center justify-end border-t border-border"
          style="padding: 12px 18px; gap: 8px"
        >
          <button
            type="button"
            class="border border-border bg-transparent text-text-2 transition hover:text-text"
            style="padding: 7px 14px; font-size: 12.5px; border-radius: 5px; height: 28px"
            @click="cancel()"
          >
            {{ t('newSession.cancel') }}
          </button>
          <button
            ref="startButtonRef"
            type="button"
            class="bg-accent text-accent-ink transition"
            style="
              padding: 7px 16px;
              font-size: 12.5px;
              font-weight: 500;
              border-radius: 5px;
              height: 28px;
              border: none;
            "
            @click="start()"
          >
            {{ t('newSession.start') }}
          </button>
        </footer>
      </div>
    </div>
  </Teleport>
</template>
