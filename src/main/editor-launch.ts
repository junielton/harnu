/**
 * Pure editor-launch logic for the Topbar "Open in {editor}" button (T581).
 *
 * No Electron, no fs, no child_process: everything here is data in, data out so
 * it is unit-testable (`tests/editor-launch.test.ts`) and importable from the
 * renderer for preset metadata (names, ids). The impure half — spawning a
 * detached GUI editor, or probing PATH for a terminal editor — lives in
 * `external.ts`.
 *
 * The one rule that never bends: the folder path is always ONE argv entry and
 * nothing here (or in the caller) ever goes through a shell.
 */

export type EditorMode = 'gui' | 'terminal'

export type NodePlatform = NodeJS.Platform

/** Placeholder a command template uses for the folder path. */
export const PATH_PLACEHOLDER = '{path}'

/** Id of the built-in default (the button's behavior before it was configurable). */
export const DEFAULT_EDITOR_ID = 'vscode'

/** Id of the free-form entry; its command lives in `EditorSetting.customCommand`. */
export const CUSTOM_EDITOR_ID = 'custom'

/** What `settings.json` stores under `editor`. */
export interface EditorSetting {
  /** A preset id from {@link EDITOR_PRESETS}, or {@link CUSTOM_EDITOR_ID}. */
  id: string
  /** Custom only: a command template such as `nvim {path}`. */
  customCommand?: string
  /** Custom only: run the command in a Harnu terminal pane instead of detached. */
  customTerminal?: boolean
}

export const DEFAULT_EDITOR_SETTING: EditorSetting = { id: DEFAULT_EDITOR_ID }

/**
 * Executable names to try, in order, per platform. `default` covers any
 * platform without its own list. Darwin lists carry the well-known absolute
 * install locations because an app launched from Finder/Dock does not inherit
 * the PATH additions a user made in `.zshrc` — see `external.ts`.
 */
interface CandidateTable {
  default: string[]
  darwin?: string[]
  win32?: string[]
  linux?: string[]
}

export interface EditorPreset {
  id: string
  /** Display name, used verbatim in "Open in {editor}". Not translated. */
  name: string
  mode: EditorMode
  candidates: CandidateTable
  /** Argv after the executable; `{path}` becomes the folder path (one entry). */
  args: string[]
}

const VSCODE_DARWIN = [
  'code',
  '/usr/local/bin/code',
  '/opt/homebrew/bin/code',
  '/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code',
  '/Applications/Visual Studio Code - Insiders.app/Contents/Resources/app/bin/code'
]

export const EDITOR_PRESETS: readonly EditorPreset[] = [
  {
    id: 'vscode',
    name: 'VS Code',
    mode: 'gui',
    candidates: { default: ['code'], darwin: VSCODE_DARWIN },
    // `--` so a path can never be parsed by `code` as a flag.
    args: ['--', PATH_PLACEHOLDER]
  },
  {
    id: 'cursor',
    name: 'Cursor',
    mode: 'gui',
    candidates: {
      default: ['cursor'],
      darwin: [
        'cursor',
        '/usr/local/bin/cursor',
        '/opt/homebrew/bin/cursor',
        '/Applications/Cursor.app/Contents/Resources/app/bin/cursor'
      ]
    },
    args: ['--', PATH_PLACEHOLDER]
  },
  {
    id: 'zed',
    name: 'Zed',
    mode: 'gui',
    candidates: {
      default: ['zed'],
      // Distros that ship Zed as `zeditor` (the upstream `zed` name clashes with other tools).
      linux: ['zed', 'zeditor', 'zed-editor'],
      darwin: [
        'zed',
        '/usr/local/bin/zed',
        '/opt/homebrew/bin/zed',
        '/Applications/Zed.app/Contents/MacOS/cli'
      ]
    },
    args: [PATH_PLACEHOLDER]
  },
  {
    id: 'sublime',
    name: 'Sublime Text',
    mode: 'gui',
    candidates: {
      default: ['subl'],
      linux: ['subl', 'sublime_text'],
      darwin: [
        'subl',
        '/usr/local/bin/subl',
        '/opt/homebrew/bin/subl',
        '/Applications/Sublime Text.app/Contents/SharedSupport/bin/subl'
      ]
    },
    args: [PATH_PLACEHOLDER]
  },
  {
    id: 'jetbrains',
    name: 'JetBrains',
    mode: 'gui',
    candidates: {
      default: ['idea', 'webstorm'],
      linux: [
        'idea',
        'intellij-idea-ultimate',
        'intellij-idea-community',
        'webstorm',
        'idea.sh',
        'webstorm.sh'
      ],
      win32: ['idea64.exe', 'idea', 'webstorm64.exe', 'webstorm'],
      darwin: [
        'idea',
        'webstorm',
        '/usr/local/bin/idea',
        '/usr/local/bin/webstorm',
        '/opt/homebrew/bin/idea',
        '/opt/homebrew/bin/webstorm',
        '/Applications/IntelliJ IDEA.app/Contents/MacOS/idea',
        '/Applications/IntelliJ IDEA CE.app/Contents/MacOS/idea',
        '/Applications/WebStorm.app/Contents/MacOS/webstorm'
      ]
    },
    args: [PATH_PLACEHOLDER]
  },
  {
    id: 'neovim',
    name: 'Neovim',
    mode: 'terminal',
    candidates: {
      default: ['nvim'],
      darwin: ['nvim', '/opt/homebrew/bin/nvim', '/usr/local/bin/nvim']
    },
    args: [PATH_PLACEHOLDER]
  },
  {
    id: 'helix',
    name: 'Helix',
    mode: 'terminal',
    candidates: {
      default: ['hx'],
      // Debian-family packages install the binary as `helix`.
      linux: ['hx', 'helix'],
      darwin: ['hx', '/opt/homebrew/bin/hx', '/usr/local/bin/hx']
    },
    args: [PATH_PLACEHOLDER]
  }
]

export function findPreset(id: string): EditorPreset | undefined {
  return EDITOR_PRESETS.find((p) => p.id === id)
}

/** Candidate executables for `preset` on `platform`, in try order. */
export function presetCandidates(preset: EditorPreset, platform: NodePlatform): string[] {
  const table = preset.candidates
  if (platform === 'darwin' && table.darwin) return table.darwin
  if (platform === 'win32' && table.win32) return table.win32
  if (platform === 'linux' && table.linux) return table.linux
  return table.default
}

// ---------------------------------------------------------------------------
// Command-template parsing (custom editor)
// ---------------------------------------------------------------------------

export type ParsedCommand =
  { ok: true; tokens: string[] } | { ok: false; reason: 'empty' | 'unterminated-quote' }

/**
 * Split a command line into argv tokens WITHOUT a shell. Supports single
 * quotes (literal), double quotes (with `\"` and `\\` escapes) and bare words.
 * A backslash outside double quotes is literal, so a Windows path such as
 * `C:\tools\nvim.exe` survives. Operators (`|`, `;`, `&&`, `$VAR`, backticks)
 * have no meaning: they are ordinary characters of whatever token they sit in.
 */
export function parseCommandTemplate(template: string): ParsedCommand {
  const tokens: string[] = []
  let cur = ''
  let inToken = false
  let quote: '"' | "'" | null = null
  for (let i = 0; i < template.length; i++) {
    const ch = template[i]
    if (quote === "'") {
      if (ch === "'") quote = null
      else cur += ch
      continue
    }
    if (quote === '"') {
      if (ch === '"') {
        quote = null
      } else if (ch === '\\' && (template[i + 1] === '"' || template[i + 1] === '\\')) {
        cur += template[i + 1]
        i++
      } else {
        cur += ch
      }
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      inToken = true
    } else if (/\s/.test(ch)) {
      if (inToken) {
        tokens.push(cur)
        cur = ''
        inToken = false
      }
    } else {
      cur += ch
      inToken = true
    }
  }
  if (quote) return { ok: false, reason: 'unterminated-quote' }
  if (inToken) tokens.push(cur)
  if (tokens.length === 0) return { ok: false, reason: 'empty' }
  return { ok: true, tokens }
}

/**
 * Substitute the folder path into argv tokens. The path is spliced into the
 * token that holds `{path}`, never re-tokenized, so spaces and quotes in it
 * stay inside that one argv entry. A template without `{path}` gets the path
 * appended as its own entry. A path starting with `-` is prefixed with `./` so
 * no editor can read it as a flag (absolute paths, the only kind the IPC
 * accepts, never start with `-`).
 */
export function fillPath(args: string[], path: string): string[] {
  const safe = path.startsWith('-') ? `./${path}` : path
  let used = false
  const out = args.map((a) => {
    if (!a.includes(PATH_PLACEHOLDER)) return a
    used = true
    // split/join, not replace(): a `$&` in the path must stay literal.
    return a.split(PATH_PLACEHOLDER).join(safe)
  })
  if (!used) out.push(safe)
  return out
}

// ---------------------------------------------------------------------------
// Settings sanitation
// ---------------------------------------------------------------------------

const MAX_COMMAND_LENGTH = 1024

/**
 * Build a clean {@link EditorSetting} from arbitrary input, or `null` when it is
 * not one. An unknown preset id or an unparsable/empty custom command is
 * rejected (the caller then keeps the previous value / default) rather than
 * persisted.
 */
export function sanitizeEditorSetting(input: unknown): EditorSetting | null {
  if (typeof input !== 'object' || input === null) return null
  const raw = input as Record<string, unknown>
  if (typeof raw.id !== 'string') return null
  if (raw.id === CUSTOM_EDITOR_ID) {
    const cmd = typeof raw.customCommand === 'string' ? raw.customCommand.trim() : ''
    if (cmd.length > MAX_COMMAND_LENGTH) return null
    // An empty command is a valid DRAFT: the picker shows Custom with an empty
    // field until the user types. Launching it reports `bad-command`.
    return { id: CUSTOM_EDITOR_ID, customCommand: cmd, customTerminal: raw.customTerminal === true }
  }
  if (!findPreset(raw.id)) return null
  return { id: raw.id }
}

/** The effective setting: the stored one if valid, else the default. */
export function effectiveEditorSetting(stored: unknown): EditorSetting {
  return sanitizeEditorSetting(stored) ?? DEFAULT_EDITOR_SETTING
}

// ---------------------------------------------------------------------------
// Launch plan
// ---------------------------------------------------------------------------

export interface LaunchAttempt {
  cmd: string
  args: string[]
}

export interface LaunchPlan {
  editorId: string
  /** Display name for the toast and tooltip ("VS Code", or "editor" for custom). */
  name: string
  mode: EditorMode
  /** Candidates in try order. The first is the one named in a "not found" error. */
  attempts: LaunchAttempt[]
}

export type PlanResult = { ok: true; plan: LaunchPlan } | { ok: false; error: 'bad-command' }

/** Build the launch plan for `setting` on `platform` against the folder `path`. */
export function planEditorLaunch(
  setting: EditorSetting,
  platform: NodePlatform,
  path: string
): PlanResult {
  if (setting.id === CUSTOM_EDITOR_ID) {
    const parsed = parseCommandTemplate(setting.customCommand ?? '')
    if (!parsed.ok) return { ok: false, error: 'bad-command' }
    const [cmd, ...rest] = parsed.tokens
    // The executable is a literal: a placeholder in it would let the path pick the program.
    if (cmd.includes(PATH_PLACEHOLDER)) return { ok: false, error: 'bad-command' }
    return {
      ok: true,
      plan: {
        editorId: CUSTOM_EDITOR_ID,
        name: 'editor',
        mode: setting.customTerminal ? 'terminal' : 'gui',
        attempts: [{ cmd, args: fillPath(rest, path) }]
      }
    }
  }
  const preset = findPreset(setting.id) ?? (findPreset(DEFAULT_EDITOR_ID) as EditorPreset)
  return {
    ok: true,
    plan: {
      editorId: preset.id,
      name: preset.name,
      mode: preset.mode,
      attempts: presetCandidates(preset, platform).map((cmd) => ({
        cmd,
        args: fillPath(preset.args, path)
      }))
    }
  }
}

/**
 * First attempt whose executable `isExecutable` accepts — used for terminal
 * editors, where the PTY spawn cannot fall through candidates on its own.
 */
export function pickAttempt(
  attempts: LaunchAttempt[],
  isExecutable: (cmd: string) => boolean
): LaunchAttempt | null {
  for (const a of attempts) if (isExecutable(a.cmd)) return a
  return null
}

/** The label the button shows for `setting`: a preset name, or null for custom. */
export function editorDisplayName(setting: EditorSetting): string | null {
  if (setting.id === CUSTOM_EDITOR_ID) return null
  return (findPreset(setting.id) ?? (findPreset(DEFAULT_EDITOR_ID) as EditorPreset)).name
}
