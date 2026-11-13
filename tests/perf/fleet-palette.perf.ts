// @vitest-environment jsdom
/**
 * The command palette, closed, against one session event (BUG-265). A mounted component needs jsdom, so
 * this runs apart from the node-environment suites; same contract and reporting (`support/run-cases.ts`).
 */

import { PALETTE_CASES } from './palette-cases'
import { registerCases } from './support/run-cases'

registerCases(
  'command palette: closed, one session event does not re-read the fleet',
  PALETTE_CASES
)
