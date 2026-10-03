<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { RotateCcw, Delete } from 'lucide-vue-next'
import SettingHint from './ui/SettingHint.vue'
import { useKeybindingsStore } from '../stores/keybindings'
import { isMac } from '../lib/platform'
import {
  chordFromEvent,
  normalizeChord,
  renderKeysString,
  type ResolvedBinding,
  type ShortcutActionId
} from '../../../main/keybindings-core'

/**
 * Settings → Keyboard Shortcuts (T1 P4). The mouse-reachable twin of
 * hand-editing `keybindings.json` — one row per rebindable action with a
 * record-a-chord capture control, per-row Reset + Unbind, a global Reset all,
 * conflict badges on every participant, and a "not in terminal" marker for the
 * renderer-only (`menu: false`) actions.
 *
 * All persistence goes through the store's `setBinding` / `resetBinding` /
 * `resetAll`, which serialize the override set back to `keybindings.json` and
 * optimistically re-resolve; the chokidar watch then confirms. See
 * `docs/specs/T1-customizable-keybindings.md`.
 */

const { t } = useI18n()
const keybindings = useKeybindingsStore()

const rows = computed<ResolvedBinding[]>(() => keybindings.resolved.list)
const anyOverridden = computed(() => rows.value.some((b) => b.source !== 'default'))

/** id of the row currently capturing a chord, or null. */
const recordingId = ref<ShortcutActionId | null>(null)

function chipText(keys: string | null): string {
  const tokens = renderKeysString(keys, { mac: isMac })
  return tokens.join(isMac ? '' : '+')
}

function conflictNames(b: ResolvedBinding): string {
  return b.conflictsWith.map((id) => t(`keybindings.actions.${id}`)).join(', ')
}

function stopRecording(): void {
  recordingId.value = null
  window.removeEventListener('keydown', onCaptureKey, true)
  window.removeEventListener('pointerdown', onOutsidePointer, true)
}

/**
 * Arm a row, then click away without pressing a key and the window `keydown`
 * capture would stay live — the next character typed into (say) the Settings
 * search box gets `preventDefault`'d and silently rebound. So a pointerdown
 * anywhere outside the armed capture button cancels the recording. A pointerdown
 * ON the armed button is left alone: its own `@click` toggles recording off.
 */
function onOutsidePointer(e: PointerEvent): void {
  const armed = recordingId.value
  if (!armed) return
  const hit = (e.target as HTMLElement | null)?.closest?.('[data-kb-capture]')
  if (hit && hit.getAttribute('data-kb-capture') === armed) return
  stopRecording()
}

function onCaptureKey(e: KeyboardEvent): void {
  e.preventDefault()
  e.stopPropagation()
  const id = recordingId.value
  if (!id) return
  const chord = chordFromEvent(e, { mac: isMac })
  if (!chord) return // a lone modifier — keep listening
  const bare = !chord.cmd && !chord.ctrl && !chord.alt && !chord.shift
  if (bare && chord.key === 'Escape') {
    stopRecording()
    return
  }
  if (bare && chord.key === 'Backspace') {
    void keybindings.setBinding(id, null)
    stopRecording()
    return
  }
  void keybindings.setBinding(id, normalizeChord(chord))
  stopRecording()
}

function startRecording(id: ShortcutActionId): void {
  if (recordingId.value === id) {
    stopRecording()
    return
  }
  recordingId.value = id
  window.addEventListener('keydown', onCaptureKey, true)
  window.addEventListener('pointerdown', onOutsidePointer, true)
}

onBeforeUnmount(stopRecording)
</script>

<template>
  <div>
    <section style="margin-bottom: 16px">
      <div class="flex items-start justify-between" style="gap: 12px; margin-bottom: 12px">
        <div style="flex: 1; min-width: 0">
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
            {{ t('keybindings.pane.eyebrow') }}
          </div>
          <p class="text-text-3" style="font-size: 11.5px; line-height: 1.5">
            {{ t('keybindings.pane.intro') }}
          </p>
        </div>
        <div class="flex shrink-0 items-center gap-1.5">
          <button
            type="button"
            class="border border-border bg-surface text-text-2 transition hover:bg-surface-2"
            style="padding: 5px 10px; border-radius: 5px; font-size: 11.5px"
            @click="keybindings.openInEditor()"
          >
            {{ t('keybindings.pane.openFile') }}
          </button>
          <button
            type="button"
            class="border border-border bg-surface text-text-2 transition hover:bg-surface-2 disabled:opacity-40"
            style="padding: 5px 10px; border-radius: 5px; font-size: 11.5px"
            :disabled="!anyOverridden"
            @click="keybindings.resetAll()"
          >
            {{ t('keybindings.pane.resetAll') }}
          </button>
        </div>
      </div>

      <div class="flex flex-col" style="gap: 2px">
        <div
          v-for="b in rows"
          :key="b.id"
          class="flex items-center border-b border-border"
          style="gap: 10px; padding: 7px 2px"
        >
          <span class="truncate text-text-2" style="flex: 1; min-width: 0; font-size: 12px">
            {{ t(`keybindings.actions.${b.id}`) }}
          </span>

          <button
            type="button"
            :data-kb-capture="b.id"
            class="shrink-0 border font-mono transition"
            :class="
              recordingId === b.id
                ? 'border-accent-line bg-surface-2 text-text'
                : 'border-border bg-surface-2 text-text-2 hover:text-text'
            "
            style="
              min-width: 92px;
              padding: 2px 6px;
              border-radius: 3px;
              font-size: 10.5px;
              line-height: 14px;
              text-align: center;
            "
            :aria-label="
              t('keybindings.pane.capture', { action: t(`keybindings.actions.${b.id}`) })
            "
            @click="startRecording(b.id)"
          >
            <template v-if="recordingId === b.id">{{ t('keybindings.pane.recording') }}</template>
            <template v-else-if="b.keys">{{ chipText(b.keys) }}</template>
            <template v-else-if="b.source === 'unbound'">{{
              t('keybindings.pane.unbound')
            }}</template>
            <template v-else>{{ t('keybindings.pane.empty') }}</template>
          </button>

          <span
            v-if="b.source !== 'default' && b.defaultKeys"
            class="shrink-0 text-text-4"
            style="font-size: 11px"
          >
            {{ t('keybindings.pane.default', { chord: chipText(b.defaultKeys) }) }}
          </span>

          <span v-if="!b.menu" class="shrink-0 text-text-4" style="font-size: 11px">
            {{ t('keybindings.pane.notInTerminal') }}
          </span>

          <span
            v-if="b.conflictsWith.length > 0"
            class="shrink-0 border border-warning-line bg-warning-soft text-warning"
            style="padding: 1px 6px; border-radius: 4px; font-size: 10.5px"
          >
            {{ t('keybindings.pane.conflict', { names: conflictNames(b) }) }}
          </span>

          <button
            v-if="b.source !== 'default'"
            type="button"
            class="flex shrink-0 items-center text-text-3 transition hover:text-text"
            style="
              gap: 3px;
              font-size: 11px;
              background: none;
              border: none;
              padding: 0;
              cursor: pointer;
            "
            @click="keybindings.resetBinding(b.id)"
          >
            <RotateCcw :size="12" :stroke-width="1.8" />
            {{ t('keybindings.pane.reset') }}
          </button>

          <button
            v-if="b.source !== 'unbound'"
            type="button"
            class="flex shrink-0 items-center text-text-3 transition hover:text-text"
            style="
              gap: 3px;
              font-size: 11px;
              background: none;
              border: none;
              padding: 0;
              cursor: pointer;
            "
            @click="keybindings.setBinding(b.id, null)"
          >
            <Delete :size="12" :stroke-width="1.8" />
            {{ t('keybindings.pane.unbind') }}
          </button>
        </div>
      </div>

      <SettingHint>{{ t('keybindings.pane.captureHint') }}</SettingHint>
    </section>
  </div>
</template>
