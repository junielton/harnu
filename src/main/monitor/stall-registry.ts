import type { StallMonitor } from './stall-monitor'

/** The running stall monitor, for the sampler and the IPC handlers. `null` when it is switched off. */
let current: StallMonitor | null = null

export const setStallMonitor = (m: StallMonitor | null): void => {
  current = m
}
export const getStallMonitor = (): StallMonitor | null => current
