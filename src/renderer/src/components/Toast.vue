<script setup lang="ts">
import { computed } from 'vue'
import { X } from 'lucide-vue-next'
import { useI18n } from 'vue-i18n'
import type { Toast } from '../stores/ui'
import { resolveActionLabel } from '../lib/toast-action-label'

/**
 * A single toast card — pure presentational component. Anatomy per
 * `design.md §6` reuse: `bg-surface` body, `border-border-2` 1px ring, 7px
 * radius, `var(--shadow-pop)`, with a 2px left border in the kind color
 * (`info`/`success`/`warning`/`danger`). Animates in via the global
 * `.anim-fade-in` helper from `main.css` — no per-component keyframes.
 *
 * Lifecycle is owned by `useUiStore.pushToast`, NOT this component:
 *  - the auto-dismiss timer lives in the store;
 *  - the component just renders + emits `dismiss` (X click) or `action`
 *    (action button click).
 *
 * `aria-live` is on the parent `<ToastStack>`, not here — each individual
 * toast is visual chrome; the stack as a region announces new entries
 * politely to screen readers (see `ToastStack.vue`).
 */

const props = defineProps<{ toast: Toast }>()

const emit = defineEmits<{
  (e: 'dismiss', id: string): void
  (e: 'action', id: string): void
}>()

const { t, te } = useI18n()

/**
 * Kind → 2px left-border accent. Falls back to `border-accent` for unknown
 * values so a future enum addition fails closed (visible, just neutral)
 * rather than producing an invisible toast. All borders are token-backed
 * — no raw hex.
 */
const kindBorderClass = computed<string>(() => {
  switch (props.toast.kind) {
    case 'success':
      return 'border-l-2 border-green'
    case 'warning':
      return 'border-l-2 border-warning'
    case 'danger':
      return 'border-l-2 border-red'
    case 'info':
    default:
      return 'border-l-2 border-accent'
  }
})

/**
 * Resolve the action label. The caller can pass either a localization key
 * under `toast.actions.*` (e.g. `'toast.actions.restartNow'`) or a literal
 * label string (e.g. the already-translated copy) — see
 * `lib/toast-action-label.ts` for the shared probe-and-fallback logic
 * (`ActivityBell.vue` uses the same helper for the persisted history rows).
 */
const actionLabel = computed<string>(() => resolveActionLabel(t, te, props.toast.action?.label))

/**
 * The whole card is an actionable hit-target when (and only when) the toast
 * carries an `action`. Without one it stays a passive `role="status"` card —
 * no pointer cursor, no keyboard affordance. We compute this once so the
 * template's role / tabindex / cursor / handlers all key off the same flag.
 */
const isActionable = computed<boolean>(() => Boolean(props.toast.action))

/**
 * Accessible name for the actionable card. Prefer the action label (e.g.
 * "Open"), falling back to the toast title so the card always announces
 * something meaningful when focused.
 */
const cardAriaLabel = computed<string>(() => actionLabel.value || props.toast.title)

function onDismissClick(): void {
  emit('dismiss', props.toast.id)
}

function onActionClick(): void {
  emit('action', props.toast.id)
}

/** Whole-card click → fire the action (only wired when `isActionable`). */
function onCardClick(): void {
  if (!isActionable.value) return
  emit('action', props.toast.id)
}

/**
 * Keyboard activation for the actionable card. Enter and Space both fire the
 * action; Space additionally calls `preventDefault()` so it doesn't scroll
 * the page.
 */
function onCardKeydown(event: KeyboardEvent): void {
  if (!isActionable.value) return
  if (event.key === 'Enter') {
    emit('action', props.toast.id)
  } else if (event.key === ' ' || event.key === 'Spacebar') {
    event.preventDefault()
    emit('action', props.toast.id)
  }
}
</script>

<template>
  <div
    class="anim-fade-in flex items-start bg-surface border border-border-2"
    :class="[kindBorderClass, isActionable ? 'cursor-pointer' : '']"
    style="
      min-width: 280px;
      max-width: 380px;
      padding: 12px 14px;
      border-radius: 7px;
      box-shadow: var(--shadow-pop);
      gap: 10px;
    "
    :role="isActionable ? 'button' : 'status'"
    :tabindex="isActionable ? 0 : undefined"
    :aria-label="isActionable ? cardAriaLabel : undefined"
    @click="onCardClick"
    @keydown="onCardKeydown"
  >
    <!-- Body: title + optional description. Takes remaining width. -->
    <div class="flex min-w-0 flex-1 flex-col" style="gap: 4px">
      <div class="text-text" style="font-size: 13px; font-weight: 500; line-height: 1.4">
        {{ toast.title }}
      </div>
      <div v-if="toast.description" class="text-text-3" style="font-size: 12px; line-height: 1.5">
        {{ toast.description }}
      </div>
    </div>

    <!--
      Trailing column: optional action button + close button. Aligned to the
      top so a multi-line description doesn't push the action down with it.
    -->
    <div class="flex shrink-0 items-start" style="gap: 8px">
      <button
        v-if="toast.action"
        type="button"
        class="text-accent transition hover:underline"
        style="font-size: 12px; font-weight: 500; line-height: 1.4; padding: 0"
        @click.stop="onActionClick"
      >
        {{ actionLabel }}
      </button>
      <button
        type="button"
        class="text-text-3 transition hover:text-text"
        :aria-label="$t('toast.dismiss')"
        style="padding: 0; line-height: 0"
        @click.stop="onDismissClick"
      >
        <X :size="12" :stroke-width="1.6" />
      </button>
    </div>
  </div>
</template>
