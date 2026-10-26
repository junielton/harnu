/**
 * Device emulation, pure core (T572 U5, spec §9.2, §13 A5): the preset table, the emulation RECORD a pane carries,
 * how an argument set (the agent's `browser_emulate` or the operator's picker) merges into it, the CDP commands
 * that make the page see it, and the fit-scale arithmetic that lets a large device sit in a small pane.
 *
 * Real mobile rules, not a narrower window: the device metrics override sets width, height, DPR and the mobile flag;
 * touch emulation, the user agent (with client hints) and the media features ride along. The fit scale is passed as
 * `scale` so the page renders at device size and is only DISPLAYED smaller; the page never sees it.
 *
 * Deliberately import-free and in `src/shared`: the renderer imports it to share the fit-scale and label code
 * with the pane chrome, so it cannot pull main-only modules. No electron, no clock.
 */

export type DeviceKind = 'phone' | 'tablet' | 'laptop' | 'desktop'

export interface DevicePreset {
  width: number
  height: number
  dpr: number
  mobile: boolean
  kind: DeviceKind
}

/** Presets are classes, not product names (spec §9.2). */
export const DEVICE_PRESETS = {
  'phone-s': { width: 360, height: 800, dpr: 3, mobile: true, kind: 'phone' },
  'phone-m': { width: 390, height: 844, dpr: 3, mobile: true, kind: 'phone' },
  'phone-l': { width: 430, height: 932, dpr: 3, mobile: true, kind: 'phone' },
  tablet: { width: 768, height: 1024, dpr: 2, mobile: true, kind: 'tablet' },
  'tablet-landscape': { width: 1024, height: 768, dpr: 2, mobile: true, kind: 'tablet' },
  laptop: { width: 1440, height: 900, dpr: 2, mobile: false, kind: 'laptop' },
  desktop: { width: 1920, height: 1080, dpr: 1, mobile: false, kind: 'desktop' }
} as const satisfies Record<string, DevicePreset>

export type DevicePresetName = keyof typeof DEVICE_PRESETS

export const DEVICE_PRESET_NAMES = Object.keys(DEVICE_PRESETS) as DevicePresetName[]

export function isPresetName(name: unknown): name is DevicePresetName {
  return typeof name === 'string' && Object.hasOwn(DEVICE_PRESETS, name)
}

/** Free-size bounds (CSS px, and the pixel ratio). */
export const DEVICE_MIN_SIZE = 100
export const DEVICE_MAX_SIZE = 10_000
export const DEVICE_MIN_DPR = 0.5
export const DEVICE_MAX_DPR = 5
export const MAX_USER_AGENT_CHARS = 512

/** What the pane emulates as a device. `preset` is `null` for a free size. */
export interface DeviceSpec {
  preset: DevicePresetName | null
  width: number
  height: number
  dpr: number
  mobile: boolean
  /** The width and height are swapped from the preset's own (the operator's Rotate, or `tablet-landscape`'s twin). */
  rotated: boolean
}

/** The emulation record that lives on the pane (spec §9.2, §10.3). An empty record is "no emulation". */
export interface EmulationRecord {
  device?: DeviceSpec
  /** Explicit touch choice; absent = on exactly when the device is mobile. */
  touch?: boolean
  /** A user agent the agent or operator set explicitly; absent = the device's own, or the page's original. */
  userAgent?: string
  colorScheme?: 'light' | 'dark'
  reducedMotion?: boolean
}

/** The arguments of one emulate call: the agent's `browser_emulate`, or the operator's picker. */
export interface EmulateArgs {
  zoom?: number
  device?: string
  width?: number
  height?: number
  dpr?: number
  mobile?: boolean
  touch?: boolean
  userAgent?: string
  colorScheme?: 'light' | 'dark'
  reducedMotion?: boolean
  reset?: boolean
  /** Operator only (the picker's Rotate button); no verb carries it. */
  rotate?: boolean
}

/**
 * The operator picker's patch from an IPC payload (untrusted input): only the known fields, only of the right type,
 * never `zoom` (the picker has its own channel for that). Whatever it keeps is judged by {@link checkEmulateArgs}.
 */
export function sanitizeEmulatePatch(raw: unknown): EmulateArgs {
  const out: EmulateArgs = {}
  if (typeof raw !== 'object' || raw === null) return out
  const r = raw as Record<string, unknown>
  if (typeof r.device === 'string') out.device = r.device
  for (const k of ['width', 'height', 'dpr'] as const) {
    if (typeof r[k] === 'number') out[k] = r[k] as number
  }
  for (const k of ['mobile', 'touch', 'reducedMotion', 'reset', 'rotate'] as const) {
    if (typeof r[k] === 'boolean') out[k] = r[k] as boolean
  }
  if (typeof r.userAgent === 'string') out.userAgent = r.userAgent
  if (r.colorScheme === 'light' || r.colorScheme === 'dark') out.colorScheme = r.colorScheme
  return out
}

export function isEmptyRecord(rec: EmulationRecord | undefined): boolean {
  if (!rec) return true
  return (
    rec.device === undefined &&
    rec.touch === undefined &&
    rec.userAgent === undefined &&
    rec.colorScheme === undefined &&
    rec.reducedMotion === undefined
  )
}

export function deviceActive(rec: EmulationRecord | undefined): boolean {
  return rec?.device !== undefined
}

/** Whether touch is emulated: the explicit choice, else on when the device is mobile. */
export function effectiveTouch(rec: EmulationRecord | undefined): boolean {
  if (!rec) return false
  return rec.touch ?? rec.device?.mobile ?? false
}

const SIZE_KEYS = ['width', 'height', 'dpr', 'mobile'] as const

/** Whether the call carries any free-size field. */
function hasSizeArgs(args: EmulateArgs): boolean {
  return SIZE_KEYS.some((k) => args[k] !== undefined)
}

export type EmulateRefusal =
  { code: 'BAD_ARGS'; detail: string } | { code: 'ZOOM_IN_DEVICE_MODE'; detail: string }

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v)
}

/**
 * The content refusals of an emulate call, judged at PLAN level (spec §6.3) so a call that can never succeed never
 * raises a confirm. `deviceActive` is whether the pane emulates a device right now (the resolved gate state).
 *
 *  - `device` together with explicit size arguments is `BAD_ARGS`;
 *  - a free size needs `width` and `height` (the pane's own device supplies the missing ones, if it has one);
 *  - `zoom` while a device is, or this very call makes, active is `ZOOM_IN_DEVICE_MODE` (Q15). `reset: true`
 *    clears the device first, so `{ reset: true, zoom }` is fine.
 */
export function checkEmulateArgs(
  args: EmulateArgs,
  ctx: { deviceActive: boolean }
): EmulateRefusal | null {
  const given = Object.entries(args).filter(([, v]) => v !== undefined)
  if (given.length === 0) {
    return {
      code: 'BAD_ARGS',
      detail:
        'Pass at least one of `zoom`, `device`, `width` and `height`, `userAgent`, `colorScheme`, `reducedMotion`, `touch` or `reset`.'
    }
  }
  if (args.device !== undefined) {
    if (!isPresetName(args.device)) {
      return {
        code: 'BAD_ARGS',
        detail: `\`device\` is one of ${DEVICE_PRESET_NAMES.join(', ')}. For another size pass \`width\` and \`height\`.`
      }
    }
    if (hasSizeArgs(args)) {
      return {
        code: 'BAD_ARGS',
        detail:
          'Pass either `device` or an explicit size (`width`, `height`, `dpr`, `mobile`), not both.'
      }
    }
  }
  if (args.width !== undefined && !(isFiniteNumber(args.width) && inSize(args.width))) {
    return { code: 'BAD_ARGS', detail: `\`width\` is ${DEVICE_MIN_SIZE}..${DEVICE_MAX_SIZE}.` }
  }
  if (args.height !== undefined && !(isFiniteNumber(args.height) && inSize(args.height))) {
    return { code: 'BAD_ARGS', detail: `\`height\` is ${DEVICE_MIN_SIZE}..${DEVICE_MAX_SIZE}.` }
  }
  if (
    args.dpr !== undefined &&
    !(isFiniteNumber(args.dpr) && args.dpr >= DEVICE_MIN_DPR && args.dpr <= DEVICE_MAX_DPR)
  ) {
    return { code: 'BAD_ARGS', detail: `\`dpr\` is ${DEVICE_MIN_DPR}..${DEVICE_MAX_DPR}.` }
  }
  if (args.zoom !== undefined && !(isFiniteNumber(args.zoom) && args.zoom > 0)) {
    return { code: 'BAD_ARGS', detail: '`zoom` is a factor above 0 (1 = 100%).' }
  }
  if (args.userAgent !== undefined) {
    const ua = args.userAgent
    if (
      typeof ua !== 'string' ||
      ua.length === 0 ||
      ua.length > MAX_USER_AGENT_CHARS ||
      hasControlChars(ua)
    ) {
      return {
        code: 'BAD_ARGS',
        detail: `\`userAgent\` is 1..${MAX_USER_AGENT_CHARS} printable characters.`
      }
    }
  }
  const sizeCall = hasSizeArgs(args) && args.device === undefined
  const keepsDevice = !args.reset && ctx.deviceActive
  if (sizeCall && !keepsDevice && (args.width === undefined || args.height === undefined)) {
    return {
      code: 'BAD_ARGS',
      detail:
        'No device is active: pass `device`, or `width` and `height` together (with `dpr` and `mobile` if you need them).'
    }
  }
  const willHaveDevice = args.device !== undefined || sizeCall || keepsDevice
  if (args.zoom !== undefined && willHaveDevice) {
    return {
      code: 'ZOOM_IN_DEVICE_MODE',
      detail:
        'Zoom is off while a device is emulated. Pass `reset: true` to leave device mode first, or leave `zoom` out.'
    }
  }
  return null
}

/** Any C0 control character or DEL: a user agent is one printable line. */
function hasControlChars(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    if (c < 0x20 || c === 0x7f) return true
  }
  return false
}

function inSize(n: number): boolean {
  return n >= DEVICE_MIN_SIZE && n <= DEVICE_MAX_SIZE
}

export function deviceFromPreset(name: DevicePresetName): DeviceSpec {
  const p = DEVICE_PRESETS[name]
  return {
    preset: name,
    width: p.width,
    height: p.height,
    dpr: p.dpr,
    mobile: p.mobile,
    rotated: false
  }
}

/**
 * Merge a CHECKED argument set into a record (it never mutates `current`). `reset` clears first, so the call can
 * also set something new. A free size drops the preset name: it is no longer that preset. `zoom` is not part of
 * the record (it lives with the page's origin).
 */
export function mergeEmulation(current: EmulationRecord, args: EmulateArgs): EmulationRecord {
  const rec: EmulationRecord = args.reset ? {} : { ...current }
  if (args.device !== undefined && isPresetName(args.device)) {
    rec.device = deviceFromPreset(args.device)
  } else if (hasSizeArgs(args)) {
    const base = rec.device
    rec.device = {
      preset: null,
      width: args.width ?? base?.width ?? DEVICE_MIN_SIZE,
      height: args.height ?? base?.height ?? DEVICE_MIN_SIZE,
      dpr: args.dpr ?? base?.dpr ?? 1,
      mobile: args.mobile ?? base?.mobile ?? false,
      rotated: false
    }
  }
  if (args.rotate === true && rec.device) {
    rec.device = {
      ...rec.device,
      width: rec.device.height,
      height: rec.device.width,
      rotated: !rec.device.rotated
    }
  }
  if (args.touch !== undefined) rec.touch = args.touch
  if (args.userAgent !== undefined) rec.userAgent = args.userAgent
  if (args.colorScheme !== undefined) rec.colorScheme = args.colorScheme
  if (args.reducedMotion !== undefined) rec.reducedMotion = args.reducedMotion
  return rec
}

/** `phone-m · 390×844 @3`, `1000×700 @1` for a free size; ` ↻` marks a rotated preset. */
export function describeDevice(device: DeviceSpec): string {
  const size = `${device.width}×${device.height} @${device.dpr}`
  const name = device.preset ?? 'custom'
  return `${name}${device.rotated ? ' (rotated)' : ''} · ${size}`
}

/** The kind of device, for the chip's icon. A free size is judged by its shape and the mobile flag. */
export function deviceKind(device: DeviceSpec): DeviceKind {
  if (device.preset) return DEVICE_PRESETS[device.preset].kind
  if (!device.mobile) return device.width >= 1600 ? 'desktop' : 'laptop'
  return Math.min(device.width, device.height) >= 600 ? 'tablet' : 'phone'
}

/* ------------------------------------------------------------------------------------------------ */
/* Fit scale                                                                                          */
/* ------------------------------------------------------------------------------------------------ */

/** The smallest fit scale; below it the pane scrolls instead of shrinking the device further. */
export const MIN_FIT_SCALE = 0.25

/**
 * The largest scale ≤ 1 at which a `device`-sized screen fits in `avail` (spec §9.2). Never below
 * {@link MIN_FIT_SCALE}; a zero or negative available size gives the minimum.
 */
export function fitScale(
  device: { width: number; height: number },
  avail: { width: number; height: number }
): number {
  if (!(device.width > 0) || !(device.height > 0)) return 1
  const k = Math.min(1, avail.width / device.width, avail.height / device.height)
  if (!Number.isFinite(k) || k <= 0) return MIN_FIT_SCALE
  return Math.max(MIN_FIT_SCALE, k)
}

/**
 * The factor between the page's CSS px and the view's own coordinates: the view shows a `device.width`-wide page in
 * `boundsWidth` of window space. Computed from the bounds main ACTUALLY set (already rounded), so the page scale
 * and the input scale can never disagree with what is on screen. `1` for a view that has no usable width.
 */
export function viewScale(deviceWidth: number, boundsWidth: number): number {
  if (!(deviceWidth > 0) || !(boundsWidth > 0)) return 1
  return boundsWidth / deviceWidth
}

/** "fit 66%" style percentage of a scale. */
export function fitPercent(scale: number): number {
  return Math.round(scale * 100)
}

/* ------------------------------------------------------------------------------------------------ */
/* User agent                                                                                         */
/* ------------------------------------------------------------------------------------------------ */

export interface UserAgentOverride {
  userAgent: string
  userAgentMetadata?: Record<string, unknown>
}

/** The Chrome major version in a user agent string, or `null`. */
export function chromeMajor(userAgent: string): number | null {
  const m = /Chrome\/(\d+)/.exec(userAgent)
  return m ? Number(m[1]) : null
}

/**
 * The user agent a mobile device presents: Chrome's reduced Android form (no model name: presets are classes), a
 * phone with `Mobile` and a tablet without it, with client-hint metadata that agrees (`Sec-CH-UA-Mobile`,
 * `Sec-CH-UA-Platform`), so a site that reads hints and one that reads the string see the same device.
 */
export function mobileUserAgent(major: number, kind: DeviceKind): UserAgentOverride {
  const m = Math.max(1, Math.trunc(major))
  const tabletTail = kind === 'tablet' ? '' : ' Mobile'
  return {
    userAgent: `Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${m}.0.0.0${tabletTail} Safari/537.36`,
    userAgentMetadata: {
      brands: [
        { brand: 'Chromium', version: String(m) },
        { brand: 'Not.A/Brand', version: '99' }
      ],
      fullVersionList: [
        { brand: 'Chromium', version: `${m}.0.0.0` },
        { brand: 'Not.A/Brand', version: '99.0.0.0' }
      ],
      platform: 'Android',
      platformVersion: '10.0.0',
      architecture: '',
      model: 'K',
      mobile: kind !== 'tablet'
    }
  }
}

/** What the host knows about the browser it runs, to rebuild its own client hints on a reset. */
export interface NativeHintsEnv {
  /** `process.versions.chrome`, e.g. `142.0.7444.265`. */
  chromeVersion: string
  /** `process.platform`. */
  platform: string
  /** `process.arch`. */
  arch: string
  /** `os.release()`. */
  osRelease: string
}

/**
 * Chromium's own brand list for its major version (its "GREASE" algorithm: a deliberately odd brand whose spelling,
 * version and place are seeded by the major version, so no site can hard-code the list). Matches what the guest sent
 * unmodified in the T572 delta-1 measurement: `"Not_A Brand";v="99", "Chromium";v="142"`.
 */
export function nativeBrands(major: number): Array<{ brand: string; version: string }> {
  const chars = [' ', '(', ':', '-', '.', '/', ')', ';', '=', '?', '_']
  const versions = ['8', '99', '24']
  const grease = {
    brand: `Not${chars[major % 11]}A${chars[(major + 1) % 11]}Brand`,
    version: versions[major % 3]!
  }
  const chromium = { brand: 'Chromium', version: String(major) }
  return major % 2 === 0 ? [grease, chromium] : [chromium, grease]
}

/**
 * The user agent and client hints the browser has on its own, as an explicit override. An override with no metadata
 * REMOVES the client hints (measured live: `brands: []` and no `Sec-CH-UA*` headers), and an empty `userAgent` does
 * not clear an override, so the only way back to what an untouched pane sends is to set the real values again.
 */
export function nativeUserAgentOverride(
  originalUserAgent: string,
  env: NativeHintsEnv
): UserAgentOverride {
  const major = chromeMajor(originalUserAgent) ?? (Number.parseInt(env.chromeVersion, 10) || 130)
  const platform =
    env.platform === 'darwin' ? 'macOS' : env.platform === 'win32' ? 'Windows' : 'Linux'
  const platformVersion =
    env.platform === 'win32' ? '10.0.0' : (/^\d+(\.\d+){0,2}/.exec(env.osRelease)?.[0] ?? '')
  const full = /^\d+(\.\d+){3}$/.test(env.chromeVersion) ? env.chromeVersion : `${major}.0.0.0`
  return {
    userAgent: originalUserAgent,
    userAgentMetadata: {
      brands: nativeBrands(major),
      fullVersionList: nativeBrands(major).map((b) => ({
        brand: b.brand,
        version: b.brand === 'Chromium' ? full : `${b.version}.0.0.0`
      })),
      platform,
      platformVersion,
      architecture: env.arch === 'arm64' || env.arch === 'arm' ? 'arm' : 'x86',
      bitness: env.arch === 'ia32' || env.arch === 'arm' ? '32' : '64',
      model: '',
      mobile: false,
      wow64: false
    }
  }
}

/**
 * The user agent the record asks for: the explicit one, else a mobile device's own, else `null` (the page's
 * original, which {@link emulationCommands} restores explicitly because clearing the metrics override does not).
 */
export function userAgentFor(
  rec: EmulationRecord,
  originalUserAgent: string
): UserAgentOverride | null {
  if (rec.userAgent !== undefined) return { userAgent: rec.userAgent }
  if (rec.device?.mobile) {
    const major = chromeMajor(originalUserAgent) ?? 130
    return mobileUserAgent(major, deviceKind(rec.device))
  }
  return null
}

/* ------------------------------------------------------------------------------------------------ */
/* CDP commands                                                                                       */
/* ------------------------------------------------------------------------------------------------ */

export interface CdpCommand {
  method: string
  params: Record<string, unknown>
}

/** `Emulation.setDeviceMetricsOverride` (or the clear) for a device at `scale`. */
export function metricsCommand(device: DeviceSpec | undefined, scale: number): CdpCommand {
  if (!device) return { method: 'Emulation.clearDeviceMetricsOverride', params: {} }
  const landscape = device.width > device.height
  return {
    method: 'Emulation.setDeviceMetricsOverride',
    params: {
      width: device.width,
      height: device.height,
      deviceScaleFactor: device.dpr,
      mobile: device.mobile,
      scale,
      screenWidth: device.width,
      screenHeight: device.height,
      ...(device.mobile
        ? {
            screenOrientation: landscape
              ? { type: 'landscapePrimary', angle: 90 }
              : { type: 'portraitPrimary', angle: 0 }
          }
        : {})
    }
  }
}

/**
 * The commands that make the page see touch, the user agent and the media features of the record. These are the
 * parts that must be on BEFORE the page's scripts run (touch is only visible to `'ontouchstart' in window` if it
 * was on at load, spec §9.2 correction 4), so the host sends them at `did-start-navigation`. Every call sets all of
 * them, so a removed setting is explicitly cleared and a reset restores the original user agent.
 */
export function sessionCommands(
  rec: EmulationRecord,
  originalUserAgent: string,
  prior: SessionState = { dirty: true },
  native?: NativeHintsEnv
): CdpCommand[] {
  // A pane that was never emulated gets NOTHING: not a restore of a user agent nobody changed, not a "touch off".
  if (isEmptyRecord(rec) && !prior.dirty) return []
  const touch = effectiveTouch(rec)
  const ua = userAgentFor(rec, originalUserAgent)
  return [
    {
      method: 'Emulation.setTouchEmulationEnabled',
      params: touch ? { enabled: true, maxTouchPoints: 5 } : { enabled: false }
    },
    {
      method: 'Emulation.setEmitTouchEventsForMouse',
      params: touch
        ? { enabled: true, configuration: rec.device && !rec.device.mobile ? 'desktop' : 'mobile' }
        : { enabled: false }
    },
    {
      method: 'Emulation.setUserAgentOverride',
      // No user agent asked for: put the real one back, with its real client hints when the host can say what they are.
      params: ua
        ? { ...ua }
        : native
          ? { ...nativeUserAgentOverride(originalUserAgent, native) }
          : { userAgent: originalUserAgent }
    },
    {
      method: 'Emulation.setEmulatedMedia',
      params: {
        features: [
          { name: 'prefers-color-scheme', value: rec.colorScheme ?? '' },
          { name: 'prefers-reduced-motion', value: rec.reducedMotion === true ? 'reduce' : '' }
        ]
      }
    }
  ]
}

/**
 * Whether Harnu has put anything on the page yet (T572 delta 1, measured live: the guest sends no client hints at all
 * before any emulation and the same nothing after a reset, so a restore on a never-emulated pane has nothing to
 * restore). `dirty` is true once a non-empty record was sent; the next empty record then sends the clearing set once.
 */
export interface SessionState {
  dirty: boolean
}

/** The state after `rec` was sent. */
export function nextSessionState(rec: EmulationRecord): SessionState {
  return { dirty: !isEmptyRecord(rec) }
}

/** The caption under the device frame (design.md "Device frame"): the segments that apply, in a fixed order. */
export function deviceCaption(rec: EmulationRecord, scale: number): string {
  const parts: string[] = []
  if (rec.device) parts.push(`fit ${fitPercent(scale)}%`)
  if (effectiveTouch(rec)) parts.push('touch on')
  if (rec.userAgent !== undefined) parts.push('custom UA')
  else if (rec.device?.mobile) parts.push('mobile UA')
  if (rec.colorScheme) parts.push(`prefers-color-scheme: ${rec.colorScheme}`)
  if (rec.reducedMotion === true) parts.push('prefers-reduced-motion: reduce')
  return parts.join(' · ')
}

/** Whether turning `next` on for a page that already loaded needs a reload: touch only counts if on at load. */
export function needsReloadFor(
  prev: EmulationRecord | undefined,
  next: EmulationRecord | undefined
): boolean {
  return !effectiveTouch(prev) && effectiveTouch(next)
}

/** The `emulation` summary `browser_list` and the ACK carry. */
export interface EmulationSummary {
  device: string | null
  width: number | null
  height: number | null
  dpr: number | null
  mobile: boolean | null
  touch: boolean
  userAgent: string | null
  colorScheme: 'light' | 'dark' | null
  reducedMotion: boolean
}

export function summarizeEmulation(rec: EmulationRecord | undefined): EmulationSummary {
  const d = rec?.device
  return {
    device: d ? (d.preset ?? 'custom') : null,
    width: d?.width ?? null,
    height: d?.height ?? null,
    dpr: d?.dpr ?? null,
    mobile: d?.mobile ?? null,
    touch: effectiveTouch(rec),
    userAgent: rec?.userAgent ?? null,
    colorScheme: rec?.colorScheme ?? null,
    reducedMotion: rec?.reducedMotion === true
  }
}
