/**
 * Pure Sentinel classifier (T31). The mirror of a mission grant: where a grant
 * auto-ALLOWS, the Sentinel auto-DENIES a small, CONSERVATIVE set of
 * obviously-catastrophic shell commands before they ever reach the human. Deny is
 * the safe direction — a false positive costs a retry, never data loss — so this
 * list errs toward MISSING a dangerous call (the human still gates it) over
 * denying a legitimate one. It NEVER allows anything; it only recognizes disaster.
 *
 * Framework-free + side-effect-free (no fs/electron) so it lands in the pure-core
 * coverage surface (ADR-0001) and is exhaustively unit-tested. Tolerates any input
 * — a malformed tool call yields `{ dangerous: false }`, never a throw.
 */

/** The Sentinel's verdict for one tool call. */
export interface SentinelVerdict {
  /** True iff the command matches a catastrophic pattern → auto-deny. */
  dangerous: boolean
  /** Short human reason (shadow-log + notification), present only when dangerous. */
  reason?: string
}

/** Catastrophic command patterns. Order-independent; the first match wins. */
const PATTERNS: ReadonlyArray<{ re: RegExp; reason: string }> = [
  {
    // rm -rf / | /* | ~ | $HOME (combined -rf/-fr, split -r -f, or --recursive --force).
    re: /\brm\s+(?:-[a-z]*(?:rf|fr)[a-z]*|-r[a-z]*\s+-f[a-z]*|-f[a-z]*\s+-r[a-z]*|--recursive\s+--force|--force\s+--recursive)\s+(?:--no-preserve-root\s+)?(?:\/(?:\s|\*|$)|~(?:\/|\s|$)|\$\{?HOME\}?)/i,
    reason: 'recursive delete of the filesystem root or home directory'
  },
  {
    // dd of=/dev/<disk> — overwrites a raw block device.
    re: /\bdd\b[^|;&\n]*\bof=\/dev\/(?:sd|nvme|disk|hd|vd)/i,
    reason: 'writing raw data over a disk device (dd of=/dev/…)'
  },
  {
    re: /\bmkfs(?:\.\w+)?\b[^|;&\n]*\/dev\//i,
    reason: 'formatting a disk device (mkfs)'
  },
  {
    re: /\bwipefs\b/i,
    reason: 'wiping a filesystem signature (wipefs)'
  },
  {
    // Redirecting into a raw block device.
    re: /(?:^|[\s;&|])>\s*\/dev\/(?:sd|nvme|disk|hd|vd)/i,
    reason: 'redirecting output onto a disk device'
  },
  {
    // Classic fork bomb :(){ :|:& };: with flexible whitespace.
    re: /:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/,
    reason: 'fork bomb'
  },
  {
    // chmod 777 on the root, recursive.
    re: /\bchmod\s+(?:-R\s+)?[0-7]*777[0-7]*\s+(?:-R\s+)?\/(?:\s|$)/i,
    reason: 'chmod 777 on the filesystem root'
  },
  {
    // Force-push to a protected branch (main/master). Excludes --force-with-lease.
    re: /\bgit\s+push\b(?![^|;&\n]*--force-with-lease)[^|;&\n]*(?:-f\b|--force\b)[^|;&\n]*\b(?:main|master)\b/i,
    reason: 'force-push to a protected branch (main/master)'
  },
  {
    // Piping a remote download straight into a shell.
    re: /\b(?:curl|wget)\b[^|]*\|\s*(?:sudo\s+)?(?:sh|bash|zsh)\b/i,
    reason: 'piping a remote download into a shell (curl … | sh)'
  }
]

/** Whether the tool is a shell whose primary argument is a command string. */
function shellCommand(toolName: unknown, toolInput: unknown): string | null {
  if (typeof toolName !== 'string') return null
  if (!/^(?:bash|shell|sh|zsh|exec|run)$/i.test(toolName)) return null
  if (typeof toolInput !== 'object' || toolInput === null) return null
  const rec = toolInput as Record<string, unknown>
  for (const key of ['command', 'cmd', 'script'] as const) {
    const v = rec[key]
    if (typeof v === 'string' && v.length > 0) return v
  }
  return null
}

/**
 * Classify one tool call. Returns `{ dangerous: true, reason }` only for a
 * shell command matching a catastrophic pattern; everything else (non-shell
 * tools, benign commands, malformed input) → `{ dangerous: false }`.
 */
export function sentinelVerdict(toolName: unknown, toolInput: unknown): SentinelVerdict {
  const cmd = shellCommand(toolName, toolInput)
  if (cmd === null) return { dangerous: false }
  for (const { re, reason } of PATTERNS) {
    if (re.test(cmd)) return { dangerous: true, reason }
  }
  return { dangerous: false }
}
