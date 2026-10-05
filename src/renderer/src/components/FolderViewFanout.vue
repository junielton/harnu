<script setup lang="ts">
import { nextTick, ref, watch } from 'vue'
import { GitBranch, ArrowRight, ChevronDown, ChevronRight } from 'lucide-vue-next'
import { useI18n } from 'vue-i18n'
import { useSessionsStore } from '../stores/sessions'
import { useUiStore } from '../stores/ui'
import ScopeTag from './ui/ScopeTag.vue'
import { scopeOf, type FanoutRow, type PillTone } from './folder-view-format'

/**
 * T286 — `Worktrees in flight`: the one block only a main checkout can show.
 * Every worktree of the repo as a row — branch, the card that branch is
 * executing, its sessions, its git drift, its PR — so "what is in flight and
 * what needs me?" is answered without opening anything.
 *
 * Purely presentational. `FolderView` owns the four reads that feed it (the
 * store's folder model, `folders:gitStatus` per sibling, `roadmap:peek` per
 * branch, one `pr-stack:load` for the repo) behind its sequence guard; this
 * component only knows how to print a `FanoutRow`.
 *
 * **Every cell degrades to nothing.** A git probe that failed, a branch no card
 * owns, a repo with no `gh` — each leaves its own cell empty and never the row,
 * never an error state, and never a spinner (AC-6). A worktree whose PR could
 * not be read is still a worktree in flight.
 *
 * The section renders **only** when the repo has more than one worktree: a lone
 * checkout fans out to nothing, and the T212 rule holds — a section with nothing
 * in it renders nothing at all (AC-10). See design.md §6 "Folder View".
 *
 * BUG-118 — on a 102-worktree repo the table ran for screens and a row click
 * navigated away with no path back. Two changes: the body is capped at
 * `--fv-fanout-max-h` and scrolls under a sticky header, and a row click now
 * expands a detail row **in place** instead of calling `selectFolder`. Leaving
 * is still possible, but only through the detail row's explicit button.
 */

const props = defineProps<{ rows: FanoutRow[]; repoPath: string; repoLabel: string }>()

const sessions = useSessionsStore()
const ui = useUiStore()
const { t } = useI18n()

/**
 * design.md §6 — the four pill tones, token-backed. `bg-warning/10` is the app's
 * existing amber-pill idiom (`PrStackCard`); there is no `--color-warning-soft`
 * token and inventing one for a single pill is not worth a theme-wide addition.
 */
const PILL_CLASS: Record<PillTone, string> = {
  ok: 'bg-green-soft text-green',
  warn: 'bg-warning/10 text-warning',
  bad: 'bg-red-soft text-red',
  mute: 'bg-surface-2 text-text-3'
}

/**
 * The one expanded row, held by **path** — never the row object and never its
 * index. `FolderView` rebuilds `rows` from scratch through `fanoutRows` every
 * time one of its three async reads lands (git per sibling, `roadmap:peek` per
 * branch, one `pr-stack:load` for the repo), so an expansion keyed on object
 * identity would silently collapse under the operator each time a probe came
 * back. A path is stable across all of them.
 *
 * A single ref is also what makes "at most one open at a time" structural rather
 * than something a handler has to remember to enforce.
 */
const expandedPath = ref<string | null>(null)

/** Switching repo is a different table; whatever was open in the old one is gone. */
watch(
  () => props.repoPath,
  () => {
    expandedPath.value = null
  }
)

/**
 * The scroll porthole itself. The cap leaves ~354px of body under the 26px
 * sticky header, and an open detail row is roughly half of that — so expanding a
 * row sitting in the lower half renders the panel below the fold, and the only
 * feedback the operator gets is the chevron flipping. Bringing it into view is
 * the same idiom `CleanupView.vue` uses after a group expands.
 */
const scroller = ref<HTMLElement | null>(null)

function toggle(row: FanoutRow): void {
  const opening = expandedPath.value !== row.path
  expandedPath.value = opening ? row.path : null
  if (!opening) return
  void nextTick(() => {
    const el = scroller.value?.querySelector('[data-test="folder-view-fanout-detail"]')
    // `block: 'nearest'` — a panel that already fits must not move the table
    // under the operator's cursor. The optional call is for jsdom, which does
    // not implement `scrollIntoView`: the tests exercise this handler for real
    // rather than a stubbed one.
    if (el instanceof HTMLElement) el.scrollIntoView?.({ block: 'nearest' })
  })
}

function isExpanded(row: FanoutRow): boolean {
  return expandedPath.value === row.path
}

/**
 * The block's ONLY caller of `selectFolder`, reached from the detail row's
 * button. Navigating away from a table of 102 rows must be a decision, not the
 * side effect of clicking a row to read it.
 */
function openWorktree(row: FanoutRow): void {
  sessions.selectFolder(row.path)
}

/** The chevron's label — the branch is in it, so it is unique per row. */
function toggleLabel(row: FanoutRow): string {
  const name = row.branch || row.label
  return `${isExpanded(row) ? t('folderView.fanout.collapse') : t('folderView.fanout.expand')}: ${name}`
}

function onPrStack(): void {
  ui.openPrStack(props.repoPath, props.repoLabel)
}
</script>

<template>
  <section data-test="folder-view-fanout">
    <div class="flex items-center justify-between" style="gap: 8px; margin-bottom: 8px">
      <span class="flex min-w-0 items-center" style="gap: 8px">
        <span class="eyebrow text-text-4">{{ $t('folderView.fanout.title') }}</span>
        <ScopeTag :scope="scopeOf('fanout')" />
      </span>
      <button
        class="flex shrink-0 cursor-pointer items-center text-text-4 transition hover:text-text-2"
        style="gap: 4px; font-size: 11px"
        data-test="folder-view-fanout-pr-stack"
        @click="onPrStack"
      >
        {{ $t('folderView.openPrStack') }}
        <ArrowRight :size="10" :stroke-width="1.8" />
      </button>
    </div>

    <!-- BUG-118 — the body is capped at `--fv-fanout-max-h` and scrolls inside
         itself, under a sticky header. ONE table inside the scroller, never a
         split header/body pair: `table-layout: fixed` shares its column widths
         between `thead` and `tbody`, and two tables would drift apart. -->
    <div ref="scroller" class="fanwrap scrollable" data-test="folder-view-fanout-scroll">
      <!-- `table-layout: fixed` and the column widths are part of the approved
           contract: without them a long branch name or a card title widens its
           column and the whole view scrolls sideways (the T285 AC-3 failure). -->
      <table class="fan" data-test="folder-view-fanout-table">
        <thead>
          <tr>
            <th class="br">{{ $t('folderView.fanout.colBranch') }}</th>
            <th>{{ $t('folderView.fanout.colCard') }}</th>
            <th class="n">{{ $t('folderView.fanout.colSessions') }}</th>
            <th class="n">{{ $t('folderView.fanout.colGit') }}</th>
            <th class="pr">{{ $t('folderView.fanout.colPr') }}</th>
          </tr>
        </thead>
        <tbody>
          <template v-for="row in rows" :key="row.path">
            <tr
              :class="[row.isSelf ? 'self' : undefined, isExpanded(row) ? 'open' : undefined]"
              data-test="folder-view-fanout-row"
              :data-self="row.isSelf ? 'true' : undefined"
              :data-expanded="isExpanded(row) ? 'true' : 'false'"
              @click="toggle(row)"
            >
              <td class="br">
                <span class="flex min-w-0 items-center" style="gap: 6px">
                  <!-- BUG-118 / AC-7 — `SystemMonitorRow`'s chevron, verbatim in
                   anatomy: a real `<button>` (so the row is keyboard-reachable
                   without a `tabindex`), `aria-expanded` for the state and an
                   `aria-label` naming which branch it opens. -->
                  <button
                    type="button"
                    class="flex shrink-0 cursor-pointer items-center justify-center text-text-4 transition hover:text-text-2"
                    style="width: 14px; height: 14px"
                    :aria-expanded="isExpanded(row)"
                    :aria-label="toggleLabel(row)"
                    data-test="folder-view-fanout-toggle"
                    @click.stop="toggle(row)"
                  >
                    <ChevronDown v-if="isExpanded(row)" :size="12" :stroke-width="2" />
                    <ChevronRight v-else :size="12" :stroke-width="2" />
                  </button>
                  <span
                    class="shrink-0 rounded-full"
                    :class="
                      row.needsInputCount > 0
                        ? 'anim-attention-dot bg-warning'
                        : row.liveCount > 0
                          ? 'anim-pulse-dot bg-green'
                          : 'bg-text-4'
                    "
                    style="width: 6px; height: 6px"
                  />
                  <GitBranch :size="12" :stroke-width="1.6" class="shrink-0 text-text-4" />
                  <span class="truncate font-mono" :title="row.branch || row.label">{{
                    row.branch || row.label
                  }}</span>
                </span>
              </td>

              <!-- AC-2: the card `executedIn` names, or an em-dash. Never a blank
               cell (which reads as "not loaded") and never a guess. -->
              <td class="cardcell">
                <template v-if="row.card">
                  <span class="id">{{ row.card.id }}</span>
                  <span>{{ row.card.title }}</span>
                </template>
                <span v-else class="dash" :title="$t('folderView.fanout.noCard')">—</span>
              </td>

              <td class="n tabular-nums">
                {{
                  row.liveCount > 0
                    ? $t('folderView.fanout.sessionsLive', {
                        n: row.sessionCount,
                        live: row.liveCount
                      })
                    : row.sessionCount
                }}
              </td>

              <!-- AC-4: nothing at all when the probe did not answer. -->
              <td class="n tabular-nums">
                <template v-if="row.ahead !== null || row.behind !== null">
                  <span v-if="row.ahead" :aria-label="$t('preview.folder.ahead', { n: row.ahead })"
                    >↑{{ row.ahead }}</span
                  >
                  <span
                    v-if="row.behind"
                    :aria-label="$t('preview.folder.behind', { n: row.behind })"
                    >↓{{ row.behind }}</span
                  >
                  <span v-if="!row.ahead && !row.behind">↑0</span>
                </template>
              </td>

              <td class="pr">
                <!-- The row you are standing in has no PR of its own to report: main
                 is the base every one of these merges into. Saying so is more
                 honest than an empty cell that reads as "not loaded". -->
                <ScopeTag v-if="row.isSelf" :scope="'folder'" />
                <a
                  v-else-if="row.pr"
                  class="pill"
                  :class="PILL_CLASS[row.pr.tone]"
                  :href="row.pr.url"
                  target="_blank"
                  rel="noreferrer"
                  data-test="folder-view-fanout-pr"
                  :data-tone="row.pr.tone"
                  @click.stop
                  >{{ $t(`folderView.fanout.prState.${row.pr.key}`, { n: row.pr.number }) }}</a
                >
              </td>
            </tr>

            <!-- BUG-118 / AC-7 — the detail row is a SIBLING `<tr>`, not a nested
             table: the fan-out's fixed column widths are shared by every row,
             and a table inside a cell would opt this content out of them. Vue 3
             renders multi-root fragments, so a `<template>` wrapping both rows
             is all the grouping this needs (`SystemMonitorRow.vue`, same
             reasoning, same shape). -->
            <tr v-if="isExpanded(row)" class="detail" data-test="folder-view-fanout-detail">
              <td colspan="5">
                <div class="dgrid">
                  <div class="dfield">
                    <span class="dk">{{ $t('folderView.fanout.detail.branch') }}</span>
                    <span class="dv font-mono">{{ row.branch || row.label }}</span>
                  </div>

                  <div class="dfield">
                    <span class="dk">{{ $t('folderView.fanout.detail.card') }}</span>
                    <span v-if="row.card" class="dv">
                      <span class="id">{{ row.card.id }}</span
                      >{{ row.card.title }}
                    </span>
                    <span v-else class="dv muted">{{ $t('folderView.fanout.noCard') }}</span>
                  </div>

                  <div class="dfield">
                    <span class="dk">{{ $t('folderView.fanout.detail.git') }}</span>
                    <!-- Same rule as the collapsed cell, spelled out instead of
                     glyphed: an unread probe SAYS it was unread. It never reads
                     as "up to date", which is what an empty value would imply
                     here where there is room for a sentence. -->
                    <span v-if="row.ahead === null && row.behind === null" class="dv muted">{{
                      $t('folderView.fanout.detail.gitUnavailable')
                    }}</span>
                    <span v-else-if="!row.ahead && !row.behind" class="dv muted">{{
                      $t('folderView.fanout.detail.gitClean')
                    }}</span>
                    <span v-else class="dv">
                      <template v-if="row.ahead">{{
                        $t('preview.folder.ahead', { n: row.ahead })
                      }}</template>
                      <template v-if="row.ahead && row.behind"> · </template>
                      <template v-if="row.behind">{{
                        $t('preview.folder.behind', { n: row.behind })
                      }}</template>
                    </span>
                  </div>

                  <div class="dfield">
                    <span class="dk">{{ $t('folderView.fanout.detail.pr') }}</span>
                    <a
                      v-if="row.pr"
                      class="dv link"
                      :href="row.pr.url"
                      target="_blank"
                      rel="noreferrer"
                      data-test="folder-view-fanout-detail-pr"
                      @click.stop
                      >{{ row.pr.title }}
                      <span class="num">{{
                        $t('folderView.fanout.detail.prNumber', { n: row.pr.number })
                      }}</span></a
                    >
                    <span v-else class="dv muted">{{ $t('folderView.fanout.detail.noPr') }}</span>
                  </div>

                  <div class="dfield wide">
                    <span class="dk">{{ $t('folderView.fanout.detail.path') }}</span>
                    <span class="dv font-mono muted">{{ row.path }}</span>
                  </div>
                </div>

                <!-- AC-8 — leaving the fan-out stays possible, and is now the only
                 thing that leaves it. The row you are standing in has nowhere
                 to go, so it says so instead of offering a no-op button. -->
                <div class="dact">
                  <button
                    v-if="!row.isSelf"
                    type="button"
                    class="openwt"
                    data-test="folder-view-fanout-open"
                    @click.stop="openWorktree(row)"
                  >
                    {{ $t('folderView.fanout.detail.open') }}
                    <ArrowRight :size="11" :stroke-width="1.8" />
                  </button>
                  <span v-else class="dv muted">{{ $t('folderView.fanout.detail.isSelf') }}</span>
                </div>
              </td>
            </tr>
          </template>
        </tbody>
      </table>
    </div>
  </section>
</template>

<style scoped>
/*
 * design.md §6 "Folder View → the fan-out". Copied from the approved spec's
 * `.fan` rules; every value is a token or a spec'd width.
 *
 * `table-layout: fixed` is load-bearing, not a detail: it is what makes the
 * branch and card cells truncate instead of pushing the table past the pane.
 */
/*
 * BUG-118 — the cap. `max-height`, never `height`: a repo with four worktrees
 * draws a four-row table at its natural height with no scrollbar and no
 * reserved gutter, and only a repo that overflows the cap ever scrolls. The
 * value is a token (design.md §9), not a literal, because the rail lists cap
 * themselves against the same decision.
 */
.fanwrap {
  max-height: var(--fv-fanout-max-h);
  overflow-y: auto;
}

.fan {
  width: 100%;
  border-collapse: collapse;
  font-size: 12.5px;
  table-layout: fixed;
}

.fan th {
  text-align: left;
  font-size: 10.5px;
  line-height: 14px;
  font-weight: 500;
  text-transform: uppercase;
  letter-spacing: 0.07em;
  color: var(--color-text-4);
  padding: 6px 10px;
  white-space: nowrap;
  /*
   * The header survives the body scrolling under it. Its rule is an inset
   * box-shadow rather than a `border-bottom`: under `border-collapse: collapse`
   * a collapsed border is painted by the TABLE, not by the sticky cell, so a
   * real border scrolls away with the first row and leaves the header floating.
   */
  position: sticky;
  top: 0;
  z-index: 1;
  background: var(--color-bg);
  box-shadow: inset 0 -1px 0 var(--color-border);
}

.fan td {
  padding: 8px 10px;
  color: var(--color-text-2);
  border-bottom: 1px solid var(--color-border);
  vertical-align: middle;
}

.fan tbody tr:last-child td {
  border-bottom: 0;
}

.fan tbody tr:not(.detail) {
  cursor: pointer;
}

.fan tbody tr:not(.detail):hover td {
  background: var(--color-surface-2);
  color: var(--color-text);
}

/* The folder you are standing in, held apart from the ones you dispatched. */
.fan tr.self td {
  background: var(--color-accent-soft);
}

/* The open row and its detail read as one block, so the row keeps the hover
   tint while its detail is showing rather than reverting the moment the pointer
   moves down into the expansion. */
.fan tbody tr.open:not(.self) td {
  background: var(--color-surface-2);
}

/*
 * BUG-118 — the detail row (design.md §6 "A row expands in place"). A sibling
 * `<tr>` spanning all five columns, so it is free of the fixed column widths the
 * collapsed row must obey — which is the whole point: this is where the fields
 * the row had to truncate get printed in full.
 */
.fan tr.detail td {
  padding: 10px 10px 12px 30px;
  background: var(--color-surface);
}

.dgrid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px 24px;
}

.dfield {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

/* Full path, full title — the fields that most need the room get the full row. */
.dfield.wide {
  grid-column: 1 / -1;
}

.dk {
  font-size: 10px;
  line-height: 14px;
  font-weight: 500;
  text-transform: uppercase;
  letter-spacing: 0.07em;
  color: var(--color-text-4);
}

/* `break-word`, not `truncate`: the collapsed row already truncates, and a
   detail row that truncated too would answer nothing. */
.dv {
  font-size: 12px;
  line-height: 17px;
  color: var(--color-text-2);
  overflow-wrap: anywhere;
}

.dv.muted {
  color: var(--color-text-4);
}

.dv .id {
  font-family:
    'JetBrainsMono Nerd Font Mono', 'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 10.5px;
  color: var(--color-text-4);
  margin-right: 6px;
}

.dv.link {
  color: var(--color-accent);
  text-decoration: none;
}

.dv.link:hover {
  text-decoration: underline;
}

.dv .num {
  color: var(--color-text-4);
  font-size: 11px;
}

.dact {
  margin-top: 10px;
}

.openwt {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  cursor: pointer;
  font-size: 11.5px;
  line-height: 16px;
  padding: 5px 10px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--color-accent-line);
  background: var(--color-accent-soft);
  color: var(--color-accent);
  transition: background var(--dur) var(--ease);
}

.openwt:hover {
  background: var(--color-surface-2);
}

.fan td.br,
.fan th.br {
  width: 250px;
}

.fan td.cardcell {
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.fan td.cardcell .id {
  font-family:
    'JetBrainsMono Nerd Font Mono', 'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 10.5px;
  color: var(--color-text-4);
  margin-right: 6px;
}

.fan td.n,
.fan th.n {
  width: 92px;
  font-size: 11px;
  color: var(--color-text-3);
  white-space: nowrap;
}

.fan td.n span + span {
  margin-left: 6px;
}

.fan td.pr,
.fan th.pr {
  width: 150px;
}

.fan .dash {
  color: var(--color-text-4);
}

.pill {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 10.5px;
  line-height: 16px;
  border-radius: 999px;
  padding: 1px 8px;
  white-space: nowrap;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
}

/*
 * Same container query as `FolderView`'s grid, and for the same reason: this is
 * a pane, not a page. In a narrow pane the branch column stops being fixed and
 * the two numeric columns fold away — a branch name plus its card and PR is the
 * irreducible row.
 */
@container folder-view (max-width: 760px) {
  .dgrid {
    grid-template-columns: minmax(0, 1fr);
  }

  .fan td.br,
  .fan th.br {
    width: auto;
  }

  .fan td.n,
  .fan th.n {
    display: none;
  }
}
</style>
