import { describe, it, expect, beforeEach } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useUiStore } from '../src/renderer/src/stores/ui'
import { useSessionsStore } from '../src/renderer/src/stores/sessions'

/**
 * Takeover dismissal contract (design.md §6 — "Takeover dismissal"):
 * entry-point buttons toggle, selecting a session dismisses, Esc dismisses.
 */
describe('takeover toggles', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('toggleRoadmap opens, then closes on a second click for the same folder', () => {
    const ui = useUiStore()
    ui.toggleRoadmap('/repos/alpha', 'alpha')
    expect(ui.roadmap.open).toBe(true)
    expect(ui.roadmap.folderPath).toBe('/repos/alpha')

    ui.toggleRoadmap('/repos/alpha', 'alpha')
    expect(ui.roadmap.open).toBe(false)
    expect(ui.roadmap.folderPath).toBeNull()
  })

  it('toggleRoadmap switches repos instead of closing when another folder is open', () => {
    const ui = useUiStore()
    ui.toggleRoadmap('/repos/alpha', 'alpha')
    ui.toggleRoadmap('/repos/beta', 'beta')
    expect(ui.roadmap.open).toBe(true)
    expect(ui.roadmap.folderPath).toBe('/repos/beta')
    expect(ui.roadmap.repoLabel).toBe('beta')
  })

  it('togglePrStack follows the same open/close/switch rules', () => {
    const ui = useUiStore()
    ui.togglePrStack('/repos/alpha', 'alpha')
    expect(ui.prStack.open).toBe(true)
    ui.togglePrStack('/repos/beta', 'beta')
    expect(ui.prStack.folderPath).toBe('/repos/beta')
    ui.togglePrStack('/repos/beta', 'beta')
    expect(ui.prStack.open).toBe(false)
  })

  it('toggleCleanup / toggleSystemMonitor / toggleUsageDashboard flip their flag', () => {
    const ui = useUiStore()
    ui.toggleCleanup()
    expect(ui.cleanupOpen).toBe(true)
    ui.toggleCleanup()
    expect(ui.cleanupOpen).toBe(false)

    ui.toggleSystemMonitor()
    expect(ui.systemMonitorOpen).toBe(true)
    ui.toggleSystemMonitor()
    expect(ui.systemMonitorOpen).toBe(false)

    ui.toggleUsageDashboard()
    expect(ui.usageDashboardOpen).toBe(true)
    ui.toggleUsageDashboard()
    expect(ui.usageDashboardOpen).toBe(false)
  })

  it('toggleReview follows the same open/close/switch rules (T164)', () => {
    const ui = useUiStore()
    ui.toggleReview('/repos/alpha', 'card-a')
    expect(ui.review.open).toBe(true)
    expect(ui.review.cardSlug).toBe('card-a')

    // A different folder switches instead of closing.
    ui.toggleReview('/repos/beta')
    expect(ui.review.open).toBe(true)
    expect(ui.review.folderPath).toBe('/repos/beta')
    expect(ui.review.cardSlug).toBeNull()

    ui.toggleReview('/repos/beta')
    expect(ui.review.open).toBe(false)
    expect(ui.review.folderPath).toBeNull()
  })

  it('opening one takeover from a toggle still closes the others (mutex holds)', () => {
    const ui = useUiStore()
    ui.toggleRoadmap('/repos/alpha', 'alpha')
    ui.togglePrStack('/repos/alpha', 'alpha')
    expect(ui.roadmap.open).toBe(false)
    expect(ui.prStack.open).toBe(true)

    ui.toggleCleanup()
    expect(ui.prStack.open).toBe(false)
    expect(ui.cleanupOpen).toBe(true)
    expect(ui.anyTakeoverOpen).toBe(true)
  })

  it('closeAll (Esc) dismisses every takeover, including the PR Stack', () => {
    const ui = useUiStore()
    ui.openPrStack('/repos/alpha', 'alpha')
    ui.closeAll()
    expect(ui.prStack.open).toBe(false)
    expect(ui.anyTakeoverOpen).toBe(false)
  })

  it('the Review takeover joins the mutex, Esc and session-select rules (T164 AC-1)', () => {
    const ui = useUiStore()
    const sessions = useSessionsStore()

    // Opening it closes whatever else was covering the transcript…
    ui.openRoadmap('/repos/alpha', 'alpha')
    ui.openReview('/repos/alpha', 'card-a')
    expect(ui.roadmap.open).toBe(false)
    expect(ui.review.open).toBe(true)
    expect(ui.anyTakeoverOpen).toBe(true)

    // …and opening another closes IT, in the other direction.
    ui.openPrStack('/repos/alpha', 'alpha')
    expect(ui.review.open).toBe(false)

    // Esc.
    ui.openReview('/repos/alpha', 'card-a')
    ui.closeAll()
    expect(ui.review.open).toBe(false)
    expect(ui.anyTakeoverOpen).toBe(false)

    // Selecting a session.
    ui.openReview('/repos/alpha', 'card-a')
    sessions.select('session-abc')
    expect(ui.review.open).toBe(false)
    expect(ui.review.folderPath).toBeNull()
  })

  it('selecting a session dismisses the open takeover', () => {
    const ui = useUiStore()
    const sessions = useSessionsStore()
    ui.openRoadmap('/repos/alpha', 'alpha')
    expect(ui.roadmap.open).toBe(true)

    sessions.select('session-abc')
    expect(ui.roadmap.open).toBe(false)
    expect(ui.anyTakeoverOpen).toBe(false)
    expect(sessions.selectedId).toBe('session-abc')
  })

  it('a programmatic selectedId write does NOT dismiss a takeover', () => {
    const ui = useUiStore()
    const sessions = useSessionsStore()
    ui.openCleanup()
    sessions.selectedId = 'session-from-a-background-reconcile'
    expect(ui.cleanupOpen).toBe(true)
  })
})
