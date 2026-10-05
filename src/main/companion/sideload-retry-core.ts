import { splitOptionArgs } from '../claude-args'

/**
 * The sideload-blocked retry (P1W2 §7.8, pure part). Under `disableSideloadFlags` the CLI exits
 * at startup when given `--plugin-dir`. The exit text was not captured by any smoke run, so
 * detection is by BEHAVIOUR: an injected spawn that dies early without ever saying hello.
 */

/** A spawn that lives this long is not a startup failure. */
export const RETRY_WINDOW_MS = 5000

export function shouldRetryWithoutSideload(x: {
  /** This spawn carried a Harnu `--plugin-dir`. */
  injected: boolean
  exitCode: number
  /** Spawn → exit. */
  livedMs: number
  /** The ledger entry left `minted`. */
  helloSeen: boolean
  retried: boolean
}): boolean {
  return x.injected && x.exitCode !== 0 && x.livedMs < RETRY_WINDOW_MS && !x.helloSeen && !x.retried
}

function pluginDirsOf(options: readonly string[]): string[] {
  const out: string[] = []
  for (let i = 0; i < options.length; i++) {
    const o = options[i]
    if (o === '--plugin-dir' && i + 1 < options.length) out.push(options[++i])
    else if (o.startsWith('--plugin-dir=')) out.push(o.slice('--plugin-dir='.length))
  }
  return out
}

/** The plugin directories present in `after`'s option portion that `before` did not carry. */
export function injectedPluginDirs(before: readonly string[], after: readonly string[]): string[] {
  const had = pluginDirsOf(splitOptionArgs(before).options)
  const out: string[] = []
  for (const d of pluginDirsOf(splitOptionArgs(after).options)) {
    const i = had.indexOf(d)
    if (i >= 0) had.splice(i, 1)
    else out.push(d)
  }
  return out
}

/** Removes exactly Harnu's own `--plugin-dir` flags from the option portion; the user's stay. */
export function stripInjectedPluginDirs(
  args: readonly string[],
  injected: readonly string[]
): string[] {
  if (injected.length === 0) return [...args]
  const drop = new Set(injected)
  const { options, promptTail } = splitOptionArgs(args)
  const kept: string[] = []
  for (let i = 0; i < options.length; i++) {
    const o = options[i]
    if (o === '--plugin-dir' && i + 1 < options.length && drop.has(options[i + 1])) {
      i++
      continue
    }
    if (o.startsWith('--plugin-dir=') && drop.has(o.slice('--plugin-dir='.length))) continue
    kept.push(o)
  }
  return [...kept, ...promptTail]
}
