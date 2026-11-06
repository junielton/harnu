import type { ElementTable } from 'claude-code'
import {
  cardTone,
  inlineOf,
  linkIndex,
  type Glyph,
  type Inline,
  type LedgerRow,
  type Report,
  type Segment
} from './lib/report-card'

/**
 * The report card's view (T583 U2, mock 02 "Card + checklist"). A pure builder: it receives the
 * resolved elements, never `$` (MOD-1), and reads no state. The bordered card holds the title, the
 * progress bar and the ledger; what the operator owes sits in its own yellow box; the rail is the
 * checklist with aligned labels; links close the report. Only a checklist row is cut at the edge
 * (`wrap: 'truncate-end'`, the full text stays in the stored message, ctrl+o): what the operator
 * owes, the ledger and every URL wrap, so nothing that matters is hidden on a narrow terminal.
 */

type Els = ElementTable<'terminal'>
const TONE = { ok: 'success', fail: 'error', accent: 'claude' } as const
const GLYPH_COLOR: Record<Glyph, string> = {
  '✓': 'success',
  '✗': 'error',
  '!': 'warning',
  '-': 'inactive'
}
/** A rail label longer than this is not split from its outcome. */
const RAIL_LABEL_MAX = 24
const LABEL_MAX = 12

const widest = (xs: string[]): number => xs.reduce((n, x) => Math.max(n, [...x].length), 0)

export function reportView(els: Els, segments: Segment[], firstOfReply: boolean) {
  const { Box, Text, Link, Markdown } = els

  const inline = (text: string, links: ReadonlyMap<string, string>) =>
    inlineOf(text, links).map((p: Inline) => {
      if (p.t === 'link') return <Link href={p.href}>{p.s}</Link>
      if (p.t === 'code') return <Text color="suggestion">{p.s}</Text>
      if (p.t === 'bold') return <Text bold>{p.s}</Text>
      return p.s
    })

  const ledgerRow = (
    r: LedgerRow,
    labelW: number,
    gutterW: number,
    links: ReadonlyMap<string, string>
  ) => (
    <Box flexDirection="column">
      <Box flexDirection="row">
        {gutterW > 0 ? (
          <Box width={2} flexShrink={0}>
            <Text color="warning">
              {r.gutter === 'open' ? '?' : r.gutter === 'warn' ? '!' : ' '}
            </Text>
          </Box>
        ) : null}
        <Box width={labelW} flexShrink={0}>
          <Text dimColor>{r.label}</Text>
        </Box>
        <Box flexGrow={1} flexShrink={1}>
          <Text>{inline(r.lines[0], links)}</Text>
        </Box>
      </Box>
      {r.lines.slice(1).map((l) => (
        <Box flexDirection="row" paddingLeft={gutterW + labelW}>
          <Text dimColor>{inline(l, links)}</Text>
        </Box>
      ))}
    </Box>
  )

  const card = (r: Report) => {
    const links = linkIndex(r.links)
    const tone = TONE[cardTone(r)]
    const rows = r.ledger.filter((x) => x.gutter !== 'owed')
    const owed = r.ledger.filter((x) => x.gutter === 'owed')
    const labelW = Math.min(widest(rows.map((x) => x.label)), LABEL_MAX) + 2
    const gutterW = rows.some((x) => x.gutter === 'open' || x.gutter === 'warn') ? 2 : 0
    const head = r.header
    const splits = r.rail.map((x) => {
      const at = x.text.indexOf(' — ')
      return at > 0 && at <= RAIL_LABEL_MAX
        ? ([x.text.slice(0, at), x.text.slice(at + 3)] as const)
        : null
    })
    const railW = widest(splits.map((s) => s?.[0] ?? '')) + 2
    return (
      <Box flexDirection="column">
        {head || rows.length > 0 ? (
          <Box flexDirection="column" borderStyle="round" borderColor={tone} paddingX={1}>
            {head ? (
              <Box flexDirection="row" justifyContent="space-between" gap={2}>
                <Text bold color={tone}>
                  {head.mark ? `${head.mark} ` : ''}
                  {head.title}
                </Text>
                {head.detail !== '' ? <Text dimColor>{head.detail}</Text> : null}
              </Box>
            ) : null}
            {head?.bar ? (
              <Box flexDirection="row" height={1}>
                <Box flexGrow={head.bar.filled} backgroundColor={tone} />
                <Box flexGrow={head.bar.total - head.bar.filled} backgroundColor="inactive" />
              </Box>
            ) : null}
            {rows.map((x) => ledgerRow(x, labelW, gutterW, links))}
          </Box>
        ) : null}
        {owed.length > 0 ? (
          <Box flexDirection="column" borderStyle="round" borderColor="warning" paddingX={1}>
            <Text bold color="warning">
              {`${owed[0].label} · ${owed.length}`}
            </Text>
            {owed.map((x, i) => (
              <Box flexDirection="column">
                <Box flexDirection="row">
                  <Box width={2} flexShrink={0}>
                    <Text color="warning">{owed.length > 1 ? String(i + 1) : '⚑'}</Text>
                  </Box>
                  <Box flexGrow={1} flexShrink={1}>
                    <Text>{inline(x.lines[0], links)}</Text>
                  </Box>
                </Box>
                {x.lines.slice(1).map((l) => (
                  <Box flexDirection="row" paddingLeft={2}>
                    <Text dimColor>{inline(l, links)}</Text>
                  </Box>
                ))}
              </Box>
            ))}
          </Box>
        ) : null}
        {r.rail.length > 0 ? (
          <Box flexDirection="column" paddingX={1}>
            {r.rail.map((x, i) => (
              <Box flexDirection="row">
                <Box width={2} flexShrink={0}>
                  <Text color={GLYPH_COLOR[x.glyph]}>{x.glyph}</Text>
                </Box>
                {splits[i] ? (
                  <Box width={railW} flexShrink={0}>
                    <Text dimColor wrap="truncate-end">
                      {splits[i]![0]}
                    </Text>
                  </Box>
                ) : null}
                <Box flexGrow={1} flexShrink={1}>
                  <Text wrap="truncate-end">
                    {inline(splits[i] ? splits[i]![1] : x.text, links)}
                  </Text>
                </Box>
              </Box>
            ))}
          </Box>
        ) : null}
        {r.links.length > 0 ? (
          <Box flexDirection="column" paddingX={1} marginTop={1}>
            {r.links.map((l) => (
              <Text dimColor>
                {`${l.label} → `}
                {/^https?:\/\//.test(l.target) ? <Link href={l.target} /> : l.target}
              </Text>
            ))}
          </Box>
        ) : null}
      </Box>
    )
  }

  // The engine leaves a blank row above the first block of a reply; our own tree must keep it.
  return (
    <Box flexDirection="row" marginTop={firstOfReply ? 1 : 0}>
      <Text>{firstOfReply ? '● ' : '  '}</Text>
      <Box flexDirection="column" flexGrow={1} flexShrink={1}>
        {segments.map((s, i) =>
          s.kind === 'text' ? (
            <Box flexDirection="column" marginTop={i > 0 ? 1 : 0}>
              <Markdown text={s.text} />
            </Box>
          ) : (
            card(s.report)
          )
        )}
      </Box>
    </Box>
  )
}
