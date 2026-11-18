// @vitest-environment jsdom
/**
 * Mission dropdown S-8 (AC-22, AC-24) — the Mission pane is gone. The helper-stack `mission` pane type and every
 * opener, the pane's eight Vue files, every string that names the pane, and the stored `om2tab.missionPane.sections`
 * value. The dropdown the Topbar pill opens is the only surface a mission has.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import en from '../src/renderer/src/i18n/en.json'
import ptBR from '../src/renderer/src/i18n/pt-BR.json'
import { paneRegistry } from '../src/renderer/src/lib/pane-registry'
import {
  RETIRED_MISSION_STORAGE_KEYS,
  removeRetiredMissionStorage,
  useMissionsStore
} from '../src/renderer/src/stores/missions'

const read = (p: string): string => readFileSync(p, 'utf8')
const files = (...paths: string[]): string[] =>
  execFileSync('git', ['ls-files', '--', ...paths], { encoding: 'utf8' })
    .split('\n')
    .filter(Boolean)

/** Every string leaf of a locale file, with its dotted key. */
function leaves(o: unknown, prefix = ''): Array<[string, string]> {
  if (typeof o === 'string') return [[prefix, o]]
  if (o && typeof o === 'object')
    return Object.entries(o).flatMap(([k, v]) => leaves(v, prefix ? `${prefix}.${k}` : k))
  return []
}

describe('the Mission pane is gone', () => {
  it('no mission pane type or opener', () => {
    // the persisted type list and the two per-type maps
    const store = read('src/main/helpers-store.ts')
    const typeBlock = store.slice(
      store.indexOf('export type HelperPaneType'),
      store.indexOf('export interface HelperPane ')
    )
    expect(typeBlock).not.toMatch(/'mission'/)
    expect('mission' in paneRegistry).toBe(false)
    expect(read('src/renderer/src/lib/pane-registry.ts')).not.toMatch(/\bmission\s*:/)
    expect(read('src/renderer/src/lib/pane-components.ts')).not.toMatch(/\bmission\s*:|MissionPane/)

    // no opener anywhere in the app (the retired-type list in the helpers store names the type as a string)
    const openers = /\b(addMissionHelper|missionHelperId|toggleMissionHelper|openMissionPane)\b/
    for (const f of files('src', 'scripts')) {
      if (!/\.(ts|vue|mjs)$/.test(f)) continue
      expect(read(f), f).not.toMatch(openers)
    }

    // the pill holds no pane state: it does not read the helpers store and is not a toggle button
    const pill = read('src/renderer/src/components/MissionPill.vue')
    expect(pill).not.toMatch(/useHelpersStore|aria-pressed|helperId|paneOpen/)
  })

  it("the pane's files and strings are gone", () => {
    // the eight files
    for (const f of [
      'MissionPane',
      'MissionPaneNext',
      'MissionPaneTree',
      'MissionPaneStep',
      'MissionPaneSessions',
      'MissionPaneAttach',
      'MissionPaneAsk',
      'MissionHandoffDialog'
    ])
      expect(existsSync(`src/renderer/src/components/${f}.vue`), f).toBe(false)

    // no component, test or script imports them
    const imports = /\b(MissionPane(Next|Tree|Step|Sessions|Attach|Ask)?|MissionHandoffDialog)\.vue/
    for (const f of files('src', 'tests', 'scripts')) {
      if (f === 'tests/mission-dropdown-replaces-pane.test.ts') continue
      if (!/\.(ts|vue|mjs)$/.test(f)) continue
      expect(read(f), f).not.toMatch(imports)
    }

    // the kept view library holds no Sessions or hand-off code
    const view = read('src/renderer/src/lib/mission-pane-view.ts')
    expect(view).not.toMatch(
      /handoffOffer|handoffErrorKey|buildSessionRows|parseSummary|PANE_SECTIONS_KEY|loadPaneSections/i
    )

    // the design-entity map and design.md
    const map = read('CLAUDE.md')
    expect(map).not.toMatch(/MissionPane|MissionHandoffDialog|\| Mission pane/)
    const design = read('design.md')
    expect(design).not.toMatch(/^#+ Mission pane/m)
    expect(design).not.toMatch(
      /`arrow-left-right`[^\n]*(hand-off|handoff|Continue in a new session)/i
    )
    for (const glyph of ['list-checks', 'copy', 'git-branch'])
      expect(design, glyph).toMatch(new RegExp(`\`${glyph}\``))

    // the stored value is removed once at start, with the hand-off offer's: nothing reads either now
    const removed: string[] = []
    removeRetiredMissionStorage({ removeItem: (k) => removed.push(k) })
    expect(removed).toEqual([...RETIRED_MISSION_STORAGE_KEYS])
    expect(removed).toContain('om2tab.missionPane.sections')
    localStorage.setItem('om2tab.missionPane.sections', '{"tree":true}')
    localStorage.setItem('om2tab.missionHandoffDismissed', '{}')
    setActivePinia(createPinia())
    useMissionsStore()
    expect(localStorage.getItem('om2tab.missionPane.sections')).toBeNull()
    expect(localStorage.getItem('om2tab.missionHandoffDismissed')).toBeNull()
    expect(() =>
      removeRetiredMissionStorage({
        removeItem: () => {
          throw new Error('blocked')
        }
      })
    ).not.toThrow()

    // every string the user, an agent or a skill reads says what is now true
    const gone = /Mission pane|Missions pane|painel da miss|painel de miss|painel Miss/i
    const door = /Continue in a new session|Continuar em uma nova sess|Sessions row|linha Sess/i
    for (const [name, locale] of [
      ['en', en],
      ['pt-BR', ptBR]
    ] as const)
      for (const [key, value] of leaves(locale)) {
        expect(value, `${name} ${key}`).not.toMatch(gone)
        expect(value, `${name} ${key}`).not.toMatch(door)
      }
    const agentFacing = [
      ...files('src/main', 'resources/skills'),
      'docs/harnu-features.md',
      ...files('docs/user'),
      'docs/dev/missions-v4-landing.md',
      'scripts/dev/dialog-routes/board-missions.mjs',
      'scripts/verify/missions-v4-landing.mjs'
    ].filter((f) => /\.(ts|md|mjs|json)$/.test(f))
    for (const f of agentFacing) {
      const text = read(f)
      expect(text, f).not.toMatch(gone)
      // the backend's own comments (handoff.ts, which must not change) still describe the door it keeps; nothing a
      // person or an agent reads points at a button that is no longer there
      if (f.startsWith('src/main/')) continue
      expect(text, f).not.toMatch(/hand-off door in the|from the pane's|in the pane's Sessions/i)
      expect(text, f).not.toMatch(/Continue in a new session/)
    }
  })
})
