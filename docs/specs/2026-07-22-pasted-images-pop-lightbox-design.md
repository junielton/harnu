# Design: Pasted-images pill pop + click-to-open lightbox

Date: 2026-07-22
Status: Approved

Visual reference (Paper mockups, both artboards match Capy's real dark-theme
tokens — no invented colors): https://app.paper.design/file/01KKVZ5MMGAZ3Y113X01H9P2ZM/2-0
("Pasted-images: pop + lightbox" page — artboard A: pill-pop storyboard,
artboard B: lightbox/carousel layout).

## Problem

The Pasted-images footer pill + popover (`StatusFooter.vue` +
`FooterImagePopover.vue`, documented in `design.md` under "Pasted-images pill

- popover") ships two gaps:

1. **No feedback when a new image actually lands.** The pill's count updates
   live via a 2s poll (`useSessionImages.ts`), but design.md is explicit
   today: _"Doesn't animate on appearing beyond the standard fade."_ A
   screenshot landing in `image-cache/` is a genuinely new event worth a
   small acknowledgement — right now it's silent.
2. **No way to see an image bigger than the 1:1 grid tile.** Clicking a tile
   in the popover does nothing; the only way to see the full image is the
   **Open** action, which leaves Capy entirely (OS image viewer). There's no
   in-app way to look at several pasted screenshots in sequence.

Both live on the same component pair and are small enough to ship together,
but they are independent changes (one is a CSS/state tweak on an existing
element, the other is a new component) — implementation can land as two
commits.

## Design

### 1. Footer pill "pop" on a genuinely new image

**Where:** `StatusFooter.vue`, the existing pill markup (`imageCount`,
around the `<Image>` icon + `tabular-nums` counter).

**Trigger condition — not "count changed," specifically "count went up for
the session already on screen":**

```ts
// StatusFooter.vue — new local state, alongside the existing imagesUuid/imageCount
const pillBump = ref(false)
let lastBumpUuid: string | null = null
let lastBumpCount = 0

watch(imageCount, (count) => {
  const uuid = imagesUuid.value
  if (uuid === lastBumpUuid && count > lastBumpCount && lastBumpCount > 0) {
    pillBump.value = true
    setTimeout(() => (pillBump.value = false), 320) // > the 300ms animation
  }
  lastBumpUuid = uuid
  lastBumpCount = count
})
```

This intentionally does **not** fire when: `imagesUuid` changes (session
switch — even into a session that already has images), or the count goes
0→1 (first image ever for this session — already covered by the pill's
existing hide-when-zero fade-in). It fires on every real increment while the
user is looking at the same session (1→2, 2→3, …).

**Markup change** — bind the bump class next to the existing open/closed
state classes:

```html
<button
  type="button"
  class="flex items-center gap-1 rounded border px-1 transition-colors"
  :class="[
    imagesPopoverOpen
      ? 'border-accent-line bg-accent-soft text-accent'
      : 'border-border bg-surface-2 text-text-2 hover:border-border-2 hover:text-text',
    pillBump ? 'anim-pill-bump' : ''
  ]"
  ...
></button>
```

**New CSS** (`main.css`, alongside the other `.anim-*` helpers) — one
keyframe, reusing the existing `--ease` token, no new duration/easing token:

```css
@keyframes pill-bump {
  0% {
    transform: scale(1);
  }
  45% {
    transform: scale(1.16);
    background-color: var(--color-accent-soft);
    border-color: var(--color-accent-line);
  }
  100% {
    transform: scale(1);
  }
}
.anim-pill-bump {
  animation: pill-bump 300ms var(--ease);
}
@media (prefers-reduced-motion: reduce) {
  .anim-pill-bump {
    animation: none;
  }
}
```

Scale never exceeds 1.16 and there is no bounce/overshoot keyframe — stays
inside design.md §7's "zero bouncing, overshoot springs" rule. The counter
text itself needs no separate treatment; it already re-renders with the new
number the instant `imageCount` changes, same as today.

### 2. Click a tile → `ImageLightbox.vue` (new component)

**Trigger:** `FooterImagePopover.vue`'s tile `<div>` (the one currently only
carrying the hover-actions overlay) gets a click handler on the tile body,
excluding the 4 action buttons (which already `@click` their own handlers —
Vue's event model means no extra `stopPropagation` is needed as long as the
tile's own click listener is on the outer wrapper and the buttons keep their
own handlers):

```html
<div
  v-for="(e, i) in entries"
  :key="e.name"
  class="group relative overflow-hidden rounded border border-border bg-surface cursor-pointer"
  @click="emit('open-lightbox', i)"
></div>
```

`FooterImagePopover.vue` gains one new emit (`open-lightbox`, payload: index
into `entries`) — it does not own the lightbox itself, since the lightbox
needs to render above the popover's own stacking context (see z-order
below).

**State ownership:** a `lightboxIndex = ref<number | null>(null)` **local to
`StatusFooter.vue`** — not the central `ui` store. Precedent: the footer
popover's own `imagesPopoverOpen`/`popoverOpen` are already component-local
(design.md's floating-surfaces table already lists "Footer fleet popover" as
local-state at z-50). The lightbox is reachable from exactly one place
(`FooterImagePopover`, itself only reachable from `StatusFooter`), unlike
`SessionPreview`/`CommandPalette` which are triggered from many components
and genuinely need the shared `ui` mutex.

```html
<!-- StatusFooter.vue template, sibling to the existing popover markup -->
<ImageLightbox
  v-if="lightboxIndex !== null"
  :entries="imageEntries"
  :index="lightboxIndex"
  :uuid="imagesUuid ?? ''"
  :folder-alias="imageFolderAlias"
  :can-reattach="canReattach"
  @close="closeImageFlow"
  @update:index="(i) => (lightboxIndex = i)"
  @reattached="closeImageFlow"
/>
```

```ts
function closeImageFlow(): void {
  lightboxIndex.value = null
  imagesPopoverOpen.value = false
}
```

Closing the lightbox — via Esc, backdrop click, or the header's close button
— always calls `closeImageFlow()`, which closes **both** the lightbox and
the popover behind it. No nested-modal Esc-stacking to reason about; one
clean exit back to the plain footer. Clicking **Re-attach** from inside the
lightbox also emits `reattached`, which triggers the same `closeImageFlow()`
— re-attaching means the user wants to look at the terminal next, not stay
in the gallery.

**`ImageLightbox.vue` structure:**

```html
<script setup lang="ts">
  const props = defineProps<{
    entries: SessionImage[]
    index: number
    uuid: string
    folderAlias: string
    canReattach: boolean
  }>()
  const emit = defineEmits<{
    close: []
    'update:index': [number]
    reattached: []
  }>()

  const current = computed(() => props.entries[props.index])

  function go(delta: number): void {
    const n = props.entries.length
    if (n === 0) return
    emit('update:index', (props.index + delta + n) % n) // wraps both ways
  }

  // Entries can change live (poll keeps running while the lightbox is open —
  // the popover is only visually, not actually, unmounted). Pruning isn't
  // guaranteed to remove from the end, so this tracks the viewed file BY NAME,
  // not by raw index — an index-only guard would silently swap the displayed
  // image if an earlier file got pruned. If the viewed file disappears, close;
  // if it's still present, re-point the index to wherever it now sits.
  watch(
    () => props.entries,
    (next) => {
      const name = current.value?.name
      const i = next.findIndex((e) => e.name === name)
      if (i === -1) emit('close')
      else if (i !== props.index) emit('update:index', i)
    },
    { deep: true }
  )

  onKeyStroke('Escape', () => emit('close'))
  onKeyStroke('ArrowLeft', () => go(-1))
  onKeyStroke('ArrowRight', () => go(1))

  function reattach(): void {
    sessions.reattachImage(current.value.path)
    emit('reattached')
  }
  // open/reveal/copy: identical bodies to FooterImagePopover.vue's, operating
  // on `current.value` instead of a loop variable — no new IPC calls, these
  // reuse window.api.openPath / showItemInFolder / imageCacheCopy exactly as
  // today.
</script>

<template>
  <Teleport to="body">
    <div
      class="anim-overlay-fade fixed inset-0 z-60 flex flex-col"
      style="background: rgba(0,0,0,0.82)"
      @click.self="emit('close')"
    >
      <!-- top bar: filename + WxH (left) · n / N counter + close (right) -->
      <!-- stage: prev button · image (object-contain, rounded, border-2, shadow-pop) · next button -->
      <!-- bottom: action toolbar (open/reveal/copy/reattach, same weight as the grid's) · filmstrip · hint line -->
    </div>
  </Teleport>
</template>
```

No new IPC surface — `open`/`reveal`/`copy`/`reattach` call the exact same
`window.api.*` functions `FooterImagePopover.vue` already calls, just
against `current.value` instead of a `v-for` item. The image itself reuses
`entries[i].dataUrl`, already loaded in full by the popover's
`loadThumbs()` on open — **no extra read**, no separate "thumbnail vs
full-size" asset.

**Image swap transition:** a plain opacity cross-fade (`--dur`/`--ease`) on
`current` changing — no slide, no parallax, keeps the carousel restrained
rather than flashy.

**design.md updates required (same commit as implementation):**

- "Pasted-images pill + popover" section: replace the "Doesn't animate on
  appearing beyond the standard fade" line with the pop behavior above; add
  a line noting tiles are clickable → opens the lightbox.
- New component section "Image lightbox (Pasted-images gallery)" documenting
  the anatomy above.
- §6 "Floating surfaces (z-order)" table: new row —
  `Image lightbox | ImageLightbox.vue | 60 | State local to StatusFooter.vue (not the ui-store mutex — single entry point). Closing it also closes the footer popover behind it.`
- §7 Motion table: two new rows — "Pasted-images pill bump" (300ms,
  `--ease`, scale 1→1.16→1 + accent cross-fade) and "Lightbox image swap"
  (`--dur`/`--ease`, opacity cross-fade only).

**i18n (both `en.json` and `pt-BR.json`, `images.*` namespace — extends the
existing keys, doesn't rename any):** `images.lightboxCounterAria`
(`"Image {index} of {count}"`), `images.lightboxPrevAria` /
`images.lightboxNextAria`, `images.lightboxCloseAria`. `open`/`reveal`/
`copy`/`reattach`/`reattachDisabled`/`ephemeral` are reused verbatim — no
new strings needed for the action row.

## Out of scope

- Tile-level animation in the grid when a new image lands (confirmed: pill
  only).
- A dedicated "expand" icon in the tile's hover-actions row (confirmed:
  click the tile body itself).
- Zoom/pan inside the lightbox — `object-contain` fitting the viewport is
  enough; these are pasted screenshots, not a photo library.
- Keyboard shortcuts beyond ← / → / Esc.
- Any change to `useSessionImages.ts`'s polling/caching behavior — both
  features are pure consumers of the existing `entries`/`count`.
- Persisting "seen" state across app restarts — the whole feature stays
  ephemeral, matching the rest of the pasted-images gallery.

## Testing / verification

- Unit: the pill-bump watcher's trigger condition — count increases with
  same uuid + prior count > 0 → bump; uuid change → no bump; 0→1 → no bump;
  poll tick with unchanged count → no bump.
- Unit: `ImageLightbox`'s index math — `go()` wraps both directions at the
  array boundaries; the entries watcher closes when the viewed file's name
  disappears from the list, and re-points the index (without closing) when
  that same file is still present but shifted position.
- Manual live-app verification (`docs/dev/live-verify-second-instance.md`):
  paste two screenshots into a running session, confirm the pill bumps only
  on the second one; open the popover, click a tile, confirm the lightbox
  opens on the right image with working prev/next (including wraparound),
  confirm Open/Reveal/Copy/Re-attach all act on the currently-shown image,
  confirm Esc/backdrop-click/close-button/Re-attach all return cleanly to
  the plain footer (popover closed, not just the lightbox).

## Changelog

A `CHANGELOG.md` entry is required (per repo convention) under `### Added`:
the Pasted-images pill now bumps when a new screenshot lands, and clicking a
thumbnail opens a full-size lightbox with prev/next navigation and the same
Open/Reveal/Copy/Re-attach actions.
