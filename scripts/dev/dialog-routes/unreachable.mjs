/**
 * T460 batch 0 — surfaces with NO route, listed so the geometry report and the baseline say so
 * (spec §6.3 step 3 "Not seedable here"). Each `open` throws: these are never opened, only reported.
 * ContainersRemoveDialog lives in cleanup.mjs and HarnuModExternal in folder-global.mjs.
 *
 * What stands in for them: unit tests (`cleanup-bulk-confirm-dialog.test.ts`, `containers-view.test.ts`,
 * `review-pane-contract.test.ts`, `image-lightbox-index.test.ts`, `mcp-confirm-*.test.ts`), the
 * characterization net (`tests/dialog-surfaces.characterization.test.ts`) and the human pass
 * (spec §6.5).
 */

const never = (id) => async () => {
  throw new Error(`${id} has no route: it cannot be opened from a seeded headless app`)
}

/** @type {Array<{ id: string, file: string, reach: 'not-seedable', note: string, open: () => Promise<void> }>} */
export const ROUTES_UNREACHABLE = [
  {
    id: 'ImageLightbox',
    file: 'ImageLightbox.vue',
    reach: 'not-seedable',
    note: 'Footer images popover → a tile. Needs a pasted screenshot in the image cache; the seed has none and a headless app has no clipboard.',
    open: never('ImageLightbox')
  },
  {
    id: 'McpConfirmOverlay',
    file: 'McpConfirmOverlay.vue',
    reach: 'not-seedable',
    note: 'Appears on `mcp:confirm:pending`: needs an MCP caller and "Ask before agent actions" on. A fail-closed security gate; its geometry is the Command-palette-like top placement, unmeasured here.',
    open: never('McpConfirmOverlay')
  },
  {
    id: 'ReviewPane.submitConfirm',
    file: 'ReviewPane.vue',
    reach: 'not-seedable',
    note: 'Review pane → Submit verdict. Needs a real pull request (gh) in the review pane; only the unit contract test (T244 AC-3) covers it.',
    open: never('ReviewPane.submitConfirm')
  }
]
