<script setup lang="ts">
/**
 * Settings → Skills tab (design §6 → "Bundled skills", T217). The operator surface
 * for the skills Harnu ships with the app: one row per catalog entry, showing the
 * skill's name, its `SKILL.md` `description` verbatim as the one-line purpose, and
 * an on/off control. Everything is OFF on a fresh install — a skill silently added
 * to a session's catalog would change model behaviour without consent, and the whole
 * point of this pane is that nothing is hidden.
 *
 * A skill that is ON for a folder is STAGED into Harnu's own userData and passed to
 * that folder's next session as `--plugin-dir`; a skill that is OFF is never staged,
 * so the session cannot see it even in principle. Nothing is written into the user's
 * repository — the per-folder override lives in Harnu's `projects.json`, not in
 * `.claude/settings.local.json`.
 *
 * The one exception is the collapsed **Advanced** block's "Also outside Harnu"
 * switch, which explicitly installs `~/.claude/skills/<name>/SKILL.md` so the
 * operator's own terminal sessions see it too. Default OFF, disclosed, and it
 * REFUSES to overwrite a directory Harnu did not itself write.
 *
 * Reuses existing components only (design §6): `ToggleSwitch` for booleans,
 * `SegmentedControl` for the scope picker and the folder tri-state,
 * `SettingHint` for every help line. No new token, no new component.
 */
import { computed, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { ChevronDown, ChevronRight, TriangleAlert } from 'lucide-vue-next'
import { useUiStore } from '../stores/ui'
import { useSessionsStore } from '../stores/sessions'
import ToggleSwitch from './ui/ToggleSwitch.vue'
import SegmentedControl from './ui/SegmentedControl.vue'
import SettingHint from './ui/SettingHint.vue'
import type { BundledSkill } from '../../../preload'

const { t } = useI18n()
const ui = useUiStore()
const sessions = useSessionsStore()

const catalog = ref<BundledSkill[]>([])
/** Global per-skill on/off. A missing key is OFF. */
const globalFlags = ref<Record<string, boolean>>({})
/** Per-skill "Also outside Harnu" (global scope only). */
const userLevel = ref<Record<string, boolean>>({})
/** Catalog names that collide with a personal skill/command of the same name. */
const collisions = ref<string[]>([])
/** Per-folder overrides for the currently selected folder. Missing key = inherit. */
const folderFlags = ref<Record<string, boolean>>({})

const scope = ref<'global' | 'project'>('global')
const advancedOpen = ref(false)

/**
 * The folder the pane's "This project" scope acts on: the folder owning the
 * currently selected session. Settings is a global dialog with no folder argument
 * of its own, so the selection is the only unambiguous "this project" there is —
 * and with nothing selected the scope is disabled rather than guessing.
 */
const selectedFolder = computed<{ path: string; alias: string } | null>(() => {
  const id = sessions.selectedId
  if (!id) return null
  const f = sessions.folders.find((folder) => folder.sessions.some((s) => s.sessionId === id))
  return f ? { path: f.path, alias: f.alias } : null
})

const scopeOptions = computed(() => [
  { value: 'global', label: t('bundledSkills.scope.global') },
  {
    value: 'project',
    label: selectedFolder.value
      ? t('bundledSkills.scope.project', { folder: selectedFolder.value.alias })
      : t('bundledSkills.scope.projectNone'),
    // Unavailable in THIS context, not outright: with no session selected there is
    // no unambiguous "this project" to scope to (design §6 disabled treatment).
    disabled: !selectedFolder.value
  }
])

/** The tri-state pills a folder row offers: explicit On / explicit Off. */
const folderOptions = computed(() => [
  { value: true, label: t('bundledSkills.on') },
  { value: false, label: t('bundledSkills.off') }
])

function hasCollision(name: string): boolean {
  return collisions.value.includes(name)
}

async function load(): Promise<void> {
  try {
    const view = await window.api.bundledSkillsGet()
    catalog.value = view.catalog
    globalFlags.value = view.enabled
    userLevel.value = view.userLevelInstall
    collisions.value = view.collisions
  } catch {
    catalog.value = []
  }
  await loadFolder()
}

async function loadFolder(): Promise<void> {
  const folder = selectedFolder.value
  if (!folder) {
    folderFlags.value = {}
    return
  }
  try {
    folderFlags.value = await window.api.bundledSkillsGetFolder(folder.path)
  } catch {
    folderFlags.value = {}
  }
}

async function toggleGlobal(name: string, enabled: boolean): Promise<void> {
  const prev = globalFlags.value[name]
  globalFlags.value = { ...globalFlags.value, [name]: enabled } // optimistic
  try {
    await window.api.bundledSkillsSetGlobal(name, enabled)
  } catch {
    globalFlags.value = { ...globalFlags.value, [name]: prev === true }
  }
}

/** `undefined` clears the override so the folder inherits the global value again. */
async function setFolder(name: string, value: boolean | undefined): Promise<void> {
  const folder = selectedFolder.value
  if (!folder) return
  try {
    folderFlags.value = await window.api.bundledSkillsSetFolder(
      folder.path,
      name,
      value === undefined ? null : value
    )
  } catch {
    await loadFolder()
  }
}

async function toggleUserLevel(name: string, install: boolean): Promise<void> {
  const prev = userLevel.value[name] === true
  userLevel.value = { ...userLevel.value, [name]: install } // optimistic
  try {
    const r = await window.api.bundledSkillsSetUserLevel(name, install)
    if (!r.ok) {
      userLevel.value = { ...userLevel.value, [name]: prev }
      ui.pushToast({
        kind: 'danger',
        title:
          r.reason === 'occupied'
            ? t('bundledSkills.advanced.occupied', { name })
            : t('bundledSkills.advanced.failed', { name })
      })
    }
  } catch {
    userLevel.value = { ...userLevel.value, [name]: prev }
  }
}

// The project scope hangs off the SELECTED session; if the selection goes away
// while the pane is open, fall back to Global rather than leaving rows that look
// editable but write nowhere.
watch(selectedFolder, (folder) => {
  if (!folder) {
    scope.value = 'global'
    folderFlags.value = {}
    return
  }
  void loadFolder()
})

onMounted(() => {
  void load()
})

const eyebrowStyle =
  'font-size: 11px; font-weight: 500; letter-spacing: 0.06em; text-transform: uppercase; margin-bottom: 8px'
</script>

<template>
  <div>
    <section style="margin-bottom: 18px">
      <div class="text-text-3" :style="eyebrowStyle">{{ $t('bundledSkills.title') }}</div>
      <SettingHint style="margin-bottom: 10px">{{ $t('bundledSkills.hint') }}</SettingHint>

      <!-- Scope: global vs. the selected session's folder (design §6 SegmentedControl) -->
      <SegmentedControl
        :model-value="scope"
        :options="scopeOptions"
        size="sm"
        :aria-label="$t('bundledSkills.scope.label')"
        style="margin-bottom: 12px"
        @update:model-value="
          (v) => {
            scope = v as 'global' | 'project'
            void loadFolder()
          }
        "
      />
      <SettingHint v-if="!selectedFolder" style="margin-bottom: 10px">
        {{ $t('bundledSkills.scope.projectDisabledHint') }}
      </SettingHint>

      <div v-if="catalog.length === 0" class="text-text-4" style="font-size: 12px; padding: 8px 0">
        {{ $t('bundledSkills.empty') }}
      </div>

      <div v-else class="flex flex-col" style="gap: 4px">
        <div
          v-for="s in catalog"
          :key="s.name"
          class="flex items-start justify-between border border-border bg-surface"
          style="gap: 12px; padding: 8px 10px; border-radius: 6px"
        >
          <div style="flex: 1; min-width: 0">
            <div class="truncate font-mono text-text" style="font-size: 12.5px">
              {{ s.name }}
            </div>
            <SettingHint>{{ s.description }}</SettingHint>
            <div
              v-if="hasCollision(s.name)"
              class="flex items-start text-text-3"
              style="gap: 5px; margin-top: 5px; font-size: 11px; line-height: 1.5"
            >
              <TriangleAlert :size="12" :stroke-width="1.8" style="margin-top: 2px; flex: none" />
              <span>
                {{ $t('bundledSkills.collision', { name: s.name }) }}
                <span class="font-mono text-text-4">harnu:{{ s.name }}</span>
              </span>
            </div>
          </div>

          <!-- Global scope: a plain boolean. Folder scope: the tri-state pills, where
               the neutral "Default" maps to UNSET (inherit the global value). -->
          <ToggleSwitch
            v-if="scope === 'global'"
            :model-value="globalFlags[s.name] === true"
            :aria-label="s.name"
            @update:model-value="toggleGlobal(s.name, $event)"
          />
          <SegmentedControl
            v-else
            :model-value="folderFlags[s.name]"
            :options="folderOptions"
            allow-default
            :default-label="$t('bundledSkills.inherit')"
            :inherited-value="globalFlags[s.name] === true"
            size="sm"
            :aria-label="s.name"
            @update:model-value="setFolder(s.name, $event as boolean | undefined)"
          />
        </div>
      </div>

      <SettingHint style="margin-top: 10px">{{ $t('bundledSkills.restartHint') }}</SettingHint>
    </section>

    <!-- Advanced: the opt-in machine-level install. Global scope only — it writes a
         file under ~/.claude, which has nothing to do with a single project. -->
    <section v-if="scope === 'global' && catalog.length > 0">
      <button
        type="button"
        class="flex items-center text-text-3 transition hover:text-text-2"
        style="gap: 5px; margin-bottom: 8px"
        :style="eyebrowStyle"
        @click="advancedOpen = !advancedOpen"
      >
        <component :is="advancedOpen ? ChevronDown : ChevronRight" :size="12" :stroke-width="2" />
        {{ $t('bundledSkills.advanced.title') }}
      </button>

      <div v-if="advancedOpen">
        <SettingHint style="margin-bottom: 8px">
          {{ $t('bundledSkills.advanced.hint') }}
        </SettingHint>
        <div class="flex flex-col" style="gap: 4px">
          <div
            v-for="s in catalog"
            :key="s.name"
            class="flex items-center justify-between border border-border bg-surface"
            style="gap: 12px; padding: 8px 10px; border-radius: 6px"
          >
            <div style="flex: 1; min-width: 0">
              <div class="truncate font-mono text-text-2" style="font-size: 12px">
                {{ s.name }}
              </div>
              <div class="truncate font-mono text-text-4" style="font-size: 11px">
                ~/.claude/skills/{{ s.name }}/SKILL.md
              </div>
            </div>
            <ToggleSwitch
              :model-value="userLevel[s.name] === true"
              :aria-label="$t('bundledSkills.advanced.label')"
              @update:model-value="toggleUserLevel(s.name, $event)"
            />
          </div>
        </div>
      </div>
    </section>
  </div>
</template>
