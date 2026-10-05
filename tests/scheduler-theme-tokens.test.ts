import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * T291 Task 1 — every theme block must define the full token set. A theme that
 * omits one of the new badge tokens renders a transparent badge, not a fallback,
 * because `var()` with no value and no fallback resolves to the initial value.
 */
const CSS = readFileSync(join(__dirname, '../src/renderer/src/styles/themes.css'), 'utf8')

const NEW_TOKENS = [
  '--color-green-line',
  '--color-red-line',
  '--color-warning-soft',
  '--color-warning-line'
]

/** Each `@theme {` / `:root[data-theme='x'] {` block, by its opening line. */
function themeBlocks(css: string): string[] {
  const starts = [...css.matchAll(/(?:^@theme|^:root\[data-theme='[^']+'\])\s*\{/gm)]
  return starts.map((m, i) => {
    const from = m.index as number
    const to = i + 1 < starts.length ? (starts[i + 1].index as number) : css.length
    return css.slice(from, to)
  })
}

describe('themes.css — badge token parity', () => {
  it('has 13 theme blocks', () => {
    expect(themeBlocks(CSS)).toHaveLength(13)
  })

  it.each(NEW_TOKENS)('every theme defines %s', (token) => {
    for (const block of themeBlocks(CSS)) {
      expect(block).toContain(`${token}:`)
    }
  })

  it('never copies the Ink value into another theme', () => {
    const inkWarningSoft = 'rgba(192, 138, 62, 0.1)'
    const uses = themeBlocks(CSS).filter((b) => b.includes(inkWarningSoft))
    expect(uses).toHaveLength(1)
  })
})
