<script setup lang="ts">
/**
 * Links shelf popover content (design.md §6 — "Links pill + popover").
 * Read-only list of the http(s) links the active session's transcript holds — or, with the Folder
 * scope, of every session in the folder — newest first. Each row offers Open / Copy / Reference on
 * hover. Labels are derived from the URL alone in main (no network). Rendered inside the positioned
 * popover container in `StatusFooter.vue`, like `FooterImagePopover`.
 */
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  CircleDot,
  Copy,
  ExternalLink,
  Figma,
  FileText,
  GitPullRequest,
  Globe,
  Reply,
  SquareCheck
} from 'lucide-vue-next'
import type { Component } from 'vue'
import type { FolderLinkGroup, SessionLink } from '../../../preload'
import { useSessionsStore } from '../stores/sessions'
import { useUiStore } from '../stores/ui'
import { writeToSession } from '../lib/terminal-bus'
import { sessionTitle } from '../lib/session-label'
import {
  formatLinkTime,
  isRawLabel,
  linkHost,
  referenceLink,
  type LinksScope
} from '../composables/useSessionLinks'

const props = defineProps<{
  scope: LinksScope
  /** The active session's links (Session scope). */
  entries: SessionLink[]
  /** The folder's links grouped by session (Folder scope); `null` while the first read is in flight. */
  groups: FolderLinkGroup[] | null
  folderAlias: string
  /** Links of the active session / of the whole folder — the header meta. */
  count: number
  folderCount: number
  /** The active session's uuid, to name its own group "This session". */
  uuid: string
  /** Reference needs a live PTY; false → the action is disabled and says why. */
  canReference: boolean
}>()

const emit = defineEmits<{
  'update:scope': [LinksScope]
  /** A link landed in the composer — the footer closes the popover. */
  referenced: []
}>()

const { t } = useI18n()
const sessions = useSessionsStore()
const ui = useUiStore()

const KIND_ICON: Record<SessionLink['kind'], Component> = {
  pr: GitPullRequest,
  issue: CircleDot,
  task: SquareCheck,
  figma: Figma,
  doc: FileText,
  web: Globe
}

/** The proper-noun half of a row's detail line (`GitHub PR`, `ClickUp`, `Figma`, `Google Docs`, `Web`). */
function kindName(link: SessionLink): string {
  if (link.kind === 'web') return t('links.kindWeb')
  if (link.kind === 'figma') return 'Figma'
  return link.detail
}

/** The mono half: the host for PR / issue / task rows, the node id for a Figma frame. */
function kindMono(link: SessionLink): string {
  if (link.kind === 'pr' || link.kind === 'issue' || link.kind === 'task') return linkHost(link.url)
  if (link.kind === 'figma') return link.detail
  return ''
}

const groupsList = computed(() => props.groups ?? [])
const folderSessionCount = computed(() => groupsList.value.length)

const metaText = computed(() =>
  props.scope === 'folder'
    ? t(
        'links.metaFolder',
        { folder: props.folderAlias, count: props.folderCount, sessions: folderSessionCount.value },
        folderSessionCount.value
      )
    : t('links.metaSession', { folder: props.folderAlias, count: props.count })
)

/** The session's own name everywhere else (`sessionTitle`), main's transcript-derived title as fallback. */
function groupLabel(g: FolderLinkGroup): string {
  if (g.sessionId === props.uuid) return t('links.thisSession')
  const known = sessions.allSessions.find((s) => s.sessionId === g.sessionId)
  return (known && sessionTitle(known, sessions.allSessions, t)) || g.title
}

/** One flat list: in Folder scope a group header precedes each session's rows. */
type Item =
  | { kind: 'group'; key: string; label: string; count: number }
  | { kind: 'link'; key: string; link: SessionLink }
const items = computed<Item[]>(() => {
  if (props.scope === 'session') {
    return props.entries.map((link): Item => ({ kind: 'link', key: link.url, link }))
  }
  return groupsList.value.flatMap((g): Item[] => [
    { kind: 'group', key: `g:${g.sessionId}`, label: groupLabel(g), count: g.count },
    ...g.links.map((link): Item => ({ kind: 'link', key: `${g.sessionId}|${link.url}`, link }))
  ])
})

function open(l: SessionLink): void {
  // Main re-validates the scheme (http/https/mailto allowlist) before `shell.openExternal`.
  void window.api.shellOpenExternal(l.url)
}
async function copy(l: SessionLink): Promise<void> {
  try {
    await navigator.clipboard.writeText(l.url)
    ui.pushToast({ kind: 'success', title: t('links.copied'), persist: false })
  } catch {
    // Clipboard denied — nothing to confirm.
  }
}
function reference(l: SessionLink): void {
  const done = referenceLink(
    { sessionId: sessions.selectedId, isLive: sessions.isSessionLive, write: writeToSession },
    l.url
  )
  if (done) emit('referenced')
}

const ACTION_BTN =
  'rounded-sm p-1 text-text-2 transition-colors hover:bg-surface-2 hover:text-text focus-visible:bg-surface-2 focus-visible:text-text disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-text-2'
</script>

<template>
  <div class="flex flex-col gap-2 p-2" data-testid="footer-links-popover">
    <!-- Header: title + folder alias · count, and the Session · Folder toggle -->
    <div class="flex items-center justify-between gap-2 px-0.5">
      <div class="flex min-w-0 items-baseline gap-1.5">
        <span class="text-[11px] font-medium text-text">{{ t('links.title') }}</span>
        <span class="truncate text-[11px] text-text-3" data-testid="footer-links-meta">{{
          metaText
        }}</span>
      </div>
      <div
        class="inline-flex shrink-0 gap-px rounded-sm border border-border p-px text-[11px]"
        role="group"
        :aria-label="t('links.scopeAria')"
      >
        <button
          type="button"
          class="rounded-xs px-2 py-px transition-colors"
          :class="
            scope === 'session' ? 'bg-accent-soft text-accent' : 'text-text-3 hover:text-text'
          "
          :aria-pressed="scope === 'session'"
          data-testid="footer-links-scope-session"
          @click="emit('update:scope', 'session')"
        >
          {{ t('links.scopeSession') }}
        </button>
        <button
          type="button"
          class="rounded-xs px-2 py-px transition-colors"
          :class="scope === 'folder' ? 'bg-accent-soft text-accent' : 'text-text-3 hover:text-text'"
          :aria-pressed="scope === 'folder'"
          data-testid="footer-links-scope-folder"
          @click="emit('update:scope', 'folder')"
        >
          {{ t('links.scopeFolder') }}
        </button>
      </div>
    </div>

    <!-- The list — one row per link, newest first. Folder scope groups rows under each session. -->
    <div class="scrollable -mx-0.5 flex max-h-[300px] flex-col overflow-y-auto" role="list">
      <div
        v-if="scope === 'folder' && groups === null"
        class="anim-shimmer-dot mx-1.5 my-1 h-8 rounded-sm bg-surface"
      />
      <p
        v-else-if="items.length === 0"
        class="px-1.5 py-2 text-[11px] text-text-4"
        data-testid="footer-links-empty"
      >
        {{ scope === 'folder' ? t('links.emptyFolder') : t('links.emptySession') }}
      </p>
      <template v-for="item in items" :key="item.key">
        <div
          v-if="item.kind === 'group'"
          class="flex items-baseline justify-between gap-2 px-1.5 pb-0.5 pt-1.5 text-[11px] text-text-3"
          data-testid="footer-links-group"
        >
          <span class="truncate">{{ item.label }}</span>
          <span class="shrink-0 font-mono text-text-4">{{ item.count }}</span>
        </div>

        <!-- Link row: kind icon · label · time (→ actions on hover) / detail line · excerpt · reason -->
        <div
          v-else
          class="group grid grid-cols-[16px_1fr_auto] items-center gap-x-2 gap-y-0.5 rounded-sm p-1.5 hover:bg-surface focus-within:bg-surface"
          role="listitem"
          data-testid="footer-links-row"
        >
          <span class="flex text-text-3">
            <component :is="KIND_ICON[item.link.kind]" :size="13" :stroke-width="1.6" />
          </span>
          <span
            class="truncate"
            :class="
              isRawLabel(item.link.kind)
                ? 'font-mono text-[11px] text-text-2'
                : 'text-[12px] text-text'
            "
            :title="item.link.url"
            >{{ item.link.label }}</span
          >

          <!-- Time gives way to the actions on hover / keyboard focus -->
          <span
            class="col-start-3 row-span-2 row-start-1 self-start pt-px text-[11px] tabular-nums text-text-4 group-focus-within:hidden group-hover:hidden"
            >{{ formatLinkTime(item.link.at) }}</span
          >
          <span
            class="col-start-3 row-span-2 row-start-1 hidden items-center gap-0.5 self-center group-focus-within:flex group-hover:flex"
          >
            <button
              type="button"
              :class="ACTION_BTN"
              :aria-label="t('links.openAria', { label: item.link.label })"
              :title="t('links.open')"
              data-testid="footer-links-open"
              @click="open(item.link)"
            >
              <ExternalLink :size="13" :stroke-width="1.6" />
            </button>
            <button
              type="button"
              :class="ACTION_BTN"
              :aria-label="t('links.copyAria', { label: item.link.label })"
              :title="t('links.copy')"
              data-testid="footer-links-copy"
              @click="copy(item.link)"
            >
              <Copy :size="13" :stroke-width="1.6" />
            </button>
            <button
              type="button"
              :class="ACTION_BTN"
              :disabled="!canReference"
              :aria-label="t('links.referenceAria', { label: item.link.label })"
              :title="canReference ? t('links.reference') : t('links.referenceDisabled')"
              data-testid="footer-links-reference"
              @click="reference(item.link)"
            >
              <Reply :size="13" :stroke-width="1.6" />
            </button>
          </span>

          <!-- Detail line: kind name · host / node (mono) · who said it -->
          <span
            class="col-start-2 flex min-w-0 items-center gap-1.5 whitespace-nowrap text-[11px] text-text-3"
          >
            <span class="shrink-0">{{ kindName(item.link) }}</span>
            <span v-if="kindMono(item.link)" class="truncate font-mono text-text-4">{{
              kindMono(item.link)
            }}</span>
            <span
              class="shrink-0 rounded-xs border px-1"
              :class="
                item.link.source === 'agent'
                  ? 'border-accent-line text-accent'
                  : 'border-border text-text-3'
              "
              >{{
                item.link.source === 'agent' ? t('links.sourceAgent') : t('links.sourceUser')
              }}</span
            >
          </span>

          <!-- The surrounding sentence, only while the row is hovered / focused -->
          <span
            v-if="item.link.excerpt"
            class="col-start-2 mt-0.5 hidden truncate border-l-2 border-border-2 py-px pl-1.5 text-[11px] text-text-3 group-focus-within:block group-hover:block"
            data-testid="footer-links-excerpt"
            >“{{ item.link.excerpt }}”</span
          >
          <span
            v-if="!canReference"
            class="col-span-2 col-start-2 mt-0.5 hidden text-[11px] text-warning group-focus-within:block group-hover:block"
            data-testid="footer-links-reference-reason"
            >{{ t('links.referenceDisabled') }}</span
          >
        </div>
      </template>
    </div>

    <!-- Where the list is read from — full sentence, with period (§8) -->
    <p class="px-0.5 text-[11px] text-text-4">
      {{ scope === 'folder' ? t('links.noteFolder') : t('links.noteSession') }}
    </p>
  </div>
</template>
