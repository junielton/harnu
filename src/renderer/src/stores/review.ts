/**
 * T164 U3 — Review pane store.
 *
 * Owns the snapshot U2's `review:load` returns, the operator's per-file
 * collapse overrides, and the intent rail's collapsed state. Every decision
 * about what the snapshot MEANS lives in `src/main/review-core.ts` (facts) and
 * `components/review-format.ts` (wording + render plan) — this store only holds
 * state and schedules effects, exactly like `stores/pr-stack.ts`.
 *
 * **No model call, ever.** The pane renders git output and the card's own body;
 * there is no code path here that asks anything to summarise, judge or review
 * (PRD §3.2 R1 / AC-12). That is a property of this file being this short.
 *
 * design.md §6 "Review pane (ReviewPane.vue, T164)".
 */

import { defineStore } from 'pinia'
import { computed, ref, shallowRef } from 'vue'
import type { SessionEndState } from '../../../main/review-core'
import type { ReviewSnapshot } from '../../../main/review-ipc'
import type { ReviewSubmitResult } from '../../../main/review-ipc'
import type { ReviewVerdict } from '../../../main/review-submit-core'
import type { ViewedState } from '../../../main/review-viewed'
import { autoExpanded, AUTO_EXPAND_ROW_BUDGET } from '../components/review-format'

export const useReviewStore = defineStore('review', () => {
  /** `shallowRef`: a branch-wide diff is a large, wholly-replaced payload. */
  const snapshot = shallowRef<ReviewSnapshot | null>(null)
  const loading = ref(false)
  const refreshing = ref(false)
  /**
   * A load that threw. `review:load` is documented never to reject for a
   * missing remote/`gh`/repo — those are first-class states, not errors (AC-6)
   * — so anything landing here is a genuine IPC failure worth naming.
   */
  const error = ref<string | null>(null)

  /** The repo's sensitive-path list, kept live via `review:blastRadiusChanged`. */
  const blastGlobs = ref<string[]>([])

  /** Per-file open/closed, seeded from the auto rule and then owned by clicks. */
  const expanded = ref<Record<string, boolean>>({})
  /**
   * Per-file "I have read this" (T243), seeded from the snapshot and then
   * POINT-PATCHED by {@link markViewed}.
   *
   * It lives here rather than being read straight off `snapshot` for one
   * reason, and it is a correctness requirement rather than an optimisation:
   * the only way to refresh a snapshot is {@link load}, and `load` re-seeds
   * `expanded` — on purpose, so a genuinely NEW diff cannot inherit stale
   * overrides. Routing a mark through it would therefore reset every other
   * file's expand/collapse state on every click, self-inflicting the exact
   * "loses their place" problem the mark exists to fix (AC-3).
   */
  const viewedFiles = ref<Record<string, ViewedState>>({})
  /** The intent rail's collapsed state below the ~1000px breakpoint (AC-8). */
  const railOpen = ref(false)

  let subscribed: (() => void) | null = null

  const sensitivePaths = computed<Set<string>>(
    () => new Set(snapshot.value?.evidence.sensitivePaths ?? [])
  )

  const isEmptyDiff = computed(
    () => !loading.value && !!snapshot.value && snapshot.value.files.length === 0
  )

  /**
   * Re-seed the collapse map from the auto rule. Called on every fresh
   * snapshot: an operator's overrides describe the diff they were reading, and
   * carrying them onto a different diff would silently hide a file.
   */
  function reseedExpanded(): void {
    expanded.value = autoExpanded(
      snapshot.value?.files ?? [],
      sensitivePaths.value,
      AUTO_EXPAND_ROW_BUDGET,
      viewedPaths.value
    )
  }

  /** The files whose mark currently reads as READ — `pending` included. */
  const viewedPaths = computed<Set<string>>(
    () =>
      new Set(
        Object.entries(viewedFiles.value)
          .filter(([, state]) => state === 'viewed' || state === 'pending')
          .map(([path]) => path)
      )
  )

  function viewedOf(path: string): ViewedState {
    return viewedFiles.value[path] ?? 'unviewed'
  }

  function toggleFile(path: string): void {
    expanded.value = { ...expanded.value, [path]: !expanded.value[path] }
  }

  function isExpanded(path: string): boolean {
    return expanded.value[path] === true
  }

  /**
   * Subscribe once to blast-radius edits. A pane showing a stale never-delegate
   * list is the one staleness that is a safety problem rather than a cosmetic
   * one, so an edit re-reads the whole snapshot instead of patching flags.
   */
  function ensureSubscribed(): void {
    if (subscribed) return
    if (typeof window.api.onReviewBlastRadiusChanged !== 'function') return
    subscribed = window.api.onReviewBlastRadiusChanged(({ folder, globs }) => {
      blastGlobs.value = globs
      if (snapshot.value?.folder === folder) void load(folder, { silent: true })
    })
  }

  /**
   * Load "branch vs base" for a folder.
   *
   * `session` is the bound session's end state when the caller knows one — the
   * pane never probes for it, because t125 is not built and inventing a value
   * would put an assertion in the receipts (PRD D3).
   */
  async function load(
    folder: string,
    opts: {
      base?: string
      head?: string
      /** Review this PR's head, fetched from `refs/pull/<n>/head` (T246). */
      prNumber?: number | null
      /**
       * Go to the network for the head, and past the `gh` cache. Set ONLY by
       * the refresh gesture: opening the pane must cost nothing, which is what
       * keeps git-only evidence a first-class state rather than a fallback.
       */
      fetch?: boolean
      session?: SessionEndState | null
      silent?: boolean
    } = {}
  ): Promise<void> {
    if (!folder) return
    ensureSubscribed()
    if (opts.silent) refreshing.value = true
    else {
      loading.value = true
      snapshot.value = null
    }
    error.value = null
    try {
      const next = await window.api.reviewLoad({
        folder,
        ...(opts.base ? { base: opts.base } : {}),
        ...(opts.head ? { head: opts.head } : {}),
        ...(opts.prNumber ? { prNumber: opts.prNumber } : {}),
        ...(opts.fetch ? { fetch: true, force: true } : {}),
        session: opts.session ?? null
      })
      snapshot.value = next
      viewedFiles.value = { ...next.viewed.files }
      reseedExpanded()
      // The snapshot's own folder, not the requested one: a foreign PR review
      // runs in the repo's MAIN worktree, and reading the blast radius of the
      // folder the caller happened to pass would flag against the wrong repo
      // entry.
      blastGlobs.value = (await window.api.reviewBlastRadius(next.folder || folder)).globs
    } catch (e) {
      error.value = e instanceof Error ? e.message : String(e)
      snapshot.value = null
    } finally {
      loading.value = false
      refreshing.value = false
    }
  }

  /**
   * Mark one file read / unread.
   *
   * A POINT PATCH: exactly one key of {@link viewedFiles} changes and nothing
   * reloads (AC-3). The main process owns the precedence rule — GitHub wins
   * whenever a PR is known — so the state written back here is the one it
   * resolved, never one this store guessed.
   *
   * Returns the error string when a PR was known and its mutation failed, so
   * the pane can say so out loud. With no PR, no remote or no `gh` there is
   * nothing to fail: the mark is local and the return is `null` (AC-5/AC-6).
   */
  async function markViewed(path: string, viewed: boolean): Promise<string | null> {
    const snap = snapshot.value
    if (!snap) return null
    const file = snap.files.find((f) => f.path === path)
    if (!file) return null

    // Optimistic, and deliberately conservative about which optimism: a mark
    // shows as `pending` until main says otherwise, never as synced.
    viewedFiles.value = { ...viewedFiles.value, [path]: viewed ? 'pending' : 'unviewed' }
    // Reading a file collapses it — the whole point of the mark. A sensitive
    // file is exempt: R3/AC-7 rank the blast radius above having-been-read.
    if (viewed && !sensitivePaths.value.has(path) && expanded.value[path]) {
      expanded.value = { ...expanded.value, [path]: false }
    }

    try {
      const res = await window.api.reviewSetViewed({
        folder: snap.folder,
        path,
        blobSha: file.blobSha,
        viewed,
        prNodeId: snap.viewed.prNodeId
      })
      viewedFiles.value = { ...viewedFiles.value, [path]: res.state }
      return res.error
    } catch (e) {
      // `review:setViewed` is documented never to reject for a missing PR /
      // remote / `gh`, so anything landing here is a genuine IPC failure. The
      // optimistic patch stays as `pending`: an edit whose outcome is unknown
      // must not settle as synced.
      return e instanceof Error ? e.message : String(e)
    }
  }

  /**
   * Submit a review to GitHub (T244).
   *
   * The pane's only write, and the only place in Harnu that speaks under the
   * operator's GitHub identity. Everything the guard needs is taken from the
   * SNAPSHOT — the base that was rendered, the ref that was diffed and the sha
   * it resolved to when it was — because that is what the operator actually
   * read; main re-reads the live values and refuses if the two disagree.
   *
   * Nothing here decides anything: no verdict is inferred, defaulted or
   * recommended, and the result is returned rather than turned into a state.
   * The pane renders "submitted" only off an `ok` it was handed.
   */
  async function submitReview(verdict: ReviewVerdict, body: string): Promise<ReviewSubmitResult> {
    const snap = snapshot.value
    if (!snap) return { ok: false, refusal: 'no-pr', detail: null, error: null }
    const pr = snap.evidence.pr.applicable ? snap.evidence.pr.pr : null
    try {
      return await window.api.reviewSubmitReview({
        folder: snap.folder,
        prNumber: pr?.number ?? null,
        verdict,
        body,
        base: snap.base,
        headRef: snap.head.ref,
        headOid: snap.head.sha
      })
    } catch (e) {
      // `review:submitReview` is documented never to reject — every refusal and
      // every `gh` failure comes back as a value — so anything landing here is a
      // genuine IPC failure. It is still surfaced: the ONE thing this path may
      // never do is leave the operator believing a review went out.
      return {
        ok: false,
        refusal: null,
        detail: null,
        error: e instanceof Error ? e.message : String(e)
      }
    }
  }

  /** Drop everything the pane held. Called when the takeover closes. */
  function reset(): void {
    snapshot.value = null
    expanded.value = {}
    viewedFiles.value = {}
    error.value = null
    loading.value = false
    refreshing.value = false
    railOpen.value = false
  }

  return {
    snapshot,
    loading,
    refreshing,
    error,
    blastGlobs,
    expanded,
    viewedFiles,
    railOpen,
    sensitivePaths,
    viewedPaths,
    isEmptyDiff,
    load,
    reset,
    toggleFile,
    isExpanded,
    viewedOf,
    markViewed,
    submitReview
  }
})
