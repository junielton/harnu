/**
 * Cases that are known to violate the contract today, each owned by a bug card that fixes it
 * (T697). While a case is listed, a violation is reported but does not fail the suite; the moment
 * it stops violating, the suite fails until the entry is deleted, so a fix can never leave a stale
 * exemption behind and a regression after the fix fails as normal.
 *
 * `PERF_STRICT=1` ignores this list: that is how the red run is produced.
 */
export const KNOWN_OFFENDERS: Readonly<Record<string, string>> = {
  // Your move resolves a transcript by probing every project slug with fs.access.
  'main/your-move-gate-tick': 'BUG-261',
  'main/your-move-mid-turn-sweep': 'BUG-261',
  // The sidebar's shelvedPartition compares every folder with every shelved worktree.
  'renderer/partition-shelved': 'BUG-262'
}

export const isStrict = (): boolean => process.env.PERF_STRICT === '1'
