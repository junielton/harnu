<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { RotateCcw, Delete, Search } from 'lucide-vue-next'
import SettingHint from './ui/SettingHint.vue'
import { useKeybindingsStore } from '../stores/keybindings'
import { isMac } from '../lib/platform'
import { TERMINAL_KEYMAP_CHORDS } from '../lib/terminalKeymap'
import {
  DESCRIPTOR_BY_ID,
  KEYBINDING_GROUPS,
  canonicalizeChord,
  chordFromEvent,
  isNotInTerminal,
  isUnreachableChord,
  matchesShortcutQuery,
  normalizeChord,
  parseShortcutQuery,
  renderKeysString,
  scopeChordKey,
  type KeybindingGroup,
  type ResolvedBinding,
  type ShortcutActionId
} from '../../../main/keybindings-core'

/**
 * Settings → Keyboard Shortcuts (T1 P4, T486 U1). The mouse-reachable twin of
 * hand-editing `keybindings.json` — one row per rebindable action with a
 * record-a-chord capture control, per-row Reset + Unbind, a global Reset all,
 * conflict badges on every participant, and a "not in terminal" marker for the
 * renderer-only actions (`isNotInTerminal`). T486 adds the search (text or
 * chord), the group headers, the Unbound / Conflicts / Customized filter chips,
 * and two hint lines: the shield hint and the terminal-keeps hint.
 *
 * All persistence goes through the store's `setBinding` / `resetBinding` /
 * `resetAll`, which serialize the override set back to `keybindings.json` and
 * optimistically re-resolve; the chokidar watch then confirms. See
 * `docs/specs/T1-customizable-keybindings.md` and
 * `docs/specs/T486-keybindings-coverage-pass.md` §4–§5.
 */

const { t } = useI18n()
const keybindings = useKeybindingsStore()

const rows = computed<ResolvedBinding[]>(() => keybindings.resolved.list)
const anyOverridden = computed(() => rows.value.some((b) => b.source !== 'default'))

type ChipId = 'unbound' | 'conflicts' | 'customized'
const CHIPS: readonly ChipId[] = ['unbound', 'conflicts', 'customized']
const CHIP_RULES: Record<ChipId, (b: ResolvedBinding) => boolean> = {
  unbound: (b) => b.keys === null,
  conflicts: (b) => b.conflictsWith.length > 0,
  customized: (b) => b.source !== 'default'
}

const search = ref('')
const searchInput = ref<HTMLInputElement | null>(null)
const activeChips = reactive<Record<ChipId, boolean>>({
  unbound: false,
  conflicts: false,
  customized: false
})

/** Counts over the WHOLE table, never the filtered view. */
const chipCounts = computed<Record<ChipId, number>>(() => ({
  unbound: rows.value.filter(CHIP_RULES.unbound).length,
  conflicts: rows.value.filter(CHIP_RULES.conflicts).length,
  customized: rows.value.filter(CHIP_RULES.customized).length
}))

const query = computed(() => parseShortcutQuery(search.value))

const visibleRows = computed(() =>
  rows.value.filter(
    (b) =>
      CHIPS.every((c) => !activeChips[c] || CHIP_RULES[c](b)) &&
      matchesShortcutQuery(b, label(b.id), query.value, isMac)
  )
)

/** Visible rows by group, in the fixed group order; empty groups dropped. */
const groups = computed<Array<{ id: KeybindingGroup; rows: ResolvedBinding[] }>>(() =>
  KEYBINDING_GROUPS.map((id) => ({
    id,
    rows: visibleRows.value.filter((b) => DESCRIPTOR_BY_ID[b.id]?.group === id)
  })).filter((g) => g.rows.length > 0)
)

/** A chord the recorder refused for a row (AC-50), shown under that row. */
const refusal = ref<{ id: ShortcutActionId; chord: string } | null>(null)

function label(id: ShortcutActionId): string {
  return t(DESCRIPTOR_BY_ID[id].labelKey)
}

function chipText(keys: string | null): string {
  const tokens = renderKeysString(keys, { mac: isMac })
  return tokens.join(isMac ? '' : '+')
}

/** The chords the terminal keymap swallows, folded the way the resolver folds. */
const terminalKept = new Set(
  (isMac ? TERMINAL_KEYMAP_CHORDS.mac : TERMINAL_KEYMAP_CHORDS.other).map((c) =>
    scopeChordKey('global', c, isMac)
  )
)

/** Shielded and bound: the shield takes its chord from every terminal (§7.4). */
function shieldHint(b: ResolvedBinding): boolean {
  return !!DESCRIPTOR_BY_ID[b.id].shield && b.keys !== null
}

/** Not shielded, and bound to a chord the terminal keymap keeps for itself. */
function terminalKeeps(b: ResolvedBinding): boolean {
  if (DESCRIPTOR_BY_ID[b.id].shield || !b.keys) return false
  const keys = canonicalizeChord(b.keys)
  return keys !== null && terminalKept.has(scopeChordKey('global', keys, isMac))
}

function conflictNames(b: ResolvedBinding): string {
  return b.conflictsWith.map(label).join(', ')
}

function stopRecording(): void {
  keybindings.recordingId = null
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
  const armed = keybindings.recordingId
  if (!armed) return
  const hit = (e.target as HTMLElement | null)?.closest?.('[data-kb-capture]')
  if (hit && hit.getAttribute('data-kb-capture') === armed) return
  stopRecording()
}

/**
 * Window capture, registered after `SettingsDialog`'s — which stands down while
 * `recordingId` is set, so a bare Esc here cancels the recording and leaves
 * Settings open.
 */
function onCaptureKey(e: KeyboardEvent): void {
  e.preventDefault()
  e.stopPropagation()
  const id = keybindings.recordingId
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
  if (isUnreachableChord(chord, DESCRIPTOR_BY_ID[id], isMac)) {
    refusal.value = { id, chord: chipText(normalizeChord(chord)) }
    stopRecording()
    return
  }
  void keybindings.setBinding(id, normalizeChord(chord))
  stopRecording()
}

function startRecording(id: ShortcutActionId): void {
  refusal.value = null
  if (keybindings.recordingId === id) {
    stopRecording()
    return
  }
  keybindings.recordingId = id
  window.addEventListener('keydown', onCaptureKey, true)
  window.addEventListener('pointerdown', onOutsidePointer, true)
}

// The search takes focus when the tab opens. `nextTick` so it lands after the
// Settings focus trap's own initial focus when the dialog opens on this tab.
onMounted(() => {
  void nextTick(() => searchInput.value?.focus())
})

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

      <!-- Search — the Settings search input anatomy (design.md §6 Keyboard Shortcuts) -->
      <div class="relative" style="margin-bottom: 8px">
        <Search
          class="pointer-events-none absolute text-text-4"
          style="left: 9px; top: 50%; transform: translateY(-50%)"
          :size="13"
          :stroke-width="1.8"
        />
        <input
          ref="searchInput"
          v-model="search"
          type="text"
          data-kb-search
          class="w-full border border-border bg-bg text-text outline-none transition placeholder:text-text-4 focus:border-accent-line"
          style="border-radius: 5px; padding: 7px 10px 7px 28px; font-size: 12px"
          :placeholder="t('keybindings.pane.search')"
          :aria-label="t('keybindings.pane.search')"
        />
      </div>

      <!-- Filter chips — Badge anatomy; Default inactive, Accent active -->
      <div
        class="flex flex-wrap items-center"
        style="gap: 6px; margin-bottom: 12px"
        role="group"
        :aria-label="t('keybindings.pane.chips.label')"
      >
        <button
          v-for="c in CHIPS"
          :key="c"
          type="button"
          :data-kb-chip="c"
          :aria-pressed="activeChips[c]"
          class="border transition"
          :class="
            activeChips[c]
              ? 'border-accent-line bg-accent-soft text-accent'
              : 'border-border bg-surface text-text-3 hover:text-text-2'
          "
          style="padding: 2px 8px; border-radius: 999px; font-size: 11px"
          @click="activeChips[c] = !activeChips[c]"
        >
          {{ t(`keybindings.pane.chips.${c}`) }}
          <span class="tabular-nums" style="margin-left: 3px">{{ chipCounts[c] }}</span>
        </button>
      </div>

      <p
        v-if="groups.length === 0"
        data-kb-no-match
        class="text-text-4"
        style="font-size: 12px; padding: 7px 2px"
      >
        {{ t('keybindings.pane.noMatch') }}
      </p>

      <div v-for="(g, gi) in groups" :key="g.id" :data-kb-group="g.id">
        <!-- Settings eyebrow, not the §3 .eyebrow: siblings of the pane's own eyebrow -->
        <div
          class="text-text-3"
          :style="{
            fontSize: '11px',
            fontWeight: 500,
            letterSpacing: '0.06em',
            textTransform: 'uppercase',
            marginTop: gi === 0 ? '0' : '14px',
            marginBottom: '4px'
          }"
        >
          {{ t(`keybindings.pane.groups.${g.id}`) }}
        </div>

        <div class="flex flex-col" style="gap: 2px">
          <div
            v-for="b in g.rows"
            :key="b.id"
            :data-kb-row="b.id"
            class="border-b border-border"
            style="padding: 7px 2px"
          >
            <div class="flex items-center" style="gap: 10px">
              <span class="truncate text-text-2" style="flex: 1; min-width: 0; font-size: 12px">
                {{ label(b.id) }}
              </span>

              <button
                type="button"
                :data-kb-capture="b.id"
                class="shrink-0 border font-mono transition"
                :class="
                  keybindings.recordingId === b.id
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
                :aria-label="t('keybindings.pane.capture', { action: label(b.id) })"
                @click="startRecording(b.id)"
              >
                <template v-if="keybindings.recordingId === b.id">{{
                  t('keybindings.pane.recording')
                }}</template>
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

              <span
                v-if="isNotInTerminal(DESCRIPTOR_BY_ID[b.id])"
                data-kb-not-in-terminal
                class="shrink-0 text-text-4"
                style="font-size: 11px"
              >
                {{ t('keybindings.pane.notInTerminal') }}
              </span>

              <span
                v-if="b.conflictsWith.length > 0"
                data-kb-conflict
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

              <!-- Only when there is a chord to drop: an unbound row, or one that
                   ships with no default and hasn't been given one, has nothing. -->
              <button
                v-if="b.keys"
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

            <p
              v-if="shieldHint(b)"
              data-kb-shield-hint
              class="text-text-4"
              style="font-size: 11px; margin-top: 3px"
            >
              {{ t('keybindings.pane.shieldHint', { chord: chipText(b.keys) }) }}
            </p>
            <p
              v-else-if="terminalKeeps(b)"
              data-kb-terminal-keeps
              class="text-text-4"
              style="font-size: 11px; margin-top: 3px"
            >
              {{ t('keybindings.pane.terminalKeepsHint', { chord: chipText(b.keys) }) }}
            </p>

            <p
              v-if="refusal && refusal.id === b.id"
              data-kb-refusal
              role="status"
              class="text-text-4"
              style="font-size: 11px; margin-top: 3px"
            >
              {{ t('keybindings.pane.unreachable', { chord: refusal.chord }) }}
            </p>
          </div>
        </div>
      </div>

      <SettingHint>{{ t('keybindings.pane.captureHint') }}</SettingHint>
    </section>
  </div>
</template>
