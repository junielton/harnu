/**
 * The policy probe's classifier (T389 P1W4 §7.6), pure and shared: P4W1 and P4W3 reuse it.
 *
 * It reads the output of `claude plugin test <staged dir>`. The staged directory holds no tests,
 * so when mods load the CLI says there is nothing to run, and when they are turned off it says so
 * before it looks for tests. The lines below are the CLI's own text (2.1.290: read from the
 * binary and from a live run), not a guess; a line it does not know is `unknown`, which the state
 * line words as "the mod did not load" and never as a cause (DOC-8).
 *
 * `off-here` cannot tell a personal setting from a managed policy, so its neutral reason is
 * `modsOff`. Detection is read-only: nothing is retried, re-staged or worked around (SEC-9f).
 */

export type PolicyProbeClass = 'loads' | 'off-here' | 'off-remote' | 'unknown'

/** The CLI states these itself; the rollout flag is the remote kill switch. */
const OFF_REMOTE = [
  /installed mods are turned off remotely/i,
  /hooks modules not loaded: rollout flag/i,
  /the rollout flag/i
]
const OFF_HERE = [
  /hooks modules are turned off here/i,
  /hooks modules are turned off (in this process|for installed plugins)/i,
  /hooks modules are switched off in this process/i,
  /Safe mode: installed plugins are disabled/i,
  /installed plugins that are not managed load no hooks module/i
]
const LOADS = [/no \*\.test\.ts or \*\.test\.tsx under/i, /\b\d+ (tests? )?(passed|ok)\b/i]

/** Only the tail matters: a long run prints its verdict last. */
const TAIL_CHARS = 8_192

export function classifyPolicyProbe(output: string): PolicyProbeClass {
  const text = output.slice(-TAIL_CHARS)
  if (OFF_REMOTE.some((r) => r.test(text))) return 'off-remote'
  if (OFF_HERE.some((r) => r.test(text))) return 'off-here'
  if (LOADS.some((r) => r.test(text))) return 'loads'
  return 'unknown'
}
