<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { openDelay, placeTooltip, resolveAnchor, STASH_ATTR, type Placement } from '../lib/tooltip'

/**
 * The app-wide tooltip (design.md §6 "Tooltip"). One instance, mounted in App.vue's body teleport. It
 * replaces Chromium's slow native `title` tooltip for every anchor in the window: on hover or keyboard
 * focus it moves the anchor's `title` aside (so the native one never also shows), waits the short open
 * delay and shows the same text. Leaving puts the `title` back, so the markup reads exactly as written
 * whenever nothing is hovered. Pure rules live in `lib/tooltip.ts`.
 */

const text = ref<string | null>(null)
const pos = ref<Placement | null>(null)
const tipEl = ref<HTMLElement | null>(null)

let anchor: Element | null = null
let openTimer: ReturnType<typeof setTimeout> | null = null
let aliveTimer: ReturnType<typeof setInterval> | null = null
let lastClosedAt: number | null = null
let titleObserver: MutationObserver | null = null

/** Move the anchor's `title` into the stash attribute so the native tooltip stays quiet. */
function stashTitle(el: Element): void {
  const title = el.getAttribute('title')
  if (title === null) return
  el.setAttribute(STASH_ATTR, title)
  el.removeAttribute('title')
}

function restoreTitle(el: Element): void {
  const stashed = el.getAttribute(STASH_ATTR)
  if (stashed === null) return
  el.removeAttribute(STASH_ATTR)
  // A re-render may have set a fresh `title` meanwhile; that one wins.
  if (!el.hasAttribute('title')) el.setAttribute('title', stashed)
}

async function show(): Promise<void> {
  if (!anchor) return
  const resolved = resolveAnchor(anchor)
  if (!resolved) return hide()
  text.value = resolved.text
  pos.value = null
  await nextTick()
  if (!anchor || !tipEl.value) return
  const r = anchor.getBoundingClientRect()
  if (r.width === 0 && r.height === 0) return hide()
  pos.value = placeTooltip(
    { left: r.left, top: r.top, width: r.width, height: r.height },
    { width: tipEl.value.offsetWidth, height: tipEl.value.offsetHeight },
    { width: window.innerWidth, height: window.innerHeight }
  )
  aliveTimer ??= setInterval(() => {
    if (anchor && !anchor.isConnected) hide()
  }, 250)
}

function hide(): void {
  if (openTimer) clearTimeout(openTimer)
  openTimer = null
  if (aliveTimer) clearInterval(aliveTimer)
  aliveTimer = null
  titleObserver?.disconnect()
  titleObserver = null
  if (anchor) restoreTitle(anchor)
  if (text.value !== null) lastClosedAt = performance.now()
  anchor = null
  text.value = null
  pos.value = null
}

function arm(target: Element | null): void {
  const resolved = resolveAnchor(target)
  if (resolved?.el === anchor) return
  hide()
  if (!resolved) return
  anchor = resolved.el
  stashTitle(anchor)
  // A `:title` that changes while hovered is stashed again and the shown text follows it.
  titleObserver = new MutationObserver(() => {
    if (!anchor) return
    if (anchor.hasAttribute('title')) stashTitle(anchor)
    if (text.value !== null) void show()
  })
  titleObserver.observe(anchor, { attributes: true, attributeFilter: ['title', 'aria-label'] })
  const delay = openDelay(performance.now(), lastClosedAt)
  if (delay === 0) void show()
  else openTimer = setTimeout(() => void show(), delay)
}

function onPointerOver(e: PointerEvent): void {
  if (e.pointerType === 'touch') return
  arm(e.target instanceof Element ? e.target : null)
}

function onPointerOut(e: PointerEvent): void {
  if (!anchor) return
  const next = e.relatedTarget instanceof Node ? e.relatedTarget : null
  if (next && anchor.contains(next)) return
  hide()
}

function onFocusIn(e: FocusEvent): void {
  const el = e.target instanceof Element ? e.target : null
  if (el && el.matches(':focus-visible')) arm(el)
}

function onFocusOut(): void {
  hide()
}

function onDismiss(): void {
  if (anchor) hide()
}

const opts = { capture: true, passive: true } as const

onMounted(() => {
  document.addEventListener('pointerover', onPointerOver, opts)
  document.addEventListener('pointerout', onPointerOut, opts)
  document.addEventListener('focusin', onFocusIn, opts)
  document.addEventListener('focusout', onFocusOut, opts)
  document.addEventListener('pointerdown', onDismiss, opts)
  document.addEventListener('keydown', onDismiss, opts)
  document.addEventListener('wheel', onDismiss, opts)
  document.addEventListener('scroll', onDismiss, opts)
  window.addEventListener('blur', onDismiss)
})

onBeforeUnmount(() => {
  hide()
  document.removeEventListener('pointerover', onPointerOver, opts)
  document.removeEventListener('pointerout', onPointerOut, opts)
  document.removeEventListener('focusin', onFocusIn, opts)
  document.removeEventListener('focusout', onFocusOut, opts)
  document.removeEventListener('pointerdown', onDismiss, opts)
  document.removeEventListener('keydown', onDismiss, opts)
  document.removeEventListener('wheel', onDismiss, opts)
  document.removeEventListener('scroll', onDismiss, opts)
  window.removeEventListener('blur', onDismiss)
})
</script>

<template>
  <div
    v-if="text !== null"
    ref="tipEl"
    role="tooltip"
    data-testid="app-tooltip"
    class="pointer-events-none fixed z-[90] max-w-80 whitespace-pre-line break-words rounded-sm border border-border-2 bg-surface px-2 py-1 text-caption text-text-2 shadow-pop"
    :class="pos ? 'anim-overlay-fade' : 'invisible'"
    :style="pos ? { left: `${pos.x}px`, top: `${pos.y}px` } : { left: '0px', top: '0px' }"
  >
    {{ text }}
  </div>
</template>
