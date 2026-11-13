// @vitest-environment jsdom
/**
 * The command palette, closed, against one session event (BUG-265). A mounted component needs jsdom, so
 * this runs apart from the node-environment suites; same contract and reporting (`support/run-cases.ts`).
 */

import { vi } from 'vitest'
import { PALETTE_CASES } from './palette-cases'
import { registerCases } from './support/run-cases'

// The simulated task-state changes would play the OS notification sound, which jsdom cannot.
vi.mock('../../src/renderer/src/lib/notification-sound', () => ({ playNotificationSound: vi.fn() }))

registerCases(
  'command palette: closed, one session event does not re-read the fleet',
  PALETTE_CASES
)
