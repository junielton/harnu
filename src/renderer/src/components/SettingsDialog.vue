<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { X, Minus, Plus, Check, Search, Puzzle } from 'lucide-vue-next'
import { useUiStore } from '../stores/ui'
import { useLayoutStore } from '../stores/layout'
import {
  useSettingsStore,
  MIN_TERMINAL_FONT_SIZE,
  MAX_TERMINAL_FONT_SIZE,
  UI_ZOOM_STEPS
} from '../stores/settings'
import { useSessionsStore } from '../stores/sessions'
import { useVoiceStore } from '../stores/voice'
import { useThemeStore, type ThemeMeta } from '../stores/theme'
import { setLocale, getStoredLocale, type Locale } from '../i18n'
import type { SessionSortMode } from './session-sort'
import type { FolderSortMode } from './folder-sort'
import type { SidebarDensity } from './sidebar-density'
import type { ResponderMode, UserProject } from '../../../preload'
import { useFocusTrap } from '../composables/useFocusTrap'
import ChangelogPane from './ChangelogPane.vue'
import UsageHistoryPane from './UsageHistoryPane.vue'
import ClaudeChangelogPane from './ClaudeChangelogPane.vue'
import ClaudeConfigPane from './ClaudeConfigPane.vue'
import ClaudeBootForm from './ClaudeBootForm.vue'
import EndpointsPane from './EndpointsPane.vue'
import PushChannelsPane from './PushChannelsPane.vue'
import VoicePane from './VoicePane.vue'
import McpServerPane from './McpServerPane.vue'
import BundledSkillsPane from './BundledSkillsPane.vue'
import ModsAuditPane from './ModsAuditPane.vue'
import MemoryLocationPane from './MemoryLocationPane.vue'
import HibernationPolicyPane from './HibernationPolicyPane.vue'
import CleanupSettingsPane from './CleanupSettingsPane.vue'
import ContainersSettingsPane from './ContainersSettingsPane.vue'
import PrStackSettingsPane from './PrStackSettingsPane.vue'
import ToggleSwitch from './ui/ToggleSwitch.vue'
import SegmentedControl from './ui/SegmentedControl.vue'
import SettingHint from './ui/SettingHint.vue'
import Button from './ui/Button.vue'
import { useCompanionStore } from '../stores/companion'
import { settingsStatusKey } from '../lib/companion-view'
import { useClaudeChangelogStore } from '../stores/claudeChangelog'
import { useClaudeStatusStore } from '../stores/claude-status'
import { useClaudeBootStore } from '../stores/claudeBoot'
import type { SettingsTabId } from '../stores/ui'

/**
 * "Settings" dialog — a `Dialog` variant (design §6 → Settings dialog).
 * Structurally clones `AddFolderDialog.vue` (Teleport, backdrop, card, focus
 * trap, Esc + backdrop-mousedown close). v1 exposes one setting: the terminal
 * font size, persisted to `settings.json` on disk via the settings store. The
 * footer has only a Close button — the dialog self-applies through the store,
 * there is no destructive action and no submit emit.
 */

const ui = useUiStore()
const layout = useLayoutStore()
const settings = useSettingsStore()
const sessions = useSessionsStore()
const companion = useCompanionStore()
// T389 P1W4: the Harnu mod block (set-companion). The store mirrors main; the switch is IPC only.
const companionEnabled = computed(() => companion.status?.enabled ?? true)
const companionStagedDir = computed(() => companion.status?.stagedDir ?? null)
const companionStatusKey = computed(() => settingsStatusKey(companion.status))
// T239: the voice master switch shown under Sound. The full pane is its own tab.
const voiceStore = useVoiceStore()
const theme = useThemeStore()
/**
 * A builtin theme carries an i18n `labelKey`; an extension theme (T137) carries
 * a plain-string `label` instead — extension content self-localizes, it never
 * gets an i18n key (ADR-0002 study §2).
 */
function themeLabel(m: ThemeMeta): string {
  return m.labelKey ? t(m.labelKey) : (m.label ?? m.id)
}
const claudeChangelog = useClaudeChangelogStore()
const claudeStatus = useClaudeStatusStore()
const boot = useClaudeBootStore()
const { t } = useI18n()

const isOpen = computed(() => ui.dialog === 'settings')

// Tabs (design §6 → Settings dialog). Rendered as a vertical left-sidebar nav.
// `general` holds the remaining settings; `interceptor` is the extracted Hook
// responder; `changelog` renders the repo CHANGELOG.md. Reset to `general` on
// each open. Each tab carries a `keywords` list so the sidebar search can jump
// to it by intent (e.g. "sound"/"font"/"theme"/"model") — keywords are internal
// match hints, not user-facing strings, so they mix en + pt terms and skip i18n.
const activeTab = ref<SettingsTabId>('general')
const tabs: Array<{ id: SettingsTabId; labelKey: string; keywords: string[] }> = [
  {
    id: 'general',
    labelKey: 'settings.tabs.general',
    keywords: [
      'terminal',
      'font',
      'fonte',
      'zoom',
      'scale',
      'escala',
      'interface',
      'language',
      'locale',
      'idioma',
      'língua',
      'lingua',
      'notification',
      'notificacao',
      'sound',
      'som',
      'sidebar',
      'sort',
      'ordenar',
      'storage',
      'armazenamento',
      'hooks',
      'haiku',
      'auto-name',
      'telemetry',
      'telemetria',
      'statusline'
    ]
  },
  {
    id: 'interceptor',
    labelKey: 'settings.tabs.interceptor',
    keywords: [
      'interceptor',
      'intercept',
      'interceptar',
      'responder',
      'hook',
      'shadow',
      'active',
      'trust',
      'confiar',
      'allow',
      'deny',
      'ask'
    ]
  },
  {
    id: 'appearance',
    labelKey: 'settings.tabs.appearance',
    keywords: [
      'theme',
      'tema',
      'appearance',
      'aparencia',
      'color',
      'cor',
      'dark',
      'light',
      'escuro'
    ]
  },
  {
    id: 'startup',
    labelKey: 'settings.tabs.startup',
    keywords: ['startup', 'boot', 'inicializacao', 'launch', 'model', 'modelo', 'flags']
  },
  {
    id: 'claudeConfig',
    labelKey: 'settings.tabs.claudeConfig',
    keywords: ['config', 'settings.json', 'permission', 'permissao', 'json']
  },
  {
    id: 'endpoints',
    labelKey: 'settings.tabs.endpoints',
    keywords: ['endpoint', 'anthropic', 'api', 'base url', 'registry', 'registro']
  },
  {
    id: 'push',
    labelKey: 'settings.tabs.push',
    keywords: [
      'push',
      'remote',
      'remota',
      'phone',
      'celular',
      'telefone',
      'ntfy',
      'webhook',
      'notification',
      'notificacao',
      'pause',
      'pausar'
    ]
  },
  {
    id: 'voice',
    labelKey: 'settings.tabs.voice',
    keywords: [
      'voice',
      'voz',
      'speak',
      'falar',
      'fala',
      'speech',
      'tts',
      'kokoro',
      'read aloud',
      'ler em voz alta',
      'audio',
      'áudio',
      'som',
      'sound',
      'mute',
      'mudo',
      'silenciar'
    ]
  },
  {
    id: 'mcp',
    labelKey: 'settings.tabs.mcp',
    keywords: ['mcp', 'control server', 'servidor', 'agent', 'agente', 'tools']
  },
  {
    id: 'skills',
    labelKey: 'settings.tabs.skills',
    keywords: [
      'skill',
      'skills',
      'habilidade',
      'bundled',
      'orchestrate',
      'delivery',
      'verifier',
      'mission',
      'conductor',
      'plugin'
    ]
  },
  {
    id: 'mods',
    labelKey: 'settings.tabs.mods',
    keywords: ['mod', 'mods', 'plugin', 'plugins', 'hooks', 'audit', 'capabilities', 'companion']
  },
  {
    id: 'memory',
    labelKey: 'settings.tabs.memory',
    keywords: [
      'memory',
      'memoria',
      'memória',
      'location',
      'local',
      'central',
      'in-project',
      'projeto',
      'drive',
      'obsidian',
      'vault'
    ]
  },
  {
    id: 'hibernationPolicy',
    labelKey: 'settings.tabs.hibernationPolicy',
    keywords: [
      'hibernation',
      'hibernacao',
      'hibernação',
      'park',
      'parked',
      'pausar',
      'idle',
      'ocioso',
      'sleep',
      'memory',
      'memoria',
      'ram',
      'sweep',
      'lru',
      'maxlive',
      'sessions',
      'monitor'
    ]
  },
  {
    id: 'usageHistory',
    labelKey: 'settings.tabs.usageHistory',
    keywords: ['usage', 'uso', 'history', 'historico', 'cost', 'custo', 'token', 'plan', 'plano']
  },
  {
    id: 'changelog',
    labelKey: 'settings.tabs.changelog',
    keywords: ['changelog', 'release', 'changes', 'mudancas', 'updates']
  },
  {
    id: 'claudeCode',
    labelKey: 'settings.tabs.claudeCode',
    keywords: ['claude code', 'cli', 'release', 'versao', 'version']
  },
  {
    id: 'cleanup',
    labelKey: 'settings.tabs.cleanup',
    keywords: [
      'cleanup',
      'worktree',
      'branch',
      'sweep',
      'reaper',
      'limpeza',
      'background scan',
      'scan',
      'escaneamento',
      'protected branches',
      'branches protegidas'
    ]
  },
  {
    id: 'containers',
    labelKey: 'settings.tabs.containers',
    keywords: [
      'containers',
      // One phrase, never the bare quoted binary name: ADR-0014 §2's guard allows
      // that only in containers-shell.ts. Searching for docker still matches it.
      'docker compose',
      'stack',
      'zombie',
      'zumbi',
      'background scan',
      'scan',
      'escaneamento',
      'notify',
      'notificar'
    ]
  },
  {
    id: 'prStack',
    labelKey: 'settings.tabs.prStack',
    keywords: [
      'pr stack',
      'pull request',
      'pr',
      'merge chain',
      'cadeia de merge',
      'canvas',
      'refresh',
      'atualizar',
      'interval',
      'intervalo',
      'staging'
    ]
  }
]

// Sidebar search. Empty query = the normal vertical tab list. A non-empty query
// switches the list into a flat *results* view with two row kinds: individual
// SETTING matches (jump to the setting's tab + scroll + flash) and TAB matches
// (switch to the tab). Match is case-insensitive/trimmed against localized label
// + keywords for both. No matches → a muted "No results" row.
const tabSearch = ref('')
const searchQuery = computed(() => tabSearch.value.trim().toLowerCase())
const searchActive = computed(() => searchQuery.value.length > 0)

// Discrete, searchable settings that live directly in SettingsDialog's own tabs
// (General / Appearance / Interceptor). Each `anchor` is the DOM `id` on that
// setting's row wrapper — `jumpToSetting` scrolls it into view and flashes it.
// Deep fields inside sub-pane components (Startup/Claude config/Endpoints/MCP)
// are out of scope for v1 — those surface only as tab-level matches via `tabs`
// keywords. Keywords are internal en+pt match hints (not user-facing → no i18n).
const settingsIndex: Array<{
  tabId: SettingsTabId
  labelKey: string
  keywords: string[]
  anchor: string
}> = [
  {
    tabId: 'general',
    labelKey: 'settings.interface.languageLabel',
    keywords: ['language', 'locale', 'idioma', 'língua', 'lingua', 'lang'],
    anchor: 'set-language'
  },
  {
    tabId: 'general',
    labelKey: 'settings.terminal.fontSize',
    keywords: ['font', 'fonte', 'size', 'tamanho', 'terminal', 'text'],
    anchor: 'set-fontSize'
  },
  {
    tabId: 'general',
    labelKey: 'settings.uiScale.label',
    keywords: [
      'zoom',
      'scale',
      'escala',
      'interface',
      'ui',
      'ampliar',
      'acessibilidade',
      'accessibility',
      'icon',
      'icone',
      'ícone'
    ],
    anchor: 'set-uiZoom'
  },
  {
    tabId: 'general',
    labelKey: 'settings.hooks.label',
    keywords: ['hooks', 'session state', 'estado', 'observer', 'bridge', 'integrations'],
    anchor: 'set-hooks'
  },
  {
    tabId: 'general',
    labelKey: 'settings.statuslineLabel',
    keywords: ['statusline', 'telemetry', 'telemetria', 'cost', 'custo', 'context'],
    anchor: 'set-statusline'
  },
  {
    tabId: 'general',
    labelKey: 'settings.harnuAwareness.label',
    keywords: [
      'capy', // legacy name: searching the old name still finds the setting
      'harnu',
      'awareness',
      'aware',
      'self',
      'self-awareness',
      'mcp',
      'append-system-prompt',
      'consciencia',
      'consciência'
    ],
    anchor: 'set-harnu-awareness'
  },
  {
    tabId: 'general',
    labelKey: 'harnuMod.settings.label',
    keywords: ['harnu mod', 'mod', 'mods', 'plugin', 'plugins', 'hooks'],
    anchor: 'set-companion'
  },
  {
    tabId: 'general',
    labelKey: 'settings.notifications.label',
    keywords: ['notification', 'notificacao', 'os', 'system', 'sistema', 'alert', 'alerta'],
    anchor: 'set-notifications'
  },
  {
    tabId: 'general',
    labelKey: 'settings.notifications.sound',
    keywords: ['sound', 'som', 'chime', 'audio', 'beep'],
    anchor: 'set-sound'
  },
  {
    tabId: 'general',
    labelKey: 'settings.notifications.voice',
    keywords: ['voice', 'voz', 'speak', 'falar', 'speech', 'tts', 'kokoro', 'aloud'],
    anchor: 'set-voice'
  },
  {
    tabId: 'appearance',
    labelKey: 'theme.label',
    keywords: [
      'theme',
      'tema',
      'appearance',
      'aparencia',
      'color',
      'cor',
      'dark',
      'light',
      'escuro',
      'claro'
    ],
    anchor: 'set-theme'
  },
  {
    tabId: 'interceptor',
    labelKey: 'settings.responder.label',
    keywords: [
      'interceptor',
      'hook',
      'responder',
      'shadow',
      'active',
      'mode',
      'modo',
      'allow',
      'deny'
    ],
    anchor: 'set-responder'
  },
  {
    tabId: 'interceptor',
    labelKey: 'settings.responder.trustAll',
    keywords: ['trust', 'confiar', 'folder', 'pasta', 'all', 'todas'],
    anchor: 'set-trustAll'
  },
  {
    tabId: 'interceptor',
    labelKey: 'settings.responder.reviewShadowLog',
    keywords: ['shadow', 'log', 'review', 'revisar', 'would-have', 'inbox'],
    anchor: 'set-reviewShadowLog'
  }
]

const matchedSettings = computed(() => {
  const q = searchQuery.value
  if (!q) return []
  return settingsIndex.filter((s) => {
    if (t(s.labelKey).toLowerCase().includes(q)) return true
    return s.keywords.some((kw) => kw.includes(q))
  })
})

const filteredTabs = computed(() => {
  const q = searchQuery.value
  if (!q) return tabs
  return tabs.filter((tab) => {
    if (t(tab.labelKey).toLowerCase().includes(q)) return true
    return tab.keywords.some((kw) => kw.includes(q))
  })
})

/** Localized label of a tab (for a setting result's muted tab subtitle). */
function tabLabelFor(tabId: SettingsTabId): string {
  const tab = tabs.find((x) => x.id === tabId)
  return tab ? t(tab.labelKey) : tabId
}

// Jump-to-setting flash: `highlightedAnchor` marks the row to flash; a timeout
// clears it after the ~1.2s animation so a later jump can re-trigger it.
const highlightedAnchor = ref<string | null>(null)
let highlightTimer: ReturnType<typeof setTimeout> | null = null

/** A tab result → just switch to it (keep the search text). */
function goToTab(tabId: SettingsTabId): void {
  activeTab.value = tabId
}

/** A setting result → open its tab, scroll the anchor into view, flash it, and
 *  clear the search so the highlighted setting is what's on screen. */
function jumpToSetting(tabId: SettingsTabId, anchor: string): void {
  activeTab.value = tabId
  tabSearch.value = ''
  highlightedAnchor.value = anchor
  if (highlightTimer) clearTimeout(highlightTimer)
  highlightTimer = setTimeout(() => {
    highlightedAnchor.value = null
    highlightTimer = null
  }, 1200)
  // Let the (possibly newly-switched) tab render before measuring/scrolling.
  void nextTick(() => {
    requestAnimationFrame(() => {
      document.getElementById(anchor)?.scrollIntoView({ block: 'nearest' })
    })
  })
}

// --- Sidebar prefs (spec §7) ----------------------------------------------
const folderSortOptions: Array<{ value: FolderSortMode; labelKey: string }> = [
  { value: 'recent', labelKey: 'settings.sidebar.folderSortRecent' },
  { value: 'name', labelKey: 'settings.sidebar.folderSortName' }
]

const sortOptions: Array<{ value: SessionSortMode; labelKey: string }> = [
  { value: 'attention', labelKey: 'settings.sidebar.sortAttention' },
  { value: 'recent', labelKey: 'settings.sidebar.sortRecent' },
  { value: 'name', labelKey: 'settings.sidebar.sortName' }
]

// Sidebar density presets (design.md §4 "Row density"). Scales the sidebar's
// row heights, session-row gap, and left indent.
const densityOptions: Array<{ value: SidebarDensity; labelKey: string }> = [
  { value: 'comfortable', labelKey: 'settings.sidebar.densityComfortable' },
  { value: 'compact', labelKey: 'settings.sidebar.densityCompact' }
]

const windowOptions: Array<{ value: number; labelKey: string }> = [
  { value: 24 * 60 * 60 * 1000, labelKey: 'settings.sidebar.window24h' },
  { value: 48 * 60 * 60 * 1000, labelKey: 'settings.sidebar.window48h' },
  { value: 7 * 24 * 60 * 60 * 1000, labelKey: 'settings.sidebar.window7d' }
]

// Session-age filter presets (session-age-filter spec §6). `0` = "All" (no
// filtering); the rest reuse the Active-elsewhere window labels.
const sessionWindowOptions: Array<{ value: number; labelKey: string }> = [
  { value: 0, labelKey: 'settings.sidebar.sessionWindowAll' },
  { value: 24 * 60 * 60 * 1000, labelKey: 'settings.sidebar.window24h' },
  { value: 48 * 60 * 60 * 1000, labelKey: 'settings.sidebar.window48h' },
  { value: 7 * 24 * 60 * 60 * 1000, labelKey: 'settings.sidebar.window7d' }
]

// OS-notification per-state toggles (os-notifications spec §8). The master
// switch + these read/write `sessions.notifyPrefs` via `setNotifyPref`.
const notifyStateOptions: Array<{ key: 'needsInput' | 'completed' | 'failed'; labelKey: string }> =
  [
    { key: 'needsInput', labelKey: 'settings.notifications.needsInput' },
    { key: 'completed', labelKey: 'settings.notifications.completed' },
    { key: 'failed', labelKey: 'settings.notifications.failed' }
  ]

// Session-state Hook Bridge opt-out (session-state spec §7). Default ON; toggling
// installs/uninstalls Harnu's observer hooks in ~/.claude/settings.json.
const hooksEnabled = ref(true)
async function loadHooksStatus(): Promise<void> {
  try {
    hooksEnabled.value = (await window.api.hooksStatus()).enabled
  } catch {
    /* leave default ON */
  }
}
async function toggleHooks(): Promise<void> {
  const next = !hooksEnabled.value
  hooksEnabled.value = next // optimistic
  try {
    await window.api.hooksSetEnabled(next)
  } catch {
    hooksEnabled.value = !next // revert on failure
  }
}

// statusLine telemetry opt-out (statusline-telemetry spec). Default ON; toggling
// installs/removes the statusLine command in ~/.claude/settings.json. `foreign`
// flags a pre-existing user statusLine we deliberately preserved (no clobber).
const statuslineEnabled = ref(true)
const statuslineForeign = ref(false)
async function loadStatuslineStatus(): Promise<void> {
  try {
    const s = await window.api.statuslineStatus()
    statuslineEnabled.value = s.enabled
    statuslineForeign.value = s.foreignPreserved
  } catch {
    /* leave default ON */
  }
}
async function toggleStatusline(): Promise<void> {
  const next = !statuslineEnabled.value
  statuslineEnabled.value = next // optimistic
  try {
    await window.api.statuslineSetEnabled(next)
  } catch {
    statuslineEnabled.value = !next // revert on failure
  }
}

// Harnu self-awareness (T55). Default ON; when on, `docs/harnu-features.md` is
// prepended to every `claude` session's --append-system-prompt so the session
// knows it runs inside Harnu (MCP verbs, image gallery, Approval Inbox, worktrees).
// Read main-side at spawn; this ref is just the toggle's editing surface.
const harnuAwarenessEnabled = ref(true)
async function loadHarnuAwareness(): Promise<void> {
  try {
    harnuAwarenessEnabled.value = await window.api.harnuFeaturesGet()
  } catch {
    /* leave default ON */
  }
}
async function toggleHarnuAwareness(): Promise<void> {
  const next = !harnuAwarenessEnabled.value
  harnuAwarenessEnabled.value = next // optimistic
  try {
    await window.api.harnuFeaturesSetEnabled(next)
  } catch {
    harnuAwarenessEnabled.value = !next // revert on failure
  }
}

// Hook responder mode (hook-responder-dispatch spec). off/shadow/active. Inert
// when the hooks are off → selector disabled. Default 'shadow' (the ramp).
const responderMode = ref<ResponderMode>('shadow')
const responderHooksEnabled = ref(true)
// T30 trust ramp: the "Trust all folders" master switch (fleet-active escape
// hatch) + the pinned-folder list the per-folder ramp rows render over. The
// per-folder ramp state itself lives in the sessions store (`interceptFolders`).
const responderTrustAll = ref(false)
const rampProjects = ref<UserProject[]>([])
async function loadResponderStatus(): Promise<void> {
  try {
    const s = await window.api.responderStatus()
    responderMode.value = s.mode
    responderHooksEnabled.value = s.hooksEnabled
    responderTrustAll.value = s.trustAll
  } catch {
    /* leave default shadow */
  }
}
async function loadRampProjects(): Promise<void> {
  try {
    const r = await window.api.userProjectsList()
    rampProjects.value = Array.isArray(r) ? r : r.projects
  } catch {
    rampProjects.value = []
  }
}
async function setResponderMode(mode: ResponderMode): Promise<void> {
  const prev = responderMode.value
  responderMode.value = mode // optimistic
  try {
    await window.api.responderSetMode(mode)
  } catch {
    responderMode.value = prev // revert on failure
  }
}
async function setResponderTrustAll(next: boolean): Promise<void> {
  const prev = responderTrustAll.value
  responderTrustAll.value = next // optimistic
  try {
    const r = await window.api.responderSetTrustAll(next)
    responderTrustAll.value = r.trustAll
  } catch {
    responderTrustAll.value = prev // revert on failure
  }
}
/** Put a pinned folder on / off the trust ramp (mirrors the folder-menu toggle). */
async function toggleRampFolder(path: string, next: boolean): Promise<void> {
  try {
    await sessions.setFolderInterceptActive(path, next)
  } catch {
    /* store mirror simply won't flip — no destructive state */
  }
}
/** Basename of an absolute path — the compact folder alias for a ramp row. */
function rampBasename(p: string): string {
  if (!p) return ''
  const trimmed = p.replace(/\/+$/, '')
  return trimmed.split('/').pop() || trimmed
}
/**
 * Reveal the "Would-have" shadow log, which now lives in the Inbox rail (T83 S0).
 * The rail is a column BEHIND this dialog, so expanding it alone would change
 * nothing visible — close the dialog too, or the operator clicks and sees nothing.
 */
function openShadowLog(): void {
  layout.setInboxRailState('expanded')
  ui.closeDialog()
}

// Haiku auto-name opt-in (haiku-service-autoname spec §4.6). A plain localStorage
// flag (om2tab.haikuAutoname), default OFF. The sessions store reads the same key
// when deciding whether to fire; this toggle is just the UI control.
const AUTONAME_KEY = 'om2tab.haikuAutoname'
const autonameEnabled = ref(false)
function loadAutonameEnabled(): void {
  try {
    autonameEnabled.value = localStorage.getItem(AUTONAME_KEY) === 'true'
  } catch {
    autonameEnabled.value = false
  }
}
function toggleAutoname(): void {
  const next = !autonameEnabled.value
  autonameEnabled.value = next
  try {
    localStorage.setItem(AUTONAME_KEY, String(next))
  } catch {
    /* private mode — in-memory only */
  }
}

// Interface language (T68). `'system'` = follow the OS/`navigator` language (no
// stored override); the two locales pin the choice. Applied live via `setLocale`,
// which persists (or clears) `om2tab.locale`. Seeded from the persisted override.
type LanguageChoice = 'system' | Locale
const LANGUAGE_OPTIONS: Array<{ value: LanguageChoice; labelKey: string }> = [
  { value: 'system', labelKey: 'settings.interface.languageSystem' },
  { value: 'en', labelKey: 'settings.interface.languageEn' },
  { value: 'pt-BR', labelKey: 'settings.interface.languagePtBR' }
]
const language = ref<LanguageChoice>(getStoredLocale() ?? 'system')
function setLanguage(choice: LanguageChoice): void {
  language.value = choice
  setLocale(choice === 'system' ? null : choice)
}

const fontSize = computed(() => settings.terminalFontSize)
const canDecrease = computed(() => fontSize.value > MIN_TERMINAL_FONT_SIZE)
const canIncrease = computed(() => fontSize.value < MAX_TERMINAL_FONT_SIZE)

function decrease(): void {
  if (!canDecrease.value) return
  settings.setFontSize(fontSize.value - 1)
}

function increase(): void {
  if (!canIncrease.value) return
  settings.setFontSize(fontSize.value + 1)
}

// UI zoom stepper (T54). Walks the discrete `UI_ZOOM_STEPS` stops; shows the
// factor as a percentage. Off-array values (e.g. a hand-edited settings.json)
// resolve to the nearest neighbouring stop rather than snapping to an end.
const uiZoomPercent = computed(() => Math.round(settings.uiZoom * 100))
const canZoomOut = computed(() => settings.uiZoom > UI_ZOOM_STEPS[0])
const canZoomIn = computed(() => settings.uiZoom < UI_ZOOM_STEPS[UI_ZOOM_STEPS.length - 1])

function zoomOut(): void {
  const prev = [...UI_ZOOM_STEPS].reverse().find((s) => s < settings.uiZoom)
  if (prev === undefined) return
  settings.setUiZoom(prev)
}

function zoomIn(): void {
  const next = UI_ZOOM_STEPS.find((s) => s > settings.uiZoom)
  if (next === undefined) return
  settings.setUiZoom(next)
}

function close(): void {
  ui.closeDialog()
}

// Claude config pane lives behind `v-else-if activeTab==='claudeConfig'`, so this
// ref is only populated while that tab is active. The footer reads its exposed
// `dirty`/`saving` to render contextual Save/Discard next to Close and calls
// `save()`/`discard()`. `computed` re-reads through the ref each render, so the
// footer reflects live dirty state and switching tabs drops the ref → no stale
// actions.
type ClaudeConfigPaneExposed = {
  dirty: boolean
  saving: boolean
  save: () => Promise<void>
  discard: () => void
}
const claudeConfigPaneRef = ref<ClaudeConfigPaneExposed | null>(null)
const claudeConfigDirty = computed(
  () => activeTab.value === 'claudeConfig' && !!claudeConfigPaneRef.value?.dirty
)
const claudeConfigSaving = computed(() => !!claudeConfigPaneRef.value?.saving)

// --- Focus trap + keyboard / backdrop -------------------------------------

const dialogRef = ref<HTMLElement | null>(null)
const closeButtonRef = ref<HTMLElement | null>(null)

useFocusTrap({
  active: isOpen,
  containerRef: dialogRef,
  initialFocusRef: closeButtonRef
})

function onBackdropMousedown(e: MouseEvent): void {
  if (e.target === e.currentTarget) close()
}

function onKeydown(e: KeyboardEvent): void {
  if (!isOpen.value) return
  if (e.key === 'Escape') {
    e.stopPropagation()
    close()
  }
}

watch(isOpen, (open) => {
  if (open) {
    const tab = ui.settingsTab ?? 'general'
    activeTab.value = tab
    ui.settingsTab = null
    tabSearch.value = ''
    highlightedAnchor.value = null
    if (tab === 'claudeCode') void claudeChangelog.markRead()
    void loadHooksStatus()
    void loadStatuslineStatus()
    void loadHarnuAwareness()
    void loadResponderStatus()
    void loadRampProjects()
    loadAutonameEnabled()
    void boot.init()
    window.addEventListener('keydown', onKeydown, true)
  } else {
    window.removeEventListener('keydown', onKeydown, true)
  }
})

// Opening the Claude Code tab is the "read" action — clears the gear dot.
watch(activeTab, (tab) => {
  if (tab === 'claudeCode') void claudeChangelog.markRead()
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown, true)
  if (highlightTimer) clearTimeout(highlightTimer)
})
</script>

<template>
  <Teleport to="body">
    <div
      v-if="isOpen"
      class="anim-overlay-fade fixed inset-0 flex items-center justify-center"
      style="background: rgba(0, 0, 0, 0.55); z-index: 60"
      role="presentation"
      @mousedown="onBackdropMousedown"
    >
      <div
        ref="dialogRef"
        class="anim-fade-in-scale flex flex-col border border-border-2 bg-surface text-text"
        :style="{
          // Widened for the vertical left-sidebar nav so its ~190px column
          // doesn't crush content (the Usage-history dashboard already wanted
          // the extra room — issue #19: widen in v1, promote to its own view).
          width: 'min(92vw, 940px)',
          // Fixed height derived from the window (T49): constant for a given
          // window size, so switching tabs or searching never resizes the card.
          // Nav + pane both scroll independently, so short tabs just leave empty
          // space at the pane's end and tall tabs (Usage history) still scroll.
          height: 'min(80vh, 720px)',
          borderRadius: '9px',
          boxShadow: 'var(--shadow-pop)'
        }"
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-dialog-title"
        @mousedown.stop
      >
        <!-- Header -->
        <header
          class="flex shrink-0 items-center justify-between border-b border-border"
          style="padding: 14px 18px 10px"
        >
          <h2
            id="settings-dialog-title"
            class="text-text"
            style="font-size: 13.5px; line-height: 20px; font-weight: 600"
          >
            {{ $t('settings.title') }}
          </h2>
          <button
            class="flex items-center justify-center rounded text-text-3 transition hover:bg-surface-2 hover:text-text"
            style="width: 24px; height: 24px"
            type="button"
            :aria-label="$t('settings.close')"
            @click="close()"
          >
            <X :size="14" :stroke-width="1.5" />
          </button>
        </header>

        <!-- Middle region: vertical nav sidebar (left) + content pane (right) -->
        <div class="flex min-h-0 flex-1">
          <!-- Nav sidebar (design §6 → Settings dialog): search on top of a
               vertical, filterable tab list. -->
          <div class="flex shrink-0 flex-col border-r border-border" style="width: 190px">
            <!-- Search — filters the tab list by label + keywords (Inputs §6) -->
            <div style="padding: 12px 12px 8px">
              <div class="relative">
                <Search
                  class="pointer-events-none absolute text-text-4"
                  style="left: 9px; top: 50%; transform: translateY(-50%)"
                  :size="13"
                  :stroke-width="1.8"
                />
                <input
                  v-model="tabSearch"
                  type="text"
                  class="w-full border border-border bg-bg text-text outline-none transition placeholder:text-text-4 focus:border-accent-line"
                  style="border-radius: 5px; padding: 7px 10px 7px 28px; font-size: 12px"
                  :placeholder="$t('settings.search.placeholder')"
                  :aria-label="$t('settings.search.placeholder')"
                />
              </div>
            </div>

            <!-- No search → vertical tab list -->
            <div
              v-if="!searchActive"
              class="scrollable flex-1 overflow-y-auto"
              style="padding: 2px 0 8px"
              role="tablist"
              aria-orientation="vertical"
            >
              <button
                v-for="tab in tabs"
                :key="tab.id"
                type="button"
                role="tab"
                class="flex w-full items-center border-l-2 bg-transparent text-left transition"
                :class="
                  activeTab === tab.id
                    ? 'border-accent bg-surface-2 text-text'
                    : 'border-transparent text-text-3 hover:bg-surface-2 hover:text-text-2'
                "
                style="padding: 8px 12px; font-size: 12.5px; font-weight: 500"
                :aria-selected="activeTab === tab.id"
                @click="activeTab = tab.id"
              >
                {{ $t(tab.labelKey) }}
              </button>
            </div>

            <!-- Searching → flat results: setting matches (jump + flash) then
                 tab matches (switch tab). -->
            <div
              v-else
              class="scrollable flex-1 overflow-y-auto"
              style="padding: 2px 0 8px"
              role="listbox"
              :aria-label="$t('settings.search.placeholder')"
            >
              <!-- Setting results — label + muted tab subtitle -->
              <button
                v-for="s in matchedSettings"
                :key="'setting-' + s.anchor"
                type="button"
                role="option"
                class="flex w-full flex-col border-l-2 border-transparent bg-transparent text-left transition hover:bg-surface-2"
                style="padding: 6px 12px; gap: 1px"
                @click="jumpToSetting(s.tabId, s.anchor)"
              >
                <span class="text-text-2" style="font-size: 12.5px; font-weight: 500">
                  {{ $t(s.labelKey) }}
                </span>
                <span class="text-text-4" style="font-size: 11px">
                  {{ tabLabelFor(s.tabId) }}
                </span>
              </button>

              <!-- Tab results -->
              <button
                v-for="tab in filteredTabs"
                :key="'tab-' + tab.id"
                type="button"
                role="option"
                class="flex w-full items-center border-l-2 bg-transparent text-left transition"
                :class="
                  activeTab === tab.id
                    ? 'border-accent bg-surface-2 text-text'
                    : 'border-transparent text-text-3 hover:bg-surface-2 hover:text-text-2'
                "
                style="padding: 8px 12px; font-size: 12.5px; font-weight: 500"
                @click="goToTab(tab.id)"
              >
                {{ $t(tab.labelKey) }}
              </button>

              <!-- Zero matches -->
              <div
                v-if="matchedSettings.length === 0 && filteredTabs.length === 0"
                class="text-text-4"
                style="padding: 8px 14px; font-size: 12px"
              >
                {{ $t('settings.search.noResults') }}
              </div>
            </div>
          </div>

          <!-- Content pane -->
          <div class="scrollable min-w-0 flex-1 overflow-y-auto" style="padding: 14px 18px">
            <ChangelogPane v-if="activeTab === 'changelog'" />
            <ClaudeConfigPane v-else-if="activeTab === 'claudeConfig'" ref="claudeConfigPaneRef" />
            <UsageHistoryPane v-else-if="activeTab === 'usageHistory'" />
            <ClaudeChangelogPane v-else-if="activeTab === 'claudeCode'" />
            <ClaudeBootForm
              v-else-if="activeTab === 'startup'"
              :model-value="boot.global"
              scope="global"
              @update:model-value="boot.setGlobal"
            />
            <EndpointsPane v-else-if="activeTab === 'endpoints'" />
            <PushChannelsPane v-else-if="activeTab === 'push'" />
            <VoicePane v-else-if="activeTab === 'voice'" />
            <McpServerPane v-else-if="activeTab === 'mcp'" />
            <BundledSkillsPane v-else-if="activeTab === 'skills'" />
            <ModsAuditPane v-else-if="activeTab === 'mods'" />
            <MemoryLocationPane v-else-if="activeTab === 'memory'" />
            <HibernationPolicyPane v-else-if="activeTab === 'hibernationPolicy'" />
            <CleanupSettingsPane v-else-if="activeTab === 'cleanup'" />
            <ContainersSettingsPane v-else-if="activeTab === 'containers'" />
            <PrStackSettingsPane v-else-if="activeTab === 'prStack'" />
            <template v-else-if="activeTab === 'appearance'">
              <!-- Appearance — theme picker (design §9, themes.css) -->
              <section style="margin-bottom: 16px">
                <div
                  class="text-text-3"
                  style="
                    font-size: 11px;
                    font-weight: 500;
                    letter-spacing: 0.06em;
                    text-transform: uppercase;
                    margin-bottom: 8px;
                  "
                >
                  {{ $t('settings.appearance.eyebrow') }}
                </div>
                <div
                  id="set-theme"
                  role="radiogroup"
                  :aria-label="$t('theme.label')"
                  :class="highlightedAnchor === 'set-theme' ? 'anim-setting-flash' : ''"
                  style="display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px"
                >
                  <button
                    v-for="m in theme.meta"
                    :key="m.id"
                    type="button"
                    class="flex flex-col border bg-surface transition hover:bg-surface-2"
                    :class="theme.current === m.id ? 'border-accent-line' : 'border-border'"
                    style="gap: 6px; padding: 6px; border-radius: 7px"
                    role="radio"
                    :aria-checked="theme.current === m.id"
                    :aria-label="themeLabel(m)"
                    @click="theme.set(m.id)"
                  >
                    <!-- Mini preview built from the theme's own swatch tokens -->
                    <div
                      class="relative w-full overflow-hidden"
                      style="height: 38px; border-radius: 5px"
                      :style="{ background: m.swatch.bg }"
                    >
                      <div
                        class="absolute top-0 bottom-0 left-0"
                        style="width: 32%"
                        :style="{ background: m.swatch.surface }"
                      ></div>
                      <div
                        class="absolute"
                        style="left: 42%; top: 9px; width: 46%; height: 3px; border-radius: 2px"
                        :style="{ background: m.swatch.text, opacity: 0.85 }"
                      ></div>
                      <div
                        class="absolute"
                        style="left: 42%; top: 16px; width: 30%; height: 3px; border-radius: 2px"
                        :style="{ background: m.swatch.text, opacity: 0.45 }"
                      ></div>
                      <div
                        class="absolute"
                        style="left: 42%; top: 24px; width: 18px; height: 6px; border-radius: 3px"
                        :style="{ background: m.swatch.accent }"
                      ></div>
                      <!-- Extension-origin badge (T137) — never shown on a builtin theme -->
                      <span
                        v-if="m.origin === 'extension'"
                        class="absolute flex items-center justify-center rounded-full bg-surface"
                        style="top: 3px; right: 3px; width: 14px; height: 14px"
                        :title="
                          $t('settings.appearance.extensionBadge', { name: m.extensionLabel })
                        "
                        :aria-label="
                          $t('settings.appearance.extensionBadge', { name: m.extensionLabel })
                        "
                      >
                        <Puzzle class="text-text-3" :size="9" :stroke-width="2" />
                      </span>
                    </div>
                    <div class="flex w-full items-center justify-between" style="gap: 4px">
                      <span
                        class="truncate"
                        :class="theme.current === m.id ? 'text-accent' : 'text-text-2'"
                        style="font-size: 11.5px"
                      >
                        {{ themeLabel(m) }}
                      </span>
                      <Check
                        v-if="theme.current === m.id"
                        class="shrink-0 text-accent"
                        :size="13"
                        :stroke-width="2.2"
                      />
                    </div>
                  </button>
                </div>
              </section>
            </template>
            <template v-else-if="activeTab === 'interceptor'">
              <!-- Interceptor — Hook responder, moved out of General (design §6 →
                 Settings dialog). Mode selector + T30 trust ramp. All state and
                 handlers stay in <script setup>. -->
              <section style="margin-bottom: 16px">
                <!-- Hook responder mode (hook-responder-dispatch spec). Off/shadow/
                   active; disabled when the Hook Bridge is off (it has nothing to
                   intercept). The hint follows the selected mode. -->
                <div
                  id="set-responder"
                  class="flex items-start justify-between"
                  :class="highlightedAnchor === 'set-responder' ? 'anim-setting-flash' : ''"
                  style="gap: 12px"
                >
                  <div style="flex: 1; min-width: 0">
                    <div class="text-text-2" style="font-size: 12px">
                      {{ $t('settings.responder.label') }}
                    </div>
                    <SettingHint>{{ $t('settings.responder.description') }}</SettingHint>
                    <SettingHint v-if="!responderHooksEnabled">
                      {{ $t('settings.responder.needsHooks') }}
                    </SettingHint>
                    <SettingHint v-else-if="responderMode === 'shadow'">
                      {{ $t('settings.responder.shadowHint') }}
                    </SettingHint>
                    <div
                      v-else-if="responderMode === 'active'"
                      class="text-warning"
                      style="font-size: 11px; line-height: 1.5; margin-top: 4px"
                    >
                      {{ $t('settings.responder.activeHint') }}
                    </div>
                  </div>
                  <SegmentedControl
                    :model-value="responderMode"
                    :options="[
                      { value: 'off', label: $t('settings.responder.modeOff') },
                      { value: 'shadow', label: $t('settings.responder.modeShadow') },
                      { value: 'active', label: $t('settings.responder.modeActive') }
                    ]"
                    size="sm"
                    :disabled="!responderHooksEnabled"
                    :aria-label="$t('settings.responder.label')"
                    @update:model-value="setResponderMode($event as ResponderMode)"
                  />
                </div>

                <!-- T30 trust ramp: revealed only when active. Trust-all master
                   switch + per-folder ramp list (twin of the MCP allowlist) +
                   the "Review shadow log" affordance. Calm-reversible tone. -->
                <div
                  v-if="responderHooksEnabled && responderMode === 'active'"
                  class="border border-border bg-surface"
                  style="margin-top: 12px; padding: 12px; border-radius: 6px"
                >
                  <!-- Trust all folders (master switch) -->
                  <div
                    id="set-trustAll"
                    class="flex items-start justify-between"
                    :class="highlightedAnchor === 'set-trustAll' ? 'anim-setting-flash' : ''"
                    style="gap: 12px"
                  >
                    <div style="flex: 1; min-width: 0">
                      <div class="text-text-2" style="font-size: 12px">
                        {{ $t('settings.responder.trustAll') }}
                      </div>
                      <SettingHint>{{ $t('settings.responder.trustAllHint') }}</SettingHint>
                    </div>
                    <ToggleSwitch
                      :model-value="responderTrustAll"
                      :aria-label="$t('settings.responder.trustAll')"
                      @update:model-value="setResponderTrustAll($event)"
                    />
                  </div>

                  <!-- Per-folder ramp list -->
                  <div
                    class="text-text-3"
                    style="
                      font-size: 11px;
                      font-weight: 500;
                      letter-spacing: 0.06em;
                      text-transform: uppercase;
                      margin-top: 14px;
                      margin-bottom: 8px;
                    "
                  >
                    {{ $t('settings.responder.rampTitle') }}
                  </div>

                  <div
                    v-if="!responderTrustAll && sessions.interceptFolders.size === 0"
                    class="text-text-4"
                    style="font-size: 12px; padding: 4px 0"
                  >
                    {{ $t('settings.responder.rampEmpty') }}
                  </div>

                  <div v-if="rampProjects.length > 0" class="flex flex-col" style="gap: 4px">
                    <div
                      v-for="p in rampProjects"
                      :key="p.path"
                      class="flex items-center justify-between border border-border bg-surface"
                      style="gap: 12px; padding: 8px 10px; border-radius: 6px"
                    >
                      <div style="flex: 1; min-width: 0">
                        <div class="truncate text-text-2" style="font-size: 12px">
                          {{ p.alias || rampBasename(p.path) }}
                        </div>
                        <div
                          class="truncate font-mono text-text-4"
                          style="font-size: 11px"
                          :title="p.path"
                        >
                          {{ p.path }}
                        </div>
                      </div>
                      <ToggleSwitch
                        :model-value="responderTrustAll || sessions.interceptFolders.has(p.path)"
                        :disabled="responderTrustAll"
                        :aria-label="$t('settings.responder.rampTitle')"
                        @update:model-value="toggleRampFolder(p.path, $event)"
                      />
                    </div>
                  </div>

                  <!-- Review shadow log (opens the inbox → Would-have tab) -->
                  <button
                    id="set-reviewShadowLog"
                    type="button"
                    class="text-accent transition hover:opacity-80"
                    :class="highlightedAnchor === 'set-reviewShadowLog' ? 'anim-setting-flash' : ''"
                    style="
                      margin-top: 12px;
                      font-size: 12px;
                      background: none;
                      border: none;
                      padding: 0;
                      cursor: pointer;
                    "
                    @click="openShadowLog()"
                  >
                    {{ $t('settings.responder.reviewShadowLog') }}
                  </button>
                </div>
              </section>
            </template>
            <template v-else>
              <!-- Interface — app-level UI language (T68) -->
              <section style="margin-bottom: 16px">
                <div
                  class="text-text-3"
                  style="
                    font-size: 11px;
                    font-weight: 500;
                    letter-spacing: 0.06em;
                    text-transform: uppercase;
                    margin-bottom: 8px;
                  "
                >
                  {{ $t('settings.interface.eyebrow') }}
                </div>
                <div
                  id="set-language"
                  class="flex items-center justify-between"
                  :class="highlightedAnchor === 'set-language' ? 'anim-setting-flash' : ''"
                  style="gap: 12px"
                >
                  <span class="text-text-2" style="font-size: 12px">
                    {{ $t('settings.interface.languageLabel') }}
                  </span>
                  <SegmentedControl
                    :options="
                      LANGUAGE_OPTIONS.map((o) => ({ value: o.value, label: $t(o.labelKey) }))
                    "
                    :model-value="language"
                    :aria-label="$t('settings.interface.languageLabel')"
                    @update:model-value="setLanguage($event as LanguageChoice)"
                  />
                </div>
              </section>

              <!-- Terminal -->
              <section style="margin-bottom: 16px">
                <div
                  class="text-text-3"
                  style="
                    font-size: 11px;
                    font-weight: 500;
                    letter-spacing: 0.06em;
                    text-transform: uppercase;
                    margin-bottom: 8px;
                  "
                >
                  {{ $t('settings.terminal.eyebrow') }}
                </div>
                <div
                  id="set-fontSize"
                  class="flex items-center justify-between"
                  :class="highlightedAnchor === 'set-fontSize' ? 'anim-setting-flash' : ''"
                  style="gap: 12px"
                >
                  <span class="text-text-2" style="font-size: 12px">
                    {{ $t('settings.terminal.fontSize') }}
                  </span>
                  <div class="flex items-center" style="gap: 8px">
                    <button
                      class="flex items-center justify-center border border-border bg-surface text-text transition hover:bg-surface-2"
                      style="width: 28px; height: 28px; border-radius: 5px"
                      :style="{
                        opacity: canDecrease ? 1 : 0.4,
                        cursor: canDecrease ? 'pointer' : 'not-allowed'
                      }"
                      type="button"
                      :disabled="!canDecrease"
                      :aria-label="$t('settings.fontSize.decrease')"
                      @click="decrease()"
                    >
                      <Minus :size="13" :stroke-width="1.8" />
                    </button>
                    <span
                      class="text-center font-mono tabular-nums text-text"
                      style="min-width: 28px; font-size: 13px"
                      >{{ fontSize }}</span
                    >
                    <button
                      class="flex items-center justify-center border border-border bg-surface text-text transition hover:bg-surface-2"
                      style="width: 28px; height: 28px; border-radius: 5px"
                      :style="{
                        opacity: canIncrease ? 1 : 0.4,
                        cursor: canIncrease ? 'pointer' : 'not-allowed'
                      }"
                      type="button"
                      :disabled="!canIncrease"
                      :aria-label="$t('settings.fontSize.increase')"
                      @click="increase()"
                    >
                      <Plus :size="13" :stroke-width="1.8" />
                    </button>
                  </div>
                </div>
              </section>

              <!-- Interface — whole-UI zoom (T54): scales typography + icons -->
              <section style="margin-bottom: 16px">
                <div
                  class="text-text-3"
                  style="
                    font-size: 11px;
                    font-weight: 500;
                    letter-spacing: 0.06em;
                    text-transform: uppercase;
                    margin-bottom: 8px;
                  "
                >
                  {{ $t('settings.uiScale.eyebrow') }}
                </div>
                <div
                  id="set-uiZoom"
                  class="flex items-center justify-between"
                  :class="highlightedAnchor === 'set-uiZoom' ? 'anim-setting-flash' : ''"
                  style="gap: 12px"
                >
                  <div style="flex: 1; min-width: 0">
                    <div class="text-text-2" style="font-size: 12px">
                      {{ $t('settings.uiScale.label') }}
                    </div>
                    <SettingHint>{{ $t('settings.uiScale.hint') }}</SettingHint>
                  </div>
                  <div class="flex items-center" style="gap: 8px">
                    <button
                      class="flex items-center justify-center border border-border bg-surface text-text transition hover:bg-surface-2"
                      style="width: 28px; height: 28px; border-radius: 5px"
                      :style="{
                        opacity: canZoomOut ? 1 : 0.4,
                        cursor: canZoomOut ? 'pointer' : 'not-allowed'
                      }"
                      type="button"
                      :disabled="!canZoomOut"
                      :aria-label="$t('settings.uiScale.decrease')"
                      @click="zoomOut()"
                    >
                      <Minus :size="13" :stroke-width="1.8" />
                    </button>
                    <span
                      class="text-center font-mono tabular-nums text-text"
                      style="min-width: 44px; font-size: 13px"
                      >{{ uiZoomPercent }}%</span
                    >
                    <button
                      class="flex items-center justify-center border border-border bg-surface text-text transition hover:bg-surface-2"
                      style="width: 28px; height: 28px; border-radius: 5px"
                      :style="{
                        opacity: canZoomIn ? 1 : 0.4,
                        cursor: canZoomIn ? 'pointer' : 'not-allowed'
                      }"
                      type="button"
                      :disabled="!canZoomIn"
                      :aria-label="$t('settings.uiScale.increase')"
                      @click="zoomIn()"
                    >
                      <Plus :size="13" :stroke-width="1.8" />
                    </button>
                  </div>
                </div>
              </section>

              <!-- Integrations — Hook Bridge opt-out (session-state spec §7) -->
              <section style="margin-bottom: 16px">
                <div
                  class="text-text-3"
                  style="
                    font-size: 11px;
                    font-weight: 500;
                    letter-spacing: 0.06em;
                    text-transform: uppercase;
                    margin-bottom: 8px;
                  "
                >
                  {{ $t('settings.integrations.eyebrow') }}
                </div>
                <div
                  id="set-hooks"
                  class="flex items-start justify-between"
                  :class="highlightedAnchor === 'set-hooks' ? 'anim-setting-flash' : ''"
                  style="gap: 12px"
                >
                  <div style="flex: 1; min-width: 0">
                    <div class="text-text-2" style="font-size: 12px">
                      {{ $t('settings.hooks.label') }}
                    </div>
                    <SettingHint>{{ $t('settings.hooks.description') }}</SettingHint>
                  </div>
                  <ToggleSwitch
                    :model-value="hooksEnabled"
                    :aria-label="$t('settings.hooks.label')"
                    @update:model-value="toggleHooks()"
                  />
                </div>

                <!-- statusLine telemetry opt-out (statusline-telemetry spec) -->
                <div
                  id="set-statusline"
                  class="flex items-start justify-between"
                  :class="highlightedAnchor === 'set-statusline' ? 'anim-setting-flash' : ''"
                  style="gap: 12px; margin-top: 14px"
                >
                  <div style="flex: 1; min-width: 0">
                    <div class="text-text-2" style="font-size: 12px">
                      {{ $t('settings.statuslineLabel') }}
                    </div>
                    <SettingHint>{{ $t('settings.statuslineDescription') }}</SettingHint>
                    <div
                      v-if="statuslineForeign"
                      class="text-warning"
                      style="font-size: 11px; line-height: 1.5; margin-top: 4px"
                    >
                      {{ $t('settings.statuslineForeignWarning') }}
                    </div>
                  </div>
                  <ToggleSwitch
                    :model-value="statuslineEnabled"
                    :aria-label="$t('settings.statuslineLabel')"
                    @update:model-value="toggleStatusline()"
                  />
                </div>

                <!-- Harnu self-awareness (T55) -->
                <div
                  id="set-harnu-awareness"
                  class="flex items-start justify-between"
                  :class="highlightedAnchor === 'set-harnu-awareness' ? 'anim-setting-flash' : ''"
                  style="gap: 12px; margin-top: 14px"
                >
                  <div style="flex: 1; min-width: 0">
                    <div class="text-text-2" style="font-size: 12px">
                      {{ $t('settings.harnuAwareness.label') }}
                    </div>
                    <SettingHint>{{ $t('settings.harnuAwareness.description') }}</SettingHint>
                  </div>
                  <ToggleSwitch
                    :model-value="harnuAwarenessEnabled"
                    :aria-label="$t('settings.harnuAwareness.label')"
                    @update:model-value="toggleHarnuAwareness()"
                  />
                </div>

                <!-- Harnu mod (T389 P1W4): the kill switch of the mod loaded into sessions -->
                <div
                  id="set-companion"
                  class="flex items-start justify-between"
                  :class="highlightedAnchor === 'set-companion' ? 'anim-setting-flash' : ''"
                  style="gap: 12px; margin-top: 14px"
                >
                  <div style="flex: 1; min-width: 0">
                    <div class="text-text-2" style="font-size: 12px">
                      {{ $t('harnuMod.settings.label') }}
                    </div>
                    <SettingHint>{{ $t('harnuMod.settings.description') }}</SettingHint>
                    <SettingHint>{{ $t('harnuMod.settings.offHint') }}</SettingHint>
                    <div
                      v-if="companionStagedDir"
                      class="flex items-center"
                      style="gap: 8px; margin-top: 6px"
                    >
                      <span
                        class="font-mono text-text-4 truncate select-text"
                        style="font-size: 11px; min-width: 0"
                        :title="companionStagedDir"
                        >{{ companionStagedDir }}</span
                      >
                      <Button variant="ghost" @click="companion.reveal()">
                        {{ $t('harnuMod.settings.reveal') }}
                      </Button>
                    </div>
                    <div
                      v-if="companionStatusKey"
                      class="text-text-3"
                      style="font-size: 11px; line-height: 1.5; margin-top: 4px"
                    >
                      {{ $t(companionStatusKey) }}
                    </div>
                    <!-- Later waves mount their own feature switches here; the Mods tab moves the block. -->
                    <div id="set-companion-keys" />
                  </div>
                  <ToggleSwitch
                    :model-value="companionEnabled"
                    :aria-label="$t('harnuMod.settings.label')"
                    @update:model-value="companion.setEnabled($event)"
                  />
                </div>

                <!-- OS notifications (os-notifications spec §8) -->
                <div
                  id="set-notifications"
                  class="flex items-start justify-between"
                  :class="highlightedAnchor === 'set-notifications' ? 'anim-setting-flash' : ''"
                  style="gap: 12px; margin-top: 14px"
                >
                  <div style="flex: 1; min-width: 0">
                    <div class="text-text-2" style="font-size: 12px">
                      {{ $t('settings.notifications.label') }}
                    </div>
                    <SettingHint>{{ $t('settings.notifications.description') }}</SettingHint>
                  </div>
                  <ToggleSwitch
                    :model-value="sessions.notifyPrefs.enabled"
                    :aria-label="$t('settings.notifications.label')"
                    @update:model-value="sessions.setNotifyPref('enabled', $event)"
                  />
                </div>
                <!-- Per-state toggles — dimmed + disabled when the master switch is off -->
                <div
                  class="flex items-center"
                  style="gap: 16px; margin-top: 10px; flex-wrap: wrap"
                  :style="{ opacity: sessions.notifyPrefs.enabled ? 1 : 0.45 }"
                >
                  <label
                    v-for="opt in notifyStateOptions"
                    :key="opt.key"
                    class="flex items-center gap-2"
                    :class="sessions.notifyPrefs.enabled ? 'cursor-pointer' : 'cursor-not-allowed'"
                  >
                    <ToggleSwitch
                      :model-value="sessions.notifyPrefs[opt.key]"
                      :disabled="!sessions.notifyPrefs.enabled"
                      :aria-label="$t(opt.labelKey)"
                      @update:model-value="sessions.setNotifyPref(opt.key, $event)"
                    />
                    <span class="text-text-2" style="font-size: 12px">{{ $t(opt.labelKey) }}</span>
                  </label>
                </div>
                <!-- Sound toggle (notification-sound spec §4.6) — orthogonal to the
                 master switch; the changelog notifies even with notifications off. -->
                <div
                  id="set-sound"
                  class="flex items-center justify-between"
                  :class="highlightedAnchor === 'set-sound' ? 'anim-setting-flash' : ''"
                  style="gap: 12px; margin-top: 14px"
                >
                  <span class="text-text-2" style="font-size: 12px">
                    {{ $t('settings.notifications.sound') }}
                  </span>
                  <ToggleSwitch
                    :model-value="sessions.notifyPrefs.sound"
                    :aria-label="$t('settings.notifications.sound')"
                    @update:model-value="sessions.setNotifyPref('sound', $event)"
                  />
                </div>

                <!-- Voice (T239) — a sibling of the chime, which is why it lives
                 directly under it. Turning it ON starts NOTHING: no engine probe,
                 no ~119 MB model fetch. Everything else (engine, download, voices,
                 phrase, the per-folder session gate) is in the Voice tab, and the
                 hint points there rather than duplicating a second control here. -->
                <div
                  id="set-voice"
                  class="flex items-start justify-between"
                  :class="highlightedAnchor === 'set-voice' ? 'anim-setting-flash' : ''"
                  style="gap: 12px; margin-top: 14px"
                >
                  <div style="flex: 1; min-width: 0">
                    <div class="text-text-2" style="font-size: 12px">
                      {{ $t('settings.notifications.voice') }}
                    </div>
                    <SettingHint>{{ $t('settings.notifications.voiceDescription') }}</SettingHint>
                  </div>
                  <div class="flex shrink-0 items-center" style="gap: 8px">
                    <button
                      type="button"
                      class="text-accent transition hover:opacity-80"
                      style="font-size: 11.5px; background: none; border: none; padding: 0"
                      @click="activeTab = 'voice'"
                    >
                      {{ $t('settings.notifications.voiceOpenTab') }}
                    </button>
                    <ToggleSwitch
                      :model-value="voiceStore.enabled"
                      :aria-label="$t('settings.notifications.voice')"
                      @update:model-value="voiceStore.setEnabled($event)"
                    />
                  </div>
                </div>

                <!-- Usage-limit reset (usage-reset-notify spec) — opt-in, gated by
                 the master switch like the per-state toggles above. -->
                <div
                  class="flex items-start justify-between"
                  style="gap: 12px; margin-top: 14px"
                  :style="{ opacity: sessions.notifyPrefs.enabled ? 1 : 0.45 }"
                >
                  <div style="flex: 1; min-width: 0">
                    <div class="text-text-2" style="font-size: 12px">
                      {{ $t('settings.notifications.usageReset') }}
                    </div>
                    <SettingHint>{{
                      $t('settings.notifications.usageResetDescription')
                    }}</SettingHint>
                  </div>
                  <ToggleSwitch
                    :model-value="sessions.notifyPrefs.usageReset"
                    :disabled="!sessions.notifyPrefs.enabled"
                    :aria-label="$t('settings.notifications.usageReset')"
                    @update:model-value="sessions.setNotifyPref('usageReset', $event)"
                  />
                </div>

                <!-- Daily-budget threshold alert (daily-budget spec) — on by
                 default, gated by the master switch like the toggles above. -->
                <div
                  class="flex items-start justify-between"
                  style="gap: 12px; margin-top: 14px"
                  :style="{ opacity: sessions.notifyPrefs.enabled ? 1 : 0.45 }"
                >
                  <div style="flex: 1; min-width: 0">
                    <div class="text-text-2" style="font-size: 12px">
                      {{ $t('settings.notifications.dailyBudget') }}
                    </div>
                    <SettingHint>{{
                      $t('settings.notifications.dailyBudgetDescription')
                    }}</SettingHint>
                  </div>
                  <ToggleSwitch
                    :model-value="sessions.notifyPrefs.dailyBudget"
                    :disabled="!sessions.notifyPrefs.enabled"
                    :aria-label="$t('settings.notifications.dailyBudget')"
                    @update:model-value="sessions.setNotifyPref('dailyBudget', $event)"
                  />
                </div>

                <!-- Claude service-status alerts (issue #17) — orthogonal to the
                 session notification master switch. -->
                <div class="flex items-start justify-between" style="gap: 12px; margin-top: 14px">
                  <div style="flex: 1; min-width: 0">
                    <div class="text-text-2" style="font-size: 12px">
                      {{ $t('settings.claudeStatus.label') }}
                    </div>
                    <SettingHint>{{ $t('settings.claudeStatus.description') }}</SettingHint>
                  </div>
                  <ToggleSwitch
                    :model-value="claudeStatus.notifyEnabled"
                    :aria-label="$t('settings.claudeStatus.label')"
                    @update:model-value="claudeStatus.setNotifyEnabled($event)"
                  />
                </div>
              </section>

              <!-- Intelligence — Haiku auto-name opt-in (haiku-service-autoname spec) -->
              <section style="margin-bottom: 16px">
                <div
                  class="text-text-3"
                  style="
                    font-size: 11px;
                    font-weight: 500;
                    letter-spacing: 0.06em;
                    text-transform: uppercase;
                    margin-bottom: 8px;
                  "
                >
                  {{ $t('settings.intelligence.eyebrow') }}
                </div>
                <div class="flex items-start justify-between" style="gap: 12px">
                  <div style="flex: 1; min-width: 0">
                    <div class="text-text-2" style="font-size: 12px">
                      {{ $t('settings.intelligence.autonameLabel') }}
                    </div>
                    <SettingHint>{{ $t('settings.intelligence.autonameHint') }}</SettingHint>
                  </div>
                  <ToggleSwitch
                    :model-value="autonameEnabled"
                    :aria-label="$t('settings.intelligence.autonameLabel')"
                    @update:model-value="toggleAutoname()"
                  />
                </div>
              </section>

              <!-- Sidebar (folder-first model, spec §7) -->
              <section style="margin-bottom: 16px">
                <div
                  class="text-text-3"
                  style="
                    font-size: 11px;
                    font-weight: 500;
                    letter-spacing: 0.06em;
                    text-transform: uppercase;
                    margin-bottom: 8px;
                  "
                >
                  {{ $t('settings.sidebar.eyebrow') }}
                </div>
                <!-- Density preset (design.md §4 "Row density") -->
                <div
                  class="flex items-center justify-between"
                  style="gap: 12px; margin-bottom: 10px"
                >
                  <span class="text-text-2" style="font-size: 12px">
                    {{ $t('settings.sidebar.densityLabel') }}
                  </span>
                  <SegmentedControl
                    :options="
                      densityOptions.map((o) => ({ value: o.value, label: $t(o.labelKey) }))
                    "
                    :model-value="sessions.sidebarDensity"
                    :aria-label="$t('settings.sidebar.densityLabel')"
                    @update:model-value="sessions.setSidebarDensity($event as SidebarDensity)"
                  />
                </div>
                <!-- Sort folders by (folder-sort spec §6) -->
                <div
                  class="flex items-center justify-between"
                  style="gap: 12px; margin-bottom: 10px"
                >
                  <span class="text-text-2" style="font-size: 12px">
                    {{ $t('settings.sidebar.folderSortLabel') }}
                  </span>
                  <SegmentedControl
                    :options="
                      folderSortOptions.map((o) => ({ value: o.value, label: $t(o.labelKey) }))
                    "
                    :model-value="sessions.folderSort"
                    :aria-label="$t('settings.sidebar.folderSortLabel')"
                    @update:model-value="sessions.setFolderSort($event as FolderSortMode)"
                  />
                </div>
                <!-- Sort sessions by -->
                <div
                  class="flex items-center justify-between"
                  style="gap: 12px; margin-bottom: 10px"
                >
                  <span class="text-text-2" style="font-size: 12px">
                    {{ $t('settings.sidebar.sortLabel') }}
                  </span>
                  <SegmentedControl
                    :options="sortOptions.map((o) => ({ value: o.value, label: $t(o.labelKey) }))"
                    :model-value="sessions.sessionSort"
                    :aria-label="$t('settings.sidebar.sortLabel')"
                    @update:model-value="sessions.setSessionSort($event as SessionSortMode)"
                  />
                </div>
                <!-- Show sessions within (session-age filter) -->
                <div
                  class="flex items-center justify-between"
                  style="gap: 12px; margin-bottom: 10px"
                >
                  <span class="text-text-2" style="font-size: 12px">
                    {{ $t('settings.sidebar.sessionWindowLabel') }}
                  </span>
                  <SegmentedControl
                    :options="
                      sessionWindowOptions.map((o) => ({ value: o.value, label: $t(o.labelKey) }))
                    "
                    :model-value="sessions.sessionWindowMs"
                    :aria-label="$t('settings.sidebar.sessionWindowLabel')"
                    @update:model-value="sessions.setSessionWindow($event as number)"
                  />
                </div>
                <!-- Active-elsewhere window -->
                <div
                  class="flex items-center justify-between"
                  style="gap: 12px; margin-bottom: 10px"
                >
                  <span class="text-text-2" style="font-size: 12px">
                    {{ $t('settings.sidebar.windowLabel') }}
                  </span>
                  <SegmentedControl
                    :options="windowOptions.map((o) => ({ value: o.value, label: $t(o.labelKey) }))"
                    :model-value="sessions.activeWindowMs"
                    :aria-label="$t('settings.sidebar.windowLabel')"
                    @update:model-value="sessions.setActiveWindow($event as number)"
                  />
                </div>
              </section>

              <!-- Storage -->
              <section>
                <div
                  class="text-text-3"
                  style="
                    font-size: 11px;
                    font-weight: 500;
                    letter-spacing: 0.06em;
                    text-transform: uppercase;
                    margin-bottom: 8px;
                  "
                >
                  {{ $t('settings.storage.eyebrow') }}
                </div>
                <div
                  class="truncate font-mono text-text-4"
                  style="font-size: 11px; margin-bottom: 10px"
                  :title="settings.path"
                  :aria-label="settings.path"
                >
                  {{ settings.path }}
                </div>
                <div class="flex flex-wrap items-center" style="gap: 8px">
                  <button
                    class="border border-border bg-surface text-text transition hover:bg-surface-2"
                    style="padding: 7px 14px; font-size: 12.5px; border-radius: 5px"
                    type="button"
                    @click="settings.reveal()"
                  >
                    {{ $t('settings.actions.reveal') }}
                  </button>
                  <button
                    class="border border-border bg-surface text-text transition hover:bg-surface-2"
                    style="padding: 7px 14px; font-size: 12.5px; border-radius: 5px"
                    type="button"
                    @click="settings.changeLocation()"
                  >
                    {{ $t('settings.actions.changeLocation') }}
                  </button>
                  <button
                    class="border border-border bg-surface text-text transition hover:bg-surface-2"
                    style="padding: 7px 14px; font-size: 12.5px; border-radius: 5px"
                    type="button"
                    @click="settings.openInEditor()"
                  >
                    {{ $t('settings.actions.editJson') }}
                  </button>
                </div>
              </section>
            </template>
          </div>
          <!-- /Content pane -->
        </div>
        <!-- /Middle region -->

        <!-- Footer — contextual: the Claude config tab adds Discard + Save here
             (next to Close) while it has unsaved edits; other tabs keep just Close. -->
        <footer
          class="flex shrink-0 items-center justify-end border-t border-border"
          style="padding: 12px 18px; gap: 8px"
        >
          <button
            v-if="claudeConfigDirty"
            type="button"
            class="bg-transparent text-text-2 transition hover:text-text"
            style="
              padding: 7px 14px;
              font-size: 12.5px;
              font-weight: 500;
              border-radius: 5px;
              height: 28px;
            "
            :disabled="claudeConfigSaving"
            @click="claudeConfigPaneRef?.discard()"
          >
            {{ $t('claudeConfig.discard') }}
          </button>
          <button
            v-if="claudeConfigDirty"
            type="button"
            class="bg-accent text-accent-ink transition"
            style="
              padding: 7px 16px;
              font-size: 12.5px;
              font-weight: 500;
              border-radius: 5px;
              height: 28px;
            "
            :disabled="claudeConfigSaving"
            @click="claudeConfigPaneRef?.save()"
          >
            {{ claudeConfigSaving ? $t('claudeConfig.saving') : $t('claudeConfig.save') }}
          </button>
          <button
            ref="closeButtonRef"
            type="button"
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
            {{ $t('settings.close') }}
          </button>
        </footer>
      </div>
    </div>
  </Teleport>
</template>
