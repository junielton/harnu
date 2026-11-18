/**
 * T154 — the four notification-sound families (`lib/notification-sound.ts`).
 *
 * The recipes are a contract (design.md → "Notification sounds — four families"): the exact notes,
 * timings, timbre and mix the operator approved in the sound lab. These tests pin them, then drive the
 * synth through a recording fake `AudioContext` to prove what is actually scheduled, and prove `info`
 * still plays the bundled `notify.wav` and that nothing ever throws.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

interface FakeParam {
  value: number
  calls: Array<[string, number, number?]>
  setValueAtTime(v: number, t: number): void
  exponentialRampToValueAtTime(v: number, t: number): void
}
const param = (value = 0): FakeParam => ({
  value,
  calls: [],
  setValueAtTime(v, t) {
    this.calls.push(['set', v, t])
  },
  exponentialRampToValueAtTime(v, t) {
    this.calls.push(['ramp', v, t])
  }
})

class FakeNode {
  connected: FakeNode[] = []
  connect(to: FakeNode): FakeNode {
    this.connected.push(to)
    return to
  }
}
class FakeOsc extends FakeNode {
  type = ''
  frequency = param()
  startedAt: number | null = null
  stoppedAt: number | null = null
  start(t: number): void {
    this.startedAt = t
  }
  stop(t: number): void {
    this.stoppedAt = t
  }
}
class FakeGain extends FakeNode {
  gain = param(1)
}
class FakeFilter extends FakeNode {
  type = ''
  frequency = param()
  Q = param()
}
class FakeDelay extends FakeNode {
  delayTime = param()
}

let created: { oscs: FakeOsc[]; gains: FakeGain[]; filters: FakeFilter[]; delays: FakeDelay[] }
let contexts = 0

class FakeAudioContext {
  currentTime = 10
  state = 'running'
  destination = new FakeNode()
  constructor() {
    contexts++
  }
  resume(): Promise<void> {
    return Promise.resolve()
  }
  createOscillator(): FakeOsc {
    const o = new FakeOsc()
    created.oscs.push(o)
    return o
  }
  createGain(): FakeGain {
    const g = new FakeGain()
    created.gains.push(g)
    return g
  }
  createBiquadFilter(): FakeFilter {
    const f = new FakeFilter()
    created.filters.push(f)
    return f
  }
  createDelay(): FakeDelay {
    const d = new FakeDelay()
    created.delays.push(d)
    return d
  }
}

const audioPlays: string[] = []
class FakeAudio {
  currentTime = 0
  constructor(public src: string) {}
  play(): Promise<void> {
    audioPlays.push(this.src)
    return Promise.resolve()
  }
}

const g = globalThis as unknown as Record<string, unknown>

beforeEach(() => {
  vi.resetModules()
  created = { oscs: [], gains: [], filters: [], delays: [] }
  contexts = 0
  audioPlays.length = 0
  g.AudioContext = FakeAudioContext
  g.Audio = FakeAudio
})

afterEach(() => {
  delete g.AudioContext
  delete g.Audio
})

describe('recipes — the contract', () => {
  it('ask is the rising fourth: E5 held two thirds as long as A5, A5 starting when E5 ends', async () => {
    const { SOUND_RECIPES } = await import('../src/renderer/src/lib/notification-sound')
    expect(SOUND_RECIPES.ask.notes).toEqual([
      [659.25, 0, 0.11, 1],
      [880, 0.11, 0.16, 1]
    ])
    expect(SOUND_RECIPES.ask.lowpass).toBeUndefined()
  })

  it('done is the level up: G5 into C6', async () => {
    const { SOUND_RECIPES } = await import('../src/renderer/src/lib/notification-sound')
    expect(SOUND_RECIPES.done.notes).toEqual([
      [783.99, 0, 0.08, 0.75],
      [1046.5, 0.07, 0.2, 1]
    ])
    expect(SOUND_RECIPES.done.lowpass).toBeUndefined()
  })

  it('fail is the muted thud pair: A3 twice through a 1400 Hz lowpass, Q 0.5', async () => {
    const { SOUND_RECIPES } = await import('../src/renderer/src/lib/notification-sound')
    expect(SOUND_RECIPES.fail.notes).toEqual([
      [220, 0, 0.08, 1],
      [220, 0.1, 0.14, 0.8]
    ])
    expect(SOUND_RECIPES.fail.lowpass).toEqual({ hz: 1400, q: 0.5 })
  })

  it('every synth family ends within about a quarter of a second', async () => {
    const { SOUND_RECIPES } = await import('../src/renderer/src/lib/notification-sound')
    for (const family of ['ask', 'done', 'fail'] as const) {
      const end = Math.max(...SOUND_RECIPES[family].notes.map(([, start, dur]) => start + dur))
      expect(end).toBeGreaterThan(0.2)
      expect(end).toBeLessThanOrEqual(0.28)
    }
  })

  it('the bell timbre and the mix are the approved ones', async () => {
    const mod = await import('../src/renderer/src/lib/notification-sound')
    expect(mod.BELL.partials).toEqual([
      [1, 1],
      [2, 0.18],
      [3.01, 0.06]
    ])
    expect(mod.BELL.attackS).toBe(0.008)
    expect(mod.MIX).toEqual({
      masterGain: 0.35,
      volume: 0.5,
      echoDelayS: 0.09,
      echoFeedback: 0.18,
      echoWet: 0.22
    })
  })

  it('names exactly the four families', async () => {
    const { SOUND_FAMILIES } = await import('../src/renderer/src/lib/notification-sound')
    expect([...SOUND_FAMILIES]).toEqual(['ask', 'done', 'fail', 'info'])
  })
})

describe('playNotificationSound — synthesis', () => {
  it('schedules every note × partial at the recipe time, frequency and decay', async () => {
    const { playNotificationSound, SOUND_RECIPES, BELL, SOUND_LEAD_S } =
      await import('../src/renderer/src/lib/notification-sound')
    for (const family of ['ask', 'done', 'fail'] as const) {
      created = { oscs: [], gains: [], filters: [], delays: [] }
      playNotificationSound(family)
      const { notes } = SOUND_RECIPES[family]
      expect(created.oscs).toHaveLength(notes.length * BELL.partials.length)
      const t0 = 10 + SOUND_LEAD_S
      let i = 0
      for (const [hz, start, dur] of notes) {
        for (const [ratio] of BELL.partials) {
          const osc = created.oscs[i++]
          expect(osc.type).toBe('sine')
          expect(osc.frequency.value).toBeCloseTo(hz * ratio, 6)
          expect(osc.startedAt).toBeCloseTo(t0 + start, 6)
          const decayEnd = t0 + start + BELL.attackS + dur / Math.sqrt(ratio)
          expect(osc.stoppedAt).toBeGreaterThanOrEqual(decayEnd)
        }
      }
    }
  })

  it('shapes each partial: attack to ratio × note gain, then decay over dur / sqrt(ratio)', async () => {
    const { playNotificationSound, SOUND_RECIPES, BELL, SOUND_LEAD_S } =
      await import('../src/renderer/src/lib/notification-sound')
    playNotificationSound('done')
    const [hz, start, dur, gain] = SOUND_RECIPES.done.notes[1]
    void hz
    const t0 = 10 + SOUND_LEAD_S
    // Find the envelope that ramps to the top note's second partial: peak = gain × 0.18.
    const wanted = gain * BELL.partials[1][1]
    const env = created.gains.find((n) =>
      n.gain.calls.some(([kind, v]) => kind === 'ramp' && Math.abs(v - wanted) < 1e-9)
    )
    expect(env).toBeDefined()
    const ramps = env!.gain.calls.filter(([kind]) => kind === 'ramp')
    expect(ramps[0][2]).toBeCloseTo(t0 + start + BELL.attackS, 6)
    expect(ramps[1][1]).toBeCloseTo(0.0001, 6)
    expect(ramps[1][2]).toBeCloseTo(t0 + start + BELL.attackS + dur / Math.sqrt(2), 6)
    // It starts from near-silence, never from zero (an exponential ramp cannot leave 0).
    expect(env!.gain.calls[0]).toEqual(['set', 0.0001, t0 + start])
  })

  it('mixes at master 0.35 × volume 0.5 with the soft echo (90 ms, feedback 0.18, wet 0.22)', async () => {
    const { playNotificationSound } = await import('../src/renderer/src/lib/notification-sound')
    playNotificationSound('ask')
    const values = created.gains.map((n) => n.gain.value)
    expect(values.some((v) => Math.abs(v - 0.175) < 1e-9)).toBe(true) // master
    expect(values).toContain(0.18) // feedback
    expect(values).toContain(0.22) // wet
    expect(created.delays).toHaveLength(1)
    expect(created.delays[0].delayTime.value).toBeCloseTo(0.09, 9)
  })

  it('only fail goes through the lowpass', async () => {
    const { playNotificationSound } = await import('../src/renderer/src/lib/notification-sound')
    playNotificationSound('ask')
    playNotificationSound('done')
    expect(created.filters).toHaveLength(0)
    playNotificationSound('fail')
    expect(created.filters).toHaveLength(1)
    expect(created.filters[0].type).toBe('lowpass')
    expect(created.filters[0].frequency.value).toBe(1400)
    expect(created.filters[0].Q.value).toBe(0.5)
  })

  it('creates the AudioContext lazily, once', async () => {
    const { playNotificationSound } = await import('../src/renderer/src/lib/notification-sound')
    expect(contexts).toBe(0)
    playNotificationSound('ask')
    playNotificationSound('done')
    playNotificationSound('fail')
    expect(contexts).toBe(1)
  })

  it('synth families never touch notify.wav', async () => {
    const { playNotificationSound } = await import('../src/renderer/src/lib/notification-sound')
    playNotificationSound('ask')
    playNotificationSound('done')
    playNotificationSound('fail')
    expect(audioPlays).toHaveLength(0)
  })
})

describe('playNotificationSound — info', () => {
  it('plays the bundled notify.wav and builds no synth graph', async () => {
    const { playNotificationSound } = await import('../src/renderer/src/lib/notification-sound')
    playNotificationSound('info')
    expect(audioPlays).toHaveLength(1)
    expect(audioPlays[0]).toMatch(/notify.*\.wav/)
    expect(contexts).toBe(0)
    expect(created.oscs).toHaveLength(0)
  })

  it('replays the same element on every call', async () => {
    const { playNotificationSound } = await import('../src/renderer/src/lib/notification-sound')
    playNotificationSound('info')
    playNotificationSound('info')
    expect(audioPlays).toHaveLength(2)
  })
})

describe('playNotificationSound — fail-soft', () => {
  it('never throws without an AudioContext or an Audio constructor', async () => {
    delete g.AudioContext
    delete g.Audio
    const { playNotificationSound } = await import('../src/renderer/src/lib/notification-sound')
    for (const family of ['ask', 'done', 'fail', 'info'] as const) {
      expect(() => playNotificationSound(family)).not.toThrow()
    }
  })

  it('never throws when the AudioContext constructor or the graph throws', async () => {
    g.AudioContext = class {
      constructor() {
        throw new Error('no output device')
      }
    }
    const { playNotificationSound } = await import('../src/renderer/src/lib/notification-sound')
    expect(() => playNotificationSound('ask')).not.toThrow()
  })

  it('swallows a rejected play()', async () => {
    g.Audio = class {
      currentTime = 0
      play(): Promise<void> {
        return Promise.reject(new Error('autoplay blocked'))
      }
    }
    const { playNotificationSound } = await import('../src/renderer/src/lib/notification-sound')
    expect(() => playNotificationSound('info')).not.toThrow()
    await Promise.resolve()
  })
})
