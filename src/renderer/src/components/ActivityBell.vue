<script setup lang="ts">
/**
 * Topbar Activity bell (T152) — the notification history's new home, out of
 * the Fleet rail (design.md — Fleet rail reorg §2.4). Global: lives in
 * `Topbar.vue`'s right cluster, OUTSIDE the `v-if="sessions.selectedSession"`
 * guard, so it's reachable with no session selected. Badge = the raw record
 * count (`notifications.list.length`) — there's no read/unread state
 * anymore, so the badge simply says "this many things are still in the
 * list."
 *
 * Row anatomy reuses the approved BUG-36/BUG-42 contract (inner 2px
 * `kind-bar`, "Session says" eyebrow for `source: 'agent'`) from the
 * approved mockup `docs/specs/2026-07-17-activity-bell/spec.html`. The
 * text-loss rule is load-bearing: short text always shows in full; long text
 * clamps to 2 lines ONLY when an expand chevron is offered alongside it, so
 * nothing a session or Harnu itself reported is ever silently hidden.
 *
 * Dismiss model (design.md §2.4): `dismiss(id)` removes a row, `clearAll()`
 * empties the list — no `markRead`, no unread dot. Being in the list IS the
 * "not yet handled" signal. Row click navigates via `sessions.activateSession()`
 * (BUG-31 — reveal + scroll the sidebar, not the old bare `select()`) for a
 * session-targeted row, or via `useUiStore().openNavigableView()` (T163) for a
 * view-targeted row (e.g. the Reaper harvestable alert → Cleanup), and then
 * removes the row — but ONLY when the row actually carries a `sessionId` OR a
 * `target` (BUG-49): a notification with nothing to navigate to is not
 * click-to-dismiss, it's just not clickable, so the row is never silently
 * cleared without having done anything. Hover swaps the timestamp for a
 * dismiss × so a row can still be cleared without navigating anywhere; the
 * right column reserves a fixed `min-width` (BUG-49) so that swap never
 * reflows the row body — see the template comment on `.right-col`-equivalent
 * below.
 */
import { nextTick, reactive, ref, watch } from 'vue'
import { onClickOutside, onKeyStroke } from '@vueuse/core'
import { useI18n } from 'vue-i18n'
import { Bell, ChevronDown, X } from 'lucide-vue-next'
import {
  useNotificationsStore,
  type NotificationKind,
  type NotificationRecord
} from '../stores/notifications'
import { useSessionsStore } from '../stores/sessions'
import { useUiStore } from '../stores/ui'
import { relativeTime } from '../composables/useRelativeTime'
import { resolveActionLabel } from '../lib/toast-action-label'

const notifications = useNotificationsStore()
const sessions = useSessionsStore()
const ui = useUiStore()
const { t, te } = useI18n()

const bellRef = ref<HTMLElement | null>(null)
const popoverRef = ref<HTMLElement | null>(null)
const popoverOpen = ref(false)

onClickOutside(bellRef, () => (popoverOpen.value = false))
onKeyStroke('Escape', () => (popoverOpen.value = false))

function toggleBell(): void {
  popoverOpen.value = !popoverOpen.value
}

/** Epoch-ms → relative label (the helper takes an ISO string). */
function relativeTimeMs(ts: number): string {
  return relativeTime(new Date(ts).toISOString())
}

/** Kind → fill color for the row's inner `kind-bar` (BUG-42) — same semantic
 *  map InboxRail used before the Activity section moved here. */
function kindBarClass(kind: NotificationKind): string {
  switch (kind) {
    case 'success':
      return 'bg-green'
    case 'warning':
      return 'bg-warning'
    case 'danger':
      return 'bg-red'
    case 'info':
    default:
      return 'bg-accent'
  }
}

// Rows the operator expanded past the 2-line clamp — reset on close (below),
// so a stale expansion never survives a close/reopen. The popover's own DOM
// is `v-if`-gated, but this component itself (mounted once by `Topbar.vue`)
// is not, so its state would otherwise persist across toggles.
const expandedIds = ref<Set<string>>(new Set())
watch(popoverOpen, (open) => {
  if (!open) expandedIds.value = new Set()
})
function toggleExpand(id: string, e: MouseEvent): void {
  e.stopPropagation()
  const next = new Set(expandedIds.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  expandedIds.value = next
}

/**
 * Whether a row's title/description actually overflow the 2-line clamp —
 * the text-loss-rule gate for the expand chevron (only render it when the
 * clamp would otherwise hide real content). Measured off the live DOM
 * (`scrollHeight` vs `clientHeight`) rather than a character-count guess:
 * the contract is "no text ever lost," so a false negative here is a real
 * bug, not just a cosmetic miss. Only ever flips false → true — the row's
 * text is immutable once a notification exists, so once discovered the
 * answer never goes stale.
 *
 * Measured in one pass after the popover's rows are in the DOM (`nextTick`,
 * not a per-element ref callback) — the clamped text nodes are tagged with
 * `data-clamp-id` and queried together, which sidesteps Vue re-invoking a
 * fresh inline function-ref on every unrelated re-render.
 */
const overflowing = reactive<Record<string, boolean>>({})
function measureOverflow(): void {
  const root = popoverRef.value
  if (!root) return
  root.querySelectorAll<HTMLElement>('[data-clamp-id]').forEach((el) => {
    const id = el.dataset.clampId
    if (id && el.scrollHeight - el.clientHeight > 1) overflowing[id] = true
  })
}

watch(
  [popoverOpen, () => notifications.list.length],
  async ([open]) => {
    if (!open) return
    await nextTick()
    measureOverflow()
  },
  { immediate: true }
)

/**
 * Row click (and the optional action button below) — BUG-31: navigate via
 * `activateSession()`, never the bare `select()`, then the row is handled.
 * A session-less row can still have a real destination (T163): `n.target`
 * points at an in-app view (Cleanup, the roadmap board, …), resolved through
 * `useUiStore().openNavigableView()` — the one door every such notification
 * shares, so this function never grows a per-view branch.
 *
 * BUG-49: a no-op when neither `n.sessionId` nor `n.target` is set — a
 * notification with nothing to navigate to must not silently dismiss having
 * done nothing. Explicit dismissal (the hover × or "Clear all") is always
 * still reachable.
 */
function activateAndDismiss(n: NotificationRecord): void {
  if (n.sessionId) {
    sessions.activateSession(n.sessionId)
  } else if (n.target) {
    ui.openNavigableView(n.target.view, n.target)
  } else {
    return
  }
  notifications.dismiss(n.id)
}

function onDismissClick(id: string, e: MouseEvent): void {
  e.stopPropagation()
  notifications.dismiss(id)
}

/** Resolve `n.action.label` — a `toast.actions.*` key or a literal string
 *  (BUG-49: was rendered raw/untranslated; shares the probe Toast.vue uses). */
function actionLabel(n: NotificationRecord): string {
  return resolveActionLabel(t, te, n.action?.label)
}
</script>

<template>
  <div ref="bellRef" class="relative">
    <button
      type="button"
      class="relative flex items-center justify-center rounded text-text-3 transition hover:bg-surface hover:text-text"
      style="width: 26px; height: 26px"
      data-dsqa="topbar-bell"
      :aria-label="
        notifications.list.length > 0
          ? $t('activityBell.bellAria', { count: notifications.list.length })
          : $t('activityBell.title')
      "
      :title="
        notifications.list.length > 0
          ? $t('activityBell.bellAria', { count: notifications.list.length })
          : $t('activityBell.title')
      "
      :aria-expanded="popoverOpen"
      @click="toggleBell"
    >
      <Bell :size="14" :stroke-width="1.5" />
      <span
        v-if="notifications.list.length > 0"
        class="absolute bg-accent text-accent-ink tabular-nums"
        style="
          top: -1px;
          right: -1px;
          min-width: 13px;
          height: 13px;
          padding: 0 3px;
          border-radius: 999px;
          font-size: 8.5px;
          font-weight: 700;
          line-height: 13px;
          text-align: center;
        "
        >{{ notifications.list.length }}</span
      >
    </button>

    <!-- Anchored popover (FolderPreview convention: bg-surface, border-2, radius, shadow-pop) -->
    <div
      v-if="popoverOpen"
      ref="popoverRef"
      class="anim-fade-in-scale absolute right-0 top-full z-50 mt-1.5 flex flex-col overflow-hidden rounded border border-border-2 bg-surface shadow-pop"
      style="width: 340px; max-height: 520px"
      data-dsqa="activity-popover"
    >
      <div
        class="flex shrink-0 items-center border-b border-border"
        style="height: 36px; padding: 0 12px; gap: 7px"
      >
        <span class="text-text" style="font-size: 12.5px; font-weight: 500">{{
          $t('activityBell.title')
        }}</span>
        <template v-if="notifications.list.length > 0">
          <span class="tabular-nums text-text-4" style="font-size: 11px">{{
            notifications.list.length
          }}</span>
          <span class="min-w-0 flex-1" />
          <button
            type="button"
            class="rounded-sm text-text-3 transition hover:bg-surface-2 hover:text-text"
            style="padding: 3px 6px; font-size: 11px; font-weight: 500"
            @click="notifications.clearAll()"
          >
            {{ $t('activityBell.clearAll') }}
          </button>
        </template>
        <span v-else class="min-w-0 flex-1" />
      </div>

      <div
        v-if="notifications.list.length === 0"
        class="text-text-4"
        style="padding: 28px 12px; font-size: 12px; text-align: center"
      >
        {{ $t('activityBell.empty') }}
      </div>
      <div v-else class="scrollable min-h-0 flex-1 overflow-y-auto">
        <div
          v-for="n in notifications.list"
          :key="n.id"
          data-dsqa="activity-row"
          class="group flex border-t border-border first:border-t-0 hover:bg-surface-2"
          :class="n.sessionId || n.target ? 'cursor-pointer' : ''"
          style="gap: 8px; padding: 8px 12px"
          @click="activateAndDismiss(n)"
        >
          <span class="w-0.5 shrink-0 self-stretch rounded-full" :class="kindBarClass(n.kind)" />

          <div class="flex min-w-0 flex-1 flex-col items-start" style="gap: 1px">
            <span
              v-if="n.source === 'agent'"
              class="text-accent"
              style="
                font-size: 9.5px;
                font-weight: 700;
                letter-spacing: 0.06em;
                text-transform: uppercase;
              "
            >
              {{ $t('activityBell.sessionSays') }}
            </span>
            <span
              :data-clamp-id="n.id"
              class="max-w-full text-text"
              :class="expandedIds.has(n.id) ? '' : 'line-clamp-2'"
              style="font-size: 12px; font-weight: 500; line-height: 1.4"
            >
              {{ n.title }}
            </span>
            <span
              v-if="n.description"
              :data-clamp-id="n.id"
              class="max-w-full text-text-3"
              :class="expandedIds.has(n.id) ? '' : 'line-clamp-2'"
              style="font-size: 11px; line-height: 1.4"
            >
              {{ n.description }}
            </span>
            <div v-if="n.action" class="flex flex-wrap" style="gap: 6px; margin-top: 4px">
              <button
                type="button"
                class="inline-flex items-center rounded-sm bg-accent-soft text-accent transition hover:opacity-80"
                style="padding: 2px 7px; font-size: 10.5px; font-weight: 500"
                @click.stop="activateAndDismiss(n)"
              >
                {{ actionLabel(n) }}
              </button>
            </div>
          </div>

          <!-- BUG-49: min-width reserved for the widest realistic timestamp
               ("yesterday") so the group-hover swap to the dismiss × below
               never narrows this column and reflows the body text. -->
          <div class="flex shrink-0 flex-col items-end" style="gap: 4px; min-width: 50px">
            <span
              class="tabular-nums text-text-4 group-hover:hidden"
              style="font-size: 10px; margin-top: 1px"
              >{{ relativeTimeMs(n.ts) }}</span
            >
            <button
              type="button"
              class="hidden items-center justify-center rounded-sm text-text-3 transition hover:bg-surface hover:text-text group-hover:flex"
              style="width: 16px; height: 16px"
              :aria-label="$t('activityBell.dismissAria')"
              :title="$t('activityBell.dismissAria')"
              @click="onDismissClick(n.id, $event)"
            >
              <X :size="11" :stroke-width="2" />
            </button>
            <button
              v-if="overflowing[n.id]"
              type="button"
              class="flex items-center justify-center rounded-sm text-text-3 transition-colors hover:bg-surface hover:text-text"
              style="width: 16px; height: 16px"
              :aria-label="
                expandedIds.has(n.id)
                  ? $t('activityBell.collapseAria')
                  : $t('activityBell.expandAria')
              "
              :title="
                expandedIds.has(n.id)
                  ? $t('activityBell.collapseAria')
                  : $t('activityBell.expandAria')
              "
              @click="toggleExpand(n.id, $event)"
            >
              <ChevronDown
                :size="11"
                :stroke-width="2"
                class="transition-transform"
                :style="{ transform: expandedIds.has(n.id) ? 'rotate(180deg)' : 'none' }"
              />
            </button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
