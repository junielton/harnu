/**
 * The renderer computeds that read the fleet, against one session event (BUG-265).
 *
 * Same contract and same reporting as `scale.perf.ts` (see `support/run-cases.ts`). Kept in its own file
 * because it builds the real sessions store, which needs a `window` stub; the pure cases do not.
 */

import { STORE_CASES } from './store-cases'
import { registerCases } from './support/run-cases'

registerCases('fleet store: one session event does not re-read the fleet', STORE_CASES)
