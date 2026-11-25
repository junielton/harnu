<script setup lang="ts">
/**
 * Mission dropdown — an open step (Missions v4 mission dropdown S-4, card BUG-288; design.md §6 "Mission
 * dropdown" → "What it draws" 4; mockup `docs/design/mission-dropdown/`, states `step-open` and `blocked`).
 *
 * What the operator reads when they open a step in the tree, top to bottom: the blocker (the reason, the exact
 * ask, what it unblocks, how long it has waited, and "Done, continue" only when the blocker is the operator's),
 * "Criteria" (the settled ones folded into one line, the open ones with who settles each and the button that is
 * the operator's), and "Links" (the pull request, a worktree as its branch name, one "Evidence" link, an
 * address on this machine). A door that fails shows one red box with what to do under the last block.
 *
 * It READS the row `buildPaneTree` made and computes no state: which criteria are settled, what blocks the step
 * and where a pull request opens were decided there, from the server's view. The only things it does are the
 * operator's doors (mark a criterion, clear a blocker), each through the store, which calls `mission:v4Door`
 * and reads the view again; and the links' own clicks (`lib/mission-dropdown-links.ts` decides what each is).
 *
 * "Test it" (S-6): at the right end of the Criteria heading, drawn only when `walkEntryAvailable(source)` says a
 * walk can start from this step. A click emits `walk` with the source; the shell calls `startWalk` and closes.
 *
 * Width: the dropdown's body is the size container, so "below 380px" answers to its own width, never the
 * window's: the who-settles cell goes under the criterion's text.
 */
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  Check,
  Copy,
  FileText,
  Flag,
  GitBranch,
  Link as LinkIcon,
  ListChecks
} from 'lucide-vue-next'
import MissionDot from './MissionDot.vue'
import { useMissionsStore, type V4DoorCall } from '../stores/missions'
import { useSessionsStore } from '../stores/sessions'
import { useHelpersStore } from '../stores/helpers'
import { walkEntryAvailable, type WalkSource } from '../lib/walk-entry'
import {
  doorErrorKey,
  formatWaited,
  linkLabelParts,
  type CriterionRow,
  type PaneStepRow
} from '../lib/mission-pane-view'
import {
  dropdownLinks,
  pathsToProbe,
  type DropdownLink,
  type KnownFolder,
  type PathKind,
  type RawLink
} from '../lib/mission-dropdown-links'

const props = defineProps<{
  /** The mission the step belongs to: the source a walk starts from names it. */
  missionId: string
  step: PaneStepRow
  /** The links the record holds for this step: the paths (a worktree, the evidence) are read from them. */
  rawLinks: readonly RawLink[]
}>()

const emit = defineEmits<{
  /** "Test it": a walk is asked for from this step; the shell starts it and closes the dropdown. */
  walk: [source: WalkSource]
}>()

const { t } = useI18n()
const missions = useMissionsStore()
const sessions = useSessionsStore()
const helpers = useHelpersStore()

// ---- the doors ---------------------------------------------------------------------------------------------

const busy = ref(false)
const failure = ref<string | null>(null)

async function run(call: V4DoorCall): Promise<void> {
  if (busy.value) return
  busy.value = true
  failure.value = null
  try {
    const res = await missions.runV4Door(call)
    if (!res.ok) failure.value = t(`missionDropdown.step.error.${doorErrorKey(res.code)}`)
  } finally {
    busy.value = false
  }
}

const clearBlocker = (blockerId: string): Promise<void> =>
  run({ door: 'clearBlocker', blockerId, stepId: props.step.id })
const markCriterion = (criterionId: string): Promise<void> =>
  run({ door: 'mark', stepId: props.step.id, criterionId })

const settlerText = (c: CriterionRow): string =>
  c.settler === 'person'
    ? c.person
      ? t('missionDropdown.step.by.person', { person: c.person })
      : t('missionDropdown.step.by.personUnnamed')
    : t(`missionDropdown.step.by.${c.settler}`)

const markText = (c: CriterionRow): string =>
  t(c.settler === 'person' ? 'missionDropdown.step.markPerson' : 'missionDropdown.step.mark')

function blockedHead(owner: 'agent' | 'operator', waitedMs: number | null): string {
  const head = t(
    owner === 'operator'
      ? 'missionDropdown.step.blocked.you'
      : 'missionDropdown.step.blocked.session'
  )
  return waitedMs === null
    ? head
    : t('missionDropdown.step.blocked.withAge', { head, age: formatWaited(waitedMs) })
}

// ---- Test it ------------------------------------------------------------------------------------------------

const walkSource = computed<WalkSource>(() => ({
  kind: 'step',
  missionId: props.missionId,
  stepId: props.step.id
}))
/** Drawn only where the provider says a walk can start: the dropdown holds no other rule about it. */
const canWalk = computed(() => walkEntryAvailable(walkSource.value))

// ---- the links ---------------------------------------------------------------------------------------------

/** The folder the step belongs to: the viewer pane opens in it, and a tooltip's path is relative to it. */
const root = computed<string | null>(
  () => sessions.selectedSession?.projectPath ?? sessions.activeFolderPath ?? null
)

/** What the disk says about the paths the links name; empty until it answers. */
const kinds = ref<Record<string, PathKind>>({})
let gone = false
onBeforeUnmount(() => {
  gone = true
  if (copiedTimer) clearTimeout(copiedTimer)
})

const probePaths = computed(() => pathsToProbe(props.rawLinks, root.value))
watch(
  () => probePaths.value.join('\n'),
  async () => {
    const paths = probePaths.value
    if (paths.length === 0) {
      kinds.value = {}
      return
    }
    const ask = window.api?.missionPathKinds
    if (typeof ask !== 'function') return
    try {
      const answer = await ask(paths)
      if (!gone) kinds.value = answer && typeof answer === 'object' ? answer : {}
    } catch {
      // The disk could not be asked: a worktree reads as present and the evidence is not drawn.
    }
  },
  { immediate: true }
)

const knownFolders = computed<KnownFolder[]>(() =>
  sessions.folders.map((f) => ({ path: f.path, gitBranch: f.gitBranch || null, pinned: f.pinned }))
)

const links = computed<DropdownLink[]>(() =>
  dropdownLinks({
    rows: props.step.links,
    raw: props.rawLinks,
    folders: knownFolders.value,
    kinds: kinds.value,
    root: root.value
  })
)

/** Open an address in the browser; a failure to open is not the mission's, so it is swallowed. */
function openAddress(url: string): void {
  void Promise.resolve(window.api.shellOpenExternal(url)).catch(() => undefined)
}

/** The worktree whose "add it to the sidebar?" offer is open. */
const offering = ref<string | null>(null)

/** A drag that ends on the label is a selection, not a click. */
const selecting = (): boolean => (window.getSelection?.()?.toString() ?? '') !== ''

function openWorktree(l: DropdownLink): void {
  if (selecting() || !l.path) return
  if (l.action === 'select') {
    sessions.selectFolder(l.path)
  } else if (l.action === 'offer-add') {
    offering.value = offering.value === l.key ? null : l.key
  }
}

async function addWorktree(l: DropdownLink): Promise<void> {
  if (!l.path) return
  offering.value = null
  try {
    await sessions.pinFolder(l.path)
  } catch {
    // The folder could not be added: nothing is selected.
    return
  }
  sessions.selectFolder(l.path)
}

function openEvidence(l: DropdownLink): void {
  if (selecting() || !l.target || !root.value) return
  helpers.addMarkdownHelper(root.value, l.target, root.value)
}

const open = (l: DropdownLink): void => (l.kind === 'worktree' ? openWorktree(l) : openEvidence(l))

/** The link whose path was just copied: its button says so for a moment. */
const copied = ref<string | null>(null)
let copiedTimer: ReturnType<typeof setTimeout> | null = null

async function copyPath(l: DropdownLink): Promise<void> {
  if (!l.path) return
  try {
    await navigator.clipboard.writeText(l.path)
  } catch {
    // The clipboard is unavailable: nothing was copied, so nothing is acknowledged.
    return
  }
  copied.value = l.key
  if (copiedTimer) clearTimeout(copiedTimer)
  copiedTimer = setTimeout(() => (copied.value = null), 1800)
}

const withPath = (title: string, l: DropdownLink): string =>
  l.relPath ? t('missionDropdown.step.titleWithPath', { title, path: l.relPath }) : title

const openTitle = (l: DropdownLink): string =>
  l.kind === 'evidence'
    ? withPath(t('missionDropdown.step.evidenceTitle'), l)
    : withPath(t('missionDropdown.step.worktreeTitle'), l)

const addressText = (l: DropdownLink): string =>
  l.kind === 'page' ? t('missionDropdown.step.page', { address: l.label }) : l.label

const labelText = (l: DropdownLink): string =>
  l.kind === 'evidence' ? t('missionDropdown.step.evidence') : l.label

const offered = computed(() => links.value.find((l) => l.key === offering.value) ?? null)

/** A compact chip: `border-border-2`, 11px, the accent for what opens. */
const CHIP =
  'inline-flex max-w-full items-center overflow-hidden rounded-sm border border-border-2 text-accent'
</script>

<template>
  <div
    class="flex flex-col"
    style="margin: 2px 0 8px 29px; gap: 9px"
    role="group"
    data-test="step-body"
    :data-step="step.id"
  >
    <!-- The blocker: the exact thing needed, then the one button that is the operator's. -->
    <div
      v-for="b in step.blockers"
      :key="b.id"
      class="flex flex-col rounded-sm border border-red-line bg-red-soft text-text"
      style="padding: 8px 10px; gap: 5px; font-size: 12px"
      data-test="blocker"
      :data-blocker="b.id"
    >
      <span
        class="flex items-center uppercase text-red"
        style="gap: 5px; font-size: 10px; font-weight: 700; letter-spacing: 0.06em"
        data-test="blocker-head"
      >
        <Flag :size="10" :stroke-width="2" class="shrink-0" aria-hidden="true" />
        {{ blockedHead(b.owner, b.waitedMs) }}
      </span>
      <span class="break-words" style="line-height: 1.4" data-test="blocker-reason">{{
        b.reason
      }}</span>
      <span
        v-if="b.ask"
        class="break-words"
        style="line-height: 1.4; font-weight: 500"
        data-test="blocker-ask"
        >{{ b.ask }}</span
      >
      <span
        v-if="b.unblocks"
        class="break-words text-text-3"
        style="font-size: 11px; line-height: 1.4"
        data-test="blocker-unblocks"
        >{{ b.unblocks }}</span
      >
      <span v-if="b.owner === 'operator'" class="flex rounded-sm" style="gap: 6px">
        <span class="rounded-sm">
          <button
            type="button"
            class="inline-flex h-5 items-center justify-center gap-1 whitespace-nowrap rounded-sm border border-accent bg-accent px-2 text-[11px] font-medium leading-none text-accent-ink transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40"
            :disabled="busy"
            data-test="blocker-clear"
            @click="clearBlocker(b.id)"
          >
            <Check :size="10" :stroke-width="2" aria-hidden="true" />{{
              $t('missionDropdown.step.clear')
            }}
          </button>
        </span>
      </span>
    </div>

    <!-- Criteria: the settled ones fold into one line; only the open ones are listed. -->
    <div class="flex flex-col" style="gap: 6px" data-test="criteria" :data-step="step.id">
      <div class="flex items-center justify-between rounded-sm" style="gap: 8px">
        <span
          class="uppercase text-text-4"
          style="font-size: 10px; font-weight: 700; letter-spacing: 0.07em"
          data-test="criteria-heading"
          >{{ $t('missionDropdown.step.criteria') }}</span
        >
        <span v-if="canWalk" class="inline-flex rounded-sm">
          <button
            type="button"
            class="inline-flex h-5 items-center justify-center gap-1 whitespace-nowrap rounded-sm border border-border-2 bg-surface-2 px-2 text-[11px] font-medium leading-none text-text transition hover:border-text-4"
            :title="$t('missionDropdown.testIt.step.tip')"
            :aria-label="
              $t('missionDropdown.testIt.aria', { what: $t('missionDropdown.testIt.step.tip') })
            "
            data-test="test-it-step"
            @click="emit('walk', walkSource)"
          >
            <ListChecks :size="10" :stroke-width="2" aria-hidden="true" />{{
              $t('missionDropdown.testIt.label')
            }}
          </button>
        </span>
      </div>
      <div
        v-if="step.verified > 0"
        class="grid items-start text-text-2"
        style="grid-template-columns: 12px minmax(0, 1fr); column-gap: 8px; font-size: 11.5px"
        data-test="criteria-verified"
      >
        <MissionDot kind="criterion" state="settled" />
        <span>{{ $t('missionDropdown.step.verified', { n: step.verified }, step.verified) }}</span>
      </div>
      <div
        v-for="c in step.open"
        :key="c.id"
        class="grid items-start text-text"
        style="
          grid-template-columns: 12px minmax(0, 1fr) auto;
          column-gap: 8px;
          row-gap: 4px;
          font-size: 11.5px;
        "
        data-test="criterion-row"
        :data-criterion="c.id"
        :data-settler="c.settler"
        data-settled="false"
      >
        <MissionDot kind="criterion" state="open" />
        <span class="min-w-0 [overflow-wrap:anywhere]" data-test="criterion">{{ c.text }}</span>
        <span
          class="flex flex-wrap items-center justify-end rounded-sm @max-[379px]:col-start-2 @max-[379px]:row-start-2 @max-[379px]:justify-start"
          style="gap: 6px"
          data-test="criterion-who"
        >
          <span class="text-text-4" style="font-size: 10.5px" data-test="criterion-by">{{
            settlerText(c)
          }}</span>
          <span v-if="c.canMark" class="rounded-sm">
            <button
              type="button"
              class="inline-flex h-5 items-center justify-center gap-1 whitespace-nowrap rounded-sm border border-border-2 bg-surface-2 px-2 text-[11px] font-medium leading-none text-text transition hover:border-text-4 disabled:cursor-not-allowed disabled:opacity-40"
              :disabled="busy"
              :title="
                c.settler === 'person' && c.person
                  ? $t('missionDropdown.step.markPersonTitle', { person: c.person })
                  : undefined
              "
              data-test="criterion-mark"
              @click="markCriterion(c.id)"
            >
              <Check :size="10" :stroke-width="2" aria-hidden="true" />{{ markText(c) }}
            </button>
          </span>
        </span>
        <span
          v-if="c.selfCheck"
          class="text-text-4"
          style="grid-column: 2 / -1; font-size: 10.5px"
          data-test="criterion-selfcheck"
          >{{ $t('missionDropdown.step.selfCheck') }}</span
        >
      </div>
      <span
        v-if="step.criteria.length === 0"
        class="text-text-4"
        style="font-size: 11px"
        data-test="criteria-none"
        >{{ $t('missionDropdown.tree.noCriteria') }}</span
      >
    </div>

    <!-- Links: only what opens something; no link, no heading. A path is never drawn, only copied. -->
    <div v-if="links.length > 0" class="flex flex-col" style="gap: 6px" data-test="step-links">
      <span
        class="uppercase text-text-4"
        style="font-size: 10px; font-weight: 700; letter-spacing: 0.07em"
        data-test="step-links-title"
        >{{ $t('missionDropdown.step.links') }}</span
      >
      <div class="flex flex-wrap rounded-sm" style="gap: 6px">
        <template v-for="l in links" :key="l.key">
          <!-- An address: a link to the browser. The pull request never toggles the step. -->
          <span v-if="l.url" class="inline-flex max-w-full rounded-sm">
            <button
              type="button"
              role="link"
              :class="[CHIP, 'transition hover:border-accent-line']"
              style="gap: 4px; padding: 1px 6px; font-size: 11px"
              :title="$t('missionDropdown.step.openLink', { label: addressText(l) })"
              data-test="step-link"
              :data-kind="l.kind"
              @click.stop="openAddress(l.url)"
            >
              <LinkIcon :size="10" :stroke-width="1.5" class="shrink-0" aria-hidden="true" />
              <!-- A break falls only after a separator (a slash, a dot, a dash) or a space, never inside a word. -->
              <span
                class="min-w-0 break-normal text-left"
                :class="l.kind === 'pr' ? 'font-mono' : ''"
                ><template v-for="(part, i) in linkLabelParts(addressText(l))" :key="i"
                  >{{ part }}<wbr v-if="i < linkLabelParts(addressText(l)).length - 1" /></template
              ></span>
            </button>
          </span>

          <!-- A path link (a worktree, the evidence): the label opens it, the copy button copies the path. -->
          <span
            v-else
            class="inline-flex max-w-full items-stretch overflow-hidden rounded-sm border border-border-2 transition hover:border-accent-line"
            :class="l.removed ? 'text-text-3' : 'text-accent'"
            style="font-size: 11px"
            data-test="step-link"
            :data-kind="l.kind"
          >
            <!-- The label is a span, not a button: a button's text cannot be selected. -->
            <span
              v-if="!l.removed"
              role="link"
              tabindex="0"
              class="inline-flex min-w-0 cursor-pointer items-center rounded-sm"
              style="gap: 4px; padding: 1px 6px"
              :title="openTitle(l)"
              data-test="link-open"
              @click="open(l)"
              @keydown.enter="open(l)"
              @keydown.space.prevent="open(l)"
            >
              <FileText
                v-if="l.kind === 'evidence'"
                :size="10"
                :stroke-width="1.5"
                class="shrink-0"
                aria-hidden="true"
              />
              <GitBranch
                v-else
                :size="10"
                :stroke-width="1.5"
                class="shrink-0"
                aria-hidden="true"
              />
              <span class="min-w-0 select-text break-all text-left" data-test="link-label">{{
                labelText(l)
              }}</span>
            </span>
            <!-- A path that no longer exists stays readable and opens nothing. -->
            <span
              v-else
              class="inline-flex min-w-0 items-center rounded-sm"
              style="gap: 4px; padding: 1px 6px"
              data-test="link-removed"
            >
              <GitBranch :size="10" :stroke-width="1.5" class="shrink-0" aria-hidden="true" />
              <span class="min-w-0 select-text break-all" data-test="link-label">{{
                labelText(l)
              }}</span>
              <span class="shrink-0 text-text-4" data-test="link-removed-note">{{
                $t('missionDropdown.step.removed')
              }}</span>
            </span>
            <span class="inline-flex rounded-sm">
              <button
                type="button"
                class="inline-flex items-center border-l border-border-2 text-text-4 transition hover:text-text"
                style="padding: 1px 5px"
                :aria-label="
                  copied === l.key
                    ? $t('missionDropdown.step.copied')
                    : $t('missionDropdown.step.copy')
                "
                :title="
                  copied === l.key
                    ? $t('missionDropdown.step.copied')
                    : $t('missionDropdown.step.copy')
                "
                data-test="link-copy"
                @click="copyPath(l)"
              >
                <Check v-if="copied === l.key" :size="10" :stroke-width="2" aria-hidden="true" />
                <Copy v-else :size="10" :stroke-width="1.5" aria-hidden="true" />
              </button>
            </span>
          </span>
        </template>
      </div>
      <span class="sr-only" role="status" data-test="link-copied">{{
        copied ? $t('missionDropdown.step.copied') : ''
      }}</span>

      <!-- A worktree that is not in the sidebar: say so, and offer to add it. -->
      <div
        v-if="offered"
        class="flex flex-wrap items-center rounded-sm border border-border-2 bg-surface-2 text-text-2"
        style="gap: 6px 8px; padding: 6px 8px; font-size: 11.5px"
        role="group"
        data-test="link-add-offer"
      >
        <span class="min-w-0">{{ $t('missionDropdown.step.addOffer') }}</span>
        <span class="flex rounded-sm" style="gap: 6px">
          <span class="rounded-sm">
            <button
              type="button"
              class="inline-flex h-5 items-center justify-center gap-1 whitespace-nowrap rounded-sm border border-accent bg-accent px-2 text-[11px] font-medium leading-none text-accent-ink transition hover:brightness-110"
              data-test="link-add"
              @click="addWorktree(offered)"
            >
              {{ $t('missionDropdown.step.add') }}
            </button>
          </span>
          <span class="rounded-sm">
            <button
              type="button"
              class="inline-flex h-5 items-center justify-center gap-1 whitespace-nowrap rounded-sm border border-border-2 bg-surface-2 px-2 text-[11px] font-medium leading-none text-text transition hover:border-text-4"
              data-test="link-add-cancel"
              @click="offering = null"
            >
              {{ $t('missionDropdown.step.addCancel') }}
            </button>
          </span>
        </span>
      </div>
    </div>

    <span
      v-if="failure"
      class="break-words rounded-sm border border-red-line bg-red-soft text-text"
      style="padding: 6px 10px; font-size: 11.5px; line-height: 1.4"
      role="alert"
      data-test="door-error"
      >{{ failure }}</span
    >
  </div>
</template>
