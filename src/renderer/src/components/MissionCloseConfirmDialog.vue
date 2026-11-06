<script setup lang="ts">
/**
 * Mission end dialog (T370 AC-S9-8; Mission v3 §3.5 — design.md §6 "Mission
 * progress" → End dialog). ONE dialog ends any non-closed mission, with a
 * choice: **Close as delivered** or **Discard**, plus an optional reason that
 * goes to the mission's Log. It lists the server's `closeWarnings` as warnings —
 * they never disable or hide the confirm. Ending is the one irreversible
 * operator door, so the popover's buttons only open this dialog; `confirm` is
 * the only path to the end door.
 *
 * Anatomy borrowed from `RemoveWorktreeDialog` — Teleport → overlay-fade
 * backdrop → fade-in-scale card, focus trap, Esc + backdrop close — with the
 * canonical `Button` in the footer. Opening it plays the confirm chime and
 * raises OS attention, the pair the "Safety confirms — sound + attention" rule
 * fires: an irreversible decision is never a silent one.
 *
 * The backdrop carries `data-mission-close-confirm` so the pill's click-outside
 * leaves the popover open behind it; the capture-phase Esc listener stops the
 * key before the popover's own Esc handler sees it.
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { Check, Trash2, TriangleAlert, X } from 'lucide-vue-next'
import { useFocusTrap } from '../composables/useFocusTrap'
import { playNotificationSound } from '../lib/notification-sound'
import type { EndChoice, EndWarning } from '../lib/mission-view'
import type { MemoryDraft } from '../../../main/consolidator-core'
import { citationRefs, draftExcerpt, draftHeading } from '../lib/memory-draft-view'
import Button from './ui/Button.vue'

const props = withDefaults(
  defineProps<{
    title: string
    busy: boolean
    /** The server's `closeWarnings`, as `endWarnings(view)` — step titles, never ids. Shown, never enforced. */
    warnings?: EndWarning[]
    /** The choice the dialog opens on. */
    initial?: EndChoice
    /** Campaign ch.6 — the memory drafts the consolidator stored on the mission. */
    drafts?: MemoryDraft[]
    /** Campaign ch.6 — the consolidator found nothing worth recording. */
    nothingNotable?: boolean
  }>(),
  { warnings: () => [], initial: 'delivered', drafts: () => [], nothingNotable: false }
)
const emit = defineEmits<{
  cancel: []
  confirm: [closedAs: EndChoice, reason?: string, record?: string[]]
}>()

const { t } = useI18n()

const choice = ref<EndChoice>(props.initial)
const reason = ref('')
/** Draft ids the operator ticked under "Also record" — unticked by default, kept across a switch to Discard. */
const ticked = ref<string[]>([])
/** The panel shows only for a delivered end that has something to say. */
const showRecord = computed(
  () => choice.value === 'delivered' && (props.drafts.length > 0 || props.nothingNotable)
)

const WARNING_KEY: Record<EndWarning['kind'], string> = {
  'end-unverified': 'endUnverified',
  'left-behind': 'leftBehind',
  'checks-open': 'checksOpen',
  'blockers-open': 'blockersOpen',
  'rescope-staged': 'rescopeStaged'
}

/** Kinds whose heading counts matters — the i18n plural takes `count`. */
const COUNTED = new Set<EndWarning['kind']>(['left-behind', 'checks-open', 'blockers-open'])

function warningHeading(w: EndWarning): string {
  const key = `mission.end.warnings.${WARNING_KEY[w.kind]}`
  return COUNTED.has(w.kind) ? t(key, w.count) : t(key)
}

const CHOICES: ReadonlyArray<{ value: EndChoice; label: string; hint: string }> = [
  { value: 'delivered', label: 'mission.end.asDelivered', hint: 'mission.end.asDeliveredHint' },
  { value: 'discarded', label: 'mission.end.asDiscarded', hint: 'mission.end.asDiscardedHint' }
]

function onConfirm(): void {
  const why = reason.value.trim()
  // Only a delivered end records; ids follow the order the record stores the drafts in.
  const record =
    choice.value === 'delivered'
      ? props.drafts.filter((d) => ticked.value.includes(d.id)).map((d) => d.id)
      : []
  emit('confirm', choice.value, why || undefined, record.length ? record : undefined)
}

const dialogRef = ref<HTMLElement | null>(null)
const cancelRef = ref<InstanceType<typeof Button> | null>(null)
/** Initial focus is Cancel — the dialog exists to stop a stray click or Enter. */
const cancelEl = computed<HTMLElement | null>(() => (cancelRef.value?.$el as HTMLElement) ?? null)

useFocusTrap({
  active: computed(() => true),
  containerRef: dialogRef,
  initialFocusRef: cancelEl
})

function onBackdropMousedown(e: MouseEvent): void {
  if (e.target === e.currentTarget) emit('cancel')
}

function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape') {
    e.stopPropagation()
    emit('cancel')
  }
}

onMounted(() => {
  window.addEventListener('keydown', onKeydown, true)
  try {
    playNotificationSound()
    window.api.requestAttention()
  } catch {
    /* no audio device / IPC teardown — the dialog still guards the door */
  }
})
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown, true)
})
</script>

<template>
  <Teleport to="body">
    <div
      class="anim-overlay-fade fixed inset-0 flex items-center justify-center"
      style="background: rgba(0, 0, 0, 0.55); z-index: 60"
      role="presentation"
      data-mission-close-confirm
      @mousedown="onBackdropMousedown"
    >
      <div
        ref="dialogRef"
        class="anim-fade-in-scale flex flex-col border border-border-2 bg-surface text-text"
        style="
          width: min(440px, 90vw);
          max-height: 80vh;
          border-radius: 9px;
          box-shadow: var(--shadow-pop);
        "
        role="dialog"
        aria-modal="true"
        aria-labelledby="mission-close-confirm-title"
        data-test="mission-close-confirm"
        @mousedown.stop
      >
        <header
          class="flex shrink-0 items-center justify-between border-b border-border"
          style="padding: 14px 18px 10px"
        >
          <h2
            id="mission-close-confirm-title"
            class="text-text"
            style="font-size: 13.5px; line-height: 20px; font-weight: 600"
          >
            {{ t('mission.end.title') }}
          </h2>
          <button
            class="flex items-center justify-center rounded text-text-3 transition hover:bg-surface-2 hover:text-text"
            style="width: 24px; height: 24px"
            :aria-label="t('mission.end.dismiss')"
            :disabled="busy"
            @click="emit('cancel')"
          >
            <X :size="14" :stroke-width="1.5" />
          </button>
        </header>

        <div
          class="scrollable overflow-y-auto text-text-2"
          style="padding: 14px 18px; font-size: 12.5px; line-height: 19px"
        >
          <i18n-t keypath="mission.end.body" tag="p" scope="global">
            <template #title>
              <b class="text-text">{{ title }}</b>
            </template>
          </i18n-t>

          <fieldset class="flex flex-col" style="gap: 6px; margin-top: 10px">
            <legend class="sr-only">{{ t('mission.end.choice') }}</legend>
            <label
              v-for="c in CHOICES"
              :key="c.value"
              class="flex cursor-pointer items-start rounded-sm border transition"
              :class="choice === c.value ? 'border-accent-line bg-accent-soft' : 'border-border-2'"
              style="gap: 8px; padding: 7px 10px"
              :data-test="`mission-end-choice-${c.value}`"
            >
              <input
                v-model="choice"
                type="radio"
                name="mission-end-choice"
                :value="c.value"
                class="shrink-0"
                style="margin-top: 3px; accent-color: var(--color-accent)"
                :disabled="busy"
              />
              <span class="min-w-0">
                <span class="block text-text" style="font-weight: 500">{{ t(c.label) }}</span>
                <span class="block text-text-3" style="font-size: 11.5px">{{ t(c.hint) }}</span>
              </span>
            </label>
          </fieldset>

          <label class="block" style="margin-top: 10px">
            <span class="block text-text-3" style="font-size: 11px; margin-bottom: 4px">{{
              t('mission.end.reason')
            }}</span>
            <textarea
              v-model="reason"
              rows="2"
              maxlength="500"
              class="w-full resize-none rounded-sm border border-border-2 bg-bg text-text outline-none focus:border-accent-line"
              style="padding: 6px 8px; font-size: 12px; line-height: 17px"
              :placeholder="t('mission.end.reasonPlaceholder')"
              :disabled="busy"
              data-test="mission-end-reason"
            />
          </label>

          <section
            v-if="showRecord"
            class="rounded-sm border border-border-2"
            style="margin-top: 10px; padding: 8px 10px"
            data-test="mission-record"
          >
            <span
              class="block uppercase text-text-3"
              style="font-size: 9.5px; font-weight: 700; letter-spacing: 0.06em"
              >{{ t('mission.end.record.title') }}</span
            >
            <p
              v-if="drafts.length === 0"
              class="text-text-3"
              style="margin: 4px 0 0; font-size: 11.5px"
              data-test="mission-record-nothing"
            >
              {{ t('mission.end.record.nothing') }}
            </p>
            <template v-else>
              <p class="text-text-3" style="margin: 2px 0 4px; font-size: 11px">
                {{ t('mission.end.record.hint') }}
              </p>
              <label
                v-for="(d, i) in drafts"
                :key="d.id"
                class="flex cursor-pointer items-start"
                :class="i > 0 ? 'border-t border-border' : ''"
                style="gap: 8px; padding: 6px 0"
                data-test="mission-record-draft"
                :data-id="d.id"
              >
                <input
                  v-model="ticked"
                  type="checkbox"
                  :value="d.id"
                  class="shrink-0"
                  style="margin-top: 3px; accent-color: var(--color-accent)"
                  :disabled="busy"
                />
                <span class="min-w-0 flex-1">
                  <span
                    class="block uppercase text-text-4"
                    style="font-size: 9.5px; font-weight: 600"
                    >{{ t(`mission.end.record.kind.${d.kind}`) }}</span
                  >
                  <span
                    class="block truncate text-text"
                    style="font-size: 12px; font-weight: 500"
                    >{{ draftHeading(d) }}</span
                  >
                  <span
                    v-if="draftExcerpt(d)"
                    class="block text-text-3"
                    style="
                      font-size: 11px;
                      display: -webkit-box;
                      -webkit-line-clamp: 3;
                      -webkit-box-orient: vertical;
                      overflow: hidden;
                    "
                    >{{ draftExcerpt(d) }}</span
                  >
                  <span
                    class="block font-mono text-text-2"
                    style="font-size: 10.5px"
                    data-test="mission-record-cites"
                    >{{ citationRefs(d).join(' · ') }}</span
                  >
                  <span
                    v-if="d.supersedes"
                    class="block text-text-3"
                    style="font-size: 11px"
                    data-test="mission-record-supersedes"
                  >
                    <i18n-t keypath="mission.end.record.replaces" scope="global">
                      <template #id
                        ><span class="font-mono">{{ d.supersedes }}</span></template
                      >
                    </i18n-t>
                  </span>
                </span>
              </label>
            </template>
          </section>

          <div
            v-if="warnings.length"
            class="flex items-start rounded-sm border border-warning-line bg-warning-soft text-warning"
            style="
              gap: 6px;
              margin-top: 10px;
              padding: 8px 10px;
              font-size: 11.5px;
              line-height: 1.5;
            "
            data-test="mission-end-warnings"
          >
            <TriangleAlert :size="13" :stroke-width="1.8" class="mt-0.5 shrink-0" />
            <div class="min-w-0 flex-1">
              <span
                class="block uppercase opacity-85"
                style="
                  font-size: 9.5px;
                  font-weight: 700;
                  letter-spacing: 0.06em;
                  margin-bottom: 3px;
                "
                >{{ t('mission.end.warnings.title') }}</span
              >
              <ul style="margin: 0; padding: 0; list-style: none">
                <li
                  v-for="w in warnings"
                  :key="w.kind"
                  data-test="mission-end-warning"
                  :data-kind="w.kind"
                  style="margin-top: 3px"
                >
                  <span class="block" style="font-weight: 500">{{ warningHeading(w) }}</span>
                  <span
                    v-for="(item, i) in w.items"
                    :key="i"
                    class="block break-words text-text-3"
                    style="font-size: 11px"
                    data-test="mission-end-warning-item"
                    >{{ item.step }}<template v-if="item.label"> — {{ item.label }}</template></span
                  >
                </li>
              </ul>
            </div>
          </div>
        </div>

        <footer
          class="flex shrink-0 items-center justify-end border-t border-border"
          style="padding: 12px 18px; gap: 8px"
        >
          <Button
            ref="cancelRef"
            variant="ghost"
            :disabled="busy"
            data-test="mission-close-cancel"
            @click="emit('cancel')"
          >
            {{ t('mission.end.cancel') }}
          </Button>
          <Button
            :variant="choice === 'delivered' ? 'success' : 'danger'"
            :disabled="busy"
            data-test="mission-close-confirm-go"
            @click="onConfirm"
          >
            <Check v-if="choice === 'delivered'" :size="14" :stroke-width="1.8" />
            <Trash2 v-else :size="14" :stroke-width="1.8" />{{
              t(choice === 'delivered' ? 'mission.end.asDelivered' : 'mission.end.asDiscarded')
            }}
          </Button>
        </footer>
      </div>
    </div>
  </Teleport>
</template>
