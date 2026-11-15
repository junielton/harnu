<script setup lang="ts">
/**
 * Topbar mission pill (T370; Missions v4 S-17, S-35 — design.md §6 "Mission pane" → Topbar pill — v4).
 *
 * Every record has one pill and one place to open: a session's mission shows "4/21 · 3 for you" (the
 * server's numbers; no campaign or chapter wording) and the pill toggles the Mission pane in the helper
 * stack. Since the cut-over (S-35) that holds for a v3 file too: the view channel reads it as v4 without
 * writing, and its first door use creates the v4 copy. Renders nothing when the selected session is in no
 * open mission (`no-mission` is a state, not a gap).
 *
 * The popover that used to open from here is no longer reachable; its files stay until S-37 deletes them.
 * The keyboard action (`view.missionProgress`) toggles the pane through this pill; an Activity row that names a
 * mission opens it through the store (`requestPopover`, kept until S-37).
 */
import { computed, onBeforeUnmount, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { Check, Target } from 'lucide-vue-next'
import {
  missionPillText,
  missionPillTone,
  V4_PILL_RING_CLASS,
  V4_PILL_TONE_CLASS
} from '../lib/mission-pane-view'
import { useHelpersStore } from '../stores/helpers'
import { useMissionsStore } from '../stores/missions'
import { useUiStore } from '../stores/ui'
import { useKeybindingsStore } from '../stores/keybindings'

const props = defineProps<{ sessionId: string }>()

const { t } = useI18n()
const missions = useMissionsStore()
const ui = useUiStore()
const helpers = useHelpersStore()
const keybindings = useKeybindingsStore()
missions.ensureStarted()

/** The mission this session is in, as the view channel answered it (a v3 file read as v4 included), or `null`. */
const v4 = computed(() => missions.v4MissionForSession(props.sessionId))
const v4Label = computed(() => (v4.value ? missionPillText(t, v4.value.detail) : ''))
const v4Tone = computed(() => (v4.value ? missionPillTone(v4.value.detail) : 'accent'))
const v4Title = computed(() =>
  v4.value
    ? t('missionPane.pill.title', { title: v4.value.detail.title, label: v4Label.value })
    : ''
)
const v4Ready = computed(() => v4.value?.detail.state === 'ready-to-close')
/** Whether the Mission pane is open in the selected session's stack: the pill reads pressed. */
const paneOpen = computed(() => helpers.panesForCurrentWorktree.some((p) => p.type === 'mission'))
function togglePane(): void {
  const worktree = helpers.currentWorktreePath
  if (worktree) helpers.toggleMissionHelper(worktree)
}

// The popover flag lives in the ui store (T486 U4a): `view.missionProgress` flips it and the App's Esc binding
// reads the anchor. The pill is the anchor while the session is in a mission; the flag never draws anything
// now, so a flip is answered by toggling the pane and putting the flag back.
watch(
  () => !!v4.value,
  (present) => ui.setPopoverAnchor('missionProgress', present),
  { immediate: true }
)
onBeforeUnmount(() => ui.setPopoverAnchor('missionProgress', false))
watch(
  () => ui.popovers.missionProgress,
  (isOpen) => {
    if (!isOpen) return
    ui.closePopover('missionProgress')
    togglePane()
  },
  { flush: 'sync' }
)
</script>

<template>
  <div
    v-if="v4"
    class="relative flex min-w-0 shrink"
    style="-webkit-app-region: no-drag"
    data-v4="true"
  >
    <button
      type="button"
      class="flex min-w-0 shrink cursor-pointer items-center rounded-sm border tabular-nums transition hover:brightness-110"
      :class="[V4_PILL_TONE_CLASS[v4Tone], paneOpen ? V4_PILL_RING_CLASS[v4Tone] : '']"
      style="gap: 5px; padding: 1px 7px; font-size: 10.5px; font-weight: 500; height: 18px"
      :title="keybindings.withChord(v4Title, 'view.missionProgress')"
      :aria-label="v4Title"
      :aria-pressed="paneOpen"
      :data-dsqa="`topbar-pill--${v4Tone}`"
      @click="togglePane"
    >
      <component :is="v4Ready ? Check : Target" :size="10" :stroke-width="1.8" class="shrink-0" />
      <span class="truncate" data-test="mission-pill-label">{{ v4Label }}</span>
    </button>
  </div>
</template>
