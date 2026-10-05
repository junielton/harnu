// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { setActivePinia, createPinia } from 'pinia'
import VoicePane from '../src/renderer/src/components/VoicePane.vue'
import SettingsDialog from '../src/renderer/src/components/SettingsDialog.vue'
import { useVoiceStore } from '../src/renderer/src/stores/voice'
import { useSessionsStore } from '../src/renderer/src/stores/sessions'
import { useUiStore } from '../src/renderer/src/stores/ui'
import { speech } from '../src/renderer/src/lib/speech'
import { DEFAULT_VOICE_PREFS } from '../src/renderer/src/lib/speech-prefs'
import { i18n } from '@renderer/i18n'

/**
 * The Kokoro backend dynamically imports a runtime that only exists in a
 * packaged app (`harnu-voice://…`). Nothing under test here is the backend — it
 * is the PANE — so it is replaced by a real async backend that speaks through
 * the same mocked `speechSay` the system-command one uses, keeping the engine,
 * the queue, the gate and the `SpeakOutcome` genuinely in play.
 */
vi.mock('../src/renderer/src/lib/speech-kokoro', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/renderer/src/lib/speech-kokoro')>()
  const { SpeechError, isSpeechErrorCode } = await import('../src/renderer/src/lib/speech-backend')
  return {
    ...actual,
    createKokoroBackend: () => ({
      id: 'kokoro' as const,
      async speak(utterance: { text: string }, signal: AbortSignal): Promise<void> {
        const api = (window as unknown as { api: { speechSay: (r: unknown) => Promise<unknown> } })
          .api
        const outcome = (await api.speechSay({ id: 'kokoro-test', text: utterance.text })) as {
          ok: boolean
          error?: string
        }
        if (signal.aborted) return
        if (!outcome.ok) {
          throw new SpeechError(
            isSpeechErrorCode(outcome.error) ? outcome.error : 'engine-unavailable'
          )
        }
      }
    })
  }
})

/**
 * T239 — the Voice pane's rendered contract. What is asserted here is what a
 * pair of eyes would otherwise have to check by hand: that the tab exists and is
 * findable, that Portuguese is visibly refused rather than quietly offered, and
 * that an inherited "on" cannot be mistaken for an explicit one.
 */

const RUNTIME = {
  entryUrl: 'harnu-voice://kokoro/npm/kokoro-js@1.2.1/+esm',
  transformersUrl: 'harnu-voice://kokoro/npm/@huggingface/transformers@3.5.1/+esm',
  wasmPaths: 'harnu-voice://kokoro/npm/@huggingface/transformers@3.5.1/dist/',
  remoteHost: 'harnu-voice://kokoro/hf/',
  remotePathTemplate: '{model}/',
  modelId: 'onnx-community/Kokoro-82M-v1.0-ONNX',
  dtype: 'q8'
}

const STATUS = {
  installed: false,
  manifest: null,
  installing: false,
  directory: '/ud/voice-kokoro',
  runtime: RUNTIME
}

function mockApi(over: Record<string, unknown> = {}): Record<string, ReturnType<typeof vi.fn>> {
  const api = {
    speechCommandGet: vi.fn().mockResolvedValue('spd-say -w'),
    speechCommandSet: vi.fn((c: string) => Promise.resolve(c)),
    speechKokoroStatus: vi.fn().mockResolvedValue(STATUS),
    speechKokoroPlan: vi.fn().mockResolvedValue({ totalBytes: 119_000_000 }),
    speechKokoroInstall: vi.fn().mockResolvedValue(STATUS),
    speechKokoroCancel: vi.fn().mockResolvedValue(true),
    speechKokoroRemove: vi.fn().mockResolvedValue(STATUS),
    onSpeechKokoroProgress: vi.fn().mockReturnValue(() => {}),
    speechAgentPrefsGet: vi.fn().mockResolvedValue({ version: 1, folders: {} }),
    speechAgentPrefsSet: vi.fn().mockResolvedValue({ version: 1, folders: {} }),
    ...over
  }
  ;(window as unknown as { api: unknown }).api = api
  return api as unknown as Record<string, ReturnType<typeof vi.fn>>
}

async function mountPane(): Promise<ReturnType<typeof mount>> {
  const w = mount(VoicePane, { global: { plugins: [i18n] } })
  await flushPromises()
  return w
}

beforeEach(() => {
  setActivePinia(createPinia())
  localStorage.clear()
  mockApi()
  // The engine is an app-wide singleton: prefs set by one case would otherwise
  // leak into the next one through it, not through the store.
  speech.stop()
  speech.configure({ ...DEFAULT_VOICE_PREFS })
})

describe('AC-1 — a Voice tab exists in Settings and is reachable by search', () => {
  it('renders the Voice pane when the Settings dialog is on the voice tab', async () => {
    const ui = useUiStore()
    const w = mount(SettingsDialog, {
      global: { plugins: [i18n], stubs: { Teleport: true } }
    })
    // Open AFTER mounting: the dialog picks up `ui.settingsTab` on the open EDGE.
    ui.openSettings('voice')
    await flushPromises()
    expect(w.findComponent(VoicePane).exists()).toBe(true)
  })

  it('the sidebar search finds it by "voice", by "tts" and in Portuguese by "voz"', async () => {
    const ui = useUiStore()
    const w = mount(SettingsDialog, {
      global: { plugins: [i18n], stubs: { Teleport: true } }
    })
    ui.openSettings('general')
    await flushPromises()

    for (const query of ['voice', 'tts', 'kokoro', 'voz']) {
      const input = w.find('input[type="search"], input[placeholder]')
      await input.setValue(query)
      expect(w.text().toLowerCase(), `search "${query}"`).toContain('voice')
    }
  })
})

describe('AC-2 — the General tab carries a Voice toggle under Sound', () => {
  it('renders it directly after the sound row, and it starts no download', async () => {
    const api = mockApi()
    const ui = useUiStore()
    const w = mount(SettingsDialog, {
      global: { plugins: [i18n], stubs: { Teleport: true } }
    })
    ui.openSettings('general')
    await flushPromises()

    const voiceRow = w.find('#set-voice')
    expect(voiceRow.exists()).toBe(true)

    // Ordering: the anchor for Sound appears before the anchor for Voice.
    const html = w.html()
    expect(html.indexOf('set-sound')).toBeLessThan(html.indexOf('set-voice'))

    await voiceRow.find('button[role="switch"], button').trigger('click')
    await flushPromises()
    expect(api.speechKokoroInstall).not.toHaveBeenCalled()
  })
})

describe('AC-8 — pt-BR is visibly disabled WITH a reason', () => {
  it('renders a disabled locale row carrying the English-only explanation', async () => {
    const store = useVoiceStore()
    const w = await mountPane()
    store.setBackend('kokoro')
    await flushPromises()

    const row = w.find('[data-testid="voice-locale-unavailable"]')
    expect(row.exists()).toBe(true)
    expect(row.attributes('aria-disabled')).toBe('true')
    expect(row.text()).toContain('pt-BR')
    // The reason, not just a greyed row: downloading more does NOT unlock it.
    expect(row.text()).toContain(i18n.global.t('voice.kokoro.englishOnly'))
  })

  it('offers no Portuguese voice anywhere in the catalog list', async () => {
    const store = useVoiceStore()
    const w = await mountPane()
    store.setBackend('kokoro')
    await flushPromises()

    for (const id of ['pf_dora', 'pm_alex', 'pm_santa']) {
      expect(w.text()).not.toContain(id)
    }
  })
})

describe('AC-3 (rendered) — the download needs its own explicit click', () => {
  it('shows a Download button and does not fetch until it is pressed', async () => {
    const api = mockApi()
    const store = useVoiceStore()
    const w = await mountPane()
    store.setBackend('kokoro')
    await flushPromises()

    const button = w.find('[data-testid="voice-download"]')
    expect(button.exists()).toBe(true)
    expect(api.speechKokoroInstall).not.toHaveBeenCalled()

    await button.trigger('click')
    await flushPromises()
    expect(api.speechKokoroInstall).toHaveBeenCalledTimes(1)
  })
})

describe('AC-12 — an inherited value is visually distinct from an explicit one', () => {
  it('an explicit value FILLS its pill; an inherited one only gets the soft border', async () => {
    const sessions = useSessionsStore()
    sessions.folders.splice(0, sessions.folders.length, {
      path: '/repo/muted',
      alias: 'muted',
      expanded: false,
      sessions: []
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any)

    const store = useVoiceStore()
    const w = await mountPane()
    // Global ON, one folder explicitly OFF.
    store.agentPrefs = { version: 1, global: true, folders: { '/repo/muted': false } }
    await flushPromises()

    const explicit = w.find('[data-testid="voice-folder-explicit-off"]')
    expect(explicit.exists()).toBe(true)
    expect(explicit.find('[data-testid="voice-folder-state-explicit-off"]').exists()).toBe(true)
    // ACCENT = filled. That is what an EXPLICIT choice looks like.
    expect(explicit.html()).toContain('bg-accent-soft')
    // Nothing in this row wears the INHERITED treatment: with a value set, no
    // option is merely "the one the global would have given you".
    expect(explicit.html()).not.toContain('bg-surface border-accent-line')

    // Now return that folder to Default (unset). It stays listed — see `touched`.
    const pills = explicit.findAll('button')
    await pills[0].trigger('click') // the neutral "Default" pill leads the group
    store.agentPrefs = { version: 1, global: true, folders: {} }
    await flushPromises()

    const inherited = w.find('[data-testid="voice-folder-inherited"]')
    expect(inherited.exists()).toBe(true)
    expect(inherited.find('[data-testid="voice-folder-state-inherited"]').exists()).toBe(true)
    // INHERITED = border only, no fill. Distinct from the filled explicit state
    // above, which is exactly what makes the setting auditable.
    expect(inherited.html()).toContain('bg-surface border-accent-line')
  })

  it('renders a blocked folder as silent-and-locked, with no editable control', async () => {
    const sessions = useSessionsStore()
    sessions.folders.splice(0, sessions.folders.length, {
      path: '/repo/blocked',
      alias: 'blocked',
      expanded: false,
      sessions: []
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any)
    sessions.agentDeniedPaths = new Set(['/repo/blocked'])

    const store = useVoiceStore()
    const w = await mountPane()
    store.agentPrefs = { version: 1, global: true, folders: {} }
    await flushPromises()

    const row = w.find('[data-testid="voice-folder-blocked"]')
    expect(row.exists()).toBe(true)
    expect(row.text()).toContain(i18n.global.t('voice.sessions.blocked'))
    // No tri-state control: a blocked folder is not negotiable from here.
    expect(row.findAll('button')).toHaveLength(0)
  })
})

describe('AC-6 — with no network the pane SAYS so, and the chime still covers it', () => {
  it('surfaces a failed download as a readable line rather than a dead button', async () => {
    mockApi({
      speechKokoroInstall: vi.fn().mockRejectedValue(new Error('getaddrinfo ENOTFOUND'))
    })
    const store = useVoiceStore()
    const w = await mountPane()
    store.setBackend('kokoro')
    await flushPromises()

    await w.find('[data-testid="voice-download"]').trigger('click')
    await flushPromises()

    expect(store.installError).toContain('ENOTFOUND')
    expect(w.text()).toContain(i18n.global.t('voice.download.failed'))
    // Nothing usable was installed, so the pane is back at the pre-download state.
    expect(store.installed).toBe(false)
  })

  it('shows WHY the last utterance was silent, and says the chime covered it', async () => {
    const store = useVoiceStore()
    const w = await mountPane()
    store.lastError = 'model-missing'
    await flushPromises()

    const status = w.find('[data-testid="voice-status"]')
    expect(status.exists()).toBe(true)
    expect(status.text()).toContain(i18n.global.t('voice.error.modelMissing'))
    // Rule 3: quiet about the failure, explicit about the reason.
    expect(status.text()).toContain(i18n.global.t('voice.status.fellBackToChime'))
  })
})

describe('AC-7 — disk usage is shown and Remove reclaims it', () => {
  it('renders the size and the directory, and Remove goes through', async () => {
    const installed = {
      installed: true,
      manifest: { voices: ['af_heart'], bytes: 98_000_000 },
      installing: false,
      directory: '/ud/voice-kokoro',
      runtime: RUNTIME
    }
    const api = mockApi({ speechKokoroStatus: vi.fn().mockResolvedValue(installed) })
    const w = await mountPane()

    expect(w.text()).toContain('/ud/voice-kokoro')
    const remove = w.find('[data-testid="voice-remove"]')
    expect(remove.exists()).toBe(true)

    await remove.trigger('click')
    await flushPromises()
    expect(api.speechKokoroRemove).toHaveBeenCalled()
  })

  it('shows no disk row at all when nothing is installed', async () => {
    const w = await mountPane()
    expect(w.find('[data-testid="voice-remove"]').exists()).toBe(false)
  })
})

describe('the notifications master switch is disclosed, not silently fatal', () => {
  it('says so when notifications are OFF — voice rides that decision', async () => {
    const sessions = useSessionsStore()
    sessions.setNotifyPref('enabled', false)
    const w = await mountPane()

    const notice = w.find('[data-testid="voice-notifications-off"]')
    expect(notice.exists()).toBe(true)
    expect(notice.text()).toContain(i18n.global.t('voice.says.notificationsOff'))
  })

  it('shows no such notice when notifications are on', async () => {
    const sessions = useSessionsStore()
    sessions.setNotifyPref('enabled', true)
    const w = await mountPane()
    expect(w.find('[data-testid="voice-notifications-off"]').exists()).toBe(false)
  })
})

describe('the phrase preview — product rule 2', () => {
  it('shows what the operator would actually hear, not a placeholder', async () => {
    const w = await mountPane()
    const preview = w.find('[data-testid="voice-phrase-preview"]')
    expect(preview.exists()).toBe(true)
    expect(preview.text()).toContain(i18n.global.t('voice.phrase.sampleFolder'))
    expect(preview.text()).toContain(i18n.global.t('voice.events.needsInput'))
  })
})

/**
 * BUG-104 — the Test button (and every per-voice play button) narrates itself.
 *
 * The whole output of these controls is AUDIO, which an operator cannot see.
 * Before this, four completely different situations all rendered as "nothing
 * happened": a muted OS, a cold Kokoro loading ~92 MB, an utterance the gate
 * dropped on purpose, and a backend that failed. These tests hold the line that
 * each of them now says which one it is.
 *
 * The engine is driven for real here — a deferred `speechSay` stands in for the
 * TTS process, so the queue, the gate and the `SpeakOutcome` are the app's own,
 * not a stub of them.
 */

interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
}

/**
 * Every deferred `say` is tracked and force-resolved after the case. The engine
 * documents the hazard (`speech-system-command.ts`): a command that never exits
 * holds the queue open, and the queue is an app-wide singleton — one unresolved
 * utterance would wedge every case that follows.
 */
const openUtterances: Array<(value: { ok: boolean }) => void> = []

function deferred<T extends { ok: boolean }>(): Deferred<T> {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  openUtterances.push(resolve as (value: { ok: boolean }) => void)
  return { promise, resolve }
}

afterEach(async () => {
  for (const resolve of openUtterances.splice(0)) resolve({ ok: true })
  await flushPromises()
})

const INSTALLED = {
  installed: true,
  manifest: { voices: ['af_heart', 'af_bella'], bytes: 98_000_000 },
  installing: false,
  directory: '/ud/voice-kokoro',
  runtime: RUNTIME
}

/** A pane with voice ON and a controllable TTS process behind it. */
async function mountSpeaking(sayImpl: ReturnType<typeof vi.fn>): Promise<{
  w: ReturnType<typeof mount>
  store: ReturnType<typeof useVoiceStore>
}> {
  mockApi({ speechSay: sayImpl, speechCancel: vi.fn() })
  const store = useVoiceStore()
  const w = await mountPane()
  store.setEnabled(true)
  await flushPromises()
  return { w, store }
}

function statusText(w: ReturnType<typeof mount>, testid = 'voice-test-status'): string {
  const el = w.find(`[data-testid="${testid}"]`)
  return el.exists() ? el.text() : ''
}

describe('AC-1/AC-2 — the click is acknowledged, then the utterance is reported', () => {
  it('renders a pending state before any audio, then speaking, then the outcome', async () => {
    // An agent utterance is already in the engine, so ours genuinely waits: the
    // click has to be acknowledged a whole utterance before it can be heard.
    const first = deferred<{ ok: boolean }>()
    const second = deferred<{ ok: boolean }>()
    let call = 0
    const say = vi.fn(() => (call++ === 0 ? first.promise : second.promise))

    const { w } = await mountSpeaking(say)
    void speech.speak('an agent is mid-sentence', { source: 'agent' })
    await flushPromises()

    await w.find('[data-testid="voice-test"]').trigger('click')
    // AC-1 — on screen immediately, with no audio of ours anywhere near it.
    expect(statusText(w)).toContain(i18n.global.t('voice.test.pending'))

    // The agent's utterance finishes; the engine takes ours.
    first.resolve({ ok: true })
    await flushPromises()
    // AC-2 — speaking, and still busy.
    expect(statusText(w)).toContain(i18n.global.t('voice.test.speaking'))

    second.resolve({ ok: true })
    await flushPromises()
    // AC-2 — the speaking state ends exactly when the promise settles.
    expect(statusText(w)).not.toContain(i18n.global.t('voice.test.speaking'))
    expect(statusText(w)).toContain(i18n.global.t('voice.test.spoken'))
  })

  it('spins the button itself while it is busy, and stops when it settles', async () => {
    const say = deferred<{ ok: boolean }>()
    const { w } = await mountSpeaking(vi.fn().mockReturnValue(say.promise))

    await w.find('[data-testid="voice-test"]').trigger('click')
    expect(w.find('[data-testid="voice-test"]').html()).toContain('anim-spin')

    say.resolve({ ok: true })
    await flushPromises()
    expect(w.find('[data-testid="voice-test"]').html()).not.toContain('anim-spin')
  })
})

describe('AC-3 — each outcome renders distinctly and in words', () => {
  it('says it was spoken', async () => {
    const { w } = await mountSpeaking(vi.fn().mockResolvedValue({ ok: true }))
    await w.find('[data-testid="voice-test"]').trigger('click')
    await flushPromises()
    expect(statusText(w)).toContain(i18n.global.t('voice.test.spoken'))
  })

  it('says WHY nothing was spoken when voice is switched off', async () => {
    const say = vi.fn().mockResolvedValue({ ok: true })
    mockApi({ speechSay: say, speechCancel: vi.fn() })
    const w = await mountPane()
    // Voice off: the engine drops it. That is a decision, not a fault, and the
    // pane has to say which one it was.
    await w.find('[data-testid="voice-test"]').trigger('click')
    await flushPromises()

    expect(say).not.toHaveBeenCalled()
    expect(statusText(w)).toContain(i18n.global.t('voice.test.dropped.disabled'))
  })

  it('says WHY nothing was spoken when voice is muted', async () => {
    const { w, store } = await mountSpeaking(vi.fn().mockResolvedValue({ ok: true }))
    store.setMuted(true)
    await flushPromises()

    await w.find('[data-testid="voice-test"]').trigger('click')
    await flushPromises()
    expect(statusText(w)).toContain(i18n.global.t('voice.test.dropped.muted'))
  })

  it('says it was stopped when a mute cuts the utterance short', async () => {
    const say = deferred<{ ok: boolean }>()
    const { w, store } = await mountSpeaking(vi.fn().mockReturnValue(say.promise))

    await w.find('[data-testid="voice-test"]').trigger('click')
    // Nothing is queued ahead of it, so the engine takes it at once.
    expect(statusText(w)).toContain(i18n.global.t('voice.test.speaking'))

    store.setMuted(true) // `configure` silences: aborts and drains the queue.
    say.resolve({ ok: true }) // the TTS process exits after the kill signal
    await flushPromises()
    expect(statusText(w)).toContain(i18n.global.t('voice.test.stopped'))
  })

  it('names WHAT failed, from the engine own error code', async () => {
    const { w } = await mountSpeaking(
      vi.fn().mockResolvedValue({ ok: false, error: 'command-not-found' })
    )
    await w.find('[data-testid="voice-test"]').trigger('click')
    await flushPromises()

    // AC-4 — the fault is named (a command not on PATH), and no line invents a
    // volume knob to blame.
    expect(statusText(w)).toContain(i18n.global.t('voice.error.commandNotFound'))
    expect(statusText(w)).not.toContain('volume')
  })
})

describe('AC-5 — a second press is refused, never queued', () => {
  it('disables every speak control while one is in flight, and speaks exactly once', async () => {
    const say = deferred<{ ok: boolean }>()
    const impl = vi.fn().mockReturnValue(say.promise)
    const { w } = await mountSpeaking(impl)

    const test = w.find('[data-testid="voice-test"]')
    await test.trigger('click')
    expect(test.attributes('disabled')).toBeDefined()

    // A second press while busy buys nothing — the engine QUEUES, so allowing it
    // would buy a second utterance played after the first.
    await test.trigger('click')
    await test.trigger('click')
    say.resolve({ ok: true })
    await flushPromises()

    expect(impl).toHaveBeenCalledTimes(1)
    expect(w.find('[data-testid="voice-test"]').attributes('disabled')).toBeUndefined()
  })
})

describe('AC-6 — the per-voice play buttons get the identical treatment', () => {
  async function mountVoices(sayImpl: ReturnType<typeof vi.fn>): Promise<{
    w: ReturnType<typeof mount>
    store: ReturnType<typeof useVoiceStore>
  }> {
    mockApi({
      speechKokoroStatus: vi.fn().mockResolvedValue(INSTALLED),
      speechSay: sayImpl,
      speechCancel: vi.fn()
    })
    const store = useVoiceStore()
    const w = await mountPane()
    store.setEnabled(true)
    store.setBackend('kokoro')
    await flushPromises()
    return { w, store }
  }

  it('the voice in use offers a Preview that speaks and reports its outcome', async () => {
    const say = deferred<{ ok: boolean }>()
    const { w } = await mountVoices(vi.fn().mockReturnValue(say.promise))

    const preview = w.find('[data-testid="voice-preview-af_heart"]')
    expect(preview.exists()).toBe(true)

    await preview.trigger('click')
    // Nothing is queued ahead of it, so the engine takes it immediately — and
    // on a cold Kokoro the pane says so rather than implying silence.
    expect(statusText(w, 'voice-preview-status')).toContain(i18n.global.t('voice.test.speaking'))
    expect(statusText(w, 'voice-preview-status')).toContain(i18n.global.t('voice.test.coldModel'))
    expect(w.find('[data-testid="voice-preview-af_heart"]').html()).toContain('anim-spin')

    say.resolve({ ok: true })
    await flushPromises()
    expect(statusText(w, 'voice-preview-status')).toContain(i18n.global.t('voice.test.spoken'))
  })

  it('Use both selects the voice AND speaks it, reporting the same outcome', async () => {
    const { w, store } = await mountVoices(vi.fn().mockResolvedValue({ ok: true }))

    await w.find('[data-testid="voice-use-af_bella"]').trigger('click')
    await flushPromises()

    expect(store.voice).toBe('af_bella')
    expect(statusText(w, 'voice-preview-status')).toContain(i18n.global.t('voice.test.spoken'))
  })

  it('disables the whole list while one preview is in flight (no pile-up)', async () => {
    const say = deferred<{ ok: boolean }>()
    const { w } = await mountVoices(vi.fn().mockReturnValue(say.promise))

    await w.find('[data-testid="voice-preview-af_heart"]').trigger('click')
    expect(w.find('[data-testid="voice-use-af_bella"]').attributes('disabled')).toBeDefined()
    expect(w.find('[data-testid="voice-test"]').attributes('disabled')).toBeDefined()

    say.resolve({ ok: true })
    await flushPromises()
    expect(w.find('[data-testid="voice-use-af_bella"]').attributes('disabled')).toBeUndefined()
  })

  it('reports a per-voice failure by name, on the list own status line', async () => {
    const { w } = await mountVoices(
      vi.fn().mockResolvedValue({ ok: false, error: 'command-failed' })
    )
    await w.find('[data-testid="voice-preview-af_heart"]').trigger('click')
    await flushPromises()
    expect(statusText(w, 'voice-preview-status')).toContain(
      i18n.global.t('voice.error.commandFailed')
    )
  })
})

describe('AC-8/AC-10/AC-11 — the 28-voice catalog is bounded, findable and keyboard-usable', () => {
  async function mountList(): Promise<ReturnType<typeof mount>> {
    mockApi({ speechKokoroStatus: vi.fn().mockResolvedValue(INSTALLED) })
    const store = useVoiceStore()
    const w = await mountPane()
    store.setBackend('kokoro')
    await flushPromises()
    return w
  }

  it('AC-8 — the list scrolls inside a bounded container, at the documented height', async () => {
    const w = await mountList()
    const list = w.find('[data-testid="voice-list"]')
    expect(list.exists()).toBe(true)
    // design.md §4 → Layout dimensions → "Settings pane — bounded list".
    expect(list.attributes('style')).toContain('max-height: 280px')
    expect(list.classes()).toContain('overflow-y-auto')
    // The shared scrollbar treatment, not a bespoke one.
    expect(list.classes()).toContain('scrollable')
  })

  it('AC-8 — WHAT IT SAYS and SESSIONS come after the list, not below 28 rows', async () => {
    const w = await mountList()
    // Every voice row lives inside the bounded container, so nothing under it is
    // pushed off the pane by the catalog length.
    const rows = w.findAll('[data-voice-row]')
    expect(rows.length).toBe(28)
    const inList = w.findAll('[data-testid="voice-list"] [data-voice-row]')
    expect(inList.length).toBe(rows.length)
    expect(w.text()).toContain(i18n.global.t('voice.says.eyebrow'))
    expect(w.text()).toContain(i18n.global.t('voice.sessions.eyebrow'))
  })

  it('AC-8 — the pt-BR disclosure stays OUTSIDE the scroller, always visible', async () => {
    const w = await mountList()
    expect(w.find('[data-testid="voice-locale-unavailable"]').exists()).toBe(true)
    expect(
      w.find('[data-testid="voice-list"] [data-testid="voice-locale-unavailable"]').exists()
    ).toBe(false)
  })

  it('AC-10 — the voice in use is named above the list, whatever the scroll position', async () => {
    const w = await mountList()
    const inUse = w.find('[data-testid="voice-in-use"]')
    expect(inUse.exists()).toBe(true)
    expect(inUse.text()).toContain('Heart')
    // And the row itself is marked, which is what the scroll-into-view targets.
    expect(w.find('[data-voice-row="af_heart"]').attributes('data-voice-selected')).toBe('true')
  })

  it('AC-10 — the summary follows the selection', async () => {
    mockApi({ speechKokoroStatus: vi.fn().mockResolvedValue(INSTALLED) })
    const store = useVoiceStore()
    const w = await mountPane()
    store.setBackend('kokoro')
    await flushPromises()

    store.setVoice('af_bella')
    await flushPromises()
    expect(w.find('[data-testid="voice-in-use"]').text()).toContain('Bella')
    expect(w.find('[data-voice-row="af_bella"]').attributes('data-voice-selected')).toBe('true')
  })

  it('AC-11 — the container is reachable by keyboard and traps nothing inside it', async () => {
    mockApi({ speechKokoroStatus: vi.fn().mockResolvedValue(INSTALLED) })
    const store = useVoiceStore()
    // Attached: `focus()` only moves `document.activeElement` in a live tree.
    const w = mount(VoicePane, { global: { plugins: [i18n] }, attachTo: document.body })
    await flushPromises()
    store.setBackend('kokoro')
    await flushPromises()
    const list = w.find('[data-testid="voice-list"]')
    // A scrollable region needs to be reachable without a mouse.
    expect(list.attributes('tabindex')).toBe('0')
    expect(list.attributes('aria-label')).toBe(i18n.global.t('voice.voices.listAria'))

    // Focus really lands on a control deep inside the scroller — nothing steals
    // it back, and no row is removed from the tab order.
    const buttons = w.findAll('[data-testid="voice-list"] button')
    expect(buttons.length).toBeGreaterThan(0)
    const last = buttons[buttons.length - 1].element as HTMLButtonElement
    expect(last.hasAttribute('disabled')).toBe(false)
    last.focus()
    expect(document.activeElement).toBe(last)
  })
})
