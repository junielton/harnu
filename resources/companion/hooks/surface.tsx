import type { ElementTable, RenderChildren } from 'claude-code'
import { fitBand, type BandState } from './lib/command-core'

/**
 * The band's view (P4W2 §7.4, T257 §8): one dim row above the prompt. A pure builder: it receives
 * the resolved elements, never `$` (MOD-1), and reads no state. `null` means "draw nothing"; otherwise the row wraps `below`, the tree the rest of the chain
 * drew, and never replaces it.
 */
export function bandView(
  els: ElementTable<'terminal'>,
  band: BandState,
  columns: number,
  below: RenderChildren
) {
  const text = fitBand(band, columns)
  if (text === null) return null
  const { Box, Text } = els
  return (
    <Box flexDirection="column">
      <Text dimColor wrap="truncate">
        {text}
      </Text>
      {below}
    </Box>
  )
}
