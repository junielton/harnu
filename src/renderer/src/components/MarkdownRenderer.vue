<script lang="ts">
/**
 * Module scope on purpose (BUG-119): the counter has to be shared by every
 * instance, and everything inside `<script setup>` runs once PER instance — a
 * counter declared there would hand every block the same `md1-`.
 *
 * Why a prefix at all: several of these blocks share a page (a folder view
 * listing card bodies, a memory pane beside a card modal), and two of them
 * rendering the same source used to emit the same heading ids — invalid HTML,
 * and a document-wide `getElementById` or an assistive tech's heading map then
 * lands on whichever came first. The seam deduplicates WITHIN one render; this
 * is what keeps two renders apart.
 *
 * A counter rather than `useId()`: `useId()` is scoped to the Vue APP, so two
 * blocks mounted in two apps (which is what a component test does) would collide
 * again. A module counter is unique for the lifetime of the module, whatever
 * mounts it. Readable and stable within a session, unlike a random value.
 */
let instanceSeq = 0
function nextInstanceId(): string {
  return `md${++instanceSeq}`
}
</script>

<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { renderMarkdown } from '../lib/markdown'

/**
 * Reusable markdown → prose renderer (T74 §3.1). Takes a STRING of markdown and
 * `v-html`s the sanitized output of the pure `renderMarkdown` seam. Knows
 * nothing about files, IPC or containment — that's `MarkdownPane`'s job — so the
 * memory pane (T79) and the roadmap cards (T80) can consume it directly with
 * content that arrives via `memory_read` (no file-read, no path gate).
 *
 * Link policy (§3.5), decided here at click time on the RAW href attribute:
 *  - `#anchor`  → scroll to the matching heading id within the pane; no navigation.
 *  - external (`http`/`https`/`mailto`) → the sanitized `target="_blank"` anchor
 *    hits the app's `setWindowOpenHandler` allowlist (opens in the OS browser).
 *    We never navigate the app window.
 *  - relative (no scheme) → emit `relativeLink` so the parent can resolve + re-open
 *    it against `linkBase`. WITHOUT a `linkBase` a relative link is inert (§3.5).
 */
interface Props {
  source: string
  /** Directory relative links resolve against. Absent ⇒ relative links inert. */
  linkBase?: string
}
const props = defineProps<Props>()
const emit = defineEmits<{ relativeLink: [href: string] }>()

const { t } = useI18n()

/**
 * This instance's heading-id prefix (BUG-119) — see `nextInstanceId` above.
 */
const idPrefix = `${nextInstanceId()}-`

const html = computed(() =>
  renderMarkdown(
    props.source ?? '',
    {
      copy: t('markdownRenderer.copyCode'),
      copied: t('markdownRenderer.copied')
    },
    idPrefix
  )
)

/** ms the "copied" icon/label stay before reverting to idle (design.md §7 — Copy → copied). */
const COPIED_RESET_MS = 1500
/** Per-button revert timers (T121) — keyed by element so copying block B never clears or
 * disturbs block A's independent timeout (multiple blocks must stay independent). */
const copyResetTimers = new WeakMap<HTMLButtonElement, ReturnType<typeof setTimeout>>()

/**
 * Copy a fenced code block's RAW source (T121). `data-raw` is `encodeURIComponent`-
 * encoded by the seam (`markdown.ts`) — NOT `escapeHtml` — because DOMPurify trims
 * leading/trailing whitespace off every attribute it re-serializes, which would
 * silently eat the fence's trailing newline; percent-encoding has no whitespace at
 * its edges to trim. `decodeURIComponent` here restores the byte-exact source. Silent
 * on clipboard failure: this component is deliberately IPC/toast-free (reused by
 * contexts, like the memory pane, that don't all wire a toast store) — the button
 * just stays idle.
 */
async function onCopyCodeBlock(btn: HTMLButtonElement): Promise<void> {
  try {
    await navigator.clipboard.writeText(decodeURIComponent(btn.dataset.raw ?? ''))
  } catch {
    return
  }
  const idleLabel = btn.dataset.labelIdle ?? ''
  const copiedLabel = btn.dataset.labelCopied ?? ''
  btn.classList.add('is-copied')
  btn.setAttribute('aria-label', copiedLabel)
  btn.setAttribute('title', copiedLabel)
  const pending = copyResetTimers.get(btn)
  if (pending) clearTimeout(pending)
  copyResetTimers.set(
    btn,
    setTimeout(() => {
      btn.classList.remove('is-copied')
      btn.setAttribute('aria-label', idleLabel)
      btn.setAttribute('title', idleLabel)
      copyResetTimers.delete(btn)
    }, COPIED_RESET_MS)
  )
}

function onClick(ev: MouseEvent): void {
  const eventTarget = ev.target as HTMLElement | null
  const copyBtn = eventTarget?.closest?.('.md-code-copy-btn') as HTMLButtonElement | null
  if (copyBtn) {
    void onCopyCodeBlock(copyBtn)
    return
  }

  const anchor = eventTarget?.closest?.('a')
  if (!anchor) return
  const href = anchor.getAttribute('href') ?? ''
  if (!href) return

  // In-document anchor → scroll the target heading into view (no navigation).
  if (href.startsWith('#')) {
    ev.preventDefault()
    const id = decodeURIComponent(href.slice(1))
    const root = ev.currentTarget as HTMLElement
    // Headings carry `idPrefix + slug` (BUG-119) while the author's link says
    // `#slug`, so resolve the prefixed id first. The bare fallback keeps a link
    // working against markup that predates the prefix, or that a consumer
    // rendered through `renderMarkdown` without one.
    const target =
      root.querySelector(`[id="${CSS.escape(idPrefix + id)}"]`) ??
      root.querySelector(`[id="${CSS.escape(id)}"]`)
    target?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    return
  }

  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(href)?.[1]?.toLowerCase()
  // External scheme → let the sanitized target="_blank" anchor open via the OS
  // handler. Any OTHER scheme shouldn't survive sanitize; treat it as inert.
  if (scheme === 'http' || scheme === 'https' || scheme === 'mailto') return
  if (scheme) {
    ev.preventDefault()
    return
  }

  // Relative link (no scheme, not an anchor). Only actionable with a linkBase.
  ev.preventDefault()
  if (props.linkBase) emit('relativeLink', href)
}
</script>

<template>
  <!-- v-html content is sanitized by the renderMarkdown seam (markdown-it
       html:false + DOMPurify) — the ONE audited sink; the app CSP is the net
       below it. Prose styling is token-mapped via :deep so it reaches the
       injected nodes. -->
  <!-- eslint-disable-next-line vue/no-v-html -- sanitized by renderMarkdown (§3.2) -->
  <div class="md-prose" @click="onClick" v-html="html"></div>
</template>

<style scoped>
.md-prose {
  color: var(--color-text-2);
  font-size: 12.5px;
  line-height: 1.6;
  word-break: break-word;
}

/* Headings (design.md §6 — Markdown pane) */
.md-prose :deep(h1) {
  font-size: 18px;
  font-weight: 600;
  color: var(--color-text);
  margin: 4px 0 10px;
  padding-bottom: 6px;
  border-bottom: 1px solid var(--color-border);
  letter-spacing: -0.01em;
}
.md-prose :deep(h2) {
  font-size: 15px;
  font-weight: 600;
  color: var(--color-text);
  margin: 18px 0 8px;
}
.md-prose :deep(h3) {
  font-size: 13px;
  font-weight: 600;
  color: var(--color-text);
  margin: 16px 0 6px;
}
.md-prose :deep(h4),
.md-prose :deep(h5),
.md-prose :deep(h6) {
  font-size: 12px;
  font-weight: 600;
  color: var(--color-text-2);
  margin: 14px 0 4px;
}
.md-prose :deep(:first-child) {
  margin-top: 0;
}

/* Body */
.md-prose :deep(p),
.md-prose :deep(li) {
  margin: 0 0 8px;
}
.md-prose :deep(a) {
  color: var(--color-accent);
  text-decoration: none;
}
.md-prose :deep(a:hover) {
  text-decoration: underline;
}
.md-prose :deep(strong) {
  color: var(--color-text);
  font-weight: 600;
}
/* Lists (design.md §6 — Markdown pane, `ul`/`ol`). BUG-119: Tailwind's preflight
   sets `list-style: none` on every `ul`/`ol` and this block never put it back, so a
   `- item` rendered as an unlabelled indented line in all seven consumers. Restored
   here, at the ONE place the markers belong, per level — a nested list whose marker
   is identical to its parent's reads as one flat list. Named types, never
   `list-style: revert`: revert would also hand back preflight's `margin`/`padding`
   and reflow every list in the app. */
.md-prose :deep(ul),
.md-prose :deep(ol) {
  margin: 0 0 8px;
  padding-left: 20px;
}
.md-prose :deep(ul) {
  list-style: disc;
}
.md-prose :deep(ul ul) {
  list-style: circle;
}
.md-prose :deep(ul ul ul) {
  list-style: square;
}
.md-prose :deep(ol) {
  list-style: decimal;
}
.md-prose :deep(ol ol) {
  list-style: lower-alpha;
}
.md-prose :deep(ol ol ol) {
  list-style: lower-roman;
}
.md-prose :deep(li) {
  margin-bottom: 4px;
}

/* Inline code + code blocks */
.md-prose :deep(code) {
  font-family: var(--font-mono);
  font-size: 11.5px;
  color: var(--color-text);
  background: var(--color-surface-2);
  border-radius: var(--radius-sm);
  padding: 1px 4px;
}
.md-prose :deep(pre) {
  font-family: var(--font-mono);
  font-size: 11.5px;
  line-height: 1.5;
  background: var(--color-surface-2);
  border: 1px solid var(--color-border);
  border-radius: var(--radius);
  padding: 10px 12px;
  overflow-x: auto;
  margin: 0 0 10px;
}
.md-prose :deep(pre code) {
  background: transparent;
  border-radius: 0;
  padding: 0;
  color: inherit;
}

/* Copy button (design.md §6 — Copy button, T121). Idle: invisible; revealed on hover of
   the whole block OR keyboard focus of the button itself (never hover-only — a
   focus-visible-only affordance would be unreachable by keyboard). */
.md-prose :deep(.md-code-block) {
  position: relative;
}
.md-prose :deep(.md-code-copy-btn) {
  position: absolute;
  top: 6px;
  right: 6px;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  background: var(--color-surface);
  color: var(--color-text-3);
  opacity: 0;
  transition:
    opacity var(--dur-fast) var(--ease),
    color var(--dur-fast) var(--ease),
    background var(--dur-fast) var(--ease);
}
.md-prose :deep(.md-code-block:hover .md-code-copy-btn),
.md-prose :deep(.md-code-copy-btn:focus-visible) {
  opacity: 1;
}
.md-prose :deep(.md-code-copy-btn:hover) {
  background: var(--color-surface-2);
  color: var(--color-text);
}
.md-prose :deep(.md-code-copy-btn.is-copied) {
  color: var(--color-green);
}
.md-prose :deep(.md-code-copy-btn .md-icon-copy),
.md-prose :deep(.md-code-copy-btn .md-icon-check) {
  width: 12px;
  height: 12px;
}
.md-prose :deep(.md-code-copy-btn .md-icon-check) {
  display: none;
}
.md-prose :deep(.md-code-copy-btn.is-copied .md-icon-copy) {
  display: none;
}
.md-prose :deep(.md-code-copy-btn.is-copied .md-icon-check) {
  display: block;
}

/* Blockquote */
.md-prose :deep(blockquote) {
  border-left: 2px solid var(--color-accent-line);
  padding-left: 10px;
  margin: 0 0 10px;
  color: var(--color-text-3);
}

/* Tables (design.md §6 — Markdown pane, `table`). BUG-119: the scroll container
   used to be the whole rendered block, so dragging a wide table sideways dragged
   the paragraphs above and below it out of view — a reader scrolling to column
   seven lost the sentence that said what the table was. Each table now sits in its
   own `.md-table-scroll` wrapper (emitted by the seam) and scrolls on its own axis;
   the wrapper carries the block's bottom margin so the spacing is unchanged.

   `min-width: max-content` is the OTHER half, and the wrapper is inert without it:
   a table's default width is shrink-to-fit, and `.md-prose`'s inherited
   `word-break: break-word` lets it shrink to almost nothing, so a wide table would
   compress into the pane and break its own header words mid-word rather than
   overflow anything. Pinning it to its natural width gives the wrapper something to
   scroll. A table that already fits is unaffected — shrink-to-fit already renders
   it at max-content. */
.md-prose :deep(.md-table-scroll) {
  overflow-x: auto;
  margin: 0 0 10px;
}
.md-prose :deep(table) {
  border-collapse: collapse;
  margin: 0;
  min-width: max-content;
  font-size: 12px;
}
.md-prose :deep(th),
.md-prose :deep(td) {
  border: 1px solid var(--color-border);
  padding: 4px 8px;
  text-align: left;
}
.md-prose :deep(th) {
  background: var(--color-surface-2);
  color: var(--color-text);
  font-weight: 600;
}

/* Rules + images */
.md-prose :deep(hr) {
  border: 0;
  border-top: 1px solid var(--color-border);
  margin: 16px 0;
}
.md-prose :deep(img) {
  max-width: 100%;
}
</style>
