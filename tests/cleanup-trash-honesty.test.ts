// Delta-1 item 11: no Cleanup string calls a checkout "freed" when it only moved to the trash.
import { describe, expect, it } from 'vitest'
import en from '../src/renderer/src/i18n/en.json'
import ptBR from '../src/renderer/src/i18n/pt-BR.json'

describe('a cleaned block is not "freed"', () => {
  it.each([
    ['en', en, /free/i],
    ['pt-BR', ptBR, /liberad/i]
  ])('%s: the map word for a finished block does not claim freed space', (_l, d, re) => {
    const map = (d as typeof en).cleanup.gc.map
    expect(map.freed).not.toMatch(re)
    expect(map.state.done).not.toMatch(re)
  })
})
