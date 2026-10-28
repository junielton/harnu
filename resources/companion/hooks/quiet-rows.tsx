import type { ElementTable } from 'claude-code'
import type { Chip } from './lib/quiet-rows'

/**
 * The quiet rows' views (T589, mockups 02 and 03). Pure builders: they receive the resolved
 * elements, never `$` (MOD-1), and read no state. A chip is one dim line cut at the terminal's edge
 * (`wrap: 'truncate-end'`); the full text stays in the stored message, one ctrl+o away.
 */

type Els = ElementTable<'terminal'>

/** The blank row the engine leaves above a user row, kept: our own tree starts at its own row 0. */
export function chipView(els: Els, chip: Chip) {
  const { Box, Text } = els
  return (
    <Box flexDirection="row" marginTop={1}>
      <Box width={2} flexShrink={0}>
        <Text color={chip.tone}>{chip.glyph}</Text>
      </Box>
      <Box flexGrow={1} flexShrink={1}>
        <Text dimColor wrap="truncate-end">
          {chip.text}
        </Text>
      </Box>
    </Box>
  )
}
