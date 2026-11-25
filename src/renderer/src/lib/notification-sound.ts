import notifyUrl from '../assets/notify.wav?url'

/**
 * Notification sounds — four families (T154, design.md → "Notification sounds — four families").
 *
 * One blip for every event was untraceable by ear, so a sound now says what KIND of thing happened:
 *
 * | Family | Operator hears   | Sound                       |
 * | ------ | ---------------- | --------------------------- |
 * | `ask`  | "Asks you"       | Rising fourth (synth)       |
 * | `done` | "Finished"       | Level up (synth)            |
 * | `fail` | "Broke"          | Muted thud pair (synth)     |
 * | `info` | "Just so you know" | the bundled `notify.wav`  |
 *
 * `ask` / `done` / `fail` are synthesized with Web Audio at play time (no asset files): the recipes
 * below are the contract the operator approved in the sound lab. `info` keeps the bundled chime.
 *
 * Callers own the decision to play (the Sound switch and the per-family mutes live in `NotifyPrefs`,
 * see `soundAllowed` in `stores/session-notify.ts`); this only emits the sound.
 *
 * Never throws: a missing `AudioContext`, a blocked autoplay policy or no output device (CI, headless)
 * is swallowed.
 */
export type SoundFamily = 'ask' | 'done' | 'fail' | 'info'

/** The four families, in the order Settings lists them. */
export const SOUND_FAMILIES: readonly SoundFamily[] = ['ask', 'done', 'fail', 'info']

/** The families that are synthesized (everything but `info`). */
export type SynthFamily = Exclude<SoundFamily, 'info'>

/** `[Hz, start s, duration s, gain]` */
export type SoundNote = readonly [hz: number, startS: number, durS: number, gain: number]

export interface SoundRecipe {
  notes: readonly SoundNote[]
  /** A lowpass on the whole family (the "muted" in the muted thud pair). */
  lowpass?: { hz: number; q: number }
}

export const SOUND_RECIPES: Record<SynthFamily, SoundRecipe> = {
  // Rising fourth: E5 held two thirds as long as A5, and A5 starts when E5 ends (~0.27 s).
  ask: {
    notes: [
      [659.25, 0, 0.11, 1],
      [880, 0.11, 0.16, 1]
    ]
  },
  // Level up: a rising jump that lands bright, G5 → C6 (~0.27 s).
  done: {
    notes: [
      [783.99, 0, 0.08, 0.75],
      [1046.5, 0.07, 0.2, 1]
    ]
  },
  // Muted thud pair: A3 twice, through a lowpass.
  fail: {
    notes: [
      [220, 0, 0.08, 1],
      [220, 0.1, 0.14, 0.8]
    ],
    lowpass: { hz: 1400, q: 0.5 }
  }
}

/** Timbre "Bell": sine partials `[ratio, gain]`, an 8 ms exponential attack from 0.0001. */
export const BELL = {
  partials: [
    [1, 1],
    [2, 0.18],
    [3.01, 0.06]
  ] as ReadonlyArray<readonly [ratio: number, gain: number]>,
  attackS: 0.008
}

/** The mix: master gain `0.35 × volume`, plus a short soft echo (and the dry signal). */
export const MIX = {
  masterGain: 0.35,
  volume: 0.5,
  echoDelayS: 0.09,
  echoFeedback: 0.18,
  echoWet: 0.22
}

/** Scheduling lead so the first note never starts in the past. */
export const SOUND_LEAD_S = 0.02

/** The decay floor of an exponential envelope (it can never reach 0). */
const FLOOR = 0.0001

type AudioContextCtor = new () => AudioContext

let ctx: AudioContext | null = null
let el: HTMLAudioElement | null = null

function audioContext(): AudioContext | null {
  if (ctx) return ctx
  const g = globalThis as unknown as {
    AudioContext?: AudioContextCtor
    webkitAudioContext?: AudioContextCtor
  }
  const Ctor = g.AudioContext ?? g.webkitAudioContext
  if (!Ctor) return null
  ctx = new Ctor()
  return ctx
}

/** Build and schedule one synth family on `ac` starting at `t0`. */
function synthesize(ac: AudioContext, recipe: SoundRecipe, t0: number): void {
  const master = ac.createGain()
  master.gain.value = MIX.masterGain * MIX.volume
  let out: AudioNode = master
  if (recipe.lowpass) {
    const lp = ac.createBiquadFilter()
    lp.type = 'lowpass'
    lp.frequency.value = recipe.lowpass.hz
    lp.Q.value = recipe.lowpass.q
    master.connect(lp)
    out = lp
  }
  // A short soft echo for space, plus the dry signal.
  const dry = ac.createGain()
  dry.gain.value = 1
  const delay = ac.createDelay()
  delay.delayTime.value = MIX.echoDelayS
  const feedback = ac.createGain()
  feedback.gain.value = MIX.echoFeedback
  const wet = ac.createGain()
  wet.gain.value = MIX.echoWet
  out.connect(dry)
  dry.connect(ac.destination)
  out.connect(delay)
  delay.connect(feedback)
  feedback.connect(delay)
  delay.connect(wet)
  wet.connect(ac.destination)

  for (const [hz, startS, durS, gain] of recipe.notes) {
    for (const [ratio, partialGain] of BELL.partials) {
      const osc = ac.createOscillator()
      osc.type = 'sine'
      osc.frequency.value = hz * ratio
      const env = ac.createGain()
      const s = t0 + startS
      const decay = durS / Math.sqrt(ratio) // higher partials die faster
      env.gain.setValueAtTime(FLOOR, s)
      env.gain.exponentialRampToValueAtTime(Math.max(gain * partialGain, 0.0002), s + BELL.attackS)
      env.gain.exponentialRampToValueAtTime(FLOOR, s + BELL.attackS + decay)
      osc.connect(env)
      env.connect(master)
      osc.start(s)
      osc.stop(s + BELL.attackS + decay + 0.05)
    }
  }
}

function playBundled(): void {
  if (!el) el = new Audio(notifyUrl)
  el.currentTime = 0
  void el.play().catch(() => {})
}

export function playNotificationSound(family: SoundFamily): void {
  try {
    if (family === 'info') {
      playBundled()
      return
    }
    const ac = audioContext()
    if (!ac) return
    // A context created before any user gesture starts suspended; the gesture that follows resumes it.
    if (ac.state === 'suspended') void ac.resume().catch(() => {})
    synthesize(ac, SOUND_RECIPES[family], ac.currentTime + SOUND_LEAD_S)
  } catch {
    /* no Audio / AudioContext, or no output device — nothing to do */
  }
}
