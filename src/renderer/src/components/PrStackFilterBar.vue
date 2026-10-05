<script setup lang="ts">
/**
 * T387 — the PR Stack Canvas filter bar (design.md §6 "PR Stack filters").
 *
 * A floating toolbar: a token field with GitHub-style qualifiers, four facet
 * menus, and — only while a filter is active — the result count, the Dim/Hide
 * switch and a clear button. It owns no filter state: the query lives in
 * `stores/pr-stack.ts` (per repo, session-only) and the facet checkboxes are a
 * second view of that same string, so a box and its token can never disagree.
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { Check, ChevronDown, Search, X } from 'lucide-vue-next'
import { usePrStackStore } from '../stores/pr-stack'
import {
  QUALIFIER_KEYS,
  QUALIFIER_VALUES,
  facetCounts,
  hasToken,
  parseQuery,
  toggleToken,
  tokenCount,
  type QualifierKey,
  type QueryTerm
} from './pr-stack-filter'

const { t } = useI18n()
const store = usePrStackStore()

const root = ref<HTMLElement | null>(null)
const input = ref<HTMLInputElement | null>(null)
const tokens = ref<HTMLElement | null>(null)
const focused = ref(false)
const suggestIndex = ref(-1)

type FacetId = 'author' | 'review' | 'checks' | 'labels'
const openMenu = ref<FacetId | null>(null)

const nodes = computed(() => store.snapshot?.graph.nodes ?? [])

// ── Chips and the term being typed ─────────────────────────────────────────

const chips = computed(() => parseQuery(store.filter.query).terms)
const draft = computed(() => store.filter.draft)

// Keep the newest term (and the caret) in view as the field fills up.
watch([chips, draft], () =>
  nextTick(() => {
    if (tokens.value) tokens.value.scrollLeft = tokens.value.scrollWidth
  })
)

/** `-review:` / `review:` / `` — the part of a chip drawn in the accent. */
function chipKey(term: QueryTerm): string {
  if (term.key === null && term.unknownKey === null) return ''
  return term.raw.slice(0, term.raw.indexOf(':') + 1)
}
function chipValue(term: QueryTerm): string {
  return term.raw.slice(chipKey(term).length)
}

function focus(): void {
  input.value?.focus()
}
defineExpose({ focus })

/** Moves the term being typed into the chips, unless it is still incomplete. */
function commitDraft(): void {
  const text = draft.value.trim()
  if (text === '') return
  if (parseQuery(text).terms.every((term) => term.status === 'pending')) return
  store.setFilterQuery([store.filter.query, text].filter((p) => p !== '').join(' '))
  store.setFilterDraft('')
}

function openQuotes(text: string): boolean {
  return (text.match(/"/g) ?? []).length % 2 === 1
}

// ── Qualifier suggestions ──────────────────────────────────────────────────

function hintFor(key: QualifierKey): string {
  const values = QUALIFIER_VALUES[key]
  if (values) return values.join(' · ')
  if (key === 'author' || key === 'review-requested') return t('prStack.filter.hintLogin')
  if (key === 'label') return t('prStack.filter.hintName')
  if (key === 'base') return t('prStack.filter.hintBranch')
  return t('prStack.filter.hintChain')
}

/** The current term is empty or still a key prefix — the only time keys help. */
const suggestions = computed(() => {
  if (!focused.value) return []
  const text = draft.value
  const negated = text.startsWith('-')
  const prefix = (negated ? text.slice(1) : text).toLowerCase()
  if (prefix.includes(':') || prefix.includes('"')) return []
  return QUALIFIER_KEYS.filter((k) => k.startsWith(prefix)).map((key) => ({
    key,
    hint: hintFor(key)
  }))
})

watch(draft, (text) => {
  suggestIndex.value = text === '' ? -1 : 0
})

function completeKey(key: QualifierKey): void {
  const negated = draft.value.startsWith('-')
  store.setFilterDraft(`${negated ? '-' : ''}${key}:`)
  suggestIndex.value = -1
  void nextTick(focus)
}

function onKeydown(e: KeyboardEvent): void {
  const list = suggestions.value
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    if (list.length === 0) return
    e.preventDefault()
    const step = e.key === 'ArrowDown' ? 1 : -1
    suggestIndex.value = (suggestIndex.value + step + list.length) % list.length
  } else if (e.key === 'Enter' || e.key === 'Tab') {
    const pick = list[suggestIndex.value]
    if (pick) {
      e.preventDefault()
      completeKey(pick.key)
    } else if (e.key === 'Enter') {
      e.preventDefault()
      commitDraft()
    }
  } else if (e.key === ' ' && !openQuotes(draft.value)) {
    if (draft.value.trim() === '') return
    e.preventDefault()
    commitDraft()
  } else if (e.key === 'Backspace' && draft.value === '' && chips.value.length > 0) {
    // Step back into the last chip to edit it, the way a token field does.
    e.preventDefault()
    const last = chips.value[chips.value.length - 1]
    store.setFilterQuery(
      chips.value
        .slice(0, -1)
        .map((term) => term.raw)
        .join(' ')
    )
    store.setFilterDraft(last.raw)
  }
}

/** First Esc leaves the field (the canvas keeps focus); the canvas's Esc clears. */
function onEscape(): void {
  openMenu.value = null
  input.value?.blur()
  ;(root.value?.closest('.pr-stack-canvas') as HTMLElement | null)?.focus()
}

function onBlur(): void {
  focused.value = false
  commitDraft()
}

// ── Facets ─────────────────────────────────────────────────────────────────

interface FacetOption {
  key: QualifierKey
  value: string
  label: string
  count: number
}
interface FacetGroup {
  title: string | null
  options: FacetOption[]
}

function optionsFor(
  key: QualifierKey,
  values: readonly string[],
  label: (v: string) => string
): FacetOption[] {
  const counts = facetCounts(nodes.value, key, values)
  return values.map((value) => ({ key, value, label: label(value), count: counts[value] ?? 0 }))
}

/** Distinct values with their first-seen casing, most-used first. */
function distinct(pick: (n: (typeof nodes.value)[number]) => string[]): string[] {
  const seen = new Map<string, { name: string; n: number }>()
  for (const node of nodes.value) {
    for (const name of new Set(pick(node))) {
      const k = name.toLowerCase()
      const hit = seen.get(k)
      if (hit) hit.n += 1
      else seen.set(k, { name, n: 1 })
    }
  }
  return [...seen.values()]
    .sort((a, b) => b.n - a.n || a.name.localeCompare(b.name))
    .map((v) => v.name)
}

const facetGroups = computed<Record<FacetId, FacetGroup[]>>(() => ({
  author: [
    {
      title: null,
      options: optionsFor(
        'author',
        distinct((n) => [n.pr.author].filter(Boolean)),
        (v) => v
      )
    }
  ],
  review: [
    {
      title: t('prStack.filter.reviewGroup'),
      options: optionsFor('review', QUALIFIER_VALUES.review ?? [], (v) => t(`prStack.filter.${v}`))
    },
    {
      title: t('prStack.filter.threadsGroup'),
      options: optionsFor('threads', ['unresolved'], (v) => t(`prStack.filter.${v}`))
    }
  ],
  checks: [
    {
      title: null,
      options: optionsFor('ci', QUALIFIER_VALUES.ci ?? [], (v) => t(`prStack.filter.${v}`))
    }
  ],
  labels: [
    {
      title: null,
      options: optionsFor(
        'label',
        distinct((n) => n.pr.labels),
        (v) => v
      )
    }
  ]
}))

const FACET_KEYS: Record<FacetId, QualifierKey[]> = {
  author: ['author'],
  review: ['review', 'threads'],
  checks: ['ci'],
  labels: ['label']
}
const FACETS: FacetId[] = ['author', 'review', 'checks', 'labels']

const fullQuery = computed(() => store.filterQuery)
const facetBadge = (id: FacetId): number => tokenCount(fullQuery.value, FACET_KEYS[id])

function toggleMenu(id: FacetId): void {
  openMenu.value = openMenu.value === id ? null : id
}

function toggleOption(option: FacetOption): void {
  // Fold a half-typed term into the chips first, so the checkbox rewrites the
  // query without swallowing what the operator was in the middle of typing.
  commitDraft()
  store.setFilterQuery(toggleToken(store.filter.query, option.key, option.value))
}
const checked = (option: FacetOption): boolean =>
  hasToken(fullQuery.value, option.key, option.value)

// Click-away and Esc close an open menu.
function onDocPointerDown(e: PointerEvent): void {
  if (openMenu.value && root.value && !root.value.contains(e.target as Node)) openMenu.value = null
}
function onDocKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape' && openMenu.value) {
    openMenu.value = null
    e.stopPropagation()
  }
}
onMounted(() => {
  document.addEventListener('pointerdown', onDocPointerDown, true)
  document.addEventListener('keydown', onDocKeydown, true)
})
onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', onDocPointerDown, true)
  document.removeEventListener('keydown', onDocKeydown, true)
})

const MODES = ['dim', 'hide'] as const
</script>

<template>
  <div
    ref="root"
    data-dsqa="pr-stack-filterbar"
    class="pointer-events-auto relative inline-flex min-w-0 max-w-full items-center gap-0.5 rounded border border-border bg-surface p-1 shadow-pop"
    @pointerdown.stop
  >
    <!-- Query field: complete terms are chips, the term being typed is the input. -->
    <div class="relative w-[260px] min-w-[120px] shrink">
      <label
        class="flex h-[26px] w-full cursor-text items-center gap-1.5 overflow-hidden rounded-sm px-2 text-text-4"
        :class="focused ? 'bg-bg ring-1 ring-inset ring-accent-line' : ''"
      >
        <Search :size="13" class="shrink-0" />
        <!-- Chips and the input scroll together, pinned to the newest term, so a
             long query never pushes the caret out of sight. -->
        <div
          ref="tokens"
          class="flex h-full min-w-0 flex-1 items-center gap-1.5 overflow-x-auto [scrollbar-width:none]"
        >
          <span
            v-for="(term, i) in chips"
            :key="`${i}:${term.raw}`"
            class="inline-flex h-[18px] shrink-0 items-center rounded-[3px] border px-1.5 font-mono text-[10.5px] text-text"
            :class="
              term.status === 'unknown'
                ? 'border-warning-line bg-warning-soft'
                : 'border-accent-line bg-accent-soft'
            "
            :title="term.status === 'unknown' ? t('prStack.filter.unknownTerm') : undefined"
          >
            <b
              v-if="chipKey(term)"
              class="font-medium"
              :class="term.status === 'unknown' ? 'text-warning' : 'text-accent'"
              >{{ chipKey(term) }}</b
            >{{ chipValue(term) }}
          </span>
          <input
            ref="input"
            type="text"
            spellcheck="false"
            autocomplete="off"
            class="h-full w-0 min-w-[24px] flex-1 bg-transparent text-[11px] text-text outline-none placeholder:text-text-4"
            :value="draft"
            :placeholder="chips.length === 0 ? t('prStack.filter.placeholder') : ''"
            :aria-label="t('prStack.filter.label')"
            @input="store.setFilterDraft(($event.target as HTMLInputElement).value)"
            @focus="focused = true"
            @blur="onBlur"
            @keydown="onKeydown"
            @keydown.esc.stop="onEscape"
          />
        </div>
        <span
          v-if="!store.filterActive && !focused"
          class="shrink-0 rounded-[3px] border border-border-2 px-1 font-mono text-[10px] leading-[14px] text-text-4"
          >/</span
        >
      </label>

      <!-- Qualifier suggestions. `mousedown.prevent` keeps the field focused. -->
      <div
        v-if="suggestions.length > 0"
        data-dsqa="pr-stack-filter-suggest"
        class="absolute left-0 top-[calc(100%+6px)] z-30 w-[300px] rounded border border-border bg-surface p-1 shadow-pop"
      >
        <h6
          class="px-2 pb-1 pt-1.5 text-[10px] font-semibold uppercase tracking-[0.06em] text-text-4"
        >
          {{ t('prStack.filter.qualifiers') }}
        </h6>
        <button
          v-for="(s, i) in suggestions"
          :key="s.key"
          type="button"
          class="flex h-[26px] w-full items-center gap-2 rounded-sm px-2 text-left text-[11.5px] text-text-2"
          :class="i === suggestIndex ? 'bg-surface-2 text-text' : 'hover:bg-surface-2'"
          @mousedown.prevent
          @click="completeKey(s.key)"
        >
          <code class="font-mono text-[11px] text-text">{{ s.key }}:</code>
          <span class="ml-auto truncate text-[10.5px] text-text-4">{{ s.hint }}</span>
        </button>
        <div
          class="mt-1 flex justify-between border-t border-border px-2 pb-[3px] pt-1.5 text-[10.5px] text-text-4"
        >
          <span>{{ t('prStack.filter.suggestExclude') }}</span>
          <span>{{ t('prStack.filter.suggestApply') }}</span>
        </div>
      </div>
    </div>

    <span class="mx-0.5 h-4 w-px shrink-0 bg-border" />

    <!-- Facets: a second view of the same query string. -->
    <div v-for="id in FACETS" :key="id" class="relative shrink-0">
      <button
        type="button"
        class="inline-flex h-[26px] items-center gap-1 rounded-sm px-[7px] text-[11px] font-medium transition-colors"
        :class="
          openMenu === id
            ? 'bg-surface-2 text-text'
            : facetBadge(id) > 0
              ? 'bg-accent-soft text-text'
              : 'text-text-3 hover:bg-surface-2 hover:text-text'
        "
        :aria-expanded="openMenu === id"
        aria-haspopup="menu"
        @click="toggleMenu(id)"
      >
        {{ t(`prStack.filter.${id}`) }}
        <span v-if="facetBadge(id) > 0" class="text-[10px] tabular-nums text-accent">{{
          facetBadge(id)
        }}</span>
        <ChevronDown :size="11" class="text-text-4" />
      </button>

      <div
        v-if="openMenu === id"
        data-dsqa="pr-stack-filter-menu"
        role="menu"
        class="absolute left-0 top-[calc(100%+6px)] z-30 w-[230px] rounded border border-border bg-surface p-1 shadow-pop"
      >
        <div class="scrollable max-h-[260px] overflow-y-auto">
          <template v-for="(group, gi) in facetGroups[id]" :key="gi">
            <h6
              v-if="group.title"
              class="px-2 pb-1 pt-1.5 text-[10px] font-semibold uppercase tracking-[0.06em] text-text-4"
            >
              {{ group.title }}
            </h6>
            <button
              v-for="option in group.options"
              :key="`${option.key}:${option.value}`"
              type="button"
              role="menuitemcheckbox"
              :aria-checked="checked(option)"
              class="flex h-[26px] w-full items-center gap-2 rounded-sm px-2 text-left text-[11.5px] text-text-2 transition-colors hover:bg-surface-2 hover:text-text"
              @click="toggleOption(option)"
            >
              <span
                class="grid h-[13px] w-[13px] flex-none place-items-center rounded-[3px] border"
                :class="
                  checked(option)
                    ? 'border-accent bg-accent text-accent-ink'
                    : 'border-border-2 text-accent-ink'
                "
              >
                <Check v-if="checked(option)" :size="9" :stroke-width="3" />
              </span>
              <span class="truncate">{{ option.label }}</span>
              <span class="ml-auto text-[10.5px] tabular-nums text-text-4">{{ option.count }}</span>
            </button>
            <p v-if="group.options.length === 0" class="px-2 py-1.5 text-[11px] text-text-4">
              {{ t('prStack.filter.noOptions') }}
            </p>
          </template>
        </div>
      </div>
    </div>

    <!-- Only while a filter is active: result count, display mode, clear. -->
    <template v-if="store.filterActive">
      <span class="mx-0.5 h-4 w-px bg-border" />
      <span class="shrink-0 whitespace-nowrap px-1.5 text-[11px] tabular-nums text-text-2">
        {{ store.matchCount }}
        <span class="text-text-4">{{ t('prStack.filter.of', { total: store.totalCount }) }}</span>
      </span>
      <div
        class="inline-flex shrink-0 rounded-sm bg-bg p-0.5"
        role="radiogroup"
        :aria-label="t('prStack.filter.mode')"
      >
        <button
          v-for="mode in MODES"
          :key="mode"
          type="button"
          role="radio"
          :aria-checked="store.filter.mode === mode"
          :title="t(`prStack.filter.${mode}Hint`)"
          class="h-5 rounded-[3px] px-[7px] text-[10.5px] font-medium transition-colors"
          :class="
            store.filter.mode === mode ? 'bg-surface-2 text-text' : 'text-text-3 hover:text-text'
          "
          @click="store.setFilterMode(mode)"
        >
          {{ t(`prStack.filter.${mode}`) }}
        </button>
      </div>
      <button
        type="button"
        class="grid h-[26px] w-[26px] shrink-0 place-items-center rounded-sm text-text-3 transition-colors hover:bg-surface-2 hover:text-text"
        :title="t('prStack.filter.clear')"
        :aria-label="t('prStack.filter.clear')"
        @click="store.clearFilter()"
      >
        <X :size="13" />
      </button>
    </template>
  </div>
</template>
