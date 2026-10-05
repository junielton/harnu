<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useUiStore } from '../stores/ui'
import { useSessionsStore } from '../stores/sessions'
import { useUsageStore } from '../stores/usage'
import { useModesStore } from '../stores/modes'
import { useHoverPreview } from '../composables/useHoverPreview'
import { contextTextClass, formatCostUsd, formatLines } from './usage-format'
import { relativeTime } from '../composables/useRelativeTime'

/**
 * Floating hover card for session rows. Anchored to the row rect provided by
 * `useHoverPreview` (see `design.md §3.9`).
 *
 * Layering:
 * - z-index 40 — strictly below menu (50) and modal (60) per finding 08.
 * - `pointer-events: auto` — the card is INTERACTIVE (T86): the row + card form
 *   ONE hover zone, so the cursor can reach the card to scroll it. The old
 *   flicker loop (mouse toward card → leaves row → close → reopen) is prevented
 *   by the grace delay in `useHoverPreview` (`scheduleClose`/`cancelClose`), not
 *   by making the card non-interactive.
 *
 * Anchor logic:
 * - Default: `left: rect.right + GAP`, `top: rect.top`.
 * - If the preview would overflow the right edge of the viewport, flip to the
 *   LEFT side of the row instead. Either way the result is clamped into
 *   `[VIEWPORT_MARGIN, vw - VIEWPORT_MARGIN - PREVIEW_MAX_WIDTH]` — flipping
 *   sides isn't enough on its own when NEITHER side has a full
 *   `PREVIEW_MAX_WIDTH` of room (a narrow window), which used to push the
 *   card off-screen with no visible padding.
 * - If it would overflow the bottom edge, clamp `top` upward; a `maxHeight` bounds
 *   the card to the viewport so tall content scrolls inside it.
 */
const ui = useUiStore()
const sessions = useSessionsStore()
const { t } = useI18n()
// The card participates in the shared hover zone: keep the preview open while the
// cursor is over the card, and arm the grace-close when it leaves (T86).
const { cancelClose, scheduleClose } = useHoverPreview()

const PREVIEW_MAX_WIDTH = 360
const GAP_PX = 8
const VIEWPORT_MARGIN = 8

const session = computed(() => {
  const id = ui.preview.sessionId
  if (!id) return null
  return sessions.allSessions.find((s) => s.sessionId === id) ?? null
})

// statusLine telemetry for this session (null until the tab reports a blob).
const usage = useUsageStore()
const tele = computed(() => {
  const id = session.value?.sessionId
  return id ? usage.telemetryFor(id) : null
})

// Context-window % — prefer the JSONL-derived value (T91 §5), else statusline.
const ctxPct = computed<number | null>(
  () => session.value?.ctxPct ?? tele.value?.contextPercent ?? null
)

// "What's happening now" (T91 §3): task-summary → last-prompt → first prompt.
const whatsHappening = computed<string>(
  () => session.value?.whatsHappening || session.value?.firstPrompt || ''
)

// The CLI's "while you were away" recap (T91 §4), shown verbatim when present.
const awaySummary = computed<string>(() => session.value?.awaySummary || '')

// Boot-mode disclosure (T138): the mode this session was born in, resolved
// against the merged builtin ∪ extension modes list so an extension-installed
// mode's origin is never indistinguishable from a builtin's.
const modes = useModesStore()
const sessionMode = computed(() => modes.findMode(session.value?.mode))

// Stagnation tally (T175/T176): the evidence behind a `stuck` verdict — calls
// in the window, distinct targets, and the top repeated one. Shown whenever
// the window has tool calls to report, NOT gated on `stagnant` itself (the
// tally is meaningful for a busy-but-not-yet-stagnant session too).
const stagnationTally = computed<string>(() => {
  const s = session.value?.stagnation
  if (!s || s.calls === 0) return ''
  return t('preview.stallTally', {
    calls: s.calls,
    distinct: s.distinct,
    target: s.topTarget,
    count: s.topCount
  })
})

/**
 * Side-aware anchor. Returns either `{ left, top }` or `{ right, top }` so
 * the template can apply `position: fixed` coordinates directly.
 *
 * Why no vertical centering on the row? The design (§3.9) shows the preview
 * top-aligned with the row, not vertically centered — the rect's `top` is
 * already the right anchor.
 */
const anchorStyle = computed<Record<string, string>>(() => {
  const rect = ui.preview.rect
  if (!rect) return { display: 'none' }

  const vw = window.innerWidth
  const vh = window.innerHeight

  // Horizontal: default to the right side of the row, flip left if clipped —
  // then ALWAYS clamp into the viewport. Flipping alone assumes the other
  // side has room, which isn't true in a narrow window; without a final
  // clamp the card can render mostly off-screen with no visible padding.
  const overflowsRight = rect.right + GAP_PX + PREVIEW_MAX_WIDTH > vw - VIEWPORT_MARGIN
  const preferredLeft = overflowsRight
    ? rect.left - GAP_PX - PREVIEW_MAX_WIDTH
    : rect.right + GAP_PX
  const maxLeft = Math.max(VIEWPORT_MARGIN, vw - VIEWPORT_MARGIN - PREVIEW_MAX_WIDTH)
  const horizontal: Record<string, string> = {
    left: `${Math.min(Math.max(preferredLeft, VIEWPORT_MARGIN), maxLeft)}px`
  }

  // Vertical: default to row top. Clamp upward if it would overflow the
  // bottom. We do not know the rendered height up-front (content varies), so
  // assume a generous 180 px envelope for the clamp check.
  const ASSUMED_PREVIEW_HEIGHT = 180
  let top = rect.top
  if (top + ASSUMED_PREVIEW_HEIGHT > vh - VIEWPORT_MARGIN) {
    top = Math.max(VIEWPORT_MARGIN, vh - VIEWPORT_MARGIN - ASSUMED_PREVIEW_HEIGHT)
  }

  // Bound the card to the viewport from its anchored top so overlong content
  // scrolls INSIDE the card (T86) instead of spilling off-screen.
  const maxHeight = `${Math.max(120, vh - top - VIEWPORT_MARGIN)}px`
  return { ...horizontal, top: `${top}px`, maxHeight } as Record<string, string>
})
</script>

<template>
  <Teleport to="body">
    <div
      v-if="ui.preview.open && session"
      class="anim-fade-in scrollable fixed border border-border-2 bg-surface"
      :style="{
        ...anchorStyle,
        maxWidth: `${PREVIEW_MAX_WIDTH}px`,
        padding: '12px 14px',
        borderRadius: '7px',
        boxShadow: 'var(--shadow-pop)',
        zIndex: 40,
        pointerEvents: 'auto',
        overflowY: 'auto',
        overscrollBehavior: 'contain'
      }"
      role="tooltip"
      :aria-label="$t('preview.label')"
      @mouseenter="cancelClose"
      @mouseleave="scheduleClose"
    >
      <!-- Header: model + timestamp -->
      <div
        class="flex items-center justify-between font-mono text-text-4"
        style="font-size: 11px; margin-bottom: 8px; gap: 8px"
      >
        <span class="truncate">{{ tele?.modelName || '—' }}</span>
        <span class="tabular-nums shrink-0">{{ relativeTime(session.modified) }}</span>
      </div>

      <!-- statusLine telemetry: cost · context · lines (+ thinking/effort/near-compact) -->
      <div
        v-if="tele"
        class="font-mono text-text-3 tabular-nums"
        style="font-size: 11px; margin-bottom: 6px"
      >
        {{ formatCostUsd(tele.costUsd) }}
        <template v-if="ctxPct != null"
          >·
          <span :class="contextTextClass(ctxPct)">{{
            $t('usage.context', { pct: ctxPct })
          }}</span></template
        >
        · {{ formatLines(tele.linesAdded, tele.linesRemoved) }}
      </div>
      <div
        v-if="tele && (tele.thinkingEnabled || tele.effortLevel || tele.exceeds200k)"
        class="flex flex-wrap text-text-4"
        style="font-size: 10.5px; gap: 8px; margin-bottom: 8px"
      >
        <span v-if="tele.thinkingEnabled">{{ $t('usage.thinkingOn') }}</span>
        <span v-if="tele.effortLevel">{{ $t('usage.effort', { level: tele.effortLevel }) }}</span>
        <span v-if="tele.exceeds200k || (ctxPct ?? 0) >= 90" class="text-accent">{{
          $t('usage.nearCompact')
        }}</span>
      </div>

      <!-- Away recap (T91 §4): the CLI's "while you were away" summary, verbatim. -->
      <div
        v-if="awaySummary"
        class="border-l-2 border-accent-line bg-accent-soft text-text-2"
        style="
          font-size: 12px;
          line-height: 1.5;
          margin-bottom: 8px;
          padding: 6px 8px;
          border-radius: 4px;
        "
      >
        <div
          class="text-text-4"
          style="
            font-size: 10px;
            text-transform: uppercase;
            letter-spacing: 0.04em;
            margin-bottom: 2px;
          "
        >
          {{ $t('preview.awayLabel') }}
        </div>
        {{ awaySummary }}
      </div>

      <!-- Boot-mode disclosure (T138): shows the mode this session was born
           in, plus its origin — a custom (extension-installed) mode must
           never look like a builtin one (ADR-0002 §2.2). -->
      <div
        v-if="session.mode"
        class="font-mono text-text-4"
        style="font-size: 11px; margin-bottom: 6px"
      >
        {{
          sessionMode?.origin === 'extension'
            ? $t('preview.modeCustom', {
                label: sessionMode.label ?? session.mode,
                name: sessionMode.extensionLabel
              })
            : $t('preview.mode', {
                label: sessionMode?.labelKey ? $t(sessionMode.labelKey) : session.mode
              })
        }}
      </div>

      <!-- Stagnation tally (T175/T176): the evidence behind a `stuck` verdict —
           calls in the window, distinct targets, the top repeated one. Shown
           whenever there's a tally to report, not gated on the verdict itself. -->
      <div
        v-if="stagnationTally"
        class="font-mono text-text-4"
        style="font-size: 11px; margin-bottom: 8px"
      >
        {{ stagnationTally }}
      </div>

      <!-- Body: what's happening now (T91 §3), clamped to 3 lines -->
      <p
        v-if="whatsHappening"
        class="text-text-2"
        style="
          font-size: 12.5px;
          line-height: 1.5;
          margin: 0 0 8px 0;
          display: -webkit-box;
          -webkit-line-clamp: 3;
          -webkit-box-orient: vertical;
          overflow: hidden;
        "
      >
        {{ whatsHappening }}
      </p>

      <!-- Footer: messages · agents. The row's `bot` chip is also a CONTROL (its
           chevron expands the nested agent list), so it stays there — but the bare
           count is data, and belongs here too (design.md "Footer: mensagens ·
           agentes"). -->
      <div class="font-mono text-text-4 tabular-nums" style="font-size: 11px">
        {{ $t('preview.messages', { count: session.messageCount })
        }}<template v-if="session.agents?.length">
          · {{ $t('agent.count', { n: session.agents.length }) }}</template
        >
      </div>
    </div>
  </Teleport>
</template>
