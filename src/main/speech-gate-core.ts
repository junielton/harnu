/**
 * T238 — the `speak` verb's PURE gate: who may make the machine talk, how much
 * they may say, and how often.
 *
 * Everything here is plain data in / plain data out (ADR-0001 pure-core /
 * thin-shell), so the rules that decide whether a folder speaks are unit-testable
 * without Electron. The env-bound half — the `<userData>/voice-prefs.json` read
 * and write — lives in `speech.ts`, which is coverage-excluded for exactly that
 * reason.
 *
 * THE DESIGN POINT: `speak` is not `notify`. `notify` appends a row to a local,
 * read-only history; `speak` makes an interruption in PHYSICAL SPACE that reaches
 * everyone in the room, including whoever is on a call. So it carries its own
 * gate — the operator's, resolved here — on top of the ordinary folder block.
 *
 * The gate is a GLOBAL DEFAULT WITH PER-FOLDER OVERRIDES, not a per-folder
 * opt-in. Enumerating folders one by one is unworkable in a repo that grows a
 * worktree per dispatch, so the resolution is the tri-state cascade
 * `folder ?? global ?? false` — literally {@link resolveSkillEnabled} from
 * `bundled-skills-core.ts`, reused rather than reimplemented, so voice and
 * bundled skills can never drift into two different answers to the same shape of
 * question.
 *
 * Three rules decide whether this is pleasant or infuriating, and all three are
 * enforced by construction below:
 *
 *  1. **Turning the global ON writes NO per-folder value** — {@link setGlobalAgentSpeech}
 *     touches `global` and nothing else. The naive materialising version (write
 *     `true` into every known folder) looks equivalent and destroys every explicit
 *     per-folder OFF. Inheritance is resolved at READ time, never persisted.
 *  2. **An explicit per-folder OFF beats a global ON** — the cascade reads the
 *     folder first. Without this the per-folder mute is decorative.
 *  3. A folder **blocked for agents** overrides everything, the global included
 *     ({@link resolveSpeakGate}'s `blocked` argument wins outright). Voice must
 *     never become a back door into a folder the operator closed.
 */

import { resolveSkillEnabled, type SkillFlags } from './bundled-skills-core'

/**
 * The one flag name the voice cascade resolves under. `resolveSkillEnabled` is
 * keyed by name because a skills catalog has many; voice has exactly one switch,
 * so it always resolves the same key. The constant exists so the two call sites
 * (global map, folder map) can never disagree on the spelling.
 */
const VOICE_FLAG = 'speak'

/**
 * The operator's agent-speech settings, as stored in `<userData>/voice-prefs.json`.
 *
 * `global` and every entry of `folders` are TRI-STATE: `undefined` means "never
 * set" and inherits; `true`/`false` are explicit and win in both directions. A
 * folder is born with NO value — never `false` — which is what makes "and every
 * future folder" work with no migration, no enumeration and no settings write.
 */
export interface AgentSpeechPrefs {
  version: 1
  /** Global default for every folder that has no explicit value. Unset ⇒ OFF. */
  global?: boolean
  /**
   * Per-folder overrides keyed by CANONICAL absolute path (the shell normalizes
   * before it looks up). A MISSING key means "not set" — inherit the global.
   * Deliberately an exact-key map, not a prefix match: a worktree is its own
   * folder in Harnu, and a repo-wide mute that silently swallowed one worktree's
   * explicit ON would be the unauditable behaviour rule 3 exists to prevent.
   */
  folders: Record<string, boolean | undefined>
}

/** A fresh install: no global, no overrides — every folder silent. */
export const EMPTY_AGENT_SPEECH_PREFS: AgentSpeechPrefs = { version: 1, folders: {} }

/**
 * Parse a stored blob into {@link AgentSpeechPrefs}. Total: missing / corrupt /
 * hand-edited input degrades to {@link EMPTY_AGENT_SPEECH_PREFS} rather than
 * throwing, and any non-boolean folder value is DROPPED (not coerced) — coercing
 * `"false"` to `true` would turn a mute into speech, which is the one direction
 * this parser must never fail in.
 */
export function parseAgentSpeechPrefs(raw: unknown): AgentSpeechPrefs {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { version: 1, folders: {} }
  const o = raw as Record<string, unknown>
  const out: AgentSpeechPrefs = { version: 1, folders: {} }
  if (typeof o.global === 'boolean') out.global = o.global
  const folders = o.folders
  if (folders && typeof folders === 'object' && !Array.isArray(folders)) {
    for (const [key, value] of Object.entries(folders as Record<string, unknown>)) {
      if (key && typeof value === 'boolean') out.folders[key] = value
    }
  }
  return out
}

/**
 * The cascade: `folder ?? global ?? false`, folder first.
 *
 * Delegates to {@link resolveSkillEnabled} — the SAME function bundled skills
 * resolve through (T217). This is the card's "do not invent a second resolution
 * rule" made structural: there is only one implementation of the tri-state
 * cascade in the codebase, and voice calls it.
 */
export function resolveAgentSpeechEnabled(prefs: AgentSpeechPrefs, folder: string): boolean {
  const global: SkillFlags = { [VOICE_FLAG]: prefs.global }
  const local: SkillFlags = { [VOICE_FLAG]: prefs.folders[folder] }
  return resolveSkillEnabled(global, local, VOICE_FLAG)
}

/**
 * Why a `speak` call was (or was not) allowed to reach the speakers. Each
 * non-`allowed` member maps to its own refusal code so the ACK NAMES the gate
 * that refused instead of leaving the agent to guess which switch to ask about.
 */
export type SpeakGate = 'allowed' | 'folder-blocked' | 'folder-muted' | 'global-off'

/**
 * Resolve the gate for one call.
 *
 * `blocked` (the operator's `agentDenied` folder block, resolved by the shell
 * from the live policy) OUTRANKS every voice setting, the global included — the
 * card's "not negotiable" clause. The ordinary MCP gate already denies a blocked
 * folder with `FOLDER_NOT_ALLOWED` before a handler runs; this argument is the
 * belt-and-braces half, so the rule holds even if `speak` were ever reached by
 * some other path.
 *
 * Below the block, the cascade decides, and the two silent outcomes are told
 * apart on purpose: an explicit per-folder `false` is a DELIBERATE mute (asking
 * the operator to flip the global would be the wrong advice), while an unset
 * folder under an unset/`false` global is simply voice not being on yet.
 */
export function resolveSpeakGate(
  prefs: AgentSpeechPrefs,
  folder: string,
  blocked: boolean
): SpeakGate {
  if (blocked) return 'folder-blocked'
  if (resolveAgentSpeechEnabled(prefs, folder)) return 'allowed'
  return prefs.folders[folder] === false ? 'folder-muted' : 'global-off'
}

/** The refusal code each silent gate reports. Keys into `deny-hint.ts`'s steers. */
export const SPEAK_GATE_ERRORS: Record<Exclude<SpeakGate, 'allowed'>, string> = {
  'folder-blocked': 'FOLDER_NOT_ALLOWED',
  'folder-muted': 'VOICE_MUTED_FOR_FOLDER',
  'global-off': 'VOICE_DISABLED'
}

/**
 * Set the GLOBAL default. Returns a new prefs object whose `folders` map is
 * carried over UNTOUCHED — rule 1. Every explicit per-folder value, in either
 * direction, survives a global flip; a folder the operator muted weeks ago does
 * not start speaking because they turned voice on somewhere else.
 */
export function setGlobalAgentSpeech(prefs: AgentSpeechPrefs, value: boolean): AgentSpeechPrefs {
  return { version: 1, global: value, folders: { ...prefs.folders } }
}

/**
 * Set (or CLEAR) one folder's override. `null` deletes the key, returning the
 * folder to inheritance — the only way back to "unset", and the reason the map
 * stores `undefined` as absence rather than as a third stored value.
 */
export function setFolderAgentSpeech(
  prefs: AgentSpeechPrefs,
  folder: string,
  value: boolean | null
): AgentSpeechPrefs {
  const folders = { ...prefs.folders }
  if (value === null) delete folders[folder]
  else folders[folder] = value
  const out: AgentSpeechPrefs = { version: 1, folders }
  if (prefs.global !== undefined) out.global = prefs.global
  return out
}

// ---- What "not spoken" means --------------------------------------------------

/**
 * Why an ALLOWED utterance still was not heard. These come back from the renderer
 * — the only side that knows where the operator is looking and what the engine's
 * own switches say — and each is a SUCCESS, not a failure.
 */
export type SpeakUnspokenReason = 'engine-off' | 'muted' | 'focused'

/**
 * The one-line explanation each reason rides with in the ACK.
 *
 * `engine-off` is the one that would otherwise be genuinely confusing: voice has
 * TWO switches, and this verb's gate is only one of them. The operator can enable
 * agent speech for a folder while the speech engine itself (the master switch,
 * shared with any read-aloud they ask for themselves) is still off — in which case
 * the agent is allowed to speak and nothing comes out. Saying so in the ACK is the
 * difference between the agent asking the right question and it silently believing
 * it was heard.
 */
export const SPEAK_UNSPOKEN_HINTS: Record<SpeakUnspokenReason, string> = {
  'engine-off':
    "Agent voice is enabled for this folder, but the speech engine itself is switched off — that is a SECOND switch (Settings \u2192 Voice), and this verb's gate cannot turn it on. Nothing was heard: use notify if the operator must not miss this.",
  muted:
    'The operator has voice muted right now, so nothing was heard. Do not retry \u2014 use notify if this must not be missed.',
  focused:
    'Suppressed on purpose: the operator is looking at this very session and can read it. This is the rule working, not a failure \u2014 do not retry.'
}

/** The hint for a reason the renderer reported, or `undefined` for an unknown one. */
export function speakUnspokenHint(reason: string | undefined): string | undefined {
  return reason && reason in SPEAK_UNSPOKEN_HINTS
    ? SPEAK_UNSPOKEN_HINTS[reason as SpeakUnspokenReason]
    : undefined
}

// ---- The rate limit ---------------------------------------------------------

/** Utterances one session may start inside {@link SPEAK_RATE_WINDOW_MS}. */
export const SPEAK_RATE_LIMIT = 5

/** The sliding window the limit is counted over. */
export const SPEAK_RATE_WINDOW_MS = 60_000

/** The outcome of one rate check, plus the pruned window to store back. */
export interface SpeakRateVerdict {
  allowed: boolean
  /** The window AFTER this attempt — pruned, and with `now` appended if allowed. */
  hits: number[]
  /** Milliseconds until the oldest hit ages out. `0` when allowed. */
  retryAfterMs: number
}

/**
 * A sliding-window rate check, pure over the caller's stored timestamps.
 *
 * The engine already SERIALISES utterances (T237's queue), so a looping agent
 * cannot overlap speech — but it can absolutely hold the speakers for as long as
 * it keeps calling, which is worse: a queue that never drains is a machine that
 * will not stop talking. This caps how many an agent may START per window;
 * refused calls are NOT counted, so a rate-limited agent cannot push its own
 * recovery further away by retrying.
 */
export function checkSpeakRate(
  hits: readonly number[],
  now: number,
  limit: number = SPEAK_RATE_LIMIT,
  windowMs: number = SPEAK_RATE_WINDOW_MS
): SpeakRateVerdict {
  const cutoff = now - windowMs
  const live = hits.filter((t) => t > cutoff).sort((a, b) => a - b)
  if (live.length < limit) return { allowed: true, hits: [...live, now], retryAfterMs: 0 }
  return { allowed: false, hits: live, retryAfterMs: Math.max(1, live[0] + windowMs - now) }
}
