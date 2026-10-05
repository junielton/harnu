// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useVoiceStore } from '../src/renderer/src/stores/voice'
import { VOICE_PREFS_KEY } from '../src/renderer/src/lib/speech-prefs'
import { DEFAULT_VOICE_PHRASE } from '../src/renderer/src/lib/voice-phrase'
import type { AgentSpeechPrefs } from '../src/main/speech-gate-core'

/**
 * T239 — the Voice store. Two product rules live here and are asserted rather
 * than trusted: **enabling voice never starts a download** (AC-3), and **the
 * per-folder gate is resolved, never materialised** (AC-11/AC-13).
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

interface ApiSpies {
  speechKokoroInstall: ReturnType<typeof vi.fn>
  speechKokoroStatus: ReturnType<typeof vi.fn>
  speechKokoroRemove: ReturnType<typeof vi.fn>
  speechKokoroCancel: ReturnType<typeof vi.fn>
  speechAgentPrefsSet: ReturnType<typeof vi.fn>
}

/** The live prefs blob main would hold, so `set` behaves like the real cascade. */
let agentPrefs: AgentSpeechPrefs

function mockApi(over: Record<string, unknown> = {}): ApiSpies {
  agentPrefs = { version: 1, folders: {} }
  const api = {
    speechCommandGet: vi.fn().mockResolvedValue('spd-say -w'),
    speechCommandSet: vi.fn((c: string) => Promise.resolve(c)),
    speechKokoroStatus: vi.fn().mockResolvedValue({
      installed: false,
      manifest: null,
      installing: false,
      directory: '/ud/voice-kokoro',
      runtime: RUNTIME
    }),
    speechKokoroPlan: vi.fn().mockResolvedValue({ totalBytes: 119_000_000 }),
    speechKokoroInstall: vi.fn().mockResolvedValue({
      installed: true,
      manifest: { voices: ['af_heart'], bytes: 119_000_000 },
      installing: false,
      directory: '/ud/voice-kokoro',
      runtime: RUNTIME
    }),
    speechKokoroCancel: vi.fn().mockResolvedValue(true),
    speechKokoroRemove: vi.fn().mockResolvedValue({
      installed: false,
      manifest: null,
      installing: false,
      directory: '/ud/voice-kokoro',
      runtime: RUNTIME
    }),
    onSpeechKokoroProgress: vi.fn().mockReturnValue(() => {}),
    speechAgentPrefsGet: vi.fn(() => Promise.resolve(agentPrefs)),
    // Mirrors main's `setGlobalAgentSpeech` / `setFolderAgentSpeech`: a global
    // write carries the folder map across UNTOUCHED, and `null` deletes a key.
    speechAgentPrefsSet: vi.fn((patch: { folder?: string; value: boolean | null }) => {
      if (patch.folder === undefined) {
        agentPrefs = {
          version: 1,
          global: patch.value === true,
          folders: { ...agentPrefs.folders }
        }
      } else {
        const folders = { ...agentPrefs.folders }
        if (patch.value === null) delete folders[patch.folder]
        else folders[patch.folder] = patch.value
        agentPrefs = {
          version: 1,
          ...(agentPrefs.global === undefined ? {} : { global: agentPrefs.global }),
          folders
        }
      }
      return Promise.resolve(agentPrefs)
    }),
    ...over
  }
  ;(window as unknown as { api: unknown }).api = api
  return api as unknown as ApiSpies
}

beforeEach(() => {
  setActivePinia(createPinia())
  localStorage.clear()
})

describe('AC-3 — enabling voice never starts a download', () => {
  it('turning the master switch on touches no install door', async () => {
    const api = mockApi()
    const store = useVoiceStore()
    await store.load()

    store.setEnabled(true)

    expect(store.enabled).toBe(true)
    expect(api.speechKokoroInstall).not.toHaveBeenCalled()
  })

  it('SELECTING the offline engine does not fetch either', async () => {
    const api = mockApi()
    const store = useVoiceStore()
    await store.load()

    store.setBackend('kokoro')

    expect(store.backend).toBe('kokoro')
    expect(api.speechKokoroInstall).not.toHaveBeenCalled()
  })

  it('loading the pane reads status but never installs', async () => {
    const api = mockApi()
    const store = useVoiceStore()
    await store.load()

    expect(api.speechKokoroStatus).toHaveBeenCalled()
    expect(api.speechKokoroInstall).not.toHaveBeenCalled()
  })

  it('install() is the ONE door, and only an explicit call opens it', async () => {
    const api = mockApi()
    const store = useVoiceStore()
    await store.load()

    await store.install(['af_heart'])

    expect(api.speechKokoroInstall).toHaveBeenCalledWith(['af_heart'])
    expect(store.installed).toBe(true)
    expect(store.downloadedVoices).toEqual(['af_heart'])
  })

  it('refuses a second install while one is already running', async () => {
    const api = mockApi()
    const store = useVoiceStore()
    await store.load()
    store.kokoro = { ...store.kokoro!, installing: true }

    await store.install()

    expect(api.speechKokoroInstall).not.toHaveBeenCalled()
  })
})

describe('AC-4 / AC-7 — cancel and reclaim', () => {
  it('cancel reaches the downloader', async () => {
    const api = mockApi()
    const store = useVoiceStore()
    await store.load()
    await store.cancelInstall()
    expect(api.speechKokoroCancel).toHaveBeenCalled()
  })

  it('remove reclaims the disk and returns to the pre-download state', async () => {
    const api = mockApi()
    const store = useVoiceStore()
    await store.load()
    await store.install()
    expect(store.diskBytes).toBe(119_000_000)

    await store.remove()

    expect(api.speechKokoroRemove).toHaveBeenCalled()
    expect(store.installed).toBe(false)
    expect(store.diskBytes).toBe(0)
    expect(store.progress).toBeNull()
  })
})

describe('preferences round-trip', () => {
  it('persists to localStorage so a chosen voice survives a restart (AC-5)', async () => {
    mockApi()
    const store = useVoiceStore()
    await store.load()

    store.setVoice('bm_george')
    store.setPhrase('{session} {event}')

    const raw = JSON.parse(localStorage.getItem(VOICE_PREFS_KEY) ?? '{}')
    expect(raw.voice).toBe('bm_george')
    expect(raw.phrase).toBe('{session} {event}')
  })

  it('coerces a voice that is not in the catalog rather than asking for a missing file', async () => {
    mockApi()
    const store = useVoiceStore()
    await store.load()
    store.setVoice('pf_dora') // a real Kokoro voice, but not one kokoro-js exposes
    expect(store.voice).toBe('af_heart')
  })

  it('an emptied phrase falls back to the default instead of silently muting', async () => {
    mockApi()
    const store = useVoiceStore()
    await store.load()
    store.setPhrase('   ')
    expect(store.phrase).toBe(DEFAULT_VOICE_PHRASE)
  })
})

describe('AC-11 — the global switch never writes a per-folder value', () => {
  it('flipping the global leaves every explicit override untouched', async () => {
    const api = mockApi()
    const store = useVoiceStore()
    await store.load()

    await store.setAgentFolder('/repo/muted', false)
    await store.setAgentFolder('/repo/loud', true)

    await store.setAgentGlobal(true)

    // The write named no folder at all…
    const globalCall = api.speechAgentPrefsSet.mock.calls.at(-1)?.[0]
    expect(globalCall).toEqual({ value: true })
    // …and the deliberate mute survived it.
    expect(store.agentPrefs.folders).toEqual({ '/repo/muted': false, '/repo/loud': true })
    expect(store.agentGlobal).toBe(true)
  })

  it('resolves each folder without materialising inheritance', async () => {
    mockApi()
    const store = useVoiceStore()
    await store.load()
    await store.setAgentFolder('/repo/muted', false)
    await store.setAgentGlobal(true)

    const rows = store.exceptionRows(
      [
        { path: '/repo/muted', alias: 'muted' },
        { path: '/repo/plain', alias: 'plain' }
      ],
      new Set<string>()
    )

    // Only the folder that carries an explicit value is a row: listing every
    // inheriting folder would bury the handful that were actually decided.
    expect(rows.map((r) => r.path)).toEqual(['/repo/muted'])
    expect(rows[0]).toMatchObject({ state: 'explicit-off', resolved: false, value: false })
    // …and the folder that was never set still has no stored value.
    expect('/repo/plain' in store.agentPrefs.folders).toBe(false)
    expect(store.resolvedForFolder('/repo/plain', false)).toBe('inherited')
  })
})

describe('AC-14 — a blocked folder is silent-and-locked regardless of the global', () => {
  it('reports `blocked` and an unresolved false even with the global ON', async () => {
    mockApi()
    const store = useVoiceStore()
    await store.load()
    await store.setAgentGlobal(true)
    await store.setAgentFolder('/repo/blocked', true) // explicitly ON, and still blocked

    const rows = store.exceptionRows(
      [{ path: '/repo/blocked', alias: 'blocked' }],
      new Set(['/repo/blocked'])
    )

    expect(rows[0]).toMatchObject({ state: 'blocked', resolved: false })
    expect(store.resolvedForFolder('/repo/blocked', true)).toBe('blocked')
  })

  it('lists a blocked folder even when it carries no voice override at all', async () => {
    mockApi()
    const store = useVoiceStore()
    await store.load()

    const rows = store.exceptionRows([{ path: '/repo/b', alias: 'b' }], new Set(['/repo/b']))

    expect(rows).toHaveLength(1)
    expect(rows[0].state).toBe('blocked')
  })
})

describe('AC-13 — "Clear exceptions" leaves the global untouched', () => {
  it('removes every per-folder override and keeps the global as it was', async () => {
    mockApi()
    const store = useVoiceStore()
    await store.load()
    await store.setAgentGlobal(true)
    await store.setAgentFolder('/a', false)
    await store.setAgentFolder('/b', true)
    expect(store.hasExceptions).toBe(true)

    await store.clearAgentExceptions()

    expect(store.agentPrefs.folders).toEqual({})
    expect(store.agentGlobal).toBe(true)
    expect(store.hasExceptions).toBe(false)
  })
})
