/**
 * Pure core for the system-command speech backend (T237).
 *
 * The renderer owns the voice engine (queue, mute, state); the one thing it
 * cannot do is start a process, so `speech.ts` spawns the operator's TTS
 * command. Every decision that spawn needs — how a command string becomes
 * argv, and what PATH to look it up on — lives here so it is unit-testable
 * without a subprocess (ADR-0001 pure-core / thin-shell convention).
 *
 * Two trust rules are enforced here, both from the repo's security lessons:
 *
 *  - **The command is never run through a shell.** It is tokenized into
 *    file + argv, so spoken text cannot be read as shell syntax no matter what
 *    an agent hands the engine (`security/001`, `security/002`).
 *  - **The renderer never names the executable.** `speech:say` carries text
 *    only; the command comes from main's own store, seeded with
 *    {@link DEFAULT_SPEECH_COMMAND} and changed only through the explicit
 *    `speech:commandSet` door. A forged or agent-influenced `speech:say`
 *    therefore cannot choose a binary — it can only ask for words
 *    (`security/003`: pin the target, don't take it from the wire).
 */

/**
 * The command a fresh install speaks with on each platform (T237 AC-4). A bare PATH
 * lookup on purpose: no absolute path, nothing tied to one machine or one operator's
 * home directory, and a binary the OS already ships.
 *
 *  - macOS: `say`, built in. It blocks until it has spoken, so utterances serialise.
 *  - Linux: `spd-say -w` (speech-dispatcher, preinstalled on most desktops). `-w`
 *    waits until the message is spoken, for the same reason.
 *  - Windows: none. Its built-in voice is reachable only through PowerShell, and
 *    handing spoken text to `powershell -Command` would let the text run as code.
 *    The operator configures a command instead; until then, `speech:say` reports
 *    `invalid-command` and stays silent.
 *
 * A command the operator saved is kept as is; this only seeds a fresh store.
 */
export function defaultSpeechCommand(platform: NodeJS.Platform = process.platform): string {
  if (platform === 'darwin') return 'say'
  if (platform === 'win32') return ''
  return 'spd-say -w'
}

/** The default for the platform this process runs on. */
export const DEFAULT_SPEECH_COMMAND = defaultSpeechCommand()

/** A configured command longer than this is a paste accident, not a command. */
export const MAX_SPEECH_COMMAND_CHARS = 512

/**
 * Hard cap on the spoken text, applied on top of whatever the renderer already
 * clamped. An oversized argv fails the spawn with E2BIG on POSIX, and the
 * renderer's own limit is a preference, not a boundary.
 */
export const MAX_SPEECH_TEXT_CHARS = 8000

export interface SpeechSpawnSpec {
  /** The executable, resolved on PATH by `spawn`. */
  file: string
  /** Configured arguments, with the utterance appended as the last one. */
  args: string[]
}

/**
 * Split a command string into argv, honouring single and double quotes so a
 * path or flag value with a space survives (`"/opt/my tts/say" -v pt`).
 *
 * Returns `null` for an unterminated quote — a config typo, which the caller
 * reports as `invalid-command` rather than silently running half of it.
 */
export function tokenizeCommand(raw: string): string[] | null {
  const tokens: string[] = []
  let current = ''
  let started = false
  let quote: '"' | "'" | null = null

  for (const ch of raw) {
    if (quote) {
      if (ch === quote) quote = null
      else current += ch
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      started = true
      continue
    }
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      if (started) {
        tokens.push(current)
        current = ''
        started = false
      }
      continue
    }
    current += ch
    started = true
  }
  if (quote) return null
  if (started) tokens.push(current)
  return tokens
}

/**
 * Build the spawn spec for one utterance. `null` means "do not spawn": an empty
 * or malformed command, or nothing to say.
 */
export function buildSpeechSpawn(command: string, text: string): SpeechSpawnSpec | null {
  // Leading dashes are stripped here, not only in the renderer's own clamp:
  // the utterance lands in a positional argv slot, and a TTS binary that parses
  // `--foo` as a flag would act on text instead of speaking it. Argument
  // injection is the sibling risk `security/002` names for any positional arg.
  const spoken = text
    .trim()
    .replace(/^[-\s]+/, '')
    .slice(0, MAX_SPEECH_TEXT_CHARS)
  if (!spoken) return null
  const tokens = tokenizeCommand(command)
  if (!tokens || tokens.length === 0) return null
  const [file, ...args] = tokens
  if (!file) return null
  return { file, args: [...args, spoken] }
}

/** Where a user-installed TTS command usually lands, per platform. */
function extraBinDirs(home: string, platform: NodeJS.Platform): string[] {
  if (platform === 'win32') return []
  const dirs = [`${home}/.local/bin`, '/usr/local/bin']
  if (platform === 'darwin') dirs.push('/opt/homebrew/bin')
  return dirs
}

/**
 * The PATH to look the command up on.
 *
 * A GUI-launched app does not inherit PATH additions made in `.zshrc` /
 * `.profile` (only a login shell sources those), so a TTS script sitting in
 * `~/.local/bin` is invisible to `spawn` — the same trap `external.ts` documents
 * for the VS Code CLI. We APPEND the well-known user bin dirs rather than
 * prepend them, so an operator's own PATH ordering always wins.
 */
export function speechSpawnPath(
  currentPath: string | undefined,
  home: string,
  platform: NodeJS.Platform
): string {
  const separator = platform === 'win32' ? ';' : ':'
  const parts = (currentPath ?? '').split(separator).filter(Boolean)
  for (const dir of extraBinDirs(home, platform)) {
    if (!parts.includes(dir)) parts.push(dir)
  }
  return parts.join(separator)
}

/**
 * Normalise a command the renderer asked to store. Junk (wrong type, blank,
 * oversized, unparsable) falls back to {@link DEFAULT_SPEECH_COMMAND} rather
 * than persisting something that can never spawn — a corrupt prefs file must
 * not be able to make the engine permanently mute.
 */
export function normalizeSpeechCommand(raw: unknown): string {
  if (typeof raw !== 'string') return DEFAULT_SPEECH_COMMAND
  const trimmed = raw.trim()
  if (!trimmed || trimmed.length > MAX_SPEECH_COMMAND_CHARS) return DEFAULT_SPEECH_COMMAND
  const tokens = tokenizeCommand(trimmed)
  if (!tokens || tokens.length === 0 || !tokens[0]) return DEFAULT_SPEECH_COMMAND
  return trimmed
}
