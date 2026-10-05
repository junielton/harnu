<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import type { Session } from '../stores/sessions'
import { useSessionsStore } from '../stores/sessions'
import { sessionTitle } from '../lib/session-label'
import { useHoverPreview } from '../composables/useHoverPreview'
import { useContextMenu } from '../composables/useContextMenu'
import { useUsageStore } from '../stores/usage'
import { relativeTime } from '../composables/useRelativeTime'
import { failureBadge, type FailureBadge } from './failure-badge'
import { contextTextClass, humanizeDuration } from './usage-format'
import { lastPtyLine, type BoardState } from './fleet-board'
import { Folder as FolderIcon } from 'lucide-vue-next'

/** PTY-fallback poll for line 2 (design.md — Fleet rail, T151 fix): unlike the
 * old sidebar board, Fleet rail cards stay mounted all day, so a one-shot
 * read-on-mount goes stale the moment the terminal keeps producing output.
 * Polled only while there's no stagnation reason (the preferred source). */
const PTY_POLL_MS = 3000

/**
 * One card in a state bucket — the Fleet rail's scrolling body (design.md —
 * Fleet rail, T151) and, until T153 removes it, the old sidebar Fleet status
 * board. A clickable row that selects the session (same effect as a sidebar
 * row) and reuses the sidebar's title/badge/context-% language. The 16px
 * state ring reflects the bucket `state` it lives in, so it always agrees
 * with wherever else that state is shown — including the minimized rail's
 * minicards, which render the same badge with no card body around it.
 */
const props = withDefaults(
  defineProps<{
    session: Session
    state: BoardState
    folderAlias: string
    /** Rail-only (T151): keep polling line 2's PTY fallback instead of a
     * one-shot read. Off by default so the old sidebar board — which can
     * show far more cards at once, many of them idle — doesn't pick up a
     * per-card interval it never needed; it stays a one-shot read until
     * T153 removes that view. */
    livePoll?: boolean
  }>(),
  { livePoll: false }
)

const sessions = useSessionsStore()
const usage = useUsageStore()
const hoverPreview = useHoverPreview()
const contextMenu = useContextMenu()
const { t } = useI18n()

const ctxClass = contextTextClass

/** The shared session name (BUG-78), "Untitled" when a real session has none yet. */
function labelFor(s: Session): string {
  return sessionTitle(s, sessions.allSessions, t) || t('session.unnamed')
}

// Prefer the JSONL-derived ctx% (T91 §5); fall back to statusline telemetry.
const contextPct = computed<number | null>(
  () => props.session.ctxPct ?? usage.contextPercentFor(props.session.sessionId)
)

const fBadge = computed<FailureBadge | null>(() =>
  failureBadge(props.session.failureReason, props.session.resetsAt, Date.now())
)
const fBadgeLabel = computed<string>(() => {
  const b = fBadge.value
  if (!b) return ''
  const base = t(b.labelKey)
  return b.countdownMs != null
    ? `${base} · ${t('session.failure.resetsIn', { time: humanizeDuration(b.countdownMs) })}`
    : base
})

// Line 2: the stagnation reason (T175/T176 — names the repeated target/count
// when the transcript itself says the session is going in circles) when
// present, else the last non-empty PTY line. Fleet rail cards (`livePoll`)
// stay mounted all day (T151), so the PTY snapshot is POLLED there instead of
// read once — a one-shot read goes stale the instant the terminal keeps
// producing output. The old sidebar board keeps the original one-shot read.
const stagnationLine = computed<string>(() => {
  const s = props.session.stagnation
  if (!s?.stagnant) return ''
  return t('board.spinningOn', { target: s.topTarget, count: s.topCount })
})
const ptyLine = ref<string>('')
const line2 = computed<string>(() => stagnationLine.value || ptyLine.value)

async function refreshPtyLine(): Promise<void> {
  if (stagnationLine.value) return // stagnation reason wins; skip the PTY read
  try {
    const replay = await window.api?.ptyReplayForSession?.(props.session.sessionId)
    if (replay) ptyLine.value = lastPtyLine(replay.data)
  } catch {
    // no live PTY / cold disk session → one-line card (additive)
  }
}

let ptyPoll: ReturnType<typeof setInterval> | null = null
onMounted(() => {
  void refreshPtyLine()
  if (props.livePoll) ptyPoll = setInterval(() => void refreshPtyLine(), PTY_POLL_MS)
})
onBeforeUnmount(() => {
  if (ptyPoll) clearInterval(ptyPoll)
})

// State ring (design.md §7 — Fleet state ring): one `fleet-ring--<state>`
// class per bucket state, defined once in main.css, never ad-hoc here. This
// replaced the card's border ring (T151/T160/T161/BUG-51) — state is now a
// 16px badge, which is what lets the minimized rail show the whole fleet in
// 44px. `state` is always a Fleet-rail tier (never `idle`) when rendered
// inside the rail; the old sidebar board still passes `idle`, which has its
// own quiet neutral rule.
const ringClass = computed<string>(() => `fleet-ring--${props.state}`)

/** Per-state announcement for the badge — the ring is the ONLY state signal
 *  on the card now, so it has to carry the accessible name the dot used to. */
const ringLabel = computed<string>(() => {
  switch (props.state) {
    case 'working':
      return t('board.state.working')
    case 'needs-input':
      return t('board.state.needsInput')
    case 'errored':
      return t('board.state.errored')
    case 'stuck':
      return t('board.state.stuck')
    case 'done':
      return t('board.state.done')
    default:
      return t('board.state.idle')
  }
})

// Entrance (design.md §7): every mount is a genuinely NEW card (Vue keeps
// existing keyed nodes across re-renders), so `.card-enter` on mount is
// exactly "a newly-arriving card animates in". The state ring is a child
// badge, so it travels with the card as one unit — nothing to suppress.
const entering = ref(true)
function onAnimationEnd(e: AnimationEvent): void {
  if (e.animationName === 'card-enter') entering.value = false
}

function onClick(): void {
  sessions.select(props.session.sessionId)
}
function onContext(e: MouseEvent): void {
  contextMenu.open(e, props.session.sessionId)
}
function onEnter(e: MouseEvent): void {
  hoverPreview.enter(
    props.session.sessionId,
    (e.currentTarget as HTMLElement).getBoundingClientRect()
  )
}
</script>

<template>
  <button
    class="group block cursor-pointer border border-border bg-surface text-left transition hover:bg-surface-2"
    :class="[
      entering ? 'card-enter' : '',
      sessions.selectedId === session.sessionId ? '!border-border-2 !bg-surface-2' : ''
    ]"
    style="
      border-radius: var(--radius);
      padding: 7px 10px;
      margin: 0 8px 4px;
      width: calc(100% - 16px);
    "
    data-dsqa="fleet-card"
    @click="onClick"
    @contextmenu="onContext"
    @mouseenter="onEnter"
    @mouseleave="hoverPreview.leave()"
    @animationend="onAnimationEnd"
  >
    <!-- Content lives in a fixed clip window (belt-and-braces alongside the
        scroll body's own overflow-x:hidden) so the entrance slide never
        widens or shifts the list (design.md §7). -->
    <span class="block overflow-hidden">
      <span class="flex flex-col" style="gap: 4px">
        <!-- Line 1 — state ring + title + folder -->
        <span class="flex w-full items-center" style="gap: 8px">
          <!-- The state ring (design.md §7). Anatomy is fixed in main.css:
              faint track + accented arc + centre dot. It is the ONLY state
              signal on the card, so it carries the accessible name. -->
          <span
            class="fleet-ring"
            :class="ringClass"
            role="img"
            :aria-label="ringLabel"
            :title="state === 'stuck' ? $t('session.statusStuckHint') : undefined"
          >
            <span class="fleet-ring-track" />
            <span class="fleet-ring-arc" />
            <span class="fleet-ring-dot" />
          </span>

          <span
            class="flex-1 truncate text-text"
            :class="sessions.selectedId === session.sessionId ? 'font-medium' : ''"
            style="font-size: 12.5px"
            >{{ labelFor(session) }}</span
          >

          <span
            class="flex shrink-0 items-center text-text-4"
            style="gap: 3px; font-size: 11px; max-width: 110px"
            :title="folderAlias"
          >
            <FolderIcon :size="11" :stroke-width="1.6" class="shrink-0" />
            <span class="truncate">{{ folderAlias }}</span>
          </span>
        </span>

        <!-- Line 2 — stagnation reason / last PTY line (omitted when empty) -->
        <span
          v-if="line2"
          class="w-full truncate font-mono text-text-3"
          style="font-size: 11px; padding-left: 24px"
          :title="line2"
          >{{ line2 }}</span
        >

        <!-- Line 3 — meta per state -->
        <span
          class="flex w-full items-center text-text-4"
          style="gap: 8px; font-size: 11px; padding-left: 24px"
        >
          <!-- errored: failure reason badge -->
          <span
            v-if="state === 'errored' && fBadge"
            class="shrink-0 truncate tabular-nums"
            :class="fBadge!.variant === 'red' ? 'text-red' : 'text-warning'"
            style="max-width: 200px"
            :title="fBadgeLabel"
            >{{ fBadgeLabel }}</span
          >

          <!-- needs-input: how long it's been blocked -->
          <span v-else-if="state === 'needs-input'" class="shrink-0 tabular-nums">{{
            $t('board.blockedFor', { time: relativeTime(session.modified) })
          }}</span>

          <!-- working / idle / done: context % chip + relative time -->
          <template v-else>
            <span
              v-if="contextPct != null"
              class="shrink-0 tabular-nums"
              :class="ctxClass(contextPct)"
              :title="$t('usage.context', { pct: contextPct })"
              >{{ contextPct }}%</span
            >
            <span class="shrink-0 tabular-nums">{{ relativeTime(session.modified) }}</span>
          </template>
        </span>
      </span>
    </span>
  </button>
</template>
