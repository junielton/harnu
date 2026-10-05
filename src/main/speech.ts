import { app, ipcMain } from 'electron'
import { spawn, type ChildProcess } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { homedir } from 'node:os'
import * as path from 'node:path'
import {
  buildSpeechSpawn,
  normalizeSpeechCommand,
  speechSpawnPath,
  DEFAULT_SPEECH_COMMAND
} from './speech-command'
import {
  parseAgentSpeechPrefs,
  setFolderAgentSpeech,
  setGlobalAgentSpeech,
  type AgentSpeechPrefs
} from './speech-gate-core'
import { normalizePath } from './mcp/permission-core'

/**
 * Main-process shell for the system-command speech backend (T237).
 *
 * The renderer owns the voice engine — the queue, the mute, the focus gate, the
 * state (`src/renderer/src/lib/speech.ts`). It only cannot start a process, so
 * this module does exactly that and nothing else: spawn the configured TTS
 * command with the utterance as its last argument, resolve when the process
 * exits, and kill it on cancel.
 *
 * **Main owns the command, not the renderer.** `speech:say` carries an id and
 * text; the executable comes from this module's own store. That is deliberate
 * (`security/003`): the renderer routes agent-supplied strings into this path
 * (T238's `speak` verb), and a message that can pick the binary is a different
 * class of thing from one that can only pick words. Changing the command is its
 * own explicit door, `speech:commandSet`.
 *
 * Never through a shell — `buildSpeechSpawn` tokenizes the command into
 * file + argv. Every decision is pure and tested in `speech-command.ts`; this
 * file is the thin, env-bound half (see the coverage exclusion in
 * `vitest.config.mts`).
 *
 * T238 adds the SECOND thing main owns about voice: the agent-speech gate (the
 * global default + per-folder overrides behind the `speak` MCP verb). It lives
 * here, next to the command, for the same reason — a decision the MCP handler
 * must make BEFORE any renderer round-trip cannot live in the renderer's
 * `localStorage`. Every rule about it is pure in `speech-gate-core.ts`; this
 * module only reads and writes the JSON.
 */

export type SpeechFailure = 'invalid-command' | 'command-not-found' | 'command-failed'

export interface SpeechSayRequest {
  /** Renderer-side utterance id, used to address a later `speech:cancel`. */
  id: string
  text: string
}

export interface SpeechSayResult {
  ok: boolean
  error?: SpeechFailure
  detail?: string
}

/** In-flight utterances, so `speech:cancel` can kill the right process. */
const live = new Map<string, ChildProcess>()

/** The main-owned half of the voice settings, as `voice-prefs.json` holds it. */
interface VoiceStore {
  /** The TTS command `speech:say` spawns. Never nameable by the renderer. */
  command: string
  /** T238: the agent-speech gate — global default + per-folder overrides. */
  agentSpeech: AgentSpeechPrefs
}

/**
 * Cached store, so a `speech:say` never waits on disk. `null` = not yet read.
 * ONE cache for the whole file: the command and the gate share `voice-prefs.json`,
 * and caching them separately would let a command write clobber a gate write (the
 * old `writeSpeechCommand` rewrote the file as `{command}` alone).
 */
let cached: VoiceStore | null = null

function commandPath(): string {
  return path.join(app.getPath('userData'), 'voice-prefs.json')
}

/** Read the whole store, defaulting every field on a fresh or unreadable file. */
async function readStore(): Promise<VoiceStore> {
  if (cached !== null) return cached
  try {
    const raw: unknown = JSON.parse(await fs.readFile(commandPath(), 'utf8'))
    const o = (raw ?? {}) as { command?: unknown; agentSpeech?: unknown }
    cached = {
      command: normalizeSpeechCommand(o.command),
      agentSpeech: parseAgentSpeechPrefs(o.agentSpeech)
    }
  } catch {
    // No store yet, or unreadable — the defaults are the right answer either way,
    // and the gate's default is SILENT, so an unreadable file never starts talking.
    cached = { command: DEFAULT_SPEECH_COMMAND, agentSpeech: parseAgentSpeechPrefs(null) }
  }
  return cached
}

/** Persist the whole store, keeping the in-memory value authoritative this run. */
async function writeStore(next: VoiceStore): Promise<void> {
  cached = next
  try {
    await fs.writeFile(commandPath(), JSON.stringify(next, null, 2), 'utf8')
  } catch {
    /* read-only / full userData — the in-memory value still applies this run */
  }
}

/** The configured command, defaulting to the platform's built-in TTS on a fresh or unreadable store. */
export async function readSpeechCommand(): Promise<string> {
  return (await readStore()).command
}

/** Persist a new command. Returns what was actually stored after normalisation. */
export async function writeSpeechCommand(raw: unknown): Promise<string> {
  const store = await readStore()
  const command = normalizeSpeechCommand(raw)
  await writeStore({ ...store, command })
  return command
}

/**
 * The agent-speech gate settings (T238) — read by the `speak` MCP handler before
 * anything reaches the renderer, and by the Voice settings pane (T239).
 */
export async function readAgentSpeechPrefs(): Promise<AgentSpeechPrefs> {
  return (await readStore()).agentSpeech
}

/**
 * Flip the GLOBAL default. Writes `global` and nothing else — see
 * `setGlobalAgentSpeech`: materialising `true` into every known folder would
 * silently destroy every deliberate per-folder mute.
 */
export async function writeAgentSpeechGlobal(value: boolean): Promise<AgentSpeechPrefs> {
  const store = await readStore()
  const agentSpeech = setGlobalAgentSpeech(store.agentSpeech, value)
  await writeStore({ ...store, agentSpeech })
  return agentSpeech
}

/**
 * Set (`true`/`false`) or CLEAR (`null`, back to inheritance) one folder's override.
 *
 * The key is CANONICALISED here — the same `normalizePath` the `speak` handler
 * uses to look it up. Without that, a `~` spelling or a trailing slash from a
 * settings pane would write a key the gate never reads, and the operator's mute
 * would silently do nothing.
 */
export async function writeAgentSpeechFolder(
  folder: string,
  value: boolean | null
): Promise<AgentSpeechPrefs> {
  const store = await readStore()
  const agentSpeech = setFolderAgentSpeech(store.agentSpeech, normalizePath(folder), value)
  await writeStore({ ...store, agentSpeech })
  return agentSpeech
}

/** Kill every in-flight utterance. Called on app quit, next to `killAllPtys`. */
export function killAllSpeech(): void {
  for (const child of live.values()) {
    try {
      child.kill()
    } catch {
      // Already gone — nothing to do.
    }
  }
  live.clear()
}

function isSayRequest(value: unknown): value is SpeechSayRequest {
  if (!value || typeof value !== 'object') return false
  const o = value as Record<string, unknown>
  return typeof o.id === 'string' && o.id.length > 0 && typeof o.text === 'string'
}

export function registerSpeechHandlers(): void {
  ipcMain.handle('speech:commandGet', (): Promise<string> => readSpeechCommand())
  ipcMain.handle('speech:commandSet', (_e, command: unknown): Promise<string> =>
    writeSpeechCommand(command)
  )

  // T238: read/write the agent-speech gate. The verb itself reads the store
  // directly (it runs in main); these exist so the Voice settings pane (T239) has
  // a door, and so "turn the global on" is ONE call that cannot accidentally
  // materialise per-folder values.
  ipcMain.handle('speech:agentPrefsGet', (): Promise<AgentSpeechPrefs> => readAgentSpeechPrefs())
  ipcMain.handle('speech:agentPrefsSet', async (_e, patch: unknown): Promise<AgentSpeechPrefs> => {
    const o = (patch ?? {}) as { folder?: unknown; value?: unknown }
    const value =
      o.value === null ? null : o.value === true ? true : o.value === false ? false : undefined
    if (value === undefined) return readAgentSpeechPrefs()
    if (typeof o.folder === 'string' && o.folder.length > 0) {
      return writeAgentSpeechFolder(o.folder, value)
    }
    // The GLOBAL default is a plain boolean — there is no "unset the global".
    return value === null ? readAgentSpeechPrefs() : writeAgentSpeechGlobal(value)
  })

  ipcMain.handle('speech:say', async (_e, req: unknown): Promise<SpeechSayResult> => {
    if (!isSayRequest(req)) {
      return { ok: false, error: 'invalid-command', detail: 'malformed speech:say payload' }
    }
    const spec = buildSpeechSpawn(await readSpeechCommand(), req.text)
    if (!spec) {
      return { ok: false, error: 'invalid-command', detail: 'empty or unparsable command' }
    }

    return new Promise<SpeechSayResult>((resolve) => {
      let child: ChildProcess
      try {
        child = spawn(spec.file, spec.args, {
          stdio: 'ignore',
          windowsHide: true,
          env: {
            ...process.env,
            PATH: speechSpawnPath(process.env.PATH, homedir(), process.platform)
          }
        })
      } catch (err) {
        resolve({ ok: false, error: 'command-failed', detail: String(err) })
        return
      }

      live.set(req.id, child)
      let settled = false
      const done = (result: SpeechSayResult): void => {
        if (settled) return
        settled = true
        live.delete(req.id)
        resolve(result)
      }

      child.once('error', (err: NodeJS.ErrnoException) => {
        done({
          ok: false,
          error: err.code === 'ENOENT' ? 'command-not-found' : 'command-failed',
          detail: err.message
        })
      })
      child.once('close', (code, signal) => {
        // Killed by our own `speech:cancel` — the renderer already discarded
        // this utterance, so reporting a failure would be noise.
        if (signal) return done({ ok: true })
        if (code === 0) return done({ ok: true })
        done({ ok: false, error: 'command-failed', detail: `exited with code ${code}` })
      })
    })
  })

  ipcMain.on('speech:cancel', (_e, id: unknown) => {
    if (typeof id !== 'string') return
    const child = live.get(id)
    if (!child) return
    live.delete(id)
    try {
      child.kill()
    } catch {
      // Already exited between the renderer's abort and this kill.
    }
  })
}
