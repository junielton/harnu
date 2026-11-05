// @vitest-environment jsdom
// U3.7 AC-3: the address-pool advice. The decision is pure; the dialog shows a copyable
// `default-address-pools` snippet and says plainly that Harnu never edits daemon.json.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import CleanupPoolAdviceDialog from '../src/renderer/src/components/CleanupPoolAdviceDialog.vue'
import CleanupDockerCard from '../src/renderer/src/components/CleanupDockerCard.vue'
import { i18n } from '../src/renderer/src/i18n'
import {
  adviceOffer,
  poolsKey,
  POOL_ADVICE_SNIPPET
} from '../src/renderer/src/lib/docker-card-view'
import { defaultGcPrefs } from '../src/main/gc/gc-prefs'
import type { DockerCapacityView, DockerWatchRecord } from '../src/main/gc/gc-wire'

const known = (
  free: number,
  source: 'default' | 'daemon.json' = 'default',
  total = 31
): DockerCapacityView => ({ known: true, total, used: total - free, free, source })

const NONE = { squeezeSeenFor: null, dismissedFor: null }

describe('poolsKey', () => {
  it('names the engine pools by source and size', () => {
    expect(poolsKey({ total: 31, source: 'default' })).toBe('default:31')
    expect(poolsKey({ total: 256, source: 'daemon.json' })).toBe('daemon.json:256')
  })
})

describe('adviceOffer', () => {
  const seen = { squeezeSeenFor: 'default:31', dismissedFor: null }

  it('offers once a squeeze was seen on default pools', () => {
    expect(adviceOffer({ capacity: known(16), state: seen })).toBe(true)
  })

  it('never on custom pools (the operator already set them)', () => {
    expect(
      adviceOffer({
        capacity: known(2, 'daemon.json', 256),
        state: { squeezeSeenFor: 'daemon.json:256', dismissedFor: null }
      })
    ).toBe(false)
  })

  it('never without an observed squeeze', () => {
    expect(adviceOffer({ capacity: known(16), state: NONE })).toBe(false)
  })

  it('never after a dismissal for these pools', () => {
    expect(
      adviceOffer({ capacity: known(2), state: { ...seen, dismissedFor: 'default:31' } })
    ).toBe(false)
  })

  it('returns when the pools change after a dismissal and a new squeeze is seen', () => {
    const state = { squeezeSeenFor: 'default:62', dismissedFor: 'default:31' }
    expect(adviceOffer({ capacity: known(2, 'default', 62), state })).toBe(true)
  })

  it('a squeeze seen on other pools does not count for these', () => {
    expect(
      adviceOffer({
        capacity: known(2),
        state: { squeezeSeenFor: 'default:62', dismissedFor: null }
      })
    ).toBe(false)
  })

  it('unknown or missing capacity never offers', () => {
    expect(adviceOffer({ capacity: { known: false, reason: 'rootless' }, state: seen })).toBe(false)
    expect(adviceOffer({ capacity: null, state: seen })).toBe(false)
  })
})

describe('the snippet', () => {
  it('is valid daemon.json with the 10.200.0.0/16 pool of /24 networks', () => {
    expect(JSON.parse(POOL_ADVICE_SNIPPET)).toEqual({
      'default-address-pools': [{ base: '10.200.0.0/16', size: 24 }]
    })
  })
})

describe('CleanupPoolAdviceDialog', () => {
  afterEach(() => document.body.replaceChildren())

  const mountDialog = () =>
    mount(CleanupPoolAdviceDialog, {
      props: { free: 3, total: 31 },
      global: { plugins: [i18n] },
      attachTo: document.body
    })
  const text = (): string => document.body.textContent ?? ''

  it('explains the squeeze and shows the file, the snippet, the restart and the clash note', () => {
    mountDialog()
    expect(text()).toContain('Add more room for Docker networks')
    expect(text()).toContain('hold 31 networks')
    expect(text()).toContain('fell to 3')
    expect(text()).toContain('/etc/docker/daemon.json')
    expect(text()).toContain('"base": "10.200.0.0/16"')
    expect(text()).toContain('"size": 24')
    expect(text()).toContain("Pick a range your VPN and LAN don't use")
    expect(text()).toContain('Restart the Docker daemon')
    expect(text()).toContain('sudo systemctl restart docker')
    expect(text()).toContain('256 networks of /24')
    expect(text()).toContain("Harnu never edits this file. You'll only see this once.")
  })

  it('Copy writes exactly the snippet and then reads Copied', async () => {
    const writeText = vi.fn(async () => undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    mountDialog()
    const copy = document.querySelector<HTMLButtonElement>('[data-testid="pool-advice-copy"]')!
    expect(copy.textContent).toContain('Copy')
    copy.click()
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith(POOL_ADVICE_SNIPPET))
    await vi.waitFor(() => expect(copy.textContent).toContain('Copied'))
  })

  it('Dismiss and Esc both emit dismiss', async () => {
    const w = mountDialog()
    document.querySelector<HTMLButtonElement>('[data-testid="pool-advice-dismiss"]')!.click()
    expect(w.emitted('dismiss')).toHaveLength(1)
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    expect(w.emitted('dismiss')).toHaveLength(2)
  })

  it('has the dialog role and a label', () => {
    mountDialog()
    const dlg = document.querySelector('[data-testid="pool-advice-dialog"]')!
    expect(dlg.getAttribute('role')).toBe('dialog')
    expect(dlg.getAttribute('aria-modal')).toBe('true')
  })
})

describe('the callout on the card', () => {
  const cardWatch = {
    at: 1,
    trigger: 'timer',
    mode: 'act',
    mark: 3,
    capacity: known(3),
    pressure: true,
    found: 0,
    acted: 0,
    refused: 0,
    failed: 0,
    deferred: 0,
    locked: false,
    paused: false,
    pausedReason: null,
    nothingLeft: false,
    items: [],
    notice: null,
    report: null
  } satisfies DockerWatchRecord

  const mountCard = (over: Record<string, unknown>) =>
    mount(CleanupDockerCard, {
      props: {
        orphanVolumes: { count: 0, bytes: 0 },
        volumes: [],
        docker: {
          buildCacheReclaimableBytes: null,
          danglingImages: null,
          orphanVolumesHidden: null
        },
        lastCycle: null,
        prefs: defaultGcPrefs(),
        dockerWatch: cardWatch,
        ...over
      },
      global: { plugins: [i18n] }
    })

  it('shows one callout only while the advice is on offer, and its button asks to open the dialog', async () => {
    const w = mountCard({ poolAdvice: true })
    const callout = w.get('[data-testid="docker-pool-offer"]')
    expect(callout.text()).toContain(
      'Docker is on its default address pools and network slots ran low.'
    )
    await callout.get('[data-testid="docker-pool-offer-open"]').trigger('click')
    expect(w.emitted('openAdvice')).toHaveLength(1)
    expect(w.findAll('[data-testid="docker-pool-offer"]')).toHaveLength(1)
  })

  it('no callout when the advice is not on offer', () => {
    expect(
      mountCard({ poolAdvice: false }).find('[data-testid="docker-pool-offer"]').exists()
    ).toBe(false)
  })
})
