import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { promises as fs, mkdtempSync } from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'

/**
 * The `<userData>` the store writes into. Minted before the electron mock so the
 * mocked `app.getPath` can close over it — every test in this file shares one
 * directory, matching the module's own process-lifetime cache.
 */
const USER_DATA = vi.hoisted(() => ({
  dir: ''
}))

vi.mock('electron', () => ({
  app: { getPath: (): string => USER_DATA.dir, isPackaged: false, getAppPath: () => process.cwd() },
  dialog: {},
  shell: {},
  BrowserWindow: class {},
  ipcMain: { handle: (): void => {}, on: (): void => {} }
}))

import {
  readAgentSpeechPrefs,
  readSpeechCommand,
  writeAgentSpeechFolder,
  writeAgentSpeechGlobal,
  writeSpeechCommand
} from '../src/main/speech'
import { resolveAgentSpeechEnabled } from '../src/main/speech-gate-core'

/**
 * T238 — the agent-speech gate's STORE, exercised against a real
 * `voice-prefs.json`.
 *
 * AC-3b is a claim about what lands ON DISK ("flipping the global writes NO
 * per-folder value"), and the pure `setGlobalAgentSpeech` can only prove half of
 * it: the other half is that the shell persists exactly what the setter
 * returned. This file reads the bytes back.
 *
 * It also pins the regression the T238 refactor had to fix: `writeSpeechCommand`
 * used to rewrite the whole file as `{ command }`, so a later command change
 * would have silently erased every voice override.
 */

const MUTED = '/home/u/repo/muted-worktree'
const FRESH = '/home/u/repo/some-worktree-created-tomorrow'

function prefsFile(): string {
  return path.join(USER_DATA.dir, 'voice-prefs.json')
}

async function onDisk(): Promise<Record<string, unknown>> {
  return JSON.parse(await fs.readFile(prefsFile(), 'utf8'))
}

beforeAll(() => {
  USER_DATA.dir = mkdtempSync(path.join(os.tmpdir(), 'harnu-voice-prefs-'))
})

afterAll(async () => {
  await fs.rm(USER_DATA.dir, { recursive: true, force: true })
})

describe('the agent-speech store', () => {
  it('a fresh install reads as silent — no file, no global, no overrides', async () => {
    const prefs = await readAgentSpeechPrefs()
    expect(prefs).toEqual({ version: 1, folders: {} })
    expect(resolveAgentSpeechEnabled(prefs, FRESH)).toBe(false)
  })

  it('AC-3b: turning the global ON persists ONLY the global — the muted folder is untouched', async () => {
    await writeAgentSpeechFolder(MUTED, false)
    await writeAgentSpeechGlobal(true)

    const raw = await onDisk()
    expect(raw.agentSpeech).toEqual({ version: 1, global: true, folders: { [MUTED]: false } })

    const prefs = await readAgentSpeechPrefs()
    // The mute survives the global; a folder that never existed inherits it.
    expect(resolveAgentSpeechEnabled(prefs, MUTED)).toBe(false)
    expect(resolveAgentSpeechEnabled(prefs, FRESH)).toBe(true)
  })

  it('clearing a folder override returns it to inheritance and drops the key', async () => {
    await writeAgentSpeechFolder(MUTED, null)
    const raw = (await onDisk()).agentSpeech as { folders: Record<string, unknown> }
    expect(MUTED in raw.folders).toBe(false)
    expect(resolveAgentSpeechEnabled(await readAgentSpeechPrefs(), MUTED)).toBe(true)
  })

  it('a folder key is canonicalised on write, so a trailing slash still mutes', async () => {
    // The gate looks the folder up by its normalized path; a settings pane that
    // wrote `/repo/` would otherwise store a key the gate never reads.
    await writeAgentSpeechFolder(`${MUTED}/`, false)
    const raw = (await onDisk()).agentSpeech as { folders: Record<string, unknown> }
    expect(Object.keys(raw.folders)).toEqual([MUTED])
    expect(resolveAgentSpeechEnabled(await readAgentSpeechPrefs(), MUTED)).toBe(false)
    await writeAgentSpeechFolder(MUTED, null)
  })

  it('changing the TTS command no longer erases the voice overrides', async () => {
    // The regression: the pre-T238 `writeSpeechCommand` wrote `{ command }` alone.
    await writeAgentSpeechFolder(MUTED, false)
    await writeSpeechCommand('espeak-ng')

    expect(await readSpeechCommand()).toBe('espeak-ng')
    const raw = await onDisk()
    expect(raw.command).toBe('espeak-ng')
    expect(raw.agentSpeech).toEqual({ version: 1, global: true, folders: { [MUTED]: false } })
  })

  it('and setting a voice override no longer erases the command', async () => {
    await writeAgentSpeechGlobal(false)
    expect(await readSpeechCommand()).toBe('espeak-ng')
    expect((await onDisk()).command).toBe('espeak-ng')
  })
})
