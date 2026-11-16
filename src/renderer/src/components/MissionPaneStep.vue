<script setup lang="ts">
import { ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { Check, Flag, Link as LinkIcon } from 'lucide-vue-next'
import { useMissionsStore, type V4DoorCall } from '../stores/missions'
import {
  doorErrorKey,
  formatWaited,
  linkLabelParts,
  type CriterionRow,
  type PaneStepRow,
  type StepLinkRow
} from '../lib/mission-pane-view'

/**
 * An open step (Missions v4 S-19, design.md §6 "Mission pane" → An open step): what the operator reads
 * when they open a step in the tree — the blocker and the one button that clears it, the acceptance
 * criteria with who settles each (the verified ones folded into one line, only the open ones listed),
 * and the links the step's session wrote.
 *
 * It READS the row `buildPaneTree` made and computes no state: which criteria are settled, what blocks
 * the step and where a link goes were decided there, from the server's view. The only things it does
 * are the operator's doors — mark a criterion, clear a blocker — and every one goes through the store,
 * which calls `mission:v4Door` and reads the view again. A door never refuses the operator; when one
 * comes back refused the pane says what to do (never the code) and shows the latest.
 */
const props = defineProps<{ step: PaneStepRow }>()

const { t } = useI18n()
const missions = useMissionsStore()

const busy = ref(false)
const failure = ref<string | null>(null)

async function run(call: V4DoorCall): Promise<void> {
  if (busy.value) return
  busy.value = true
  failure.value = null
  try {
    const res = await missions.runV4Door(call)
    if (!res.ok) {
      failure.value = t(`missionPane.step.error.${doorErrorKey(res.code)}`)
    }
  } finally {
    busy.value = false
  }
}

const clearBlocker = (blockerId: string): Promise<void> =>
  run({ door: 'clearBlocker', blockerId, stepId: props.step.id })
const markCriterion = (criterionId: string): Promise<void> =>
  run({ door: 'mark', stepId: props.step.id, criterionId })

/** Open an address in the browser; a failure to open is not the mission's, so it is swallowed. */
function openLink(url: string): void {
  void Promise.resolve(window.api.shellOpenExternal(url)).catch(() => undefined)
}

const settlerText = (c: CriterionRow): string =>
  c.settler === 'person'
    ? c.person
      ? t('missionPane.step.by.person', { person: c.person })
      : t('missionPane.step.by.personUnnamed')
    : t(`missionPane.step.by.${c.settler}`)

const markText = (c: CriterionRow): string =>
  t(c.settler === 'person' ? 'missionPane.step.markPerson' : 'missionPane.step.mark')

const linkText = (l: StepLinkRow): string =>
  l.kind === 'page' ? t('missionPane.step.page', { address: l.label }) : l.label

function blockedHead(owner: 'agent' | 'operator', waitedMs: number | null, age: string): string {
  const head = t(
    owner === 'operator' ? 'missionPane.step.blocked.you' : 'missionPane.step.blocked.session'
  )
  return waitedMs === null ? head : t('missionPane.step.blocked.withAge', { head, age })
}
</script>

<template>
  <div
    class="flex flex-col"
    style="margin: 2px 0 8px 29px; gap: 8px"
    data-test="step-open"
    :data-step="step.id"
  >
    <!-- The blocker: the exact thing needed, then the one button that is the operator's. -->
    <div
      v-for="b in step.blockers"
      :key="b.id"
      class="flex flex-col rounded-sm border border-red-line bg-red-soft text-text"
      style="padding: 8px 10px; gap: 6px; font-size: 12px"
      data-test="blocker"
      :data-blocker="b.id"
    >
      <span
        class="flex items-center uppercase text-red"
        style="gap: 6px; font-size: 10px; font-weight: 700; letter-spacing: 0.06em"
        data-test="blocker-head"
      >
        <Flag :size="13" :stroke-width="2" class="shrink-0" aria-hidden="true" />
        {{ blockedHead(b.owner, b.waitedMs, b.waitedMs === null ? '' : formatWaited(b.waitedMs)) }}
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
      <span v-if="b.owner === 'operator'" class="flex" style="gap: 6px">
        <button
          type="button"
          class="rounded-sm border border-transparent bg-accent text-accent-ink transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40"
          style="padding: 2px 7px; font-size: 11px; font-weight: 500"
          :disabled="busy"
          data-test="blocker-clear"
          @click="clearBlocker(b.id)"
        >
          {{ $t('missionPane.step.clear') }}
        </button>
      </span>
    </div>

    <!-- Acceptance criteria: the settled ones fold into one line; only the open ones are listed. -->
    <div class="flex flex-col" style="gap: 5px" data-test="criteria" :data-step="step.id">
      <span
        class="uppercase text-text-4"
        style="font-size: 10px; font-weight: 700; letter-spacing: 0.07em"
        >{{ $t('missionPane.step.criteria') }}</span
      >
      <div
        v-if="step.verified > 0"
        class="grid items-start text-text-2"
        style="grid-template-columns: 12px minmax(0, 1fr); column-gap: 8px; font-size: 11.5px"
        data-test="criteria-verified"
      >
        <span
          class="flex items-center justify-center rounded-full bg-green"
          style="width: 12px; height: 12px; margin-top: 1px"
          aria-hidden="true"
          ><Check :size="8" :stroke-width="3" class="text-bg"
        /></span>
        <span>{{ $t('missionPane.step.verified', { n: step.verified }, step.verified) }}</span>
      </div>
      <div
        v-for="c in step.open"
        :key="c.id"
        class="grid items-start text-text"
        style="
          grid-template-columns: 12px minmax(0, 1fr) auto;
          column-gap: 8px;
          row-gap: 3px;
          font-size: 11.5px;
        "
        data-test="criterion"
        :data-criterion="c.id"
        :data-settler="c.settler"
        data-settled="false"
      >
        <span
          class="rounded-sm border-[1.5px] border-text-3"
          style="width: 12px; height: 12px; margin-top: 1px"
          role="img"
          :aria-label="$t('missionPane.tree.criterionOpen')"
        />
        <span class="min-w-0 break-words" data-test="criterion-text">{{ c.text }}</span>
        <span
          class="flex flex-wrap items-center justify-end @max-[340px]:col-start-2 @max-[340px]:row-start-2 @max-[340px]:justify-start"
          style="gap: 6px"
        >
          <span class="text-text-4" style="font-size: 10.5px" data-test="criterion-by">{{
            settlerText(c)
          }}</span>
          <button
            v-if="c.canMark"
            type="button"
            class="rounded-sm border border-border-2 text-text-2 transition hover:bg-surface-2 hover:text-text disabled:cursor-not-allowed disabled:opacity-40"
            style="padding: 1px 7px; font-size: 11px"
            :disabled="busy"
            :title="
              c.settler === 'person' && c.person
                ? $t('missionPane.step.markPersonTitle', { person: c.person })
                : undefined
            "
            data-test="criterion-mark"
            @click="markCriterion(c.id)"
          >
            {{ markText(c) }}
          </button>
        </span>
        <span
          v-if="c.selfCheck"
          class="text-text-4"
          style="grid-column: 2 / -1; font-size: 10.5px"
          data-test="criterion-selfcheck"
          >{{ $t('missionPane.step.selfCheck') }}</span
        >
      </div>
      <span
        v-if="step.criteria.length === 0"
        class="text-text-4"
        style="font-size: 11px"
        data-test="criteria-none"
        >{{ $t('missionPane.tree.noCriteria') }}</span
      >
    </div>

    <!-- Links the step's session wrote: the pull request, the finished page, reports. -->
    <div class="flex flex-col" style="gap: 5px" data-test="step-links" :data-step="step.id">
      <span
        class="uppercase text-text-4"
        style="font-size: 10px; font-weight: 700; letter-spacing: 0.07em"
        data-test="step-links-title"
        >{{ $t('missionPane.step.linksTitle') }}</span
      >
      <div v-if="step.links.length > 0" class="flex flex-wrap" style="gap: 6px">
        <template v-for="l in step.links" :key="l.key">
          <button
            v-if="l.url"
            type="button"
            role="link"
            class="inline-flex max-w-full items-center overflow-hidden rounded-sm border border-border-2 text-accent transition hover:border-accent-line"
            style="gap: 4px; padding: 1px 6px; font-size: 11px"
            :title="$t('missionPane.step.openLink', { label: linkText(l) })"
            data-test="step-link"
            :data-kind="l.kind"
            @click="openLink(l.url)"
          >
            <LinkIcon :size="10" :stroke-width="1.5" class="shrink-0" aria-hidden="true" />
            <!-- A break falls only after a separator (a slash, a dot, a dash) or a space, never inside a word. -->
            <span class="min-w-0 break-normal text-left" :class="l.kind === 'pr' ? 'font-mono' : ''"
              ><template v-for="(part, i) in linkLabelParts(linkText(l))" :key="i"
                >{{ part }}<wbr v-if="i < linkLabelParts(linkText(l)).length - 1" /></template
            ></span>
          </button>
          <span
            v-else
            class="inline-flex max-w-full items-center overflow-hidden rounded-sm border border-border-2 text-text-3"
            style="gap: 4px; padding: 1px 6px; font-size: 11px"
            :title="linkText(l)"
            data-test="step-link"
            :data-kind="l.kind"
          >
            <span class="min-w-0 break-normal" :class="l.kind === 'pr' ? 'font-mono' : ''"
              ><template v-for="(part, i) in linkLabelParts(linkText(l))" :key="i"
                >{{ part }}<wbr v-if="i < linkLabelParts(linkText(l)).length - 1" /></template
            ></span>
          </span>
        </template>
      </div>
      <span v-else class="text-text-4" style="font-size: 11px" data-test="step-links-empty">{{
        $t('missionPane.step.linksNone')
      }}</span>
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
