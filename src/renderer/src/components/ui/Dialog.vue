<script setup lang="ts">
import { computed, customRef, ref, toRef, useId, useSlots, watch } from 'vue'
import { X } from 'lucide-vue-next'
import { useI18n } from 'vue-i18n'
import { useFocusTrap } from '../../composables/useFocusTrap'
import { DEFAULT_ESC_IGNORE, useDialogStack } from '../../composables/useDialogStack'

/**
 * The one modal shell (design.md §6 "Dialog", T460). Every blocking overlay with a card is a
 * `Dialog`; a hand-rolled scrim is a bug (`tests/dialog-shell-ratchet.test.ts`).
 *
 * CONTROLLED: it never closes itself. It emits `close(reason)` and the owner runs the close logic it
 * already has — `ui.closeDialog()`, an `emit('cancel')`, a local ref, a dirty/busy guard are all just
 * the `@close` handler. `open` is the owner's own state.
 *
 * Anatomy: scrim → card (flex column, capped at `--dialog-max-h`) → header · body · footer. Header
 * and footer are `shrink-0`; the body is the ONLY scroller. Esc routing (topmost dialog only) lives
 * in `useDialogStack`, Tab wrap + focus restore in `useFocusTrap`.
 */
defineOptions({ inheritAttrs: false })

type Size = 'sm' | 'md' | 'lg' | 'xl'

const props = withDefaults(
  defineProps<{
    /** The owner's open state (store flag, v-if, local ref). */
    open: boolean
    size?: Size
    /** CSS height of a fixed-size card (Settings, Open subfolder). Must not exceed the cap. */
    height?: string
    /** `top` anchors the card below the top edge: for a card whose height changes as its queue grows. */
    placement?: 'center' | 'top'
    /** `raised` sits above ordinary dialogs: fail-closed gates that no other surface may cover. */
    layer?: 'dialog' | 'raised'
    title?: string
    /** Mono, `--color-text-4` — the folder basename / path next to the title. */
    subtitle?: string
    /** Required when `#header` replaces the title row, so the card still has an accessible name. */
    ariaLabel?: string
    /** Id of the body copy a confirm describes. */
    describedby?: string
    /** `false`: no ✕, and Esc / scrim clicks do nothing (Esc is still swallowed). */
    dismissible?: boolean
    /** Selector inside the card, or a getter; default = the first focusable. */
    initialFocus?: string | (() => HTMLElement | null)
    /** Esc whose target matches belongs to a nested dropdown, not to the dialog. */
    escIgnore?: string
  }>(),
  {
    size: 'md',
    height: undefined,
    placement: 'center',
    layer: 'dialog',
    title: undefined,
    subtitle: undefined,
    ariaLabel: undefined,
    describedby: undefined,
    dismissible: true,
    initialFocus: undefined,
    escIgnore: DEFAULT_ESC_IGNORE
  }
)

const emit = defineEmits<{
  close: [reason: 'esc' | 'scrim' | 'button']
}>()

const slots = useSlots()
const { t } = useI18n()

const titleId = `dialog-title-${useId()}`
const cardRef = ref<HTMLElement | null>(null)
const open = toRef(props, 'open')

// Literal class strings, so Tailwind sees every one and emits the token each reads.
const WIDTH: Record<Size, string> = {
  sm: 'w-(--dialog-w-sm)',
  md: 'w-(--dialog-w-md)',
  lg: 'w-(--dialog-w-lg)',
  xl: 'w-(--dialog-w-xl)'
}
const LAYER = { dialog: 'z-(--z-dialog)', raised: 'z-(--z-dialog-raised)' } as const

const hasHeaderSlot = computed(() => !!slots.header)
const hasFooter = computed(() => !!slots.footer || !!slots.meta)

function request(reason: 'esc' | 'scrim' | 'button'): void {
  if (props.dismissible) emit('close', reason)
}

function onScrimMousedown(e: MouseEvent): void {
  // Mousedown, not click, and only on the scrim itself: a drag that starts inside the card and ends
  // outside must not dismiss it.
  if (e.target === e.currentTarget) request('scrim')
}

const { isTop, closedUnderAnother } = useDialogStack({
  open,
  onEscape: () => request('esc'),
  escIgnore: () => props.escIgnore
})

/**
 * `useFocusTrap` reads `initialFocusRef.value` once, after `nextTick`, when it activates. A
 * `customRef` whose getter re-resolves on every read (no caching) lets a selector be scoped to the
 * card — slot content is mounted by then — without a watcher. `null` = fall back to the first
 * focusable, then the card.
 */
const initialFocusRef = customRef<HTMLElement | null>(() => ({
  get() {
    const target = props.initialFocus
    if (!target) return null
    if (typeof target === 'function') return target()
    return cardRef.value?.querySelector<HTMLElement>(target) ?? null
  },
  set() {
    // read-only: the value is always resolved from `props.initialFocus`
  }
}))

useFocusTrap({
  active: open,
  containerRef: cardRef,
  initialFocusRef,
  // Under another dialog while open; and still "under" at the moment it closes out of order, so its
  // trap does not pull focus to the page opener from beneath the dialog that is still on top.
  suspended: computed(() => (props.open ? !isTop.value : closedUnderAnother.value))
})

// ---- dev-only contract checks (C03, C18) -----------------------------------------------------

/** Fallback of `--dialog-max-h` (themes.css) for a window that has not resolved the token. */
const CAP_VH_FALLBACK = 84

/**
 * Can `height` exceed the cap? Conservative: only a value PROVABLY taller is flagged. `min()` is
 * within the cap when ANY term is; `vh` terms compare with the cap, `px` terms with the cap at the
 * current window; anything else (`calc()`, `%`) is given the benefit of the doubt.
 */
function heightExceedsCap(height: string): boolean {
  const capVh =
    parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--dialog-max-h')) ||
    CAP_VH_FALLBACK
  const inner = /^min\((.*)\)$/.exec(height.trim())?.[1] ?? height
  const terms = inner.split(',').map((term) => term.trim())
  return terms.every((term) => {
    const m = /^(\d+(?:\.\d+)?)(vh|px)$/.exec(term)
    if (!m) return false
    const n = parseFloat(m[1])
    return m[2] === 'vh' ? n > capVh : n > (window.innerHeight * capVh) / 100
  })
}

if (import.meta.env.DEV) {
  watch(
    () => [props.open, props.height, props.title, props.ariaLabel, hasHeaderSlot.value] as const,
    ([isOpen, height, title, ariaLabel, custom]) => {
      if (!isOpen) return
      if (height && heightExceedsCap(height)) {
        console.error(
          `[Dialog] height "${height}" exceeds the cap (--dialog-max-h); use a smaller one.`
        )
      }
      if (!title && !ariaLabel) {
        console.error(
          `[Dialog] needs a title${custom ? ' or an ariaLabel (a #header replaces the title row)' : ''} — a dialog always has an accessible name.`
        )
      }
    },
    { immediate: true }
  )
}
</script>

<template>
  <Teleport to="body">
    <div
      v-if="open"
      class="anim-overlay-fade fixed inset-0 flex justify-center bg-scrim"
      :class="[LAYER[layer], placement === 'top' ? 'items-start pt-[10vh]' : 'items-center']"
      role="presentation"
      @mousedown="onScrimMousedown"
    >
      <div
        v-bind="$attrs"
        ref="cardRef"
        class="anim-fade-in-scale flex max-h-(--dialog-max-h) max-w-[90vw] flex-col rounded-lg border border-border-2 bg-surface text-text shadow-pop"
        :class="WIDTH[size]"
        :style="height ? { height } : undefined"
        role="dialog"
        aria-modal="true"
        :aria-labelledby="hasHeaderSlot ? undefined : titleId"
        :aria-label="hasHeaderSlot ? ariaLabel : undefined"
        :aria-describedby="describedby"
        tabindex="-1"
        @mousedown.stop
      >
        <!-- Header -->
        <header
          class="flex shrink-0 items-center justify-between border-b border-border px-4.5 pt-3.5 pb-2.5"
        >
          <slot v-if="hasHeaderSlot" name="header" />
          <template v-else>
            <div class="flex min-w-0 items-center gap-2">
              <slot name="icon" />
              <div class="flex min-w-0 items-baseline gap-2">
                <h2 :id="titleId" class="text-dialog-title font-semibold text-text">
                  {{ title }}
                </h2>
                <span v-if="subtitle" class="truncate font-mono text-[11.5px] text-text-4">{{
                  subtitle
                }}</span>
              </div>
            </div>
            <button
              v-if="dismissible"
              type="button"
              class="flex size-6 shrink-0 items-center justify-center rounded text-text-3 transition hover:bg-surface-2 hover:text-text"
              :aria-label="t('dialog.close')"
              @click="request('button')"
            >
              <X :size="14" :stroke-width="1.5" />
            </button>
          </template>
        </header>

        <!-- Body: the only scroller -->
        <div class="scrollable min-h-0 flex-1 overflow-y-auto px-4.5 py-3.5">
          <slot />
        </div>

        <!-- Footer -->
        <footer
          v-if="hasFooter"
          class="flex shrink-0 items-center justify-end gap-2 border-t border-border px-4.5 py-3"
        >
          <div v-if="$slots.meta" class="mr-auto flex items-center">
            <slot name="meta" />
          </div>
          <slot name="footer" />
        </footer>
      </div>
    </div>
  </Teleport>
</template>
