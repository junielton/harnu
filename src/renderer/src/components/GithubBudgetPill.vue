<script setup lang="ts">
/**
 * Footer GitHub budget pill + popover (T611 U2, design.md §6 — GitHub budget pill; mockup
 * `b--own-pill`).
 *
 * Its own pill, left of the Cleanup pill: the GitHub glyph and how many calls are left in the
 * TIGHTER bucket (D-2). Warning-toned while Harnu is slowing down, red with the reset countdown
 * once the limit is spent. Hidden while the budget is `unavailable` (no `gh`, not signed in, or no
 * answer yet). Click opens the popover (`ui.popovers.githubBudget`, one of the footer popovers).
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { onClickOutside, onKeyStroke, useNow } from '@vueuse/core'
import { Github } from 'lucide-vue-next'
import { useNativeOverlay } from '../composables/useNativeOverlay'
import { useGithubBudgetStore } from '../stores/github-budget'
import { useUiStore } from '../stores/ui'
import GithubBudgetPopover from './GithubBudgetPopover.vue'
import {
  formatCountdown,
  formatCount,
  minutesUntil,
  pillToneClass
} from '../lib/github-budget-view'

const { t, locale } = useI18n()
const store = useGithubBudgetStore()
const ui = useUiStore()
const now = useNow({ interval: 30_000 })

onMounted(() => void store.init())

const ready = computed(() => store.ready)
const visible = computed(() => ready.value !== null)
const open = computed(() => ui.popovers.githubBudget)

const left = computed(() => {
  const r = ready.value
  return r ? formatCount(r.tighterView.bucket.remaining, String(locale.value)) : ''
})
const countdown = computed(() => {
  const ms = store.resetAtMs
  return ms === null ? '' : formatCountdown(minutesUntil(ms, now.value.getTime()))
})
const text = computed(() =>
  store.state === 'exhausted'
    ? t('githubBudget.pill.exhausted', { countdown: countdown.value })
    : t('githubBudget.pill.left', { n: left.value })
)
const aria = computed(() => {
  if (store.state === 'exhausted') {
    return t('githubBudget.pill.a11yExhausted', { countdown: countdown.value })
  }
  return t(store.state === 'low' ? 'githubBudget.pill.a11yLow' : 'githubBudget.pill.a11y', {
    n: left.value
  })
})

// Footer popover plumbing, same as the fleet and status popovers: the anchor is reported while the
// button renders, outside-click and Esc close, and the open layer joins the native-overlay freeze.
watch(visible, (v) => ui.setPopoverAnchor('githubBudget', v), { immediate: true })
onBeforeUnmount(() => ui.setPopoverAnchor('githubBudget', false))
const rootRef = ref<HTMLElement | null>(null)
const popoverEl = ref<HTMLElement | null>(null)
useNativeOverlay('footer-github-budget-popover', popoverEl)
onClickOutside(rootRef, () => ui.closePopover('githubBudget'))
onKeyStroke('Escape', () => ui.closePopover('githubBudget'))

// Open = read the freshest numbers, not the 60 s-old poll.
watch(open, (o) => {
  if (o) void store.refresh()
})

function openDetails(): void {
  ui.closePopover('githubBudget')
  ui.openSettings('githubApi')
}
</script>

<template>
  <div v-if="visible" ref="rootRef" class="relative">
    <button
      type="button"
      data-dsqa="github-footer-pill"
      data-dsqa-part="gh-pill"
      :data-state="store.state"
      class="flex h-5 items-center gap-1.5 whitespace-nowrap rounded-sm px-1.5 text-[11px] transition-colors"
      :class="pillToneClass(store.state)"
      :aria-label="aria"
      :title="aria"
      :aria-expanded="open"
      @click="ui.togglePopover('githubBudget')"
    >
      <Github :size="12" :stroke-width="1.6" class="shrink-0" />
      <span class="tabular-nums">{{ text }}</span>
    </button>
    <div
      v-if="open"
      ref="popoverEl"
      data-dsqa-part="gh-popover"
      class="anim-fade-in-scale absolute bottom-full right-0 z-50 mb-1.5 w-[320px] rounded-lg border border-border-2 bg-surface-2 p-2 shadow-pop"
    >
      <GithubBudgetPopover @details="openDetails" />
    </div>
  </div>
</template>
