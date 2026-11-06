import {
  computed,
  onBeforeUnmount,
  ref,
  shallowRef,
  toValue,
  watch,
  type MaybeRefOrGetter,
  type Ref
} from 'vue'

/**
 * The stack of open `ui/Dialog` cards (T460, design.md §6 "Dialog" → Keyboard).
 *
 * Before this existed every dialog added its own `window` capture keydown listener, and
 * `stopPropagation()` does not stop OTHER listeners on the same target — so one Esc reached every
 * mounted dialog, and each stacked pair carried a hand-written guard (`confirming`, `busy`, the
 * combobox exemption) to compensate. Here ONE capture listener serves the whole stack: Esc is
 * routed to the TOP entry only and swallowed, so it never reaches a takeover behind it either.
 *
 * The listener is installed when the first dialog opens and removed when the last one closes.
 * Each entry also exposes `isTop`, which `Dialog` feeds to `useFocusTrap` as `suspended` so a
 * dialog under another stops trapping Tab and stops restoring focus.
 */

/** Esc whose target sits inside a match belongs to that nested dropdown, not to the dialog. */
export const DEFAULT_ESC_IGNORE = '[data-esc-owner],[data-branch-combobox-panel]'

interface StackEntry {
  id: symbol
  onEscape: () => void
  escIgnore: () => string
}

/** Bottom → top. Replaced, never mutated, so `isTop` computeds track it. */
const stack = shallowRef<readonly StackEntry[]>([])
let listening = false

function onKeydown(e: KeyboardEvent): void {
  if (e.key !== 'Escape') return
  const top = stack.value[stack.value.length - 1]
  if (!top) return
  const ignore = top.escIgnore()
  if (ignore && e.target instanceof Element && e.target.closest(ignore)) return
  e.stopPropagation()
  top.onEscape()
}

function syncListener(): void {
  const want = stack.value.length > 0
  if (want && !listening) {
    window.addEventListener('keydown', onKeydown, true)
    listening = true
  } else if (!want && listening) {
    window.removeEventListener('keydown', onKeydown, true)
    listening = false
  }
}

interface UseDialogStackOptions {
  /** Reactive open flag — the entry is on the stack exactly while this is true. */
  open: Ref<boolean>
  /** Called when Esc reaches this dialog (it is the top one and the target is not ignored). */
  onEscape: () => void
  /** CSS selector of nested dropdowns that own their own Esc. Defaults to {@link DEFAULT_ESC_IGNORE}. */
  escIgnore?: MaybeRefOrGetter<string>
}

export function useDialogStack(options: UseDialogStackOptions): {
  /** This dialog is open and nothing sits above it. */
  isTop: Readonly<Ref<boolean>>
  /** It last closed while another dialog was still above it (an out-of-order close). */
  closedUnderAnother: Readonly<Ref<boolean>>
} {
  const id = Symbol('dialog')
  const entry: StackEntry = {
    id,
    onEscape: options.onEscape,
    escIgnore: () => toValue(options.escIgnore) ?? DEFAULT_ESC_IGNORE
  }

  const closedUnderAnother = ref(false)

  function remove(): void {
    const index = stack.value.findIndex((e) => e.id === id)
    if (index < 0) return
    closedUnderAnother.value = index < stack.value.length - 1
    stack.value = stack.value.filter((e) => e.id !== id)
    syncListener()
  }

  // `sync`: the stack must be right before anything else in the same flush (the focus trap reads
  // `isTop` as it activates), and an out-of-order close must never leave a dangling listener.
  watch(
    options.open,
    (open) => {
      if (open) {
        closedUnderAnother.value = false
        if (!stack.value.some((e) => e.id === id)) stack.value = [...stack.value, entry]
        syncListener()
      } else {
        remove()
      }
    },
    { immediate: true, flush: 'sync' }
  )

  onBeforeUnmount(remove)

  const isTop = computed(() => stack.value[stack.value.length - 1]?.id === id)
  return { isTop, closedUnderAnother }
}
