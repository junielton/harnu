<script setup lang="ts">
/**
 * Topbar mission pill (T370; Missions v4 S-17, S-35; Mission dropdown S-7 — design.md §6 "Mission dropdown" →
 * "Topbar pill").
 *
 * Every record has one pill and one place to open: a session's mission shows "4/21 · 3 for you" (the
 * server's numbers; no campaign or chapter wording) and the pill opens the Mission dropdown that hangs under
 * it. Since the cut-over (S-35) that holds for a v3 file too: the view channel reads it as v4 without
 * writing, and its first door use creates the v4 copy. A session in no mission draws a muted, icon-only pill
 * ("No mission") that opens the dropdown's empty state, so the attach picker keeps a door.
 *
 * The pill is a button with `aria-haspopup="dialog"` and `aria-expanded`, a trailing caret, and the tone's ring
 * while the dropdown is open. The dropdown's open state is the `ui.popovers.missionProgress` flag: the button, the
 * keyboard action (`view.missionProgress`) and the store's `openMissionDropdown` (the Activity row, the Your
 * move card) all flip it. The pill is the flag's anchor whenever it is drawn, a no-mission pill too, and it
 * mounts the dropdown, which is teleported to `body`.
 */
import { computed, onBeforeUnmount, onMounted, onUpdated } from 'vue'
import { useI18n } from 'vue-i18n'
import { Check, ChevronDown, Target } from 'lucide-vue-next'
import {
  missionPillText,
  missionPillTone,
  V4_PILL_RING_CLASS,
  V4_PILL_TONE_CLASS
} from '../lib/mission-pane-view'
import { useMissionsStore } from '../stores/missions'
import { useUiStore } from '../stores/ui'
import { useKeybindingsStore } from '../stores/keybindings'
import MissionDropdown from './MissionDropdown.vue'

const props = defineProps<{ sessionId: string }>()
/**
 * The pill's width changed or the pill came or went. The Topbar reserves what it cannot shrink (this pill, the
 * provider and the orchestrator badges) and plans its action cluster around it, so it measures again.
 */
const emit = defineEmits<{ layout: [] }>()
onMounted(() => emit('layout'))
onUpdated(() => emit('layout'))
onBeforeUnmount(() => emit('layout'))

const { t } = useI18n()
const missions = useMissionsStore()
const ui = useUiStore()
const keybindings = useKeybindingsStore()
missions.ensureStarted()

/** The mission this session is in, as the view channel answered it (a v3 file read as v4 included), or `null`. */
const v4 = computed(() => missions.v4MissionForSession(props.sessionId))
const v4Label = computed(() => (v4.value ? missionPillText(t, v4.value.detail) : ''))
const v4Tone = computed(() => (v4.value ? missionPillTone(v4.value.detail) : 'accent'))
const v4Title = computed(() =>
  v4.value
    ? t('missionPane.pill.title', { title: v4.value.detail.title, label: v4Label.value })
    : t('missionDropdown.pill.none')
)
const v4Ready = computed(() => v4.value?.detail.state === 'ready-to-close')
/** The quiet pill: the muted, icon-only one a session in no mission draws. */
const quiet = computed(() => !v4.value)
const open = computed(() => ui.popovers.missionProgress)

/** The tone's classes: the muted pill is `border-border-2` / `text-text-3` with no fill and no ring. */
const toneClass = computed(() =>
  quiet.value ? 'border-border-2 text-text-3' : V4_PILL_TONE_CLASS[v4Tone.value]
)
const ringClass = computed(() =>
  open.value ? (quiet.value ? 'ring-2 ring-border-2' : V4_PILL_RING_CLASS[v4Tone.value]) : ''
)

// The popover flag lives in the ui store (T486 U4a): `view.missionProgress` flips it, the App's Esc binding reads
// the anchor and the dropdown reads the flag. The pill is the anchor whenever it is drawn.
ui.setPopoverAnchor('missionProgress', true)
onBeforeUnmount(() => ui.setPopoverAnchor('missionProgress', false))
</script>

<template>
  <!-- `data-topbar-extra`: the Topbar reserves the pill's width, so the breadcrumb and the title give way first
       and the action cluster moves into the `…` menu before the pill is touched. The title carries a huge flex-shrink
       (`shrink-[1000]`, Topbar.vue), so it gives way, down to its stub, before the pill does (the mockup draws the
       pill `flex-shrink: 0`),
       and only when the header cannot hold the pill and the controls it never pushes out does the label truncate
       (its full text is in the `title`). -->
  <div
    class="relative flex min-w-0 shrink"
    style="-webkit-app-region: no-drag"
    data-v4="true"
    data-topbar-extra
  >
    <button
      type="button"
      class="flex min-w-0 shrink cursor-pointer items-center rounded-sm border tabular-nums transition hover:brightness-110"
      :class="[toneClass, ringClass]"
      :style="{
        gap: '5px',
        padding: quiet ? '1px 5px' : '1px 7px',
        fontSize: '10.5px',
        fontWeight: 500,
        height: '18px'
      }"
      :title="keybindings.withChord(v4Title, 'view.missionProgress')"
      :aria-label="v4Title"
      aria-haspopup="dialog"
      :aria-expanded="open"
      :data-dsqa="`topbar-pill--${quiet ? 'none' : v4Tone}`"
      @click="ui.togglePopover('missionProgress')"
    >
      <component :is="v4Ready ? Check : Target" :size="10" :stroke-width="1.8" class="shrink-0" />
      <span v-if="v4" class="truncate" data-test="mission-pill-label">{{ v4Label }}</span>
      <ChevronDown
        :size="10"
        :stroke-width="1.8"
        class="shrink-0 opacity-70 transition-transform"
        :class="open ? 'rotate-180' : ''"
        data-test="mission-pill-caret"
      />
    </button>
    <MissionDropdown />
  </div>
</template>
