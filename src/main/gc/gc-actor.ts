// Per-run shell deps: who is running (so the journal line says whether the autopilot or the
// operator removed something) and what is protected right now. Pure over its inputs, so the
// stamping and the live-prefs read are unit-tested in tests/gc-actor.test.ts.

import { isProtectedNow } from './autopilot-core'
import { resolveRealPaths } from './gc-shell'
import type { GcShellDeps } from './gc-shell'
import type { GcPrefs } from './gc-prefs'

export function withActor(
  base: GcShellDeps,
  actor: 'operator' | 'autopilot',
  prefs: () => GcPrefs
): GcShellDeps {
  return {
    ...base,
    // The live prefs, not the flags the bundle was built with: the operator may have pressed
    // Keep or listed a path since the scan, and the reprobe asks this before it does anything.
    isProtectedNow: async (b) => {
      const live = prefs()
      // Real paths of the worktree, its repo and every neverClean entry, read now: an entry
      // added under a symlinked spelling is the same folder, and prefs can change any time.
      const paths = [b.item.path, b.item.repoPath, ...live.neverClean].filter(
        (p): p is string => !!p
      )
      const canonical = await resolveRealPaths(paths, async (p) => {
        const real = await base.realpath(p)
        if (real === null) throw new Error(`cannot resolve ${p}`)
        return real
      })
      // The worktree's own path must resolve: one that does not may be anyone's.
      if (b.item.path && !canonical(b.item.path).resolved) return true
      return isProtectedNow(b, live, canonical)
    },
    executor: {
      ...base.executor,
      // The actor lands in the journal line cleanItem writes, which is how an unattended run
      // is told apart from a click.
      appendTombstone: (t) => base.executor.appendTombstone({ ...t, actor })
    }
  }
}
