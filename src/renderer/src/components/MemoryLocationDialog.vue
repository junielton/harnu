<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { X, FolderOpen, TriangleAlert } from 'lucide-vue-next'
import { useI18n } from 'vue-i18n'
import { useUiStore } from '../stores/ui'
import { useFocusTrap } from '../composables/useFocusTrap'
import { basename } from './folder-alias'
import SegmentedControl from './ui/SegmentedControl.vue'
import SettingHint from './ui/SettingHint.vue'
import type { FolderMemoryLocation, MemoryLocationConfig } from '../../../preload'

/**
 * "Store this project's memory in…" dialog (T89): the per-project override that
 * wins over the global default (Settings → Memory). Three choices — follow the
 * global default, force in-project, or a central root — persisted only in Harnu's
 * config, never in the repo. After a location change it offers the assisted
 * "move existing memory now" migration so memory is never silently orphaned.
 * design.md §6 "Store memory in… (folder menu)".
 */

type OverrideMode = 'global' | 'in-project' | 'central'

const ui = useUiStore()
const { t } = useI18n()

const isOpen = computed(() => ui.dialog === 'memoryLocation')
const targetPath = computed(() => ui.folderActionPath ?? '')
const base = computed(() => basename(targetPath.value))

const loading = ref(true)
const saving = ref(false)
const error = ref<string | null>(null)

const overrideMode = ref<OverrideMode>('global')
const root = ref('')
/** The location snapshot when the dialog opened — the migration source. */
const before = ref<FolderMemoryLocation | null>(null)

/** After a save that moved the location: the from/to configs to offer a move. */
const pendingMove = ref<{ from: MemoryLocationConfig; to: MemoryLocationConfig } | null>(null)
const moving = ref(false)
const moveSummary = ref<string | null>(null)

const globalModeLabel = computed(() => {
  const g = before.value?.globalDefault
  return g?.mode === 'central' ? t('memoryLocation.modeCentral') : t('memoryLocation.modeInProject')
})

function buildOverride(): MemoryLocationConfig | null {
  if (overrideMode.value === 'global') return null
  if (overrideMode.value === 'central') return { mode: 'central', root: root.value.trim() }
  return { mode: 'in-project' }
}

const canSave = computed(
  () => !saving.value && (overrideMode.value !== 'central' || root.value.trim().length > 0)
)

const modeOptions = computed(() => [
  { value: 'global', label: t('memoryLocation.dialogFollowGlobal') },
  { value: 'in-project', label: t('memoryLocation.dialogInProject') },
  { value: 'central', label: t('memoryLocation.modeCentral') }
])

async function load(): Promise<void> {
  loading.value = true
  error.value = null
  pendingMove.value = null
  moveSummary.value = null
  try {
    const res = await window.api.memoryLocationGetForFolder(targetPath.value)
    if (!res.ok) {
      error.value = t('memoryLocation.loadFailed')
      return
    }
    before.value = res
    if (!res.override) overrideMode.value = 'global'
    else overrideMode.value = res.override.mode
    root.value = res.override?.mode === 'central' ? res.override.root : ''
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    loading.value = false
  }
}

async function choose(): Promise<void> {
  const { path } = await window.api.dialogOpenDirectory()
  if (path) root.value = path
}

async function save(): Promise<void> {
  if (!canSave.value || !before.value) return
  saving.value = true
  error.value = null
  const prev = before.value
  try {
    const res = await window.api.memoryLocationSetOverride(targetPath.value, buildOverride())
    if (!res.ok) {
      error.value =
        res.code === 'invalid-root'
          ? t('memoryLocation.invalidRoot')
          : t('memoryLocation.saveFailed')
      return
    }
    // Offer the move only when there is existing memory at the OLD location and
    // the resolved dir actually changed.
    if (prev.exists && prev.memoryDir !== res.memoryDir) {
      before.value = res
      pendingMove.value = { from: prev.effective, to: res.effective }
    } else {
      ui.closeDialog()
    }
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    saving.value = false
  }
}

async function moveNow(): Promise<void> {
  if (!pendingMove.value || moving.value) return
  moving.value = true
  try {
    const res = await window.api.memoryLocationMigrateFolder(
      targetPath.value,
      pendingMove.value.from,
      pendingMove.value.to
    )
    if (!res.ok) {
      moveSummary.value = t('memoryLocation.moveFailed', { detail: res.code })
      return
    }
    const r = res.report
    switch (r.code) {
      case 'moved':
        moveSummary.value = t('memoryLocation.moveDone', { count: r.movedFiles.length })
        break
      case 'nothing-to-move':
        moveSummary.value = t('memoryLocation.moveNothing')
        break
      case 'same-location':
        moveSummary.value = t('memoryLocation.moveSameLocation')
        break
      case 'target-exists':
        moveSummary.value = t('memoryLocation.moveTargetExists')
        break
      default:
        moveSummary.value = t('memoryLocation.moveFailed', { detail: r.detail ?? r.code })
    }
    pendingMove.value = null
  } catch (e) {
    moveSummary.value = e instanceof Error ? e.message : String(e)
  } finally {
    moving.value = false
  }
}

function close(): void {
  ui.closeDialog()
}

const dialogRef = ref<HTMLElement | null>(null)
useFocusTrap({ active: isOpen, containerRef: dialogRef })

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
    window.addEventListener('keydown', onKeydown, true)
    void load()
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
          width: min(520px, 92vw);
          max-height: 82vh;
          border-radius: 9px;
          box-shadow: var(--shadow-pop);
        "
        role="dialog"
        aria-modal="true"
        aria-labelledby="memory-location-dialog-title"
        @mousedown.stop
      >
        <!-- Header -->
        <header
          class="flex shrink-0 items-center justify-between border-b border-border"
          style="padding: 14px 18px 10px"
        >
          <div class="flex items-baseline" style="gap: 8px; min-width: 0">
            <h2
              id="memory-location-dialog-title"
              class="text-text"
              style="font-size: 13.5px; line-height: 20px; font-weight: 600"
            >
              {{ t('memoryLocation.dialogTitle') }}
            </h2>
            <span class="truncate font-mono text-text-4" style="font-size: 11.5px">{{ base }}</span>
          </div>
          <button
            class="flex items-center justify-center rounded text-text-3 transition hover:bg-surface-2 hover:text-text"
            style="width: 24px; height: 24px"
            :aria-label="t('memoryLocation.close')"
            @click="close()"
          >
            <X :size="14" :stroke-width="1.5" />
          </button>
        </header>

        <!-- Body -->
        <div class="flex-1 overflow-y-auto" style="padding: 14px 18px">
          <p v-if="loading" class="text-text-3" style="font-size: 12px">
            {{ t('memoryLocation.loading') }}
          </p>

          <template v-else>
            <div
              class="text-text-3"
              style="
                font-size: 11px;
                font-weight: 500;
                letter-spacing: 0.06em;
                text-transform: uppercase;
                margin-bottom: 8px;
              "
            >
              {{ t('memoryLocation.overrideEyebrow') }}
            </div>
            <SegmentedControl
              v-model="overrideMode"
              :options="modeOptions"
              size="sm"
              :aria-label="t('memoryLocation.overrideEyebrow')"
            />
            <SettingHint v-if="overrideMode === 'global'">
              {{ t('memoryLocation.followGlobalHint', { mode: globalModeLabel }) }}
            </SettingHint>
            <SettingHint v-else-if="overrideMode === 'central'">
              {{ t('memoryLocation.centralHint') }}
            </SettingHint>
            <SettingHint v-else>
              {{ t('memoryLocation.inProjectHint') }}
            </SettingHint>

            <div v-if="overrideMode === 'central'" style="margin-top: 12px">
              <label
                class="text-text-3"
                style="display: block; font-size: 11px; font-weight: 500; margin-bottom: 6px"
              >
                {{ t('memoryLocation.rootLabel') }}
              </label>
              <div class="flex items-center" style="gap: 8px">
                <input
                  v-model="root"
                  type="text"
                  spellcheck="false"
                  autocomplete="off"
                  class="w-full border border-border bg-bg font-mono text-text transition focus:border-accent-line focus:outline-none"
                  style="padding: 6px 9px; font-size: 12px; border-radius: 5px"
                  :placeholder="t('memoryLocation.rootPlaceholder')"
                />
                <button
                  type="button"
                  class="flex shrink-0 items-center border border-border bg-surface text-text transition hover:bg-surface-2"
                  style="padding: 7px 12px; font-size: 12.5px; border-radius: 5px; gap: 6px"
                  @click="choose()"
                >
                  <FolderOpen :size="13" :stroke-width="1.7" />
                  {{ t('memoryLocation.choose') }}
                </button>
              </div>
            </div>

            <!-- Current resolved location -->
            <div v-if="before" style="margin-top: 14px">
              <div
                class="text-text-3"
                style="
                  font-size: 11px;
                  font-weight: 500;
                  letter-spacing: 0.06em;
                  text-transform: uppercase;
                  margin-bottom: 4px;
                "
              >
                {{ t('memoryLocation.currentLocation') }}
              </div>
              <div
                class="truncate font-mono text-text-4"
                style="font-size: 11px"
                :title="before.memoryDir"
              >
                {{ before.memoryDir }}
              </div>
            </div>

            <div
              v-if="error"
              class="flex items-start border border-red text-warning"
              style="
                gap: 8px;
                padding: 9px 11px;
                margin-top: 12px;
                border-radius: 6px;
                background: var(--color-red-soft);
                font-size: 12px;
              "
            >
              <TriangleAlert
                :size="14"
                :stroke-width="1.7"
                style="margin-top: 1px; flex-shrink: 0"
              />
              <span>{{ error }}</span>
            </div>

            <!-- Assisted migration (never silently orphan) -->
            <div
              v-if="pendingMove"
              class="border border-border bg-bg"
              style="margin-top: 16px; border-radius: 7px; padding: 12px"
            >
              <div
                class="text-text-2"
                style="font-size: 12px; font-weight: 500; margin-bottom: 4px"
              >
                {{ t('memoryLocation.moveNowTitle') }}
              </div>
              <p class="text-text-3" style="font-size: 11px; line-height: 1.5; margin-bottom: 10px">
                {{ t('memoryLocation.moveNowBody') }}
              </p>
              <button
                type="button"
                class="border border-border bg-surface text-text transition hover:bg-surface-2 disabled:opacity-40"
                style="padding: 7px 14px; font-size: 12.5px; border-radius: 5px"
                :disabled="moving"
                @click="moveNow()"
              >
                {{ moving ? t('memoryLocation.moving') : t('memoryLocation.moveNow') }}
              </button>
            </div>

            <p
              v-if="moveSummary"
              class="text-text-3"
              style="font-size: 11.5px; margin-top: 12px; line-height: 1.5"
            >
              {{ moveSummary }}
            </p>
          </template>
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
            {{ pendingMove ? t('memoryLocation.close') : t('actions.cancel') }}
          </button>
          <button
            v-if="!pendingMove"
            class="bg-accent text-accent-ink transition"
            style="
              padding: 7px 14px;
              font-size: 12.5px;
              font-weight: 500;
              border-radius: 5px;
              border: none;
              height: 28px;
            "
            :style="{ opacity: canSave ? 1 : 0.4, cursor: canSave ? 'pointer' : 'not-allowed' }"
            :disabled="!canSave"
            @click="save()"
          >
            {{ saving ? t('memoryLocation.saving') : t('memoryLocation.save') }}
          </button>
        </footer>
      </div>
    </div>
  </Teleport>
</template>
