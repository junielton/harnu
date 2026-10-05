<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { X, Folder as FolderIcon } from 'lucide-vue-next'
import { useUiStore } from '../stores/ui'
import { useFocusTrap } from '../composables/useFocusTrap'

/**
 * "Add project folder" dialog — anatomy per `design.md §3.7`.
 *
 * Driven by `useUiStore().dialog === 'addFolder'`. The component owns the
 * transient state (chosen `path`, edited `alias`) for the lifetime of the
 * dialog and emits `submit` with the final payload. The parent (App.vue,
 * wired in T-2.6) is responsible for turning that into a sessions store action.
 *
 * Folder-first model: a folder is the entity; a git worktree is optional
 * per-folder metadata derived later by the git probe. The dialog therefore
 * adds exactly the chosen folder — there is no sibling-worktree multi-select.
 *
 * Mounted exactly once at the App level via Teleport — `v-if` on the open
 * state keeps the DOM empty when closed (lighter than `v-show`).
 */

const emit = defineEmits<{
  (e: 'submit', payload: { path: string; alias: string }): void
}>()

const ui = useUiStore()

const isOpen = computed(() => ui.dialog === 'addFolder')

// --- Local form state ------------------------------------------------------

const path = ref('')
const aliasOverride = ref<string | null>(null)

/**
 * Cross-platform basename. The renderer can be running on Linux, macOS, or
 * Windows; the chosen path may carry either separator depending on the OS
 * the Electron dialog returns. We strip trailing slashes/backslashes then
 * take the last segment.
 */
function basename(p: string): string {
  if (!p) return ''
  return (
    p
      .replace(/[/\\]+$/, '')
      .split(/[/\\]/)
      .pop() ?? ''
  )
}

const derivedAlias = computed(() => basename(path.value))

const alias = computed<string>({
  get(): string {
    return aliasOverride.value ?? derivedAlias.value
  },
  set(v: string): void {
    aliasOverride.value = v
  }
})

const canSubmit = computed(() => path.value.length > 0 && alias.value.trim().length > 0)

function resetState(): void {
  path.value = ''
  aliasOverride.value = null
}

// --- IPC: browse -----------------------------------------------------------

async function browse(): Promise<void> {
  const { path: chosen } = await window.api.dialogOpenDirectory()
  if (!chosen) return
  path.value = chosen
  aliasOverride.value = null
}

// --- Submit / close --------------------------------------------------------

function submit(): void {
  if (!canSubmit.value) return
  // Folder-first (spec §6): adding a project pins exactly the chosen folder.
  emit('submit', {
    path: path.value,
    alias: alias.value.trim()
  })
  ui.closeDialog()
}

function close(): void {
  ui.closeDialog()
}

// --- Backdrop click + keyboard --------------------------------------------

const aliasInputRef = ref<HTMLInputElement | null>(null)
/**
 * Dialog card ref — drives the focus trap. The composable focuses the
 * first focusable element inside, traps Tab cycles, and restores focus
 * to the trigger on close. See `useFocusTrap.ts` for the contract.
 */
const dialogRef = ref<HTMLElement | null>(null)

useFocusTrap({
  active: isOpen,
  containerRef: dialogRef,
  initialFocusRef: aliasInputRef
})

function onBackdropMousedown(e: MouseEvent): void {
  if (e.target === e.currentTarget) close()
}

function onKeydown(e: KeyboardEvent): void {
  if (!isOpen.value) return
  if (e.key === 'Escape') {
    e.stopPropagation()
    close()
  }
}

watch(isOpen, (open) => {
  if (open) {
    resetState()
    window.addEventListener('keydown', onKeydown, true)
  } else {
    window.removeEventListener('keydown', onKeydown, true)
  }
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown, true)
})
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
          width: min(560px, 90vw);
          max-height: 80vh;
          border-radius: 9px;
          box-shadow: var(--shadow-pop);
        "
        role="dialog"
        aria-modal="true"
        aria-labelledby="add-folder-dialog-title"
        @mousedown.stop
      >
        <!-- Header -->
        <header
          class="flex shrink-0 items-center justify-between border-b border-border"
          style="padding: 14px 18px 10px"
        >
          <h2
            id="add-folder-dialog-title"
            class="text-text"
            style="font-size: 13.5px; line-height: 20px; font-weight: 600"
          >
            {{ $t('dialog.addFolder.title') }}
          </h2>
          <button
            class="flex items-center justify-center rounded text-text-3 transition hover:bg-surface-2 hover:text-text"
            style="width: 24px; height: 24px"
            :aria-label="$t('dialog.addFolder.close')"
            @click="close()"
          >
            <X :size="14" :stroke-width="1.5" />
          </button>
        </header>

        <!-- Body -->
        <div class="scrollable flex-1 overflow-y-auto" style="padding: 14px 18px">
          <!-- Root folder -->
          <section style="margin-bottom: 14px">
            <div
              class="text-text-3"
              style="
                font-size: 11px;
                font-weight: 500;
                letter-spacing: 0.06em;
                text-transform: uppercase;
                margin-bottom: 6px;
              "
            >
              {{ $t('dialog.addFolder.rootLabel') }}
            </div>
            <div class="flex items-center" style="gap: 8px">
              <div
                class="flex flex-1 items-center border border-border bg-bg text-text-2"
                style="
                  border-radius: 5px;
                  padding: 7px 10px;
                  font-size: 12px;
                  min-height: 32px;
                  gap: 8px;
                  min-width: 0;
                "
              >
                <FolderIcon :size="13" :stroke-width="1.6" class="shrink-0 text-text-4" />
                <span
                  class="flex-1 truncate font-mono"
                  :class="path ? 'text-text-2' : 'text-text-4'"
                  style="font-size: 12px"
                >
                  {{ path || $t('dialog.addFolder.rootPlaceholder') }}
                </span>
              </div>
              <button
                class="flex shrink-0 items-center border border-border bg-surface text-text transition hover:bg-surface-2"
                style="
                  border-radius: 5px;
                  padding: 7px 14px;
                  font-size: 12.5px;
                  font-weight: 500;
                  gap: 7px;
                  height: 32px;
                "
                @click="browse()"
              >
                {{ $t('actions.browse') }}
              </button>
            </div>
          </section>

          <!-- Alias -->
          <section style="margin-bottom: 14px">
            <label
              for="add-folder-alias"
              class="text-text-3"
              style="
                display: block;
                font-size: 11px;
                font-weight: 500;
                letter-spacing: 0.06em;
                text-transform: uppercase;
                margin-bottom: 6px;
              "
            >
              {{ $t('dialog.addFolder.aliasLabel') }}
            </label>
            <input
              id="add-folder-alias"
              ref="aliasInputRef"
              v-model="alias"
              class="w-full border border-border bg-bg text-text transition focus:border-accent-line"
              style="
                border-radius: 5px;
                padding: 8px 10px;
                font-size: 13px;
                outline: none;
                height: 32px;
              "
              type="text"
              autocomplete="off"
              spellcheck="false"
            />
            <p class="text-text-3" style="font-size: 11px; margin-top: 6px">
              {{ $t('dialog.addFolder.aliasHint') }}
            </p>
          </section>
        </div>

        <!-- Footer -->
        <footer
          class="flex shrink-0 items-center justify-end border-t border-border"
          style="padding: 12px 18px; gap: 8px"
        >
          <button
            class="border border-border bg-transparent text-text-2 transition hover:text-text"
            style="
              padding: 7px 14px;
              font-size: 12.5px;
              font-weight: 500;
              border-radius: 5px;
              height: 28px;
            "
            @click="close()"
          >
            {{ $t('actions.cancel') }}
          </button>
          <button
            class="bg-accent text-accent-ink transition"
            style="
              padding: 7px 14px;
              font-size: 12.5px;
              font-weight: 500;
              border-radius: 5px;
              border: none;
              height: 28px;
            "
            :style="{
              opacity: canSubmit ? 1 : 0.4,
              cursor: canSubmit ? 'pointer' : 'not-allowed'
            }"
            :disabled="!canSubmit"
            @click="submit()"
          >
            {{ $t('actions.addProject') }}
          </button>
        </footer>
      </div>
    </div>
  </Teleport>
</template>
