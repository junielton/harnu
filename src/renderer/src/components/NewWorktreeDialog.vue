<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { Check, ChevronRight, GitBranch, Sparkles, X } from 'lucide-vue-next'
import { useI18n } from 'vue-i18n'
import { useUiStore } from '../stores/ui'
import { useFocusTrap } from '../composables/useFocusTrap'
import { slugifyBranchName } from '../lib/branch-slug'
import SegmentedControl from './ui/SegmentedControl.vue'
import BranchCombobox from './ui/BranchCombobox.vue'
import type { Api, BranchRef } from '../../../preload'

/**
 * "New worktree" plan + create dialog — a non-destructive `Dialog` variant
 * (`design.md §6` → "New worktree"). Driven by
 * `useUiStore().dialog === 'newWorktree'`, reads the target repo/folder path
 * off `ui.newWorktreePath`. Triggered from `FolderMenu.vue` (gated to git
 * folders).
 *
 * Two phases live in the SAME card:
 *  - **form** — a branch input + optional base-ref input. Both are debounced
 *    (~350ms) into `worktreePlan(...)`, a read-only dry-run that never throws.
 *    The result is a union: a `WorktreePlanPreview` (target/base/mode/seed/
 *    commands/warnings — disclosed before anything runs) or a typed
 *    `WorktreePlanError` (Create disabled + a red message).
 *  - **progress** — a vertical stage stepper (`resolve → worktree-add → seed →
 *    setup → adopt`) driven by `onWorktreeProgress(id, …)`. The running stage
 *    shimmers; completed stages show a check. On success we toast + close; on
 *    failure the engine has already rolled back, so we surface the verbatim
 *    error inline and let the operator go Back or Close.
 *
 * Mirrors `AddFolderDialog.vue` / `RemoveWorktreeDialog.vue` anatomy (Teleport →
 * overlay-fade backdrop → fade-in-scale card → header/body/footer, focus trap,
 * Esc + backdrop close). Reuses only existing tokens + motion helpers.
 */

const ui = useUiStore()
const { t } = useI18n()

const isOpen = computed(() => ui.dialog === 'newWorktree')

/** The repo/folder path this dialog targets, or `null` when closed. */
const repoPath = computed(() => ui.newWorktreePath)

// --- Types (derived from the preload `Api` — the renderer cannot import from
//     `src/main`, so we peel the plan/progress shapes off the exposed fns). ---
type PlanResult = Awaited<ReturnType<Api['worktreePlan']>>
type PlanPreview = Extract<PlanResult, { targetPath: string }>
type ProgressEvent = Parameters<Parameters<Api['onWorktreeProgress']>[1]>[0]
type Stage = ProgressEvent['stage']
type StageStatus = 'pending' | 'running' | 'done' | 'failed'

/** Display order of the create pipeline stages (matches the engine's emit order). */
const STAGES: Stage[] = ['resolve', 'worktree-add', 'seed', 'setup', 'adopt']

/** Map the raw stage id → its camelCase i18n key under `worktree.create.stages`. */
const STAGE_KEY: Record<Stage, string> = {
  resolve: 'resolve',
  'worktree-add': 'worktreeAdd',
  seed: 'seed',
  setup: 'setup',
  adopt: 'adopt'
}

/**
 * Cross-platform basename (identical to the helper in the other dialogs). The
 * path may carry either separator depending on the host OS.
 */
function basename(p: string): string {
  if (!p) return ''
  return (
    p
      .replace(/[/\\]+$/, '')
      .split(/[/\\]/)
      .pop() ?? ''
  )
}

const folderName = computed(() => basename(repoPath.value ?? ''))

// --- Local state -----------------------------------------------------------

/** Which phase the card is showing. */
const phase = ref<'form' | 'progress'>('form')

/**
 * Create mode. `new` cuts a fresh branch off a base (the default); `existing`
 * CHECKS OUT an already-existing local/remote branch into a worktree (the PR-review
 * flow — the MCP `create_worktree` `ref` param, T44 S2, that the dialog never
 * exposed). In `existing` mode the worktree directory is derived from the picked
 * branch (so `branch === ref`), so there's no separate name field.
 */
const mode = ref<'new' | 'existing'>('new')

const branch = ref('')
const baseRef = ref('')
/** The existing branch to check out, in `existing` mode (empty → Create disabled). */
const checkoutRef = ref('')

const modeOptions = computed(() => [
  { value: 'new', label: t('worktree.create.modeNewTab') },
  { value: 'existing', label: t('worktree.create.modeExistingTab') }
])

// Effective values fed to the plan dry-run + create, resolved per mode. In
// `existing` mode `branch` (the worktree dir name) IS the checked-out ref, and no
// base applies; in `new` mode there is no ref and the base select drives the cut.
const effectiveBranch = computed(() =>
  mode.value === 'existing' ? checkoutRef.value.trim() : branch.value.trim()
)
const effectiveRef = computed<string | undefined>(() =>
  mode.value === 'existing' ? checkoutRef.value.trim() || undefined : undefined
)
const effectiveBaseRef = computed<string | undefined>(() =>
  mode.value === 'existing' ? undefined : baseRef.value.trim() || undefined
)

/** Repo branches (local + remote) for the base-ref select; loaded on open. */
const branches = ref<BranchRef[]>([])
/** True while the branch list is being fetched (select shows only HEAD until then). */
const branchesLoading = ref(false)

/** Latest dry-run plan (preview or typed error), or `null` before any call. */
const plan = ref<PlanResult | null>(null)
/** True while a debounced plan call is in flight. */
const planLoading = ref(false)
/** Whether the setup-commands disclosure is expanded. */
const commandsOpen = ref(false)

// --- Slugify strip (design.md §6 → "New worktree" → Slugify strip) ----------
//
// The real input in `new` mode is a ticket title pasted out of an issue tracker,
// which isn't a valid branch name. When the typed value differs from its slug we
// offer the slug; applying it makes the strip vanish (the transform is
// idempotent). Suggestion only — nothing is ever rewritten without a click.

const SLUGIFY_KEY = 'om2tab.worktreeSlugify'

/** Prefix + the two toggles are PREFERENCES: they outlive `resetState()`. */
const slugPrefix = ref('')
const slugifyPrefix = ref(false)
const slugPreserveCase = ref(false)
/** Whether the strip's options disclosure is expanded (form state, reset on close). */
const slugOptionsOpen = ref(false)

function loadSlugifyPrefs(): void {
  try {
    const raw = localStorage.getItem(SLUGIFY_KEY)
    if (!raw) return
    const parsed = JSON.parse(raw) as Partial<{
      prefix: string
      slugifyPrefix: boolean
      preserveCase: boolean
    }>
    if (typeof parsed?.prefix === 'string') slugPrefix.value = parsed.prefix
    if (typeof parsed?.slugifyPrefix === 'boolean') slugifyPrefix.value = parsed.slugifyPrefix
    if (typeof parsed?.preserveCase === 'boolean') slugPreserveCase.value = parsed.preserveCase
  } catch {
    /* malformed or unavailable — defaults stand */
  }
}
loadSlugifyPrefs()

watch([slugPrefix, slugifyPrefix, slugPreserveCase], () => {
  try {
    localStorage.setItem(
      SLUGIFY_KEY,
      JSON.stringify({
        prefix: slugPrefix.value,
        slugifyPrefix: slugifyPrefix.value,
        preserveCase: slugPreserveCase.value
      })
    )
  } catch {
    /* private mode — in-memory only */
  }
})

const slugSuggestion = computed(() =>
  slugifyBranchName(branch.value, {
    prefix: slugPrefix.value,
    slugifyPrefix: slugifyPrefix.value,
    preserveCase: slugPreserveCase.value
  })
)

/**
 * Absent for an already-clean name; vanishes after Apply. Scoping to `new` mode
 * is structural — the strip lives inside the mode's template branch.
 */
const showSlugStrip = computed(
  () => slugSuggestion.value !== '' && slugSuggestion.value !== branch.value.trim()
)

function applySlug(): void {
  branch.value = slugSuggestion.value
  branchInputRef.value?.focus()
}

// T61: whether this create offers agent-control inheritance (global opt-in ON +
// repo agent-allowed) and, if so, whether the operator keeps it (checkbox, default
// checked = inherit). `optOutInherit` is sent to the create when unchecked.
const inheritOffer = ref(false)
const inheritChecked = ref(true)

/** In-flight guard for the create — blocks double-submit + close mid-create. */
const creating = ref(false)
/** Verbatim create error (engine already rolled back); keeps the dialog open. */
const createError = ref<string | null>(null)
/** Per-stage status for the progress stepper. */
const stageState = ref<Record<Stage, StageStatus>>({
  resolve: 'pending',
  'worktree-add': 'pending',
  seed: 'pending',
  setup: 'pending',
  adopt: 'pending'
})

// --- Plan dry-run (debounced) ----------------------------------------------

let planTimer: ReturnType<typeof setTimeout> | null = null
/** Monotonic sequence so a slow response can't overwrite a newer one. */
let planSeq = 0

function schedulePlan(): void {
  if (planTimer) clearTimeout(planTimer)
  if (effectiveBranch.value.length === 0) {
    // Nothing chosen (no branch typed / no checkout picked) → no call, no preview.
    planSeq++
    plan.value = null
    planLoading.value = false
    inheritOffer.value = false
    return
  }
  planLoading.value = true
  planTimer = setTimeout(() => {
    void runPlan()
  }, 350)
}

async function runPlan(): Promise<void> {
  const repo = repoPath.value
  const b = effectiveBranch.value
  if (!repo || b.length === 0) {
    plan.value = null
    planLoading.value = false
    return
  }
  const seq = ++planSeq
  planLoading.value = true
  try {
    // Dry-run, never throws — the result is a discriminated union.
    const result = await window.api.worktreePlan({
      repoPath: repo,
      branch: b,
      baseRef: effectiveBaseRef.value,
      ref: effectiveRef.value
    })
    if (seq !== planSeq) return // a newer call superseded this one
    plan.value = result
    // T61: refresh the inheritance offer alongside the plan (same debounce + seq).
    try {
      const offer = await window.api.worktreeInheritOffer({
        repoPath: repo,
        branch: b,
        baseRef: effectiveBaseRef.value
      })
      if (seq === planSeq) inheritOffer.value = offer
    } catch {
      if (seq === planSeq) inheritOffer.value = false
    }
  } catch {
    // Contract says it never throws; be defensive so a rejected promise
    // doesn't leave the button wrongly enabled from a stale preview.
    if (seq !== planSeq) return
    plan.value = null
    inheritOffer.value = false
  } finally {
    if (seq === planSeq) planLoading.value = false
  }
}

// --- Plan discrimination ---------------------------------------------------

const planPreview = computed<PlanPreview | null>(() =>
  plan.value && !('error' in plan.value) ? plan.value : null
)

const planErrorObj = computed(() => (plan.value && 'error' in plan.value ? plan.value : null))

/** Localized message for the current plan error, if any. */
const planErrorMessage = computed<string>(() => {
  const e = planErrorObj.value
  if (!e) return ''
  switch (e.error) {
    case 'target-exists':
      return t('worktree.create.errors.targetExists', { path: e.path })
    case 'branch-checked-out':
      return t('worktree.create.errors.branchCheckedOut', { worktree: e.worktree })
    case 'no-commits':
      return t('worktree.create.errors.noCommits')
    case 'unsafe-target':
      return t('worktree.create.errors.unsafeTarget', { path: e.path })
    case 'invalid-request':
      return t('worktree.create.errors.invalidRequest', { reason: e.reason })
    default:
      return ''
  }
})

const modeLabel = computed<string>(() => {
  const p = planPreview.value
  if (!p) return ''
  switch (p.mode) {
    case 'delegated-create':
      return t('worktree.create.modeDelegatedCreate')
    case 'existing-branch':
      return t('worktree.create.modeCheckout')
    case 'detached':
      return t('worktree.create.modeDetached')
    default:
      return t('worktree.create.modeNewBranch')
  }
})

// --- Always-visible preview (item a: no layout shift) ----------------------
// The Target/Base/Mode box renders throughout the form phase; before a plan
// resolves each value falls back to a neutral placeholder so the box (and the
// footer below it) never jumps in when the branch is first typed.

/** True once a valid preview exists (drives placeholder vs. real-value styling). */
const hasPreview = computed(() => planPreview.value !== null)
/** Target dir, or `—` until the plan resolves. */
const targetDisplay = computed(() => planPreview.value?.targetPath ?? '—')
/** Resolved base/ref, or the current select value (`HEAD` for a new-branch default). */
const baseRefDisplay = computed(() => {
  if (planPreview.value) return planPreview.value.baseRef
  if (mode.value === 'existing') return checkoutRef.value.trim() || '—'
  return baseRef.value.trim() || 'HEAD'
})
/** Create mode label, or `—` until the plan resolves. */
const modeDisplay = computed(() => (planPreview.value ? modeLabel.value : '—'))

const hasSeed = computed<boolean>(() => {
  const p = planPreview.value
  return !!p && (p.seed.copy.length > 0 || p.seed.link.length > 0)
})

const seedText = computed<string>(() => {
  const p = planPreview.value
  if (!p) return ''
  const parts: string[] = []
  if (p.seed.copy.length) parts.push(`copy: ${p.seed.copy.join(', ')}`)
  if (p.seed.link.length) parts.push(`link: ${p.seed.link.join(', ')}`)
  return parts.join('  ·  ')
})

const canCreate = computed<boolean>(
  () =>
    !creating.value &&
    !planLoading.value &&
    effectiveBranch.value.length > 0 &&
    planPreview.value !== null
)

// --- Create (with progress subscription) -----------------------------------

let unsubscribeProgress: (() => void) | null = null

function teardownProgress(): void {
  if (unsubscribeProgress) {
    unsubscribeProgress()
    unsubscribeProgress = null
  }
}

/** Mark `stage` with `status`; every earlier stage is implicitly done. */
function markStage(stage: Stage, status: StageStatus): void {
  const idx = STAGES.indexOf(stage)
  STAGES.forEach((s, i) => {
    if (i < idx) stageState.value[s] = 'done'
    else if (i === idx) stageState.value[s] = status
  })
}

function markAllDone(): void {
  for (const s of STAGES) stageState.value[s] = 'done'
}

async function create(): Promise<void> {
  const repo = repoPath.value
  const b = effectiveBranch.value
  if (!repo || b.length === 0 || !canCreate.value || creating.value) return

  creating.value = true
  createError.value = null
  for (const s of STAGES) stageState.value[s] = 'pending'
  phase.value = 'progress'

  const id = crypto.randomUUID()
  unsubscribeProgress = window.api.onWorktreeProgress(id, (ev) => {
    if (ev.done) {
      // Terminal event (`{ stage: 'adopt', done: true }`) — everything finished.
      markAllDone()
    } else {
      markStage(ev.stage, 'running')
    }
  })

  try {
    // Rejects on failure; the engine has already rolled back any partial state.
    await window.api.worktreeCreate({
      repoPath: repo,
      branch: b,
      baseRef: effectiveBaseRef.value,
      ref: effectiveRef.value,
      id,
      // T61: opt out of inheritance only when the offer was shown and unchecked.
      optOutInherit: inheritOffer.value && !inheritChecked.value
    })
    markAllDone()
    teardownProgress()
    ui.pushToast({ kind: 'success', title: t('worktree.create.toastCreated') })
    ui.closeDialog()
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    const running = STAGES.find((s) => stageState.value[s] === 'running')
    if (running) stageState.value[running] = 'failed'
    createError.value = msg
    teardownProgress()
    ui.pushToast({
      kind: 'danger',
      title: t('worktree.create.toastFailed'),
      description: msg
    })
  } finally {
    creating.value = false
  }
}

/** Return from a failed progress view to the form (inputs are preserved). */
function backToForm(): void {
  createError.value = null
  phase.value = 'form'
  schedulePlan()
}

// --- Reset / close ---------------------------------------------------------

function resetState(): void {
  phase.value = 'form'
  mode.value = 'new'
  branch.value = ''
  baseRef.value = ''
  checkoutRef.value = ''
  branches.value = []
  branchesLoading.value = false
  plan.value = null
  planLoading.value = false
  commandsOpen.value = false
  // Only the disclosure resets — prefix + toggles are persisted preferences.
  slugOptionsOpen.value = false
  inheritOffer.value = false
  inheritChecked.value = true
  creating.value = false
  createError.value = null
  for (const s of STAGES) stageState.value[s] = 'pending'
  if (planTimer) {
    clearTimeout(planTimer)
    planTimer = null
  }
  planSeq++ // invalidate any in-flight plan response
  teardownProgress()
}

function close(): void {
  // In-flight guard: can't dismiss while a create is actually running (there's
  // no abort). Once it settles — success closes us, failure clears `creating`.
  if (creating.value) return
  ui.closeDialog()
}

// --- Focus trap + backdrop click + keyboard --------------------------------

const dialogRef = ref<HTMLElement | null>(null)
const branchInputRef = ref<HTMLInputElement | null>(null)

useFocusTrap({
  active: isOpen,
  containerRef: dialogRef,
  initialFocusRef: branchInputRef
})

function onBackdropMousedown(e: MouseEvent): void {
  if (e.target === e.currentTarget) close()
}

function onKeydown(e: KeyboardEvent): void {
  if (!isOpen.value) return
  if (e.key === 'Escape') {
    if ((e.target as Element | null)?.closest?.('[data-branch-combobox-panel]')) return
    e.stopPropagation()
    close()
  }
}

/** Enter in the form phase submits the create when the plan is valid. */
function onFormSubmit(): void {
  if (phase.value === 'form' && canCreate.value) void create()
}

watch([mode, branch, baseRef, checkoutRef], () => {
  if (phase.value === 'form') schedulePlan()
})

/** Fetch the repo's branches for the base-ref select (never throws → empty list). */
function loadBranches(): void {
  const repo = repoPath.value
  if (!repo) return
  branchesLoading.value = true
  window.api
    .worktreeBranches({ repoPath: repo })
    .then((b) => {
      branches.value = b
    })
    .catch(() => {
      branches.value = []
    })
    .finally(() => {
      branchesLoading.value = false
    })
}

watch(isOpen, (open) => {
  if (open) {
    resetState()
    loadBranches()
    window.addEventListener('keydown', onKeydown, true)
  } else {
    resetState()
    window.removeEventListener('keydown', onKeydown, true)
  }
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown, true)
  if (planTimer) clearTimeout(planTimer)
  teardownProgress()
})
</script>

<template>
  <Teleport to="body">
    <div
      v-if="isOpen && repoPath"
      class="anim-overlay-fade fixed inset-0 flex items-center justify-center"
      style="background: rgba(0, 0, 0, 0.55); z-index: 60"
      role="presentation"
      @mousedown="onBackdropMousedown"
    >
      <div
        ref="dialogRef"
        class="anim-fade-in-scale flex flex-col border border-border-2 bg-surface text-text"
        style="
          width: min(560px, 90vw);
          max-height: 82vh;
          border-radius: 9px;
          box-shadow: var(--shadow-pop);
        "
        role="dialog"
        aria-modal="true"
        aria-labelledby="new-worktree-dialog-title"
        @mousedown.stop
      >
        <!-- Header -->
        <header
          class="flex shrink-0 items-center justify-between border-b border-border"
          style="padding: 14px 18px 10px"
        >
          <div class="flex min-w-0 items-baseline" style="gap: 8px">
            <h2
              id="new-worktree-dialog-title"
              class="shrink-0 text-text"
              style="font-size: 13.5px; line-height: 20px; font-weight: 600"
            >
              {{ $t('worktree.create.title') }}
            </h2>
            <span class="truncate font-mono text-text-4" style="font-size: 11.5px">
              {{ folderName }}
            </span>
          </div>
          <button
            class="flex items-center justify-center rounded text-text-3 transition hover:bg-surface-2 hover:text-text"
            style="width: 24px; height: 24px"
            :aria-label="$t('actions.cancel')"
            @click="close()"
          >
            <X :size="14" :stroke-width="1.5" />
          </button>
        </header>

        <!-- Body -->
        <div class="scrollable flex-1 overflow-y-auto" style="padding: 14px 18px">
          <!-- ============================ PHASE A: form + preview ============ -->
          <template v-if="phase === 'form'">
            <!-- Mode: create a new branch vs. check out an existing one (PR review) -->
            <section style="margin-bottom: 14px">
              <span
                class="text-text-3"
                style="
                  display: block;
                  font-size: 11px;
                  font-weight: 500;
                  letter-spacing: 0.06em;
                  text-transform: uppercase;
                  margin-bottom: 6px;
                "
              >
                {{ $t('worktree.create.modeToggleLabel') }}
              </span>
              <SegmentedControl
                :options="modeOptions"
                :model-value="mode"
                size="sm"
                :aria-label="$t('worktree.create.modeToggleLabel')"
                @update:model-value="mode = $event as 'new' | 'existing'"
              />
            </section>

            <!-- NEW-BRANCH mode: name + base ref -->
            <template v-if="mode === 'new'">
              <!-- Branch -->
              <section style="margin-bottom: 14px">
                <label
                  for="new-worktree-branch"
                  class="text-text-3"
                  style="
                    display: block;
                    font-size: 11px;
                    font-weight: 500;
                    letter-spacing: 0.06em;
                    text-transform: uppercase;
                    margin-bottom: 6px;
                  "
                >
                  {{ $t('worktree.create.branchLabel') }}
                </label>
                <input
                  id="new-worktree-branch"
                  ref="branchInputRef"
                  v-model="branch"
                  class="w-full border border-border bg-bg text-text transition focus:border-accent-line"
                  style="
                    border-radius: 5px;
                    padding: 8px 10px;
                    font-size: 13px;
                    outline: none;
                    height: 32px;
                  "
                  type="text"
                  autocomplete="off"
                  spellcheck="false"
                  :placeholder="$t('worktree.create.branchPlaceholder')"
                  @keydown.enter.prevent="onFormSubmit()"
                />

                <!-- Slugify strip — only when the typed name differs from its
                     slug. Applying it makes this disappear (idempotent). -->
                <div
                  v-if="showSlugStrip"
                  class="border border-border bg-bg"
                  style="border-radius: 5px; padding: 8px 10px; margin-top: 8px"
                >
                  <div class="flex items-center" style="gap: 8px">
                    <Sparkles
                      :size="13"
                      :stroke-width="1.8"
                      class="shrink-0 text-accent"
                      aria-hidden="true"
                    />
                    <span
                      class="min-w-0 flex-1 truncate font-mono text-text-2"
                      style="font-size: 11.5px"
                      :title="slugSuggestion"
                      :aria-label="$t('worktree.create.slugifyHint')"
                    >
                      {{ slugSuggestion }}
                    </span>
                    <button
                      type="button"
                      class="shrink-0 text-accent transition hover:opacity-80"
                      style="font-size: 11.5px; font-weight: 500"
                      @click="applySlug()"
                    >
                      {{ $t('worktree.create.slugifyApply') }}
                    </button>
                  </div>

                  <button
                    type="button"
                    class="flex items-center text-text-2 transition hover:text-text"
                    style="gap: 6px; font-size: 11.5px; margin-top: 6px"
                    :aria-expanded="slugOptionsOpen"
                    @click="slugOptionsOpen = !slugOptionsOpen"
                  >
                    <ChevronRight
                      :size="13"
                      :stroke-width="1.8"
                      class="transition-transform"
                      :style="{ transform: slugOptionsOpen ? 'rotate(90deg)' : 'none' }"
                    />
                    {{ $t('worktree.create.slugifyOptions') }}
                  </button>

                  <div v-if="slugOptionsOpen" style="margin-top: 8px">
                    <label
                      for="new-worktree-slug-prefix"
                      class="text-text-3"
                      style="
                        display: block;
                        font-size: 11px;
                        font-weight: 500;
                        letter-spacing: 0.06em;
                        text-transform: uppercase;
                        margin-bottom: 6px;
                      "
                    >
                      {{ $t('worktree.create.slugifyPrefixLabel') }}
                    </label>
                    <input
                      id="new-worktree-slug-prefix"
                      v-model="slugPrefix"
                      class="w-full border border-border bg-bg text-text transition focus:border-accent-line"
                      style="
                        border-radius: 5px;
                        padding: 8px 10px;
                        font-size: 13px;
                        outline: none;
                        height: 32px;
                      "
                      type="text"
                      autocomplete="off"
                      spellcheck="false"
                      :placeholder="$t('worktree.create.slugifyPrefixPlaceholder')"
                      @keydown.enter.prevent="applySlug()"
                    />
                    <label
                      class="flex cursor-pointer items-center text-text-2"
                      style="gap: 7px; font-size: 11.5px; margin-top: 8px"
                    >
                      <input v-model="slugifyPrefix" type="checkbox" />
                      {{ $t('worktree.create.slugifyPrefixToggle') }}
                    </label>
                    <label
                      class="flex cursor-pointer items-center text-text-2"
                      style="gap: 7px; font-size: 11.5px; margin-top: 6px"
                    >
                      <input v-model="slugPreserveCase" type="checkbox" />
                      {{ $t('worktree.create.slugifyPreserveCase') }}
                    </label>
                  </div>
                </div>
              </section>

              <!-- Base ref (optional) -->
              <section style="margin-bottom: 14px">
                <label
                  for="new-worktree-base"
                  class="text-text-3"
                  style="
                    display: block;
                    font-size: 11px;
                    font-weight: 500;
                    letter-spacing: 0.06em;
                    text-transform: uppercase;
                    margin-bottom: 6px;
                  "
                >
                  {{ $t('worktree.create.baseLabel') }}
                </label>
                <BranchCombobox
                  id="new-worktree-base"
                  v-model="baseRef"
                  :branches="branches"
                  :loading="branchesLoading"
                  :placeholder="$t('worktree.create.baseSelectDefault')"
                  :local-label="$t('worktree.create.baseLocalGroup')"
                  :remote-label="$t('worktree.create.baseRemoteGroup')"
                  :no-match-label="$t('worktree.create.noBranchesMatch')"
                  :search-placeholder="$t('worktree.create.branchSearchPlaceholder')"
                />
              </section>
            </template>

            <!-- EXISTING-BRANCH mode: check out a branch (PR review). The worktree
                 directory is derived from the branch, so there's no name field. -->
            <template v-else>
              <section style="margin-bottom: 14px">
                <label
                  for="new-worktree-checkout"
                  class="text-text-3"
                  style="
                    display: block;
                    font-size: 11px;
                    font-weight: 500;
                    letter-spacing: 0.06em;
                    text-transform: uppercase;
                    margin-bottom: 6px;
                  "
                >
                  {{ $t('worktree.create.checkoutLabel') }}
                </label>
                <BranchCombobox
                  id="new-worktree-checkout"
                  v-model="checkoutRef"
                  :branches="branches"
                  :loading="branchesLoading"
                  :placeholder="$t('worktree.create.checkoutSelectDefault')"
                  :local-label="$t('worktree.create.baseLocalGroup')"
                  :remote-label="$t('worktree.create.baseRemoteGroup')"
                  :no-match-label="$t('worktree.create.noBranchesMatch')"
                  :search-placeholder="$t('worktree.create.branchSearchPlaceholder')"
                />
                <p class="text-text-4" style="font-size: 11px; line-height: 1.5; margin-top: 6px">
                  {{ $t('worktree.create.checkoutHint') }}
                </p>
              </section>
            </template>

            <!-- Plan error — a strip ABOVE the preview box, so a typo/invalid
                 branch never removes the box below (no layout shift). -->
            <p
              v-if="planErrorObj"
              class="border text-red"
              style="
                border-color: var(--color-red-soft);
                background: var(--color-red-soft);
                border-radius: 5px;
                padding: 8px 10px;
                font-size: 11.5px;
                line-height: 17px;
                margin-bottom: 10px;
              "
            >
              {{ planErrorMessage }}
            </p>

            <!-- Plan preview — the Target/Base/Mode box is ALWAYS present in the
                 form phase (placeholders `—`/`HEAD` before the plan resolves), so
                 typing the branch never materializes the box or shifts the footer.
                 Seed/commands/warnings still disclose only once a plan resolves. -->
            <div class="border border-border bg-bg" style="border-radius: 5px; padding: 10px 12px">
              <!-- target / base / mode -->
              <dl style="display: grid; grid-template-columns: auto 1fr; gap: 4px 12px; margin: 0">
                <dt class="text-text-4" style="font-size: 11px">
                  {{ $t('worktree.create.targetLabel') }}
                </dt>
                <dd
                  class="truncate font-mono"
                  :class="hasPreview ? 'text-text-2' : 'text-text-4'"
                  style="font-size: 11.5px; margin: 0"
                >
                  {{ targetDisplay }}
                </dd>
                <dt class="text-text-4" style="font-size: 11px">
                  {{ $t('worktree.create.baseRefLabel') }}
                </dt>
                <dd
                  class="truncate font-mono"
                  :class="hasPreview ? 'text-text-2' : 'text-text-4'"
                  style="font-size: 11.5px; margin: 0"
                >
                  {{ baseRefDisplay }}
                </dd>
                <dt class="text-text-4" style="font-size: 11px">
                  {{ $t('worktree.create.modeLabel') }}
                </dt>
                <dd
                  :class="hasPreview ? 'text-text-2' : 'text-text-4'"
                  style="font-size: 11.5px; margin: 0"
                >
                  {{ modeDisplay }}
                </dd>
              </dl>

              <!-- seed -->
              <div
                v-if="hasSeed"
                class="border-t border-border"
                style="margin-top: 8px; padding-top: 8px"
              >
                <span class="text-text-4" style="font-size: 11px">
                  {{ $t('worktree.create.seedLabel') }}
                </span>
                <span class="font-mono text-text-2" style="font-size: 11.5px; margin-left: 8px">
                  {{ seedText }}
                </span>
              </div>

              <!-- setup / commands disclosure -->
              <div
                v-if="planPreview && planPreview.commands.length"
                class="border-t border-border"
                style="margin-top: 8px; padding-top: 8px"
              >
                <button
                  class="flex items-center text-text-2 transition hover:text-text"
                  style="gap: 6px; font-size: 11.5px"
                  @click="commandsOpen = !commandsOpen"
                >
                  <ChevronRight
                    :size="13"
                    :stroke-width="1.8"
                    class="transition-transform"
                    :style="{ transform: commandsOpen ? 'rotate(90deg)' : 'none' }"
                  />
                  {{ $t('worktree.create.commandsLabel') }} ({{ planPreview.commands.length }})
                </button>
                <div v-if="commandsOpen" style="margin-top: 8px">
                  <pre
                    class="scrollable overflow-x-auto whitespace-pre bg-surface-2 font-mono text-text-2"
                    style="
                      border-radius: 5px;
                      padding: 8px 10px;
                      font-size: 11.5px;
                      line-height: 18px;
                      margin: 0;
                    "
                  ><code>{{ planPreview.commands.join('\n') }}</code></pre>
                  <p
                    class="text-warning"
                    style="font-size: 11px; margin-top: 6px; line-height: 16px"
                  >
                    {{ $t('worktree.create.commandsWarning') }}
                  </p>
                </div>
              </div>

              <!-- warnings -->
              <div
                v-if="planPreview && planPreview.warnings.length"
                class="border-t border-border"
                style="margin-top: 8px; padding-top: 8px"
              >
                <span class="text-text-4" style="font-size: 11px">
                  {{ $t('worktree.create.warningsLabel') }}
                </span>
                <p
                  v-for="(w, i) in planPreview.warnings"
                  :key="i"
                  class="text-warning"
                  style="font-size: 11px; line-height: 16px; margin-top: 2px"
                >
                  {{ w }}
                </p>
              </div>
            </div>

            <!-- T61: agent-control inheritance opt-out (only when the repo offers it) -->
            <label
              v-if="inheritOffer"
              class="flex cursor-pointer items-start border border-border bg-surface-2"
              style="gap: 8px; padding: 9px 11px; border-radius: 6px; margin-top: 10px"
            >
              <input v-model="inheritChecked" type="checkbox" style="margin-top: 2px" />
              <span class="text-text-2" style="font-size: 11.5px; line-height: 1.45">
                {{ $t('worktree.create.inheritControl') }}
              </span>
            </label>
          </template>

          <!-- ============================ PHASE B: progress stepper ========== -->
          <template v-else>
            <ol style="display: flex; flex-direction: column; gap: 10px; margin: 0; padding: 0">
              <li
                v-for="stage in STAGES"
                :key="stage"
                class="flex items-center"
                style="gap: 10px; list-style: none"
              >
                <span
                  class="flex shrink-0 items-center justify-center"
                  style="width: 14px; height: 14px"
                >
                  <Check
                    v-if="stageState[stage] === 'done'"
                    :size="13"
                    :stroke-width="2"
                    class="text-green"
                  />
                  <X
                    v-else-if="stageState[stage] === 'failed'"
                    :size="13"
                    :stroke-width="2"
                    class="text-red"
                  />
                  <span
                    v-else-if="stageState[stage] === 'running'"
                    class="anim-shimmer-dot rounded-full bg-accent"
                    style="width: 7px; height: 7px"
                  />
                  <span
                    v-else
                    class="rounded-full bg-text-4"
                    style="width: 6px; height: 6px; opacity: 0.5"
                  />
                </span>
                <span
                  style="font-size: 12.5px"
                  :class="{
                    'text-text': stageState[stage] === 'running',
                    'text-text-2': stageState[stage] === 'done',
                    'text-red': stageState[stage] === 'failed',
                    'text-text-4': stageState[stage] === 'pending'
                  }"
                >
                  {{ $t('worktree.create.stages.' + STAGE_KEY[stage]) }}
                </span>
              </li>
            </ol>

            <!-- Verbatim create error (engine already rolled back) -->
            <p
              v-if="createError"
              class="border text-red"
              style="
                border-color: var(--color-red-soft);
                background: var(--color-red-soft);
                border-radius: 5px;
                padding: 8px 10px;
                font-size: 11.5px;
                line-height: 17px;
                margin-top: 14px;
                white-space: pre-wrap;
              "
            >
              {{ createError }}
            </p>
          </template>
        </div>

        <!-- Footer -->
        <footer
          class="flex shrink-0 items-center justify-end border-t border-border"
          style="padding: 12px 18px; gap: 8px"
        >
          <template v-if="phase === 'form'">
            <button
              class="border border-border bg-transparent text-text-2 transition hover:text-text"
              style="
                padding: 7px 14px;
                font-size: 12.5px;
                font-weight: 500;
                border-radius: 5px;
                height: 28px;
              "
              @click="close()"
            >
              {{ $t('actions.cancel') }}
            </button>
            <button
              class="inline-flex items-center bg-accent text-accent-ink transition"
              style="
                gap: 6px;
                padding: 7px 14px;
                font-size: 12.5px;
                font-weight: 500;
                border-radius: 5px;
                border: none;
                height: 28px;
              "
              :style="{
                opacity: canCreate ? 1 : 0.4,
                cursor: canCreate ? 'pointer' : 'not-allowed'
              }"
              :disabled="!canCreate"
              @click="create()"
            >
              <GitBranch :size="13" :stroke-width="1.8" />
              {{ $t('worktree.create.confirm') }}
            </button>
          </template>

          <!-- Progress, still running: a disabled "Creating…" affordance. -->
          <template v-else-if="!createError">
            <button
              class="bg-accent text-accent-ink"
              style="
                padding: 7px 14px;
                font-size: 12.5px;
                font-weight: 500;
                border-radius: 5px;
                border: none;
                height: 28px;
                opacity: 0.4;
                cursor: not-allowed;
              "
              disabled
            >
              {{ $t('worktree.create.creating') }}
            </button>
          </template>

          <!-- Progress, failed: Back to form or Close. -->
          <template v-else>
            <button
              class="border border-border bg-transparent text-text-2 transition hover:text-text"
              style="
                padding: 7px 14px;
                font-size: 12.5px;
                font-weight: 500;
                border-radius: 5px;
                height: 28px;
              "
              @click="close()"
            >
              {{ $t('actions.cancel') }}
            </button>
            <button
              class="border border-border bg-surface text-text transition hover:bg-surface-2"
              style="
                padding: 7px 14px;
                font-size: 12.5px;
                font-weight: 500;
                border-radius: 5px;
                height: 28px;
              "
              @click="backToForm()"
            >
              {{ $t('worktree.create.back') }}
            </button>
          </template>
        </footer>
      </div>
    </div>
  </Teleport>
</template>
