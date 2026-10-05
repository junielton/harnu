import './styles/main.css'
import '@xterm/xterm/css/xterm.css'

import { createApp } from 'vue'
import { createPinia } from 'pinia'

import App from './App.vue'
import { i18n } from './i18n'
import { useSessionsStore } from './stores/sessions'
import { useSettingsStore } from './stores/settings'
import { useUsageStore } from './stores/usage'
import { useDailyBudgetStore } from './stores/daily-budget'
import { useClaudeStatusStore } from './stores/claude-status'

const app = createApp(App)
app.use(createPinia())
app.use(i18n)

// Kick off the initial scan + IPC subscriptions before painting. The store
// itself handles the await — we just fire and forget here so a slow disk
// can't block the first paint of the shell.
const sessions = useSessionsStore()
sessions.init().catch((err) => {
  console.error('[sessions] init failed', err)
})

// Dev-only handle for E2E driving (os-notifications spec §11). Stripped from
// production builds by Vite's `import.meta.env.DEV` constant-folding + DCE.
if (import.meta.env.DEV) {
  ;(window as unknown as { __omStore?: unknown }).__omStore = sessions
}

// Load disk-backed settings (terminal font size) + start its file watch. Fire
// and forget — terminals are created lazily on the first session selection,
// well after this resolves, and the default equals the on-disk default so even
// a race is visually correct.
const settings = useSettingsStore()
settings.init().catch((err) => {
  console.error('[settings] init failed', err)
})

// Plan-usage panel data (plan-usage-widget spec). Fire-and-forget; the panel
// shows a skeleton until the first `claude -p "/usage"` snapshot arrives, then
// hides only if the user has no subscription usage to show.
const usage = useUsageStore()
usage.init().catch((err) => {
  console.error('[usage] init failed', err)
})

// Daily-budget row of the same panel (daily-budget spec). Reads the working-day
// preference and the start-of-day baseline; until they land the row simply
// reports `unavailable` and stays hidden, so this too is fire-and-forget.
const dailyBudget = useDailyBudgetStore()
dailyBudget.init().catch((err) => {
  console.error('[daily-budget] init failed', err)
})

// Claude service-status (issue #17). Fire-and-forget; main background-polls the
// status.claude.com Statuspage summary and pushes the footer dot + native alerts.
const claudeStatus = useClaudeStatusStore()
claudeStatus.init().catch((err) => {
  console.error('[claude-status] init failed', err)
})

app.mount('#app')
