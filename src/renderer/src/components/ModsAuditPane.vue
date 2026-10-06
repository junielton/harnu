<script setup lang="ts">
/**
 * Settings → Mods tab (design §6 → "Mods (Settings → Mods, T389)"). A read-only list
 * of the mods a session started in a folder can load, and for each one what its source
 * DECLARES it can do, as neutral "can …" chips.
 *
 * A disclosure, not a control and not a verdict: there is no switch for anyone else's
 * mod (the pane points at the mechanism that owns it), no chip is coloured, and no
 * copy grades a mod. The blind spots — destinations, arguments, paths, what a running
 * session actually loaded — are stated in place, in the footer.
 *
 * The read is static (`claude plugin validate --json`, cached by content hash in
 * main). The renderer passes ROW KEYS to main, never paths; each settled analysis
 * arrives as one `modsAudit:row` event, so rows fill in as they finish.
 *
 * Reuses existing components only: `SegmentedControl` for the scope, `SettingHint`
 * for every help line, the bordered `--surface` row of the Skills pane, the Default
 * badge for chips. No new token, no new component.
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { ChevronDown, ChevronRight, TriangleAlert } from 'lucide-vue-next'
import { useSessionsStore } from '../stores/sessions'
import SegmentedControl from './ui/SegmentedControl.vue'
import SettingHint from './ui/SettingHint.vue'
import type { ModRow, ModsAuditView } from '../../../preload'

const { t, locale } = useI18n()
const sessions = useSessionsStore()

const view = ref<ModsAuditView | null>(null)
const rows = ref<ModRow[]>([])
/** Rows that settled as a plugin with no hooks module: counted, not listed. */
const hiddenKeys = ref<Set<string>>(new Set())
/** Row keys whose analysis is queued or running. */
const analysing = ref<Set<string>>(new Set())
const expanded = ref<Set<string>>(new Set())
const scope = ref<'global' | 'project'>('global')
const loaded = ref(false)

/** The folder of the selected session — the only unambiguous "this project" (as in Skills). */
const selectedFolder = computed<{ path: string; alias: string } | null>(() => {
  const id = sessions.selectedId
  if (!id) return null
  const f = sessions.folders.find((folder) => folder.sessions.some((s) => s.sessionId === id))
  return f ? { path: f.path, alias: f.alias } : null
})

const scopeOptions = computed(() => [
  { value: 'global', label: t('modsAudit.scope.global') },
  {
    value: 'project',
    label: selectedFolder.value
      ? t('modsAudit.scope.project', { folder: selectedFolder.value.alias })
      : t('modsAudit.scope.projectNone'),
    disabled: !selectedFolder.value
  }
])

const activeFolder = computed<string | null>(() =>
  scope.value === 'project' ? (selectedFolder.value?.path ?? null) : null
)

const withoutModule = computed(() => (view.value?.withoutModule ?? 0) + hiddenKeys.value.size)

/** Guards a slow listing against a newer one (scope switch, Refresh). */
let seq = 0

function isNoModule(row: ModRow): boolean {
  return row.analysis?.status === 'ok' && !row.analysis.hasModule
}

function setAnalysing(keys: string[], on: boolean): void {
  const next = new Set(analysing.value)
  for (const k of keys) {
    if (on) next.add(k)
    else next.delete(k)
  }
  analysing.value = next
}

async function load(force = false): Promise<void> {
  const mine = ++seq
  const folder = activeFolder.value
  let result: ModsAuditView
  try {
    result = await window.api.modsAuditList(folder)
  } catch {
    if (mine !== seq) return
    view.value = null
    rows.value = []
    loaded.value = true
    return
  }
  if (mine !== seq) return
  view.value = result
  rows.value = result.rows
  hiddenKeys.value = new Set()
  analysing.value = new Set()
  loaded.value = true
  if (!result.cli.path) return

  const pending = force ? result.rows : result.rows.filter((r) => r.analysis === null)
  if (pending.length === 0) return
  setAnalysing(
    pending.map((r) => r.key),
    true
  )
  try {
    await window.api.modsAuditAnalyse({ folder, force })
  } catch {
    if (mine === seq) analysing.value = new Set()
  }
}

async function retry(row: ModRow): Promise<void> {
  setAnalysing([row.key], true)
  try {
    await window.api.modsAuditAnalyse({ folder: activeFolder.value, keys: [row.key], force: true })
  } catch {
    setAnalysing([row.key], false)
  }
}

let offRow: (() => void) | null = null

function onRow(row: ModRow): void {
  setAnalysing([row.key], false)
  if (!rows.value.some((r) => r.key === row.key)) return // a stale event from another scope
  if (isNoModule(row)) {
    rows.value = rows.value.filter((r) => r.key !== row.key)
    hiddenKeys.value = new Set(hiddenKeys.value).add(row.key)
    return
  }
  rows.value = rows.value.map((r) => (r.key === row.key ? row : r))
}

function toggle(key: string): void {
  const next = new Set(expanded.value)
  if (next.has(key)) next.delete(key)
  else next.add(key)
  expanded.value = next
}

function reveal(root: string): void {
  void window.api.showItemInFolder(root)
}

watch(selectedFolder, (folder) => {
  if (!folder && scope.value === 'project') scope.value = 'global'
})
watch(activeFolder, () => void load())

onMounted(() => {
  offRow = window.api.onModsAuditRow(onRow)
  void load()
})
onBeforeUnmount(() => {
  seq++
  offRow?.()
})

const SOURCE_KEY = {
  harnu: 'modsAudit.source.harnu',
  'harnu-skills': 'modsAudit.source.harnuSkills',
  installed: 'modsAudit.source.installed',
  'skills-dir': 'modsAudit.source.skillsDir',
  'boot-arg': 'modsAudit.source.bootArg'
} as const

function sourceLabel(row: ModRow): string {
  const base = t(SOURCE_KEY[row.source], { scope: row.scope ?? '' })
  return row.version ? `${base} · ${row.version}` : base
}

const fmtTime = (ms: number): string =>
  new Date(ms).toLocaleString(locale.value, { dateStyle: 'medium', timeStyle: 'short' })
const fmtDate = (ms: number): string =>
  new Date(ms).toLocaleDateString(locale.value, { day: 'numeric', month: 'short' })

/** A hook matcher as the source spells it: `event{matcher}`. */
const braced = (matcher: string): string => '{' + matcher + '}'

const eyebrowStyle =
  'font-size: 11px; font-weight: 500; letter-spacing: 0.06em; text-transform: uppercase'
const captionStyle = 'font-size: 11px; margin-top: 8px; margin-bottom: 2px'
</script>

<template>
  <div>
    <section style="margin-bottom: 18px">
      <div class="flex items-center justify-between" style="margin-bottom: 8px">
        <div class="text-text-3" :style="eyebrowStyle">{{ $t('modsAudit.title') }}</div>
        <button
          type="button"
          class="border border-border bg-transparent text-text-2 transition hover:text-text disabled:opacity-40"
          style="padding: 4px 10px; font-size: 12px; font-weight: 500; border-radius: 5px"
          :disabled="!view?.cli.path"
          @click="load(true)"
        >
          {{ $t('modsAudit.refresh') }}
        </button>
      </div>
      <SettingHint style="margin-bottom: 10px">{{ $t('modsAudit.hint') }}</SettingHint>

      <SegmentedControl
        :model-value="scope"
        :options="scopeOptions"
        size="sm"
        :aria-label="$t('modsAudit.scope.label')"
        style="margin-bottom: 12px"
        @update:model-value="(v) => (scope = v as 'global' | 'project')"
      />
      <SettingHint v-if="!selectedFolder" style="margin-bottom: 10px">
        {{ $t('modsAudit.scope.projectDisabledHint') }}
      </SettingHint>

      <!-- Settings region: the Harnu mod's own switches mount here (later waves). -->
      <div id="mods-companion" class="empty:hidden" style="margin-bottom: 12px" />

      <!-- Banners: a hint line, no fill and no colour (design §6 → Mods) -->
      <div
        v-if="view?.policy === 'off-here' || view?.policy === 'off-remote'"
        data-testid="mods-policy-banner"
        class="flex items-start text-text-3"
        style="gap: 5px; margin-bottom: 10px; font-size: 11px; line-height: 1.5"
      >
        <TriangleAlert :size="12" :stroke-width="1.8" style="margin-top: 2px; flex: none" />
        <span>{{
          view.policy === 'off-here'
            ? $t('modsAudit.policy.offHere')
            : $t('modsAudit.policy.offRemote')
        }}</span>
      </div>
      <div
        v-if="view?.safeMode"
        class="flex items-start text-text-3"
        style="gap: 5px; margin-bottom: 10px; font-size: 11px; line-height: 1.5"
      >
        <TriangleAlert :size="12" :stroke-width="1.8" style="margin-top: 2px; flex: none" />
        <i18n-t keypath="modsAudit.safeMode" scope="global" tag="span">
          <template #flag>
            <code class="font-mono text-text-2">--safe-mode</code>
          </template>
        </i18n-t>
      </div>
      <div
        v-if="view?.installedUnreadable"
        class="flex items-start text-text-3"
        style="gap: 5px; margin-bottom: 10px; font-size: 11px; line-height: 1.5"
      >
        <TriangleAlert :size="12" :stroke-width="1.8" style="margin-top: 2px; flex: none" />
        <span>{{ $t('modsAudit.installedUnreadable') }}</span>
      </div>

      <div
        v-if="loaded && view && !view.cli.path"
        data-testid="mods-no-cli"
        class="text-text-4"
        style="font-size: 12px; padding: 8px 0"
      >
        {{ $t('modsAudit.noCli') }}
      </div>
      <div
        v-else-if="loaded && rows.length === 0"
        class="text-text-4"
        style="font-size: 12px; padding: 8px 0"
      >
        {{ $t('modsAudit.empty') }}
      </div>

      <div v-else class="flex flex-col" style="gap: 4px">
        <div
          v-for="row in rows"
          :key="row.key"
          :data-source="row.source"
          data-testid="mods-row"
          class="border border-border bg-surface"
          style="padding: 8px 10px; border-radius: 6px"
        >
          <button
            type="button"
            class="flex w-full items-center justify-between text-left"
            style="gap: 12px"
            :aria-expanded="expanded.has(row.key)"
            :aria-label="$t('modsAudit.toggle', { name: row.name })"
            @click="toggle(row.key)"
          >
            <span class="truncate font-mono text-text" style="font-size: 12.5px">{{
              row.name
            }}</span>
            <span class="flex shrink-0 items-center text-text-3" style="gap: 6px; font-size: 11px">
              <span data-testid="mods-source">{{ sourceLabel(row) }}</span>
              <component
                :is="expanded.has(row.key) ? ChevronDown : ChevronRight"
                :size="12"
                :stroke-width="2"
              />
            </span>
          </button>

          <!-- Chips: facts in the form "can …", always the Default badge variant -->
          <div
            v-if="row.analysis && row.analysis.capabilities.length > 0"
            class="flex flex-wrap"
            style="gap: 4px; margin-top: 6px"
          >
            <span
              v-for="cap in row.analysis.capabilities"
              :key="cap"
              :data-cap="cap"
              class="border border-border bg-surface text-text-3"
              style="padding: 2px 8px; border-radius: 999px; font-size: 11px; line-height: 1.4"
            >
              {{ $t(`modsAudit.cap.${cap}`) }}
            </span>
          </div>

          <div
            v-if="analysing.has(row.key)"
            class="text-text-4"
            style="margin-top: 6px; font-size: 11px"
          >
            {{ $t('modsAudit.analysing') }}
          </div>
          <div
            v-else-if="row.analysis && row.analysis.status !== 'ok'"
            class="flex items-start text-text-3"
            style="gap: 5px; margin-top: 6px; font-size: 11px; line-height: 1.5"
          >
            <TriangleAlert :size="12" :stroke-width="1.8" style="margin-top: 2px; flex: none" />
            <span>{{ $t(`modsAudit.status.${row.analysis.status}`) }}</span>
            <button
              v-if="row.analysis.status === 'failed'"
              type="button"
              class="text-text-2 transition hover:text-text"
              style="margin-left: 4px"
              @click="retry(row)"
            >
              {{ $t('modsAudit.retry') }}
            </button>
          </div>
          <div
            v-if="row.analysis?.changedSince"
            class="text-text-3"
            style="margin-top: 4px; font-size: 11px"
          >
            {{ $t('modsAudit.changedSince', { date: fmtDate(row.analysis.changedSince) }) }}
          </div>
          <SettingHint v-if="row.loadsInFolder === 'unknown'">
            {{ $t('modsAudit.loads.unknown') }}
          </SettingHint>

          <!-- Expanded: the declared facts, the path, and the mechanism that owns the mod -->
          <div v-if="expanded.has(row.key)" data-testid="mods-details" style="margin-top: 8px">
            <template v-if="row.analysis">
              <div v-if="row.analysis.hooks.length > 0">
                <div class="text-text-3" :style="captionStyle">
                  {{ $t('modsAudit.detail.hooks') }}
                </div>
                <div
                  v-for="(h, i) in row.analysis.hooks"
                  :key="`h${i}`"
                  class="font-mono text-text-2"
                  style="font-size: 11px"
                >
                  {{ h.event
                  }}<span v-if="h.matcher !== undefined" class="text-text-3">{{
                    braced(h.matcher)
                  }}</span>
                </div>
              </div>
              <div v-if="row.analysis.calls.length > 0">
                <div class="text-text-3" :style="captionStyle">
                  {{ $t('modsAudit.detail.calls') }}
                </div>
                <div
                  v-for="(c, i) in row.analysis.calls"
                  :key="`c${i}`"
                  class="font-mono text-text-2"
                  style="font-size: 11px"
                >
                  {{ c.op
                  }}<span v-if="c.via" class="text-text-3">
                    {{ $t('modsAudit.detail.via', { helper: c.via }) }}</span
                  >
                </div>
              </div>
              <template
                v-for="group in [
                  ['envReads', row.analysis.env.reads],
                  ['envWrites', row.analysis.env.writes],
                  ['stateReads', row.analysis.state.reads],
                  ['stateWrites', row.analysis.state.writes],
                  ['stateForeign', row.analysis.state.foreignUnchecked],
                  ['unparsed', row.analysis.unparsed],
                  ['errors', row.analysis.errors],
                  ['warnings', row.analysis.warnings]
                ] as [string, string[]][]"
                :key="group[0]"
              >
                <div v-if="group[1].length > 0">
                  <div class="text-text-3" :style="captionStyle">
                    {{ $t(`modsAudit.detail.${group[0]}`) }}
                  </div>
                  <div
                    v-for="(item, i) in group[1]"
                    :key="`${group[0]}${i}`"
                    class="break-all font-mono text-text-2"
                    style="font-size: 11px"
                  >
                    {{ item }}
                  </div>
                </div>
              </template>
              <div
                v-if="
                  row.analysis.status === 'ok' &&
                  row.analysis.hooks.length === 0 &&
                  row.analysis.calls.length === 0
                "
                class="text-text-4"
                style="font-size: 11px; margin-top: 8px"
              >
                {{ $t('modsAudit.detail.nothing') }}
              </div>
            </template>

            <div class="break-all font-mono text-text-4" style="font-size: 11px; margin-top: 8px">
              {{ row.root }}
            </div>
            <div v-if="row.analysis" class="text-text-4" style="font-size: 11px; margin-top: 2px">
              {{
                $t('modsAudit.lastAnalysed', {
                  hash: row.analysis.hash.slice(0, 8),
                  time: fmtTime(row.analysis.analysedAt)
                })
              }}
            </div>
            <div class="flex items-center" style="gap: 10px; margin-top: 8px">
              <button
                type="button"
                class="border border-border bg-transparent text-text-2 transition hover:text-text"
                style="padding: 4px 10px; font-size: 12px; font-weight: 500; border-radius: 5px"
                @click="reveal(row.root)"
              >
                {{ $t('modsAudit.reveal') }}
              </button>
              <SettingHint v-if="row.source === 'installed'" style="margin-top: 0">
                <i18n-t keypath="modsAudit.manage.installed" scope="global" tag="span">
                  <template #slash><code class="font-mono text-text-2">/plugin</code></template>
                  <template #command>
                    <code class="font-mono text-text-2">claude plugin disable {{ row.id }}</code>
                  </template>
                </i18n-t>
              </SettingHint>
              <SettingHint v-else-if="row.source === 'harnu-skills'" style="margin-top: 0">
                {{ $t('modsAudit.manage.harnuSkills') }}
              </SettingHint>
              <SettingHint v-else-if="row.source === 'skills-dir'" style="margin-top: 0">
                {{ $t('modsAudit.manage.skillsDir') }}
              </SettingHint>
              <SettingHint v-else-if="row.source === 'boot-arg'" style="margin-top: 0">
                {{ $t('modsAudit.manage.bootArg') }}
              </SettingHint>
            </div>
          </div>
        </div>
      </div>

      <template v-if="view?.cli.path">
        <SettingHint
          v-if="withoutModule > 0"
          data-testid="mods-without-module"
          style="margin-top: 10px"
        >
          {{ $t('modsAudit.withoutModule', { n: withoutModule }, withoutModule) }}
        </SettingHint>
        <SettingHint style="margin-top: 10px">{{ $t('modsAudit.blindSpots') }}</SettingHint>
        <SettingHint>
          <i18n-t keypath="modsAudit.managedHint" scope="global" tag="span">
            <template #option
              ><code class="font-mono text-text-2">allowManagedModsOnly</code></template
            >
          </i18n-t>
        </SettingHint>
      </template>
    </section>
  </div>
</template>
