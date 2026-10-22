/**
 * The one live table of browser leases (T564 U4). Kept apart from `lease.ts` (pure, clock injected) so the pure
 * module stays free of module-level state and a unit test builds its own.
 */
import { BrowserLeases } from './lease'

export const browserLeases = new BrowserLeases()
