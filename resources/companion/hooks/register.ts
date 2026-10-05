import type { Register } from 'claude-code'
import * as contract from './contract'
import { MOD_VERSION } from './coords.gen'

// Referenced from the hook so that a missing or broken generated file or contract
// fails the module load here, in validation, rather than in a later wave.
const BOOT = { modVersion: MOD_VERSION, proto: contract } as const

// Skeleton: one pass-through hook. It makes "the mod loaded" an observable line in the
// debug log and gives the harness something to assert. No network call, no state.
export const register: Register = (on) => {
  on('session.start', async (_$, e, next) => {
    try {
      void BOOT
      return await next(e)
    } catch {
      return e
    }
  })
}
