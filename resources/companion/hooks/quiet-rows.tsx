import type { ElementTable } from 'claude-code'
import type { Chip } from './lib/quiet-rows'
import { fitHeader, fitNoChange, type TickCard } from './lib/mission-state'

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

const LABEL_W = 9

/**
 * The loop tick (mock 02): a bordered card with the mission's title and position, what is running
 * now or what changed, and what the operator owes. A tick that found nothing new is one dim line.
 * The border and the bar are the accent while the mission runs and green when it is done; the `⚑`
 * rows are always yellow, because they are the one thing that waits for a person. Rows wrap: only
 * the "no change" line is cut at the edge (the full prompt is one ctrl+o away).
 */
export function tickView(els: Els, card: TickCard, columns?: number) {
  const { Box, Text } = els
  if (card.kind === 'nochange') {
    // The line, a space and `ctrl+o`, and one spare cell: "no change since #N" is the last to be cut.
    const line = fitNoChange(card, columns === undefined ? 1000 : columns - 8)
    return (
      <Box flexDirection="row" marginTop={1}>
        <Box flexGrow={1} flexShrink={1}>
          <Text dimColor wrap="truncate-end">
            {line}
          </Text>
        </Box>
        <Box flexShrink={0} paddingLeft={1}>
          <Text dimColor>ctrl+o</Text>
        </Box>
      </Box>
    )
  }
  // The card is a border and a cell of padding on each side wide.
  const header = fitHeader(card, columns === undefined ? 1000 : columns - 4)
  return (
    <Box
      flexDirection="column"
      marginTop={1}
      borderStyle="round"
      borderColor={card.tone}
      paddingX={1}
    >
      <Box flexDirection="row" justifyContent="space-between" gap={2}>
        <Box flexShrink={1}>
          <Text bold color={card.tone} wrap="truncate-end">
            {header.left}
          </Text>
        </Box>
        <Box flexDirection="row" flexShrink={0}>
          {header.bar ? <Text color={card.tone}>{'▰'.repeat(header.bar.filled)}</Text> : null}
          {header.bar ? (
            <Text dimColor>{'▱'.repeat(header.bar.total - header.bar.filled)}</Text>
          ) : null}
          <Text dimColor>{(header.bar ? ' ' : '') + header.detail}</Text>
        </Box>
      </Box>
      {card.rows.map((r) => (
        <Box key={r.label} flexDirection="row">
          <Box width={LABEL_W} flexShrink={0}>
            <Text dimColor>{r.label}</Text>
          </Box>
          <Box flexGrow={1} flexShrink={1}>
            <Text>{r.text}</Text>
          </Box>
        </Box>
      ))}
      {card.you.map((y, i) => (
        <Box key={'you-' + i} flexDirection="row">
          <Box width={2} flexShrink={0}>
            <Text color="warning">⚑</Text>
          </Box>
          <Box width={LABEL_W - 2} flexShrink={0}>
            <Text dimColor>you</Text>
          </Box>
          <Box flexGrow={1} flexShrink={1}>
            <Text>{y}</Text>
          </Box>
        </Box>
      ))}
    </Box>
  )
}
