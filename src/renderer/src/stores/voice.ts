import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { speech } from '../lib/speech'
import { DEFAULT_VOICE_PREFS, VOICE_PREFS_KEY, type VoicePrefs } from '../lib/speech-prefs'
import { KOKORO_VOICES, resolveKokoroVoice } from '../lib/speech-kokoro-voices'
import { normalizeVoicePhrase } from '../lib/voice-phrase'
import type { SpeechBackendId, SpeechErrorCode } from '../lib/speech-backend'
import type { AgentSpeechPrefs } from '../../../main/speech-gate-core'
import type { KokoroProgress, KokoroStatus } from '../../../main/speech-kokoro-plan'

/**
 * The Voice settings store (T239) — everything the Voice pane reads and writes.
 *
 * It owns no rules of its own. The engine (T237) decides how a string becomes
 * audio, the download (T241) decides what is fetched and what a cancel deletes,
 * and the gate (T238) decides which folders may speak. This store is the place
 * those three surfaces meet a UI: it holds the operator's preferences, mirrors
 * the install status, and forwards every change to whoever actually owns it.
 *
 * Two invariants are load-bearing here, both of them product rules:
 *
 *  1. **Nothing in this store starts a download.** `install()` is the only thing
 *     that touches the network and it is only ever called from an explicit click.
 *     Enabling voice, selecting the Kokoro engine, opening the pane and picking a
 *     voice all leave the network alone.
 *  2. **The agent-speech gate is read, never materialised.** `setGlobalAgentSpeech`
 *     writes `global` and nothing else; per-folder values are written only when
 *     the operator sets one. Inheritance is resolved at read time by
 *     `resolvedForFolder`, so flipping the global can never erase a deliberate
 *     per-folder mute.
 */

/** localStorage-backed prefs, written through on every change. */
function persist(prefs: VoicePrefs): void {
  try {
    if (typeof localStorage === 'undefined') return
    localStorage.setItem(VOICE_PREFS_KEY, JSON.stringify(prefs))
  } catch {
    // A hostile/full storage must never break the setting the operator just made
    // — it applies to the running engine either way, it just won't survive a
    // restart. Same posture as `loadVoicePrefs`.
  }
}

/** How a folder ends up speaking (or not). Rendered as-is by the pane. */
export type FolderSpeechState = 'blocked' | 'explicit-on' | 'explicit-off' | 'inherited'

export interface FolderSpeechRow {
  path: string
  alias: string
  /** The explicit override, or `undefined` when the folder inherits. */
  value: boolean | undefined
  /** The RESOLVED answer — what `speak` would actually do in this folder. */
  resolved: boolean
  state: FolderSpeechState
}

export const useVoiceStore = defineStore('voice', () => {
  // ---- Engine preferences ---------------------------------------------------

  /**
   * Seeded from the ENGINE, not from a second `loadVoicePrefs()` read: the engine
   * parsed storage at module load and is what actually speaks, so re-reading here
   * could show the operator a value the engine does not have (another window
   * wrote the key in between).
   */
  const prefs = ref<VoicePrefs>(speech.config)

  /** Apply a patch to the engine AND to storage. The engine is the source of truth. */
  function configure(patch: Partial<VoicePrefs>): void {
    speech.configure(patch)
    prefs.value = speech.config
    persist(prefs.value)
  }

  const enabled = computed(() => prefs.value.enabled)
  const muted = computed(() => prefs.value.muted)
  const backend = computed(() => prefs.value.backend)
  const phrase = computed(() => prefs.value.phrase)
  const voice = computed(() => prefs.value.voice)

  /**
   * The master switch. Deliberately the ONLY thing it does: no download, no
   * engine probe, no network. The General-tab toggle and the pane's own switch
   * both land here so the two can never disagree.
   */
  function setEnabled(value: boolean): void {
    configure({ enabled: value })
  }

  function setMuted(value: boolean): void {
    configure({ muted: value })
  }

  /** Switching engine never fetches anything — see invariant 1. */
  function setBackend(id: SpeechBackendId): void {
    configure({ backend: id })
  }

  function setVoice(id: string): void {
    configure({ voice: resolveKokoroVoice(id) })
  }

  function setPhrase(template: string): void {
    configure({ phrase: normalizeVoicePhrase(template) })
  }

  // ---- Engine state (the visible reason for a silence) -----------------------

  const lastError = ref<SpeechErrorCode | null>(speech.state.lastError)
  const speaking = ref(speech.state.speaking)
  /**
   * Utterances waiting BEHIND the one being spoken. The pane needs it to tell
   * "the engine has my utterance" from "my utterance is queued behind another"
   * — the difference between a Test that is running and one that has not
   * started yet, which is the whole point of a pending state (BUG-104).
   */
  const queued = ref(speech.state.queued)

  let unsubscribeEngine: (() => void) | null = null

  // ---- The TTS command (main-owned — the renderer never names an executable) --

  const command = ref('')

  async function loadCommand(): Promise<void> {
    try {
      command.value = await window.api.speechCommandGet()
    } catch {
      command.value = ''
    }
  }

  async function setCommand(next: string): Promise<void> {
    try {
      command.value = await window.api.speechCommandSet(next)
    } catch {
      await loadCommand()
    }
  }

  // ---- The offline voice download (T241) ------------------------------------

  const kokoro = ref<KokoroStatus | null>(null)
  const progress = ref<KokoroProgress | null>(null)
  /** A `runInstall` that ended in `failed` — kept so the pane can say why. */
  const installError = ref<string | null>(null)

  let unsubscribeProgress: (() => void) | null = null

  /**
   * True between the click and the ACK. Without it the pane flickers back to the
   * "Download" button for the moment before main answers, which reads as "my
   * click did nothing" and invites a second one.
   */
  const pending = ref(false)

  const installed = computed(() => kokoro.value?.installed === true)
  const installing = computed(() => kokoro.value?.installing === true || pending.value)
  /** Voice ids already on disk. Everything else offers a per-voice "Get". */
  const downloadedVoices = computed<string[]>(() => kokoro.value?.manifest?.voices ?? [])
  const diskBytes = computed(() => kokoro.value?.manifest?.bytes ?? 0)
  const directory = computed(() => kokoro.value?.directory ?? '')

  async function loadKokoro(): Promise<void> {
    try {
      kokoro.value = await window.api.speechKokoroStatus()
    } catch {
      kokoro.value = null
    }
  }

  /**
   * The ONE network door (product rule 1). Called only from an explicit click:
   * "Download the voice", or "Get" on a single voice row.
   */
  async function install(voices?: string[]): Promise<void> {
    if (installing.value) return
    pending.value = true
    installError.value = null
    progress.value = null
    try {
      kokoro.value = await window.api.speechKokoroInstall(voices)
    } catch (err) {
      installError.value = err instanceof Error ? err.message : String(err)
      await loadKokoro()
    } finally {
      pending.value = false
    }
  }

  async function cancelInstall(): Promise<void> {
    try {
      await window.api.speechKokoroCancel()
    } catch {
      // Cancelling a run that already finished is not an error.
    }
  }

  /** Reclaim the disk and return to the pre-download state. */
  async function remove(): Promise<void> {
    try {
      kokoro.value = await window.api.speechKokoroRemove()
    } catch {
      await loadKokoro()
    }
    progress.value = null
    installError.value = null
  }

  // ---- The agent-speech gate (T238) -----------------------------------------

  const agentPrefs = ref<AgentSpeechPrefs>({ version: 1, folders: {} })

  /** The global default. `undefined` (never set) resolves to OFF. */
  const agentGlobal = computed(() => agentPrefs.value.global === true)

  async function loadAgentPrefs(): Promise<void> {
    try {
      agentPrefs.value = await window.api.speechAgentPrefsGet()
    } catch {
      agentPrefs.value = { version: 1, folders: {} }
    }
  }

  /**
   * Flip the GLOBAL default. Writes `global` and NOTHING per-folder — main's
   * `setGlobalAgentSpeech` carries the overrides across untouched. Materialising
   * inheritance here (writing `true` into every known folder) would look
   * identical for one click and destroy every explicit mute forever after.
   */
  async function setAgentGlobal(value: boolean): Promise<void> {
    try {
      agentPrefs.value = await window.api.speechAgentPrefsSet({ value })
    } catch {
      await loadAgentPrefs()
    }
  }

  /** `null` clears the override, returning the folder to inheritance. */
  async function setAgentFolder(folder: string, value: boolean | null): Promise<void> {
    try {
      agentPrefs.value = await window.api.speechAgentPrefsSet({ folder, value })
    } catch {
      await loadAgentPrefs()
    }
  }

  /**
   * Remove every per-folder override, leaving the global exactly as it is. The
   * way back to pure inheritance — and the other half of the audit surface the
   * exceptions list opens.
   */
  async function clearAgentExceptions(): Promise<void> {
    for (const path of Object.keys(agentPrefs.value.folders)) {
      await setAgentFolder(path, null)
    }
  }

  /**
   * Resolve one folder WITHOUT writing anything: `blocked` first (an operator's
   * folder block outranks every voice setting), then `folder ?? global ?? false`.
   * Mirrors `resolveSpeakGate` in `speech-gate-core.ts`, which is what actually
   * decides at call time; this is the pane's read-only view of the same answer.
   */
  function resolvedForFolder(path: string, blocked: boolean): FolderSpeechRow['state'] {
    if (blocked) return 'blocked'
    const own = agentPrefs.value.folders[path]
    if (own === true) return 'explicit-on'
    if (own === false) return 'explicit-off'
    return 'inherited'
  }

  /**
   * Build the exceptions list: every folder that carries an explicit value, plus
   * every folder blocked for agents. A folder that simply inherits is NOT a row —
   * listing all of them would bury the handful that were actually decided, which
   * is the audit problem this list exists to solve.
   *
   * `alsoShow` is the one exception to that: a folder the operator just returned
   * to **Default** in this very pane stays listed, so the control they clicked
   * does not vanish under the cursor and they can see the inherited state they
   * chose. It is view state, not stored state — nothing is written for it.
   */
  function exceptionRows(
    folders: ReadonlyArray<{ path: string; alias: string }>,
    blockedPaths: ReadonlySet<string>,
    alsoShow: ReadonlySet<string> = new Set()
  ): FolderSpeechRow[] {
    const known = new Map(folders.map((f) => [f.path, f.alias]))
    const paths = new Set<string>([
      ...Object.keys(agentPrefs.value.folders),
      ...blockedPaths,
      ...alsoShow
    ])
    const rows: FolderSpeechRow[] = []
    for (const path of paths) {
      const blocked = blockedPaths.has(path)
      const value = agentPrefs.value.folders[path]
      const state = resolvedForFolder(path, blocked)
      rows.push({
        path,
        alias: known.get(path) ?? path.split('/').filter(Boolean).pop() ?? path,
        value,
        resolved: blocked ? false : (value ?? agentGlobal.value),
        state
      })
    }
    return rows.sort((a, b) => a.alias.localeCompare(b.alias))
  }

  const hasExceptions = computed(() => Object.keys(agentPrefs.value.folders).length > 0)

  // ---- Catalog --------------------------------------------------------------

  const catalog = computed(() => KOKORO_VOICES)
  const localeCount = computed(() => new Set(KOKORO_VOICES.map((v) => v.locale)).size)

  // ---- Lifecycle ------------------------------------------------------------

  const loaded = ref(false)

  /**
   * Called by the pane on mount. Idempotent for the subscriptions; the reads are
   * cheap and re-run so a pane reopened after a download shows the truth.
   */
  async function load(): Promise<void> {
    if (!unsubscribeEngine) {
      unsubscribeEngine = speech.subscribe((s) => {
        lastError.value = s.lastError
        speaking.value = s.speaking
        queued.value = s.queued
      })
    }
    if (!unsubscribeProgress) {
      try {
        unsubscribeProgress = window.api.onSpeechKokoroProgress((p) => {
          progress.value = p
          if (p.phase === 'failed') installError.value = p.error ?? 'unknown'
          if (p.phase === 'done' || p.phase === 'cancelled') void loadKokoro()
        })
      } catch {
        unsubscribeProgress = null
      }
    }
    await Promise.all([loadCommand(), loadKokoro(), loadAgentPrefs()])
    loaded.value = true
  }

  function dispose(): void {
    unsubscribeEngine?.()
    unsubscribeEngine = null
    unsubscribeProgress?.()
    unsubscribeProgress = null
  }

  return {
    // engine prefs
    prefs,
    enabled,
    muted,
    backend,
    voice,
    phrase,
    setEnabled,
    setMuted,
    setBackend,
    setVoice,
    setPhrase,
    configure,
    // engine state
    lastError,
    speaking,
    queued,
    // command
    command,
    loadCommand,
    setCommand,
    // download
    kokoro,
    progress,
    installError,
    installed,
    installing,
    pending,
    downloadedVoices,
    diskBytes,
    directory,
    loadKokoro,
    install,
    cancelInstall,
    remove,
    // gate
    agentPrefs,
    agentGlobal,
    hasExceptions,
    loadAgentPrefs,
    setAgentGlobal,
    setAgentFolder,
    clearAgentExceptions,
    resolvedForFolder,
    exceptionRows,
    // catalog
    catalog,
    localeCount,
    // lifecycle
    loaded,
    load,
    dispose,
    DEFAULTS: DEFAULT_VOICE_PREFS
  }
})
