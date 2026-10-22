/**
 * T572 (browser pane U5, AC-2, AC-3, AC-4, AC-5) — the device emulation core: presets, the plan-level argument
 * refusals, the record merge, the fit-scale arithmetic and the CDP commands that make the page see a real device.
 */
import { describe, it, expect } from 'vitest'
import {
  DEVICE_PRESETS,
  DEVICE_PRESET_NAMES,
  checkEmulateArgs,
  chromeMajor,
  deviceCaption,
  deviceFromPreset,
  describeDevice,
  deviceKind,
  effectiveTouch,
  fitScale,
  isEmptyRecord,
  mergeEmulation,
  sanitizeEmulatePatch,
  metricsCommand,
  needsReloadFor,
  sessionCommands,
  summarizeEmulation,
  userAgentFor,
  viewScale,
  type EmulationRecord
} from '../src/shared/browser-emulation'

const CHROME_UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.7339.0 Electron/39.0.0 Safari/537.36'

describe('presets', () => {
  it('are the seven classes of spec §9.2, never product names', () => {
    expect(DEVICE_PRESET_NAMES).toEqual([
      'phone-s',
      'phone-m',
      'phone-l',
      'tablet',
      'tablet-landscape',
      'laptop',
      'desktop'
    ])
    expect(DEVICE_PRESETS['phone-s']).toMatchObject({ width: 360, height: 800, dpr: 3 })
    expect(DEVICE_PRESETS['phone-m']).toMatchObject({ width: 390, height: 844, dpr: 3 })
    expect(DEVICE_PRESETS['phone-l']).toMatchObject({ width: 430, height: 932, dpr: 3 })
    expect(DEVICE_PRESETS.tablet).toMatchObject({ width: 768, height: 1024, dpr: 2 })
    expect(DEVICE_PRESETS['tablet-landscape']).toMatchObject({ width: 1024, height: 768, dpr: 2 })
    expect(DEVICE_PRESETS.laptop).toMatchObject({ width: 1440, height: 900, dpr: 2 })
    expect(DEVICE_PRESETS.desktop).toMatchObject({ width: 1920, height: 1080, dpr: 1 })
  })
})

describe('checkEmulateArgs (plan level, spec §6.3)', () => {
  const none = { deviceActive: false }
  const on = { deviceActive: true }

  it('an empty call is BAD_ARGS', () => {
    expect(checkEmulateArgs({}, none)?.code).toBe('BAD_ARGS')
  })

  it('`device` together with explicit size args is BAD_ARGS, for each size arg', () => {
    for (const extra of [{ width: 500 }, { height: 500 }, { dpr: 2 }, { mobile: true }]) {
      expect(checkEmulateArgs({ device: 'phone-m', ...extra }, none)?.code).toBe('BAD_ARGS')
    }
  })

  it('an unknown preset is BAD_ARGS and names the valid ones', () => {
    const r = checkEmulateArgs({ device: 'iphone-15' }, none)
    expect(r?.code).toBe('BAD_ARGS')
    expect(r?.detail).toContain('phone-m')
  })

  it('zoom while a device is active is ZOOM_IN_DEVICE_MODE', () => {
    expect(checkEmulateArgs({ zoom: 1.5 }, on)?.code).toBe('ZOOM_IN_DEVICE_MODE')
  })

  it('zoom together with a device in the same call is ZOOM_IN_DEVICE_MODE too', () => {
    expect(checkEmulateArgs({ zoom: 1.5, device: 'tablet' }, none)?.code).toBe(
      'ZOOM_IN_DEVICE_MODE'
    )
    expect(checkEmulateArgs({ zoom: 1.5, width: 500, height: 500 }, none)?.code).toBe(
      'ZOOM_IN_DEVICE_MODE'
    )
  })

  it('zoom with reset is fine: reset leaves device mode first', () => {
    expect(checkEmulateArgs({ zoom: 1.5, reset: true }, on)).toBeNull()
  })

  it('zoom with no device is fine, and so is a bare device', () => {
    expect(checkEmulateArgs({ zoom: 2 }, none)).toBeNull()
    expect(checkEmulateArgs({ device: 'phone-m' }, none)).toBeNull()
  })

  it('a free size needs width and height unless a device is already active', () => {
    expect(checkEmulateArgs({ width: 500 }, none)?.code).toBe('BAD_ARGS')
    expect(checkEmulateArgs({ dpr: 2 }, none)?.code).toBe('BAD_ARGS')
    expect(checkEmulateArgs({ width: 500, height: 600 }, none)).toBeNull()
    expect(checkEmulateArgs({ dpr: 2 }, on)).toBeNull()
    expect(checkEmulateArgs({ dpr: 2, reset: true }, on)?.code).toBe('BAD_ARGS')
  })

  it('range-checks the size, the pixel ratio, the zoom and the user agent', () => {
    expect(checkEmulateArgs({ width: 99, height: 500 }, none)?.code).toBe('BAD_ARGS')
    expect(checkEmulateArgs({ width: 500, height: 10001 }, none)?.code).toBe('BAD_ARGS')
    expect(checkEmulateArgs({ width: 500, height: 500, dpr: 0.1 }, none)?.code).toBe('BAD_ARGS')
    expect(checkEmulateArgs({ width: 500, height: 500, dpr: 9 }, none)?.code).toBe('BAD_ARGS')
    expect(checkEmulateArgs({ zoom: 0 }, none)?.code).toBe('BAD_ARGS')
    expect(checkEmulateArgs({ zoom: Number.NaN }, none)?.code).toBe('BAD_ARGS')
    expect(checkEmulateArgs({ userAgent: '' }, none)?.code).toBe('BAD_ARGS')
    expect(checkEmulateArgs({ userAgent: 'a\nb' }, none)?.code).toBe('BAD_ARGS')
    expect(checkEmulateArgs({ userAgent: 'x'.repeat(513) }, none)?.code).toBe('BAD_ARGS')
  })

  it('colour scheme, reduced motion, touch and reset on their own are fine', () => {
    expect(checkEmulateArgs({ colorScheme: 'dark' }, none)).toBeNull()
    expect(checkEmulateArgs({ reducedMotion: true }, none)).toBeNull()
    expect(checkEmulateArgs({ touch: true }, none)).toBeNull()
    expect(checkEmulateArgs({ reset: true }, none)).toBeNull()
  })
})

describe('mergeEmulation (the one record, AC-5)', () => {
  it('a preset sets the whole device', () => {
    const r = mergeEmulation({}, { device: 'phone-m' })
    expect(r.device).toEqual(deviceFromPreset('phone-m'))
    expect(effectiveTouch(r)).toBe(true)
  })

  it('a free size drops the preset name and keeps what it does not set', () => {
    const base = mergeEmulation({}, { device: 'phone-m' })
    const r = mergeEmulation(base, { dpr: 2 })
    expect(r.device).toMatchObject({ preset: null, width: 390, height: 844, dpr: 2, mobile: true })
  })

  it('a free size on no device defaults to desktop-like (not mobile, dpr 1)', () => {
    const r = mergeEmulation({}, { width: 800, height: 600 })
    expect(r.device).toEqual({
      preset: null,
      width: 800,
      height: 600,
      dpr: 1,
      mobile: false,
      rotated: false
    })
    expect(effectiveTouch(r)).toBe(false)
  })

  it('rotate swaps the size, keeps the preset, and rotating twice is the identity', () => {
    const once = mergeEmulation(mergeEmulation({}, { device: 'phone-m' }), { rotate: true })
    expect(once.device).toMatchObject({ preset: 'phone-m', width: 844, height: 390, rotated: true })
    const twice = mergeEmulation(once, { rotate: true })
    expect(twice.device).toEqual(deviceFromPreset('phone-m'))
  })

  it('rotate with no device does nothing', () => {
    expect(mergeEmulation({}, { rotate: true })).toEqual({})
  })

  it('the media toggles and the user agent set and persist', () => {
    const r = mergeEmulation({}, { colorScheme: 'dark', reducedMotion: true, userAgent: 'UA/1' })
    expect(r).toMatchObject({ colorScheme: 'dark', reducedMotion: true, userAgent: 'UA/1' })
    const r2 = mergeEmulation(r, { colorScheme: 'light' })
    expect(r2.colorScheme).toBe('light')
    expect(r2.reducedMotion).toBe(true)
  })

  it('reset clears everything, and a call can set something new in the same breath', () => {
    const full = mergeEmulation({}, { device: 'phone-m', colorScheme: 'dark' })
    expect(isEmptyRecord(mergeEmulation(full, { reset: true }))).toBe(true)
    expect(mergeEmulation(full, { reset: true, device: 'tablet' }).colorScheme).toBeUndefined()
  })

  it('never mutates the record it was given', () => {
    const base: EmulationRecord = { colorScheme: 'dark' }
    mergeEmulation(base, { device: 'phone-m', reset: true })
    expect(base).toEqual({ colorScheme: 'dark' })
  })

  it('the operator picker and the agent verb produce the same record for the same intent', () => {
    // The picker sends the same argument shape the verb does (AC-5: the picker shows the truth).
    const viaVerb = mergeEmulation({}, { device: 'tablet', colorScheme: 'dark' })
    const viaPicker = mergeEmulation(mergeEmulation({}, { device: 'tablet' }), {
      colorScheme: 'dark'
    })
    expect(viaPicker).toEqual(viaVerb)
  })
})

describe('fit scale and view scale (AC-3)', () => {
  it('is the largest scale ≤ 1 that fits', () => {
    expect(fitScale({ width: 390, height: 844 }, { width: 600, height: 422 })).toBeCloseTo(0.5)
    expect(fitScale({ width: 390, height: 844 }, { width: 195, height: 2000 })).toBeCloseTo(0.5)
  })

  it('never enlarges a device past 1', () => {
    expect(fitScale({ width: 390, height: 844 }, { width: 5000, height: 5000 })).toBe(1)
  })

  it('never goes below the minimum and survives a zero-size pane', () => {
    expect(fitScale({ width: 1920, height: 1080 }, { width: 100, height: 100 })).toBe(0.25)
    expect(fitScale({ width: 390, height: 844 }, { width: 0, height: 0 })).toBe(0.25)
  })

  it('viewScale is the ratio of the bounds main set to the device width', () => {
    expect(viewScale(390, 195)).toBeCloseTo(0.5)
    expect(viewScale(390, 0)).toBe(1)
    expect(viewScale(0, 100)).toBe(1)
  })
})

describe('CDP commands (AC-2)', () => {
  it('the metrics override carries width, height, DPR, mobile and the fit scale', () => {
    const cmd = metricsCommand(deviceFromPreset('phone-m'), 0.5)
    expect(cmd.method).toBe('Emulation.setDeviceMetricsOverride')
    expect(cmd.params).toMatchObject({
      width: 390,
      height: 844,
      deviceScaleFactor: 3,
      mobile: true,
      scale: 0.5
    })
    expect(cmd.params.screenOrientation).toEqual({ type: 'portraitPrimary', angle: 0 })
  })

  it('a landscape mobile device reports a landscape orientation', () => {
    const cmd = metricsCommand(deviceFromPreset('tablet-landscape'), 1)
    expect(cmd.params.screenOrientation).toEqual({ type: 'landscapePrimary', angle: 90 })
  })

  it('no device clears the override', () => {
    expect(metricsCommand(undefined, 1).method).toBe('Emulation.clearDeviceMetricsOverride')
  })

  it('a mobile device turns touch on, with a mobile user agent and matching client hints', () => {
    const cmds = sessionCommands(mergeEmulation({}, { device: 'phone-m' }), CHROME_UA)
    const by = Object.fromEntries(cmds.map((c) => [c.method, c.params]))
    expect(by['Emulation.setTouchEmulationEnabled']).toEqual({ enabled: true, maxTouchPoints: 5 })
    expect(by['Emulation.setEmitTouchEventsForMouse']).toMatchObject({
      enabled: true,
      configuration: 'mobile'
    })
    const ua = by['Emulation.setUserAgentOverride']!
    expect(String(ua.userAgent)).toContain('Android')
    expect(String(ua.userAgent)).toContain('Chrome/140.')
    expect(String(ua.userAgent)).toContain('Mobile')
    expect(ua.userAgentMetadata).toMatchObject({ platform: 'Android', mobile: true })
  })

  it('a tablet user agent has no `Mobile` token and says so in the hints', () => {
    const ua = userAgentFor(mergeEmulation({}, { device: 'tablet' }), CHROME_UA)!
    expect(ua.userAgent).not.toContain('Mobile')
    expect(ua.userAgentMetadata).toMatchObject({ mobile: false })
  })

  it('a desktop device and an empty record RESTORE the original user agent explicitly (A5)', () => {
    for (const rec of [mergeEmulation({}, { device: 'laptop' }), {}]) {
      const cmd = sessionCommands(rec, CHROME_UA).find(
        (c) => c.method === 'Emulation.setUserAgentOverride'
      )!
      expect(cmd.params).toEqual({ userAgent: CHROME_UA })
    }
  })

  it('an explicit user agent wins over the device’s', () => {
    const rec = mergeEmulation({}, { device: 'phone-m', userAgent: 'Custom/1' })
    expect(userAgentFor(rec, CHROME_UA)).toEqual({ userAgent: 'Custom/1' })
  })

  it('an empty record switches touch and the media features off explicitly', () => {
    const by = Object.fromEntries(sessionCommands({}, CHROME_UA).map((c) => [c.method, c.params]))
    expect(by['Emulation.setTouchEmulationEnabled']).toEqual({ enabled: false })
    expect(by['Emulation.setEmulatedMedia']).toEqual({
      features: [
        { name: 'prefers-color-scheme', value: '' },
        { name: 'prefers-reduced-motion', value: '' }
      ]
    })
  })

  it('colour scheme and reduced motion go out as media features', () => {
    const rec = mergeEmulation({}, { colorScheme: 'dark', reducedMotion: true })
    const media = sessionCommands(rec, CHROME_UA).find(
      (c) => c.method === 'Emulation.setEmulatedMedia'
    )!
    expect(media.params).toEqual({
      features: [
        { name: 'prefers-color-scheme', value: 'dark' },
        { name: 'prefers-reduced-motion', value: 'reduce' }
      ]
    })
  })

  it('an explicit touch choice beats the device default', () => {
    const rec = mergeEmulation(mergeEmulation({}, { device: 'phone-m' }), { touch: false })
    expect(effectiveTouch(rec)).toBe(false)
  })

  it('reads the Chrome major from a user agent', () => {
    expect(chromeMajor(CHROME_UA)).toBe(140)
    expect(chromeMajor('curl/8')).toBeNull()
  })
})

describe('labels and summaries', () => {
  it('describes a device the way the chip shows it', () => {
    expect(describeDevice(deviceFromPreset('phone-m'))).toBe('phone-m · 390×844 @3')
    expect(describeDevice(mergeEmulation({}, { width: 1000, height: 700 }).device!)).toBe(
      'custom · 1000×700 @1'
    )
  })

  it('judges the icon of a free size by its shape', () => {
    expect(deviceKind(deviceFromPreset('phone-m'))).toBe('phone')
    expect(deviceKind(mergeEmulation({}, { width: 700, height: 900, mobile: true }).device!)).toBe(
      'tablet'
    )
    expect(deviceKind(mergeEmulation({}, { width: 1000, height: 700 }).device!)).toBe('laptop')
    expect(deviceKind(mergeEmulation({}, { width: 2000, height: 1000 }).device!)).toBe('desktop')
  })

  it('the caption lists only the segments that apply', () => {
    const rec = mergeEmulation({}, { device: 'phone-m', colorScheme: 'light' })
    expect(deviceCaption(rec, 0.66)).toBe(
      'fit 66% · touch on · mobile UA · prefers-color-scheme: light'
    )
    expect(deviceCaption({ colorScheme: 'dark' }, 1)).toBe('prefers-color-scheme: dark')
  })

  it('summarizes a record for browser_list and the ACK', () => {
    expect(summarizeEmulation(undefined)).toMatchObject({ device: null, touch: false })
    expect(summarizeEmulation(mergeEmulation({}, { device: 'tablet' }))).toMatchObject({
      device: 'tablet',
      width: 768,
      height: 1024,
      dpr: 2,
      mobile: true,
      touch: true
    })
  })

  it('touch needs a reload only when it turns ON for a page that already loaded', () => {
    const phone = mergeEmulation({}, { device: 'phone-m' })
    expect(needsReloadFor({}, phone)).toBe(true)
    expect(needsReloadFor(phone, phone)).toBe(false)
    expect(needsReloadFor(phone, {})).toBe(false)
  })
})

describe('sanitizeEmulatePatch (the picker’s IPC payload is untrusted)', () => {
  it('keeps the known fields of the right type and drops the rest', () => {
    expect(
      sanitizeEmulatePatch({
        device: 'phone-m',
        width: 500,
        height: 'x',
        dpr: 2,
        mobile: true,
        touch: 'yes',
        colorScheme: 'dark',
        rotate: true,
        zoom: 3,
        evil: { a: 1 },
        __proto__: { polluted: true }
      })
    ).toEqual({
      device: 'phone-m',
      width: 500,
      dpr: 2,
      mobile: true,
      colorScheme: 'dark',
      rotate: true
    })
  })

  it('never lets the picker set zoom', () => {
    expect(sanitizeEmulatePatch({ zoom: 2 })).toEqual({})
  })

  it('anything that is not an object is an empty patch', () => {
    for (const v of [null, undefined, 3, 'x', []]) expect(sanitizeEmulatePatch(v)).toEqual({})
  })

  it('a bad colour scheme is dropped, not passed through', () => {
    expect(sanitizeEmulatePatch({ colorScheme: 'sepia' })).toEqual({})
  })
})
