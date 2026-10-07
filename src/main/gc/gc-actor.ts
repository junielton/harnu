// Per-run shell deps: who is running (so the journal line says whether the autopilot or the
// operator removed something) and what is protected right now. Pure over its inputs, so the
// stamping and the live-prefs read are unit-tested in tests/gc-actor.test.ts.

import { isProtectedNow } from './autopilot-core'
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
    isProtectedNow: (b) => isProtectedNow(b, prefs()),
    executor: {
      ...base.executor,
      // The actor lands in the journal line cleanItem writes, which is how an unattended run
      // is told apart from a click.
      appendTombstone: (t) => base.executor.appendTombstone({ ...t, actor })
    }
  }
}
