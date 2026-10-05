/**
 * Pure helpers for the Containers takeover (T331, design.md "Containers takeover").
 *
 * The view never derives a verdict — the main process does (PRD §5). What lives
 * here is presentation only: which section a verdict renders in, what each
 * verdict offers as actions (PRD §3.4), sizes and durations, the meter, and the
 * Recent labels. Framework-free so every rule is unit-tested without a mount.
 */
import type {
  ContainerRow,
  ContainersSnapshot,
  ContainersTombstone,
  ContainersVerdict,
  StackRow
} from '../../../preload'

type Verdict = ContainersVerdict

export const DAY_MS = 86_400_000
const HOUR_MS = 3_600_000
const MINUTE_MS = 60_000

/** Verdicts listed under "Needs you" — mirrors `NEEDS_YOU_VERDICTS` in containers-wire.ts. */
export const NEEDS_YOU: readonly Verdict[] = ['zombie', 'orphan']

export function isNeedsYou(verdict: Verdict): boolean {
  return NEEDS_YOU.includes(verdict)
}

// ---- sizes ----------------------------------------------------------------------

/** RAM as the spec prints it: "831 MB", "1.7 GB", "0 B". Decimal units, like docker. */
export function formatRam(bytes: number): string {
  const abs = Math.abs(bytes)
  if (abs >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`
  if (abs >= 1e6) return `${Math.round(bytes / 1e6)} MB`
  if (abs >= 1e3) return `${Math.round(bytes / 1e3)} KB`
  return `${Math.round(bytes)} B`
}

/** Disk as the spec prints it: "249.2 MB", "1.4 GB", "0 B". */
export function formatDisk(bytes: number): string {
  const abs = Math.abs(bytes)
  if (abs >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`
  if (abs >= 1e6) return `${(bytes / 1e6).toFixed(1)} MB`
  if (abs >= 1e3) return `${Math.round(bytes / 1e3)} KB`
  return `${Math.round(bytes)} B`
}

/** An anonymous docker volume is named by a 64-hex id; the spec prints "anonymous". */
export function isAnonymousVolume(name: string): boolean {
  return /^[0-9a-f]{64}$/.test(name)
}

/** `/home/<user>/…` and `/Users/<user>/…` read as `~/…`; anything else is untouched. */
export function displayPath(p: string): string {
  return p.replace(/^\/(?:home|Users)\/[^/]+(?=\/|$)/, '~')
}

// ---- durations --------------------------------------------------------------------

export type DurationUnit = 'minutes' | 'hours' | 'days'

/** A duration as one whole unit, rounded down ("2 days", "5 hours", "4 minutes"). */
export function durationParts(ms: number): { unit: DurationUnit; n: number } {
  const safe = Math.max(0, ms)
  if (safe >= DAY_MS) return { unit: 'days', n: Math.floor(safe / DAY_MS) }
  if (safe >= HOUR_MS) return { unit: 'hours', n: Math.floor(safe / HOUR_MS) }
  return { unit: 'minutes', n: Math.max(1, Math.floor(safe / MINUTE_MS)) }
}

/** An elapsed time, or `justNow` under a minute. */
export function agoParts(ms: number): { unit: DurationUnit | 'justNow'; n: number } {
  if (ms < MINUTE_MS) return { unit: 'justNow', n: 0 }
  return durationParts(ms)
}

/** Whole days until a pending stack turns zombie, never below 1 ("zombie in 1d"). */
export function zombieInDays(zombieInMs: number | null): number {
  if (zombieInMs === null) return 1
  return Math.max(1, Math.ceil(zombieInMs / DAY_MS))
}

/** "2026-09-10 14:02", local time. */
export function formatStamp(ms: number): string {
  const d = new Date(ms)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

// ---- stack facts ------------------------------------------------------------------

/** The latest FinishedAt among the stack's containers, or null. */
export function lastExitedAt(stack: Pick<StackRow, 'containers'>): number | null {
  const times = stack.containers.map((c) => c.finishedAt).filter((t): t is number => t !== null)
  return times.length > 0 ? Math.max(...times) : null
}

/** The latest StartedAt among the stack's running containers, or null. */
export function runningSince(stack: Pick<StackRow, 'containers'>): number | null {
  const times = stack.containers
    .filter((c) => c.running)
    .map((c) => c.startedAt)
    .filter((t): t is number => t !== null)
  return times.length > 0 ? Math.max(...times) : null
}

/** Worktree-shaped attributions ("Worktree", "Open worktree") vs a folder ("Folder", "Open folder"). */
export function isWorktreeAttribution(stack: Pick<StackRow, 'attribution'>): boolean {
  const kind = stack.attribution.folderKind
  return kind === 'worktree' || kind === 'gone'
}

/** Which title icon a stack carries (design.md "Detail pane"). */
export type StackIcon = 'box' | 'container' | 'ghost' | 'shield' | 'help'

export function stackIcon(stack: Pick<StackRow, 'verdict' | 'kind'>): StackIcon {
  if (stack.verdict === 'unknown') return 'help'
  if (stack.verdict === 'orphan') return 'ghost'
  if (stack.verdict === 'protected') return 'shield'
  return stack.kind === 'container' ? 'container' : 'box'
}

/** Tailwind classes for a verdict chip (Cleanup's chip anatomy). */
export function chipToneClass(verdict: Verdict): string {
  switch (verdict) {
    case 'zombie':
      return 'bg-green-soft text-green'
    case 'orphan':
      return 'bg-warning-soft text-warning'
    case 'active':
      return 'bg-accent-soft text-accent'
    default:
      return 'bg-surface-2 text-text-3'
  }
}

// ---- actions (PRD §3.4) ----------------------------------------------------------

export type TierAction = 'stop' | 'start' | 'remove'
export type TierVariant = 'primary' | 'default' | 'danger'

export interface Tier {
  action: TierAction
  variant: TierVariant
  /** Rendered disabled (only Remove on a running stack). */
  disabled: boolean
  /** `containers.tier.caption.*` key. */
  caption:
    'reversible' | 'stopFirst' | 'backAsItWas' | 'asksFirst' | 'asksFirstNoVolume' | 'appGoesDown'
  captionTone: 'quiet' | 'warn'
  /** Sent with a manual stop: main refuses active/protected without it. */
  force: boolean
}

/** True when the stack holds a volume a removal could take (non-shared). */
export function hasRemovableVolume(stack: Pick<StackRow, 'volumes'>): boolean {
  return stack.volumes.some((v) => !v.shared)
}

/**
 * Exactly what each verdict offers, in tier order (design.md "Tiers" table).
 * One Remove, and only a stopped zombie or orphan enables it.
 */
export function tiersFor(stack: Pick<StackRow, 'verdict' | 'running' | 'volumes'>): Tier[] {
  const removeCaption = hasRemovableVolume(stack) ? 'asksFirst' : 'asksFirstNoVolume'
  const stop = (variant: TierVariant, force: boolean, warn = false): Tier => ({
    action: 'stop',
    variant,
    disabled: false,
    caption: warn ? 'appGoesDown' : 'reversible',
    captionTone: warn ? 'warn' : 'quiet',
    force
  })
  const start: Tier = {
    action: 'start',
    variant: 'default',
    disabled: false,
    caption: 'backAsItWas',
    captionTone: 'quiet',
    force: false
  }
  const removeDisabled: Tier = {
    action: 'remove',
    variant: 'danger',
    disabled: true,
    caption: 'stopFirst',
    captionTone: 'quiet',
    force: false
  }
  const remove: Tier = { ...removeDisabled, disabled: false, caption: removeCaption }

  switch (stack.verdict) {
    case 'unknown':
      return []
    case 'zombie':
      return stack.running ? [stop('primary', false), removeDisabled] : [start, remove]
    case 'orphan':
      // Start is refused on an orphan (WORKTREE_GONE): the code it ran from is gone.
      return stack.running ? [stop('primary', false), removeDisabled] : [remove]
    case 'active':
      return stack.running ? [stop('default', true, true)] : [start]
    case 'protected':
      return stack.running ? [stop('default', true)] : [start]
    case 'pending':
      return stack.running ? [stop('default', false)] : [start]
  }
}

/** A running "Needs you" row carries the hover quick-stop. */
export function hasQuickStop(stack: Pick<StackRow, 'verdict' | 'running'>): boolean {
  return stack.running && isNeedsYou(stack.verdict)
}

// ---- the sweep (T341) ----------------------------------------------------------------

/**
 * True when a sweep may take this stack — mirrors `refusalFor('sweep', …)` in
 * `containers-actions.ts`: every zombie and orphan, running or exited, and
 * nothing else. `active`, `protected`, `pending` and `unknown` are refused
 * there, so the button never offers them. Presentation only: main picks the
 * real set and refuses anything its tiers forbid (PRD §7.4).
 */
export function isSweepable(stack: Pick<StackRow, 'verdict'>): boolean {
  return isNeedsYou(stack.verdict)
}

export function sweepTargets<T extends Pick<StackRow, 'verdict'>>(stacks: readonly T[]): T[] {
  return stacks.filter(isSweepable)
}

// ---- the selection (T342) ------------------------------------------------------------

/**
 * Which eligible stacks the operator left ticked.
 *
 * `null` is the pristine state — "every eligible stack", which is what the view
 * opens with and what keeps the one-click clean-up exactly as it was. Once the
 * operator unticks anything it becomes the explicit list of ids they kept, so a
 * stack that appears in a later scan arrives UNTICKED (a destructive action fails
 * safe). "Select all" returns to `null`, which re-arms that behaviour.
 */
export type SweepSelection = string[] | null

/** The ticked stacks, in snapshot order; ids that are gone or ineligible drop out. */
export function tickedStacks<T extends Pick<StackRow, 'id' | 'verdict'>>(
  stacks: readonly T[],
  selection: SweepSelection
): T[] {
  const eligible = sweepTargets(stacks)
  if (selection === null) return eligible
  const keep = new Set(selection)
  return eligible.filter((s) => keep.has(s.id))
}

export function isTicked(
  stacks: readonly Pick<StackRow, 'id' | 'verdict'>[],
  selection: SweepSelection,
  id: string
): boolean {
  return selection === null ? sweepTargets(stacks).some((s) => s.id === id) : selection.includes(id)
}

/**
 * Tick or untick one stack. Unticking from the pristine state materialises the
 * selection — from then on it is an explicit list, and an id it never named is
 * unticked, however it got into the snapshot.
 */
export function toggleTicked(
  stacks: readonly Pick<StackRow, 'id' | 'verdict'>[],
  selection: SweepSelection,
  id: string
): SweepSelection {
  const eligible = sweepTargets(stacks).map((s) => s.id)
  if (!eligible.includes(id)) return selection
  const current = selection === null ? eligible : selection.filter((x) => eligible.includes(x))
  return current.includes(id) ? current.filter((x) => x !== id) : [...current, id]
}

/** The header control's three states: everything, nothing, or some of it. */
export type SweepSelectionState = 'all' | 'none' | 'mixed'

export function sweepSelectionState(
  stacks: readonly Pick<StackRow, 'id' | 'verdict'>[],
  selection: SweepSelection
): SweepSelectionState {
  const total = sweepTargets(stacks).length
  const ticked = tickedStacks(stacks, selection).length
  if (ticked === 0) return 'none'
  return ticked === total ? 'all' : 'mixed'
}

/**
 * The header control: everything ticked clears the selection, anything else
 * ticks everything — and goes back to pristine, so later arrivals are ticked
 * again (the untouched one-click flow).
 */
export function toggleAllTicked(
  stacks: readonly Pick<StackRow, 'id' | 'verdict'>[],
  selection: SweepSelection
): SweepSelection {
  return sweepSelectionState(stacks, selection) === 'all' ? [] : null
}

/**
 * Drop ids the latest scan no longer lists as eligible. A stack that vanishes is
 * forgotten rather than remembered, so one that comes back later arrives
 * unticked like any other new stack — the same fail-safe.
 */
export function pruneSelection(
  stacks: readonly Pick<StackRow, 'id' | 'verdict'>[],
  selection: SweepSelection
): SweepSelection {
  if (selection === null) return null
  const eligible = new Set(sweepTargets(stacks).map((s) => s.id))
  const kept = selection.filter((id) => eligible.has(id))
  return kept.length === selection.length ? selection : kept
}

/** One swept stack, as the dialog lists it. */
export interface SweepStack {
  id: string
  name: string
  containers: number
}

/** What a sweep would take, aggregated across every eligible stack. */
export interface SweepPlan {
  stacks: SweepStack[]
  /** Total containers the sweep removes — the confirm button's number. */
  containers: number
  /** Volumes the sweep can take, deduplicated across stacks. */
  volumes: string[]
  /** Their total size, or null when any one of them has no size. */
  volumeBytes: number | null
  /** Volumes left in place because something outside the sweep still mounts them. */
  keptVolumes: string[]
}

/**
 * The dialog's disclosure, in snapshot order.
 *
 * A volume is removable when nothing outside the sweep mounts it, which is the
 * rule main applies after every container is gone (`planSweepVolumes`, T340): a
 * non-shared volume always, a shared one only when at least two stacks mount it
 * and every one of them is itself swept. A shared volume with a single owner is
 * kept, because docker flags it shared for a reason the snapshot cannot
 * attribute — it is treated as another compose project's. Anything else is kept
 * and named. Each volume is counted once however many swept stacks mount it.
 *
 * `selection` (T342) narrows the swept set, so an eligible stack the operator
 * unticked is a SURVIVOR here — a volume it shares with a ticked stack is kept
 * and named, exactly like one an `active` stack still mounts. `null` means every
 * eligible stack, which is the plan this function always produced.
 */
export function sweepPlan(
  stacks: readonly StackRow[],
  selection: SweepSelection = null
): SweepPlan {
  const targets = tickedStacks(stacks, selection)
  const swept = new Set(targets.map((s) => s.id))
  const owners = new Map<string, Set<string>>()
  for (const s of stacks) {
    for (const v of s.volumes) {
      const set = owners.get(v.name) ?? new Set<string>()
      set.add(s.id)
      owners.set(v.name, set)
    }
  }
  const volumes: string[] = []
  const keptVolumes: string[] = []
  const seen = new Set<string>()
  let bytes = 0
  let unknownSize = false
  for (const s of targets) {
    for (const v of s.volumes) {
      if (seen.has(v.name)) continue
      seen.add(v.name)
      const own = owners.get(v.name) ?? new Set([s.id])
      const removable = v.shared ? own.size > 1 && [...own].every((id) => swept.has(id)) : true
      if (!removable) {
        keptVolumes.push(v.name)
        continue
      }
      volumes.push(v.name)
      if (v.sizeBytes === null) unknownSize = true
      else bytes += v.sizeBytes
    }
  }
  return {
    stacks: targets.map((s) => ({ id: s.id, name: s.name, containers: s.containers.length })),
    containers: targets.reduce((sum, s) => sum + s.containers.length, 0),
    volumes,
    volumeBytes: unknownSize ? null : bytes,
    keptVolumes
  }
}

/**
 * "Cleaning… N of M": M is the stacks the sweep targeted, N how many of those
 * the latest scan no longer reports at all — a swept stack is gone, not
 * stopped, so its absence is the progress.
 */
export function sweepProgress(
  targets: readonly string[],
  stacks: readonly Pick<StackRow, 'id'>[]
): { done: number; total: number } {
  const present = new Set(stacks.map((s) => s.id))
  return { done: targets.filter((id) => !present.has(id)).length, total: targets.length }
}

/**
 * "Stopping… N of M": M is the stack's running containers when the action
 * began, N how many of those the latest scan no longer reports running.
 */
export function stopProgress(
  baseline: readonly string[],
  containers: readonly Pick<ContainerRow, 'id' | 'running'>[]
): { done: number; total: number } {
  const stillRunning = new Set(containers.filter((c) => c.running).map((c) => c.id))
  const done = baseline.filter((id) => !stillRunning.has(id)).length
  return { done, total: baseline.length }
}

/**
 * Stopped by Harnu — the master row reads "stopped", not "—". True only when the
 * MOST RECENT tombstone naming this stack (`recent` is newest first) is a stop;
 * an older stop tombstone doesn't count once a later start (or anything else)
 * for the same stack supersedes it, so a stack Harnu restarted and someone then
 * stopped outside Harnu correctly reads "—", not "stopped".
 */
export function stoppedByHarnu(
  stack: Pick<StackRow, 'id' | 'running'>,
  recent: readonly ContainersTombstone[]
): boolean {
  if (stack.running) return false
  const last = recent.find((t) => t.stacks.some((s) => s.stack === stack.id))
  return last?.verb === 'stop'
}

// ---- the meter ----------------------------------------------------------------------

export type MeterTone = 'zombie' | 'active' | 'muted' | 'unknown'

export function meterTone(verdict: Verdict): MeterTone {
  if (verdict === 'zombie' || verdict === 'orphan') return 'zombie'
  if (verdict === 'active') return 'active'
  if (verdict === 'unknown') return 'unknown'
  return 'muted' // protected, pending
}

export const METER_TONE_CLASS: Record<MeterTone, string> = {
  zombie: 'bg-green',
  active: 'bg-accent',
  muted: 'bg-text-4',
  unknown: 'bg-border-2'
}

/** One segment per running stack with RAM, in snapshot order, widths in percent. */
export function meterSegments(
  stacks: readonly Pick<StackRow, 'id' | 'verdict' | 'running' | 'ramBytes'>[]
): Array<{ id: string; tone: MeterTone; pct: number }> {
  const holding = stacks.filter((s) => s.running && s.ramBytes > 0)
  const total = holding.reduce((sum, s) => sum + s.ramBytes, 0)
  if (total <= 0) return []
  return holding.map((s) => ({
    id: s.id,
    tone: meterTone(s.verdict),
    pct: Math.round((s.ramBytes / total) * 1000) / 10
  }))
}

export type LegendKey = 'zombie' | 'active' | 'protected' | 'pending' | 'unknown'

/** The legend's non-empty buckets, in the spec's order. */
export function meterLegend(
  ramByVerdict: Record<Verdict, number>
): Array<{ key: LegendKey; tone: MeterTone; bytes: number }> {
  const rows: Array<{ key: LegendKey; tone: MeterTone; bytes: number }> = [
    { key: 'zombie', tone: 'zombie', bytes: ramByVerdict.zombie + ramByVerdict.orphan },
    { key: 'active', tone: 'active', bytes: ramByVerdict.active },
    { key: 'protected', tone: 'muted', bytes: ramByVerdict.protected },
    { key: 'pending', tone: 'muted', bytes: ramByVerdict.pending },
    { key: 'unknown', tone: 'unknown', bytes: ramByVerdict.unknown }
  ]
  return rows.filter((r) => r.bytes > 0)
}

// ---- Recent (tombstones) --------------------------------------------------------------

/** A stable key for a tombstone: its time plus the stacks it touched. */
export function tombstoneKey(t: Pick<ContainersTombstone, 'at' | 'stacks'>): string {
  return `${t.at}:${t.stacks.map((s) => s.stack).join(',')}`
}

export function containerCount(t: Pick<ContainersTombstone, 'stacks'>): number {
  return t.stacks.reduce((sum, s) => sum + s.containerIds.length, 0)
}

export function freedRam(t: Pick<ContainersTombstone, 'stacks'>): number {
  return t.stacks.reduce((sum, s) => sum + s.freed.ramBytes, 0)
}

export function freedPorts(t: Pick<ContainersTombstone, 'stacks'>): number {
  return new Set(t.stacks.flatMap((s) => s.freed.ports)).size
}

export function removedVolumes(t: Pick<ContainersTombstone, 'stacks'>): string[] {
  return t.stacks.flatMap((s) => s.freed.volumes)
}

/** A volume a removal left in place, as the journal records it. */
export interface KeptVolume {
  name: string
  /** Known only when its stack kept exactly one volume: the journal records the sum. */
  sizeBytes: number | null
}

/** The volumes a removal kept, straight from the tombstone (`TombstoneStack.keptVolumes`). */
export function keptVolumesOf(t: Pick<ContainersTombstone, 'stacks'>): KeptVolume[] {
  return t.stacks.flatMap((s) => {
    const names = s.keptVolumes ?? []
    return names.map((name) => ({
      name,
      sizeBytes: names.length === 1 ? (s.keptVolumeBytes ?? null) : null
    }))
  })
}

/**
 * The verb text a Recent row carries: `stopped` / `started` / `removed`, or
 * `removedVolumeKept` / `removedVolumeRemoved` when the tombstone records the
 * removal's volume fate. A journal line written before `keptVolumes` existed
 * reads as plain `removed`.
 */
export function recentVerbKey(
  t: Pick<ContainersTombstone, 'verb' | 'stacks'>
): 'stopped' | 'started' | 'removed' | 'removedVolumeKept' | 'removedVolumeRemoved' {
  if (t.verb === 'stop') return 'stopped'
  if (t.verb === 'start') return 'started'
  if (removedVolumes(t).length > 0) return 'removedVolumeRemoved'
  if (keptVolumesOf(t).length > 0) return 'removedVolumeKept'
  return 'removed'
}

// ---- buttons (Cleanup toolbar button anatomy) -------------------------------------------

export type BtnVariant = 'default' | 'primary' | 'danger' | 'ghost'

const BTN_VARIANT: Record<BtnVariant, string> = {
  default: 'border-border-2 bg-surface text-text-2 hover:bg-surface-2',
  primary: 'border-green-line bg-green-soft text-green',
  danger: 'border-red-line bg-red-soft text-red',
  ghost: 'border-transparent bg-transparent text-text-2'
}

/**
 * `.btn` (12px, 6px 12px) and `.btn.sm` (11px, 3px 9px) from the spec, per variant.
 *
 * T345 migrated `ContainersView.vue`'s own toolbar buttons to `ui/Button.vue`
 * (design.md §6 "Buttons"), but this helper stays: `ContainersDetail.vue`,
 * `ContainersSweepDialog.vue` and `ContainersRemoveDialog.vue` still call it, and
 * those detail/dialog surfaces were out of T345's scope (header/toolbar buttons
 * only). Its `sm` size and `ghost` treatment also have no equivalent on
 * `ui/Button.vue` yet — migrating the remaining call sites is a follow-up, not a
 * duplicate left behind by accident.
 */
export function btnClass(variant: BtnVariant, size: 'md' | 'sm' = 'md'): string {
  const box =
    size === 'sm' ? 'gap-[5px] px-[9px] py-[3px] text-[11px]' : 'gap-1.5 px-3 py-1.5 text-[12px]'
  return `inline-flex items-center whitespace-nowrap rounded-sm border font-medium cursor-pointer transition disabled:cursor-not-allowed disabled:opacity-50 ${box} ${BTN_VARIANT[variant]}`
}

/** The spec's 22px `.icon-btn`. */
export const ICON_BTN_CLASS =
  'flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-sm border border-border-2 bg-surface p-0 text-text-2 transition hover:bg-surface-2 hover:text-text cursor-pointer'

// ---- selection --------------------------------------------------------------------

export type Selection = { kind: 'stack'; id: string } | { kind: 'recent'; key: string }

/**
 * Keeps the operator's selection across rescans: the same stack or tombstone
 * while it still exists, otherwise the first "Needs you" row, then the first row
 * of all, then nothing.
 */
export function resolveSelection(
  current: Selection | null,
  snap: ContainersSnapshot | null
): Selection | null {
  if (!snap || !snap.dockerAvailable) return null
  if (current?.kind === 'stack' && snap.stacks.some((s) => s.id === current.id)) return current
  if (current?.kind === 'recent' && snap.recent.some((t) => tombstoneKey(t) === current.key)) {
    return current
  }
  const first = snap.stacks.find((s) => isNeedsYou(s.verdict)) ?? snap.stacks[0]
  if (first) return { kind: 'stack', id: first.id }
  const tomb = snap.recent[0]
  return tomb ? { kind: 'recent', key: tombstoneKey(tomb) } : null
}
