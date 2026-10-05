<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { X, Trash2 } from 'lucide-vue-next'
import { useI18n } from 'vue-i18n'
import { useUiStore } from '../stores/ui'
import { useFocusTrap } from '../composables/useFocusTrap'
import ToggleSwitch from './ui/ToggleSwitch.vue'

/**
 * "Remove worktree" confirm dialog — a destructive `Dialog` variant
 * (`design.md §6` → "Remove worktree"). Driven by
 * `useUiStore().dialog === 'removeWorktree'`, reads the target off
 * `ui.removeWorktreeTarget` (`{ path, branch }` — the LINKED worktree's own
 * path + branch; the trigger is `FolderMenu.vue`, gated to linked worktrees).
 *
 * Mirrors `AddFolderDialog.vue`'s anatomy (Teleport → overlay-fade backdrop →
 * fade-in-scale card → header/body/footer, focus trap, Esc + backdrop close).
 * Only the body + footer content and the `dialog` id differ.
 *
 * The backend guard (`worktree-ipc.ts#removeWorktree`) REFUSES a worktree with
 * uncommitted changes OR unpushed commits unless `force` is set. The dialog
 * discovers that lazily: a first Remove attempt without force may come back
 * blocked, at which point we reveal the red **Force** disclosure so the operator
 * can consciously discard the work. `deleteBranch` optionally deletes the
 * worktree's branch after a successful remove.
 */

const ui = useUiStore()
const { t } = useI18n()

const isOpen = computed(() => ui.dialog === 'removeWorktree')

/** The worktree this dialog targets, or `null` when closed. */
const target = computed(() => ui.removeWorktreeTarget)

/**
 * Cross-platform basename of the worktree path (identical to the helper in
 * `AddFolderDialog.vue`). The path may carry either separator depending on the
 * host OS.
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

const worktreeName = computed(() => basename(target.value?.path ?? ''))
const branch = computed(() => target.value?.branch ?? '')

// --- Local form state ------------------------------------------------------

/** Also delete the worktree's branch after removal (default OFF). */
const deleteBranch = ref(false)
/**
 * Force removal — discards uncommitted / unpushed work. Only surfaced AFTER a
 * blocked attempt (`blockedReason` set); default OFF.
 */
const force = ref(false)
/**
 * The verbatim guard message from a blocked remove attempt ("worktree has
 * uncommitted changes; …" / "… unpushed commits; …"), or `null` when the
 * remove hasn't been blocked. Its presence reveals the Force disclosure.
 */
const blockedReason = ref<string | null>(null)
/** In-flight guard so a double-click can't fire two removes. */
const removing = ref(false)

function resetState(): void {
  deleteBranch.value = false
  force.value = false
  blockedReason.value = null
  removing.value = false
}

// --- Remove / close --------------------------------------------------------

async function remove(): Promise<void> {
  const tgt = ui.removeWorktreeTarget
  if (!tgt || removing.value) return
  removing.value = true
  try {
    // repoPath === worktreePath: git resolves the shared common-dir from the
    // worktree itself, so `git -C <worktree> worktree remove <worktree>` removes
    // the worktree we're standing on (worktree-ipc.ts#removeWorktree).
    await window.api.worktreeRemove({
      repoPath: tgt.path,
      worktreePath: tgt.path,
      force: force.value,
      deleteBranch: deleteBranch.value
    })
    ui.pushToast({ kind: 'success', title: t('worktree.remove.toastRemoved') })
    ui.closeDialog()
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    // The engine throws "worktree has uncommitted changes; …" or "… unpushed
    // commits; …" when the guard trips. Reveal the Force disclosure instead of
    // failing outright, so the operator can opt into discarding the work.
    if (/uncommitted|unpushed/i.test(msg) && !force.value) {
      blockedReason.value = msg
    } else {
      ui.pushToast({
        kind: 'danger',
        title: t('worktree.remove.toastFailed'),
        description: msg
      })
    }
  } finally {
    removing.value = false
  }
}

function close(): void {
  ui.closeDialog()
}

// --- Focus trap + backdrop click + keyboard --------------------------------

const dialogRef = ref<HTMLElement | null>(null)
/** Confirm button gets initial focus — the primary action of the dialog. */
const confirmButtonRef = ref<HTMLElement | null>(null)

useFocusTrap({
  active: isOpen,
  containerRef: dialogRef,
  initialFocusRef: confirmButtonRef
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
      v-if="isOpen && target"
      class="anim-overlay-fade fixed inset-0 flex items-center justify-center"
      style="background: rgba(0, 0, 0, 0.55); z-index: 60"
      role="presentation"
      @mousedown="onBackdropMousedown"
    >
      <div
        ref="dialogRef"
        class="anim-fade-in-scale flex flex-col border border-border-2 bg-surface text-text"
        style="
          width: min(480px, 90vw);
          max-height: 80vh;
          border-radius: 9px;
          box-shadow: var(--shadow-pop);
        "
        role="dialog"
        aria-modal="true"
        aria-labelledby="remove-worktree-dialog-title"
        @mousedown.stop
      >
        <!-- Header -->
        <header
          class="flex shrink-0 items-center justify-between border-b border-border"
          style="padding: 14px 18px 10px"
        >
          <h2
            id="remove-worktree-dialog-title"
            class="text-text"
            style="font-size: 13.5px; line-height: 20px; font-weight: 600"
          >
            {{ $t('worktree.remove.title') }}
          </h2>
          <button
            class="flex items-center justify-center rounded text-text-3 transition hover:bg-surface-2 hover:text-text"
            style="width: 24px; height: 24px"
            :aria-label="$t('actions.cancel')"
            @click="close()"
          >
            <X :size="14" :stroke-width="1.5" />
          </button>
        </header>

        <!-- Body -->
        <div class="scrollable flex-1 overflow-y-auto" style="padding: 14px 18px">
          <!-- Confirm sentence — worktree basename (bold) + branch (mono chip) -->
          <i18n-t
            keypath="worktree.remove.body"
            tag="p"
            scope="global"
            class="text-text-2"
            style="font-size: 12.5px; line-height: 19px"
          >
            <template #name>
              <b class="text-text">{{ worktreeName }}</b>
            </template>
            <template #branch>
              <code class="font-mono text-text-2" style="font-size: 11.5px">{{ branch }}</code>
            </template>
          </i18n-t>

          <!-- Also delete branch (default OFF) -->
          <label
            class="flex cursor-pointer items-center justify-between"
            style="gap: 12px; margin-top: 14px"
          >
            <span class="min-w-0 flex-1 text-text-2" style="font-size: 12px">
              {{ $t('worktree.remove.deleteBranch', { branch }) }}
            </span>
            <ToggleSwitch
              v-model="deleteBranch"
              :aria-label="$t('worktree.remove.deleteBranch', { branch })"
            />
          </label>

          <!-- Guard block + Force disclosure — only after a blocked attempt -->
          <div v-if="blockedReason" style="margin-top: 14px">
            <p
              class="border text-red"
              style="
                border-color: var(--color-red-soft);
                background: var(--color-red-soft);
                border-radius: 5px;
                padding: 8px 10px;
                font-size: 11.5px;
                line-height: 17px;
              "
            >
              {{ $t('worktree.remove.blocked') }}
            </p>
            <label
              class="flex cursor-pointer items-center justify-between"
              style="gap: 12px; margin-top: 12px"
            >
              <span class="min-w-0 flex-1 text-red" style="font-size: 12px; font-weight: 500">
                {{ $t('worktree.remove.force') }}
              </span>
              <ToggleSwitch v-model="force" :aria-label="$t('worktree.remove.force')" />
            </label>
          </div>
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
            :style="{
              opacity: removing ? 0.4 : 1,
              cursor: removing ? 'not-allowed' : 'pointer'
            }"
            :disabled="removing"
            @click="remove()"
          >
            <Trash2 :size="13" :stroke-width="1.8" />
            {{ $t('worktree.remove.confirm') }}
          </button>
        </footer>
      </div>
    </div>
  </Teleport>
</template>
