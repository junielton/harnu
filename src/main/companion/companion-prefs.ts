/**
 * The store behind `<userData>/companion-prefs.json` (T389 P1W4 §7.3): an in-memory mirror
 * hydrated at boot and written on change, like `responder-registry.ts`. Electron-free on purpose
 * (the shell tells it where the file is), so every rule is tested without a stub of `electron`.
 * The decisions themselves are pure in `companion-prefs-core.ts`.
 *
 * It also holds the two inputs the prefs file does not: the CLI gate of the installed binary and
 * the per-folder ramp (`projects.json`'s `companionActive`).
 */

import { promises as fs } from 'node:fs'
import { dirname, join } from 'node:path'
import type { RolloutView } from './arbitration-core'
import { normalizeFolder } from './arbitration-core'
import {
  buildRollout,
  companionModeOf,
  decideInject,
  defaultPrefs,
  listenerWantedFor,
  parsePrefs,
  serializePrefs,
  type CompanionPrefs,
  type PrefsKeySpec
} from './companion-prefs-core'
import type { CompanionInjectDecision } from './arbitration-core'
import type { CompanionMode, FactFamily } from './mode'
import type { CliGate } from './version-gate'

let prefsPath: string | null = null
let prefs: CompanionPrefs = defaultPrefs()
let gate: CliGate = 'unknown'
let ramp: ReadonlySet<string> = new Set()
const listeners = new Set<() => void>()
const keySpecs = new Map<string, PrefsKeySpec<unknown>>()

// ---- change notification -------------------------------------------------------------------

interface Answer {
  mode: CompanionMode
  wanted: boolean
  enabled: boolean
}
const answer = (): Answer => ({
  mode: companionModeOf(prefs, gate, ramp),
  wanted: listenerWantedFor(prefs),
  enabled: prefs.enabled
})

/** Runs a mutation and fires the listeners once when the host-visible answer changed. */
function mutate<T>(fn: () => T): T {
  const before = answer()
  const out = fn()
  const after = answer()
  if (
    before.mode !== after.mode ||
    before.wanted !== after.wanted ||
    before.enabled !== after.enabled
  ) {
    for (const l of [...listeners]) {
      try {
        l()
      } catch {
        // one listener's failure never stops the others
      }
    }
  }
  return out
}

/** Fires when a prefs write, the kill switch or the settled CLI-version probe changes the answer. */
export function onModeChange(fn: () => void): () => void {
  listeners.add(fn)
  return () => void listeners.delete(fn)
}

// ---- persistence ---------------------------------------------------------------------------

let writeChain: Promise<void> = Promise.resolve()
let writeFailureLogged = false

async function writeNow(path: string, text: string): Promise<void> {
  await fs.mkdir(dirname(path), { recursive: true })
  const tmp = join(dirname(path), `.companion-prefs.${process.pid}.tmp`)
  await fs.writeFile(tmp, text, { mode: 0o600 })
  await fs.chmod(tmp, 0o600) // the create mode is masked by the umask
  await fs.rename(tmp, path)
}

function persist(): Promise<void> {
  const path = prefsPath
  if (path === null) return Promise.resolve()
  const text = serializePrefs(prefs)
  writeChain = writeChain.then(() =>
    writeNow(path, text).catch((err: unknown) => {
      if (!writeFailureLogged) {
        writeFailureLogged = true
        console.warn(
          `[companion] could not write companion-prefs.json (${(err as { code?: string }).code ?? 'error'}); the setting holds for this run only`
        )
      }
    })
  )
  return writeChain
}

/** Resolves once every queued write has landed. */
export function flushCompanionPrefs(): Promise<void> {
  return writeChain
}

// ---- lifecycle -----------------------------------------------------------------------------

/** Where `companion-prefs.json` lives; `null` means no file is read or written. */
export function setCompanionPrefsPath(path: string | null): void {
  prefsPath = path
  prefs = defaultPrefs()
  ramp = new Set()
  writeFailureLogged = false
}

/** Reads the prefs file once; a missing or unusable file reads the shipped defaults. */
export async function hydrateCompanionPrefs(): Promise<void> {
  let raw: string | null = null
  if (prefsPath !== null) {
    try {
      raw = await fs.readFile(prefsPath, 'utf8')
    } catch {
      raw = null // a missing file is the normal case
    }
  }
  const next = parsePrefs(raw)
  mutate(() => {
    prefs = next
  })
}

/** The CLI gate of the installed binary; fires `onModeChange` when the answer changes. */
export function setCompanionCliGate(next: CliGate): void {
  mutate(() => {
    gate = next
  })
}

export function companionCliGate(): CliGate {
  return gate
}

/** Replaces the per-folder ramp (`projects.json` `companionActive`), normalized like the ramp set. */
export function setRampFolders(paths: readonly string[]): void {
  mutate(() => {
    ramp = new Set(paths.map(normalizeFolder))
  })
}

// ---- reads ---------------------------------------------------------------------------------

export function rolloutView(): RolloutView {
  return buildRollout(prefs, gate, ramp)
}

export function getCompanionPrefs(): Readonly<CompanionPrefs> {
  return prefs
}

export const companionMode = (): CompanionMode => companionModeOf(prefs, gate, ramp)
export const listenerWantedNow = (): boolean => listenerWantedFor(prefs)

export function companionInjectDecision(ctx: {
  kind: string
  cliGate: CliGate
}): CompanionInjectDecision {
  return decideInject(prefs, ctx)
}

// ---- writes (renderer IPC only; no MCP verb reaches them, SEC-9) ---------------------------

export function setCompanionEnabled(on: boolean): Promise<void> {
  mutate(() => {
    prefs = { ...prefs, enabled: on }
  })
  return persist()
}

export function setFamilyMode(family: FactFamily, mode: CompanionMode): Promise<void> {
  mutate(() => {
    prefs = { ...prefs, families: { ...prefs.families, [family]: mode } }
  })
  return persist()
}

export function setAllFolders(on: boolean): Promise<void> {
  mutate(() => {
    prefs = { ...prefs, allFolders: on }
  })
  return persist()
}

/** Stamps the first time the notice was rendered; later calls change nothing. */
export function markDisclosureShown(at: number = Date.now()): Promise<void> {
  if (prefs.disclosureShownAt !== undefined) return Promise.resolve()
  mutate(() => {
    prefs = { ...prefs, disclosureShownAt: at }
  })
  return persist()
}

// ---- the extension point for features with no fact family (ARB-6b, contract §11.5) ---------

/** Each wave registers its own key; none edits this schema. */
export function registerPrefsKey<T>(key: string, spec: PrefsKeySpec<T>): void {
  keySpecs.set(key, spec as PrefsKeySpec<unknown>)
}

/** Capped at `observeCap` when the CLI gate is `above`, whatever the file holds. */
export function prefsKey<T>(key: string): T {
  const spec = keySpecs.get(key)
  if (!spec) throw new Error(`companion prefs key not registered: ${key}`)
  if (gate === 'above' && spec.observeCap !== undefined) return spec.observeCap as T
  return (key in prefs.keys ? spec.parse(prefs.keys[key]) : spec.default) as T
}

export function setPrefsKey<T>(key: string, value: T): void {
  if (!keySpecs.has(key)) throw new Error(`companion prefs key not registered: ${key}`)
  mutate(() => {
    prefs = { ...prefs, keys: { ...prefs.keys, [key]: value } }
  })
  void persist()
}

export function resetPrefsKeysForTests(): void {
  keySpecs.clear()
}
