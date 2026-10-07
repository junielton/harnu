import { CONFIG_BOUNDS, type Command, type CommandName, type Config } from '../contract'

/**
 * Pure helpers for the commands a host hands to the mod (contract §9). `$`-free (MOD-1): the
 * module that owns `$` calls these and does the effects.
 */

/** What this build of the mod can run at all; everything else is `CMD_UNSUPPORTED`. */
const RUNNABLE: ReadonlySet<CommandName> = new Set(['flush', 'config.update'])

/**
 * The tokenless second lock (contract §9, §21 item 5; conformance row 26): a mod whose hello
 * carried no spawn token answers every command other than these three with `CMD_UNSUPPORTED`,
 * without looking at what `enable` says. A forged or rewritten response (smoke D6) therefore
 * still cannot make an outside session run a prompt (SEC-3d).
 */
const TOKENLESS_ALLOWED: ReadonlySet<string> = new Set(['flush', 'config.update', 'ui.band.set'])

export type CommandVerdict =
  { run: true } | { run: false; code: 'CMD_UNSUPPORTED' | 'CMD_EXPIRED'; message: string }

export function judgeCommand(cmd: Command, tokenless: boolean, now: number): CommandVerdict {
  if (typeof cmd.name !== 'string') {
    return { run: false, code: 'CMD_UNSUPPORTED', message: 'unnamed command' }
  }
  if (tokenless && !TOKENLESS_ALLOWED.has(cmd.name)) {
    return { run: false, code: 'CMD_UNSUPPORTED', message: 'not allowed outside Harnu' }
  }
  if (!RUNNABLE.has(cmd.name as CommandName)) {
    return { run: false, code: 'CMD_UNSUPPORTED', message: 'not supported by this mod' }
  }
  if (typeof cmd.expiresAt === 'number' && cmd.expiresAt < now) {
    return { run: false, code: 'CMD_EXPIRED', message: 'expired' }
  }
  return { run: true }
}

/** A `config.update` that stays inside CONFIG_BOUNDS: the bounded patch, or null. */
export function boundedConfig(raw: unknown): Partial<Config> | null {
  if (typeof raw !== 'object' || raw === null) return null
  const out: Partial<Config> = {}
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    const bounds = CONFIG_BOUNDS[k as keyof Config]
    if (!bounds || typeof v !== 'number' || !Number.isFinite(v)) return null
    if (v < bounds[0] || v > bounds[1]) return null
    out[k as keyof Config] = v
  }
  return out
}

/** The commands of a response that are well-formed, in order, above the recorded cursor. */
export function freshCommands(raw: unknown, cursor: number): Command[] {
  if (!Array.isArray(raw)) return []
  const out: Command[] = []
  for (const c of raw as unknown[]) {
    if (typeof c !== 'object' || c === null) continue
    const r = c as Partial<Command>
    if (typeof r.cmd !== 'string' || typeof r.n !== 'number' || typeof r.name !== 'string') continue
    if (r.n <= cursor) continue
    out.push(r as Command)
  }
  return out.sort((a, b) => a.n - b.n)
}
