<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import type { FolderGitStatus, PrStackSnapshot, RoadmapPeekCard } from '../../../preload'
import type { Folder, Session } from '../stores/sessions'
import { useSessionsStore } from '../stores/sessions'
import { sessionTitle } from '../lib/session-label'
import { relativeTime } from '../composables/useRelativeTime'
import ScopeTag from './ui/ScopeTag.vue'
import { featureRail, scopeOf, type RailPr, type RailStep } from './folder-view-format'

/**
 * T287 — the worktree profile's hero: **the card this branch owns**, and how far
 * that card has travelled. A worktree exists to land one card and then die, so
 * its N sessions (implement, ship, review, rebase) are all steps toward the same
 * merge — the hero is the card, not the session list.
 *
 * The ownership read is T284's `roadmap:peek` with a `branch` argument, which
 * answers with the card whose `executedIn` names it. It is asked HERE rather
 * than in `FolderView` on purpose: the parent's peek is the untargeted
 * two-field one that feeds the roadmap rail card, and threading a branch through
 * it would couple two blocks that degrade independently.
 *
 * **Absent, not empty (AC-4).** A worktree whose branch owns no card renders
 * nothing at all — the profile falls back to the sections already there. That is
 * the common case for a hand-cut worktree and it must not look broken, so there
 * is deliberately no placeholder, no "no card yet" box and no skeleton.
 *
 * design.md §6 "Folder View → Worktree profile"; spec.html `#d-worktree`
 * `.owncard`.
 */

const props = defineProps<{ folder: Folder }>()

const sessions = useSessionsStore()
const { t } = useI18n()

const branch = computed(() => props.folder.gitBranch ?? '')

// --- Reads. Every one degrades on its own; none of them can throw upward. ----
const owned = ref<RoadmapPeekCard | null>(null)
const gitStatus = ref<FolderGitStatus | null>(null)
/**
 * `null` = read it, no commits. `undefined` = could not read it (AC-5).
 *
 * In practice `undefined` only survives an IPC-level rejection: `roadmap:
 * mergeEvidence` never throws and answers `ahead: 0` for a missing repo, a
 * missing upstream and a timed-out probe alike, so an unreadable count arrives
 * here as a genuine-looking `0`. Both render the same "not yet" step, so the
 * rail stays honest — but `step.known` is optimistic for the commits step and
 * must not be read as proof the count was actually observed.
 */
const commits = ref<number | null | undefined>(undefined)
const latestSha = ref<string | null>(null)
/** `null` = read it, no PR. `undefined` = could not read it (AC-5). */
const pr = ref<PrForBranch | null | undefined>(undefined)

interface PrForBranch extends RailPr {
  /** `MERGED` / `CLOSED` / `OPEN`, plus draft and the review decision. */
  draft: boolean
  closed: boolean
  reviewDecision: string | null
}

let seq = 0

/**
 * The PR read, deliberately the LAST one and deliberately conditional.
 *
 * `pr-stack:load` shells out to `gh pr list` — a network round-trip, and the one
 * expensive thing on this view. It only fires once a card has actually claimed
 * this branch, so a hand-cut worktree (the common AC-4 case, which renders no
 * hero at all) costs no `gh` call whatsoever.
 *
 * Returns `null` for "could not read it": a missing `gh`, an unauthenticated
 * one, a rate limit or a non-GitHub remote all arrive as `ghAvailable: false`,
 * and none of them is the same fact as "this branch has no PR".
 *
 * **Known gap — the snapshot only carries OPEN pull requests.** `buildGraph` in
 * `pr-stack-core.ts` filters `state === 'OPEN'` before it builds `graph.nodes`,
 * and the snapshot exposes no other list, so a MERGED or CLOSED PR simply is
 * not in there. The `merged` / `closed` mapping below is therefore latent: it
 * is the correct reading of the field IF such an entry ever arrives, and today
 * one never does. The practical effect is that a branch whose PR has landed
 * falls back to "no PR" and the rail's `merge` step stays "not yet" — an
 * UNDER-report, which is the side of the AC-5 line this block is required to
 * fall on. Closing it needs a merged-PR read on the main-process side, which is
 * `pr-stack*.ts` and single-owned by T280.
 */
async function loadPrSnapshot(path: string): Promise<PrStackSnapshot | null> {
  if (typeof window.api?.prStackLoad !== 'function') return null
  try {
    const next = await window.api.prStackLoad(path)
    return next?.ghAvailable ? next : null
  } catch {
    return null
  }
}

watch(
  () => [props.folder.path, branch.value] as const,
  ([path, br]) => {
    const mine = ++seq
    owned.value = null
    gitStatus.value = null
    commits.value = undefined
    latestSha.value = null
    pr.value = undefined
    if (!path || !br) return

    if (typeof window.api?.roadmapPeek === 'function') {
      window.api
        .roadmapPeek(path, br)
        .then((p) => {
          if (mine !== seq) return
          owned.value = p?.owned ?? null
          // No card owns this branch → no hero, and no reason to call `gh`.
          if (!owned.value) return
          return loadPrSnapshot(path).then((snapshot) => {
            if (mine !== seq) return
            if (!snapshot) return // stays `undefined` — unread, not "no PR"
            const node = snapshot.graph.nodes.find((n) => n.pr.branch === br)
            pr.value = node
              ? {
                  number: node.pr.number,
                  merged: node.pr.state === 'MERGED',
                  closed: node.pr.state === 'CLOSED',
                  draft: node.pr.isDraft,
                  reviewDecision: node.pr.reviewDecision
                }
              : null
          })
        })
        .catch(() => {
          /* degrade — no hero at all */
        })
    }

    if (typeof window.api?.foldersGitStatus === 'function') {
      window.api
        .foldersGitStatus(path)
        .then((s) => {
          if (mine === seq) gitStatus.value = s
        })
        .catch(() => {
          /* degrade — the meta line drops its git half */
        })
    }

    // T80's read-only merge-evidence probe: commits this branch carries beyond
    // `origin/main` plus up to five short SHAs, newest first. An EXISTING call —
    // the rail adds no main-process surface of its own (AC-3).
    if (typeof window.api?.roadmapMergeEvidence === 'function') {
      window.api
        .roadmapMergeEvidence({ folder: path, branch: br })
        .then((e) => {
          if (mine !== seq) return
          commits.value = e?.ahead ?? 0
          latestSha.value = e?.refs?.[0] ?? null
        })
        .catch(() => {
          /* leave `undefined` — unreadable, never zero */
        })
    }
  },
  { immediate: true }
)

// --- Shaping -----------------------------------------------------------------

/** The whole block hangs on this: no owned card, no hero (AC-4). */
const hasCard = computed(() => owned.value !== null)

const rail = computed<RailStep[]>(() =>
  featureRail({
    dispatched: hasCard.value,
    commits: commits.value ?? null,
    pr: pr.value
  })
)

/** The session the card is bound to, when it is one of this folder's. */
const ownerSession = computed<Session | null>(() => {
  const id = owned.value?.session
  if (!id) return null
  return props.folder.sessions.find((s) => s.sessionId === id) ?? null
})

/**
 * When the dispatch happened. The card itself carries no dispatch timestamp —
 * `provenance.at` is when the card was RAISED, which is a different event — so
 * the honest source is the bound session's own creation, which is exactly the
 * moment the dispatch spawned it. Unknown when that session is not on disk here;
 * the step then prints its bare name rather than inventing an age.
 */
const dispatchedAge = computed(() => relativeTime(ownerSession.value?.created))

const ownerTitle = computed(() => {
  const s = ownerSession.value
  if (!s) return ''
  return sessionTitle(s, sessions.allSessions, t) || s.sessionId
})

/** The branch this worktree was cut from (T191 lineage), when Harnu recorded it. */
const cutFrom = computed(() => {
  const from = props.folder.bornFrom
  if (!from) return ''
  const mother = sessions.folders.find((f) => f.path === from)
  return mother?.gitBranch ?? ''
})

// --- The PR state pill -------------------------------------------------------

type PillTone = 'ok' | 'warn' | 'bad' | 'mute'

interface Pill {
  key: string
  tone: PillTone
  n?: number
}

/**
 * The card's PR state, as one pill. Absent when there is no PR to describe —
 * including when `gh` could not be reached, since "we did not look" is not a
 * state worth a chip.
 */
const pill = computed<Pill | null>(() => {
  const p = pr.value
  if (!p) return null
  if (p.merged) return { key: 'merged', tone: 'ok' }
  if (p.closed) return { key: 'closed', tone: 'mute' }
  if (p.draft) return { key: 'draft', tone: 'mute' }
  if (p.reviewDecision === 'CHANGES_REQUESTED') return { key: 'changesRequested', tone: 'warn' }
  if (p.reviewDecision === 'APPROVED') return { key: 'approved', tone: 'ok' }
  return { key: 'inReview', tone: 'mute' }
})

const PILL_CLASS: Record<PillTone, string> = {
  ok: 'bg-green-soft text-green',
  warn: 'bg-warning/10 text-warning',
  bad: 'bg-red-soft text-red',
  mute: 'bg-surface-2 text-text-3'
}

// --- Step labels -------------------------------------------------------------

/**
 * Each step names itself and carries its real evidence. A step whose evidence
 * is unreadable falls back to the bare name — never to a fabricated zero.
 */
function stepLabel(step: RailStep): { key: string; args?: Record<string, unknown> } {
  switch (step.key) {
    case 'dispatched':
      return dispatchedAge.value
        ? { key: 'folderView.owned.rail.dispatchedAt', args: { age: dispatchedAge.value } }
        : { key: 'folderView.owned.rail.dispatched' }
    case 'commits': {
      const n = commits.value
      if (n === undefined || n === null || n <= 0) return { key: 'folderView.owned.rail.commits' }
      return latestSha.value
        ? { key: 'folderView.owned.rail.commitsLatest', args: { n, sha: latestSha.value } }
        : { key: 'folderView.owned.rail.commitsCount', args: { n } }
    }
    case 'pr': {
      const p = pr.value
      if (!p) return { key: 'folderView.owned.rail.pr' }
      return { key: 'folderView.owned.rail.prNumber', args: { n: p.number } }
    }
    default:
      return pr.value?.merged
        ? { key: 'folderView.owned.rail.merged' }
        : { key: 'folderView.owned.rail.merge' }
  }
}

/** design.md §6 — the bar is the state. Only `current` is accent, and only one is. */
const BAR_CLASS: Record<RailStep['state'], string> = {
  done: 'bg-green',
  current: 'bg-accent',
  pending: 'bg-border'
}
</script>

<template>
  <!-- AC-4: absent, not empty. No card owns this branch → no hero. -->
  <section
    v-if="hasCard && owned"
    class="flex flex-col border border-accent-line bg-accent-soft"
    style="gap: 10px; border-radius: var(--radius); padding: 14px 16px"
    data-test="folder-view-owned-card"
  >
    <div class="flex flex-wrap items-center" style="gap: 8px">
      <span
        class="shrink-0 truncate font-mono text-accent"
        style="max-width: 96px; font-size: 11px"
        :title="owned.id"
        data-test="folder-view-owned-card-id"
        >{{ owned.id }}</span
      >
      <h3
        class="min-w-0 flex-1 truncate text-text"
        style="font-size: 14px; line-height: 20px; font-weight: 500"
        :title="owned.title"
        data-test="folder-view-owned-card-title"
      >
        {{ owned.title }}
      </h3>
      <span
        v-if="pill"
        class="inline-flex shrink-0 items-center whitespace-nowrap"
        :class="PILL_CLASS[pill.tone]"
        style="border-radius: 999px; padding: 1px 8px; font-size: 10.5px; line-height: 16px"
        data-test="folder-view-owned-card-pr-pill"
        >{{ $t(`folderView.owned.pr.${pill.key}`) }}</span
      >
      <ScopeTag :scope="scopeOf('ownedCard')" />
    </div>

    <!-- The four-step rail: dispatched → commits → PR → merge. -->
    <div class="fv-steps" data-test="folder-view-owned-card-rail">
      <div
        v-for="step in rail"
        :key="step.key"
        class="flex flex-col"
        style="gap: 6px"
        data-test="folder-view-owned-card-step"
        :data-step="step.key"
        :data-state="step.state"
        :data-known="step.known ? 'yes' : 'no'"
      >
        <div
          class="rounded-full"
          :class="BAR_CLASS[step.state]"
          style="height: 4px"
          aria-hidden="true"
        />
        <div
          class="truncate"
          :class="step.state === 'pending' ? 'text-text-4' : 'text-text-2'"
          style="font-size: 10.5px; padding-right: 8px"
        >
          {{ $t(stepLabel(step).key, stepLabel(step).args ?? {}) }}
        </div>
      </div>
    </div>

    <div class="flex flex-wrap text-text-3" style="gap: 6px 18px; font-size: 11.5px">
      <span data-test="folder-view-owned-card-status">
        {{ $t('folderView.owned.meta.status') }}
        <b class="font-medium text-text">{{ $t(`roadmap.columns.${owned.status}`) }}</b>
      </span>
      <span v-if="ownerTitle" class="min-w-0 max-w-full truncate" :title="ownerTitle">
        {{ $t('folderView.owned.meta.ownerSession') }}
        <b class="font-medium text-text">{{ ownerTitle }}</b>
      </span>
      <!-- `↑n unpushed` only when there IS something unpushed — the header
           applies the same rule, and `↑0` reads as a fact rather than a
           non-event. A null `ahead` means no upstream, so it is omitted too. -->
      <span v-if="gitStatus" data-test="folder-view-owned-card-git">
        {{ $t('folderView.owned.meta.git') }}
        <template v-if="gitStatus.ahead != null && gitStatus.ahead > 0">
          <b class="tabular-nums font-medium text-text">↑{{ gitStatus.ahead }}</b>
          {{ $t('folderView.owned.meta.unpushed') }} ·
        </template>
        <template v-if="gitStatus.dirtyCount != null">
          {{
            gitStatus.dirtyCount > 0
              ? $t('preview.folder.changes', { count: gitStatus.dirtyCount })
              : $t('preview.folder.clean')
          }}
        </template>
      </span>
      <span v-if="cutFrom" class="min-w-0 max-w-full truncate">
        {{ $t('folderView.owned.meta.cutFrom') }}
        <b class="font-mono font-medium text-text">{{ cutFrom }}</b>
      </span>
    </div>
  </section>
</template>

<style scoped>
/*
 * design.md §6 "Folder View → Worktree profile". Four equal steps, 2px apart —
 * the bars read as one segmented track rather than four chips.
 *
 * The fold is a CONTAINER query on the view's own `folder-view` container, for
 * the same reason every other breakpoint in this view is: the Folder View is a
 * pane, not a page, and a 230px pane inside a 1440px window would keep four
 * columns and paint four one-word ellipses.
 */
.fv-steps {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 2px;
}

@container folder-view (max-width: 760px) {
  .fv-steps {
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 8px 2px;
  }
}
</style>
