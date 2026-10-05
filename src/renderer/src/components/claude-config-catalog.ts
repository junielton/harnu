/**
 * Hand-curated catalog of known `~/.claude/settings.json` options (issue #16,
 * Phase 1). Claude Code publishes no machine-readable schema, and keys the user
 * never set simply aren't present in the file — so the GUI can't introspect what
 * to show. This list is the source of truth for which options render as typed
 * controls; everything NOT here still survives on disk (the patch layer only
 * touches changed keys) and shows up read-only in the Advanced/raw block.
 *
 * Keep this conservative and accurate: a missing entry degrades to "less pretty"
 * (raw block), never "lost setting". Grow it over time. `path` is the dot-path
 * key as it appears in settings.json; `default` is the documented default used to
 * render the "Set vs. default" marker (not written to disk).
 */

export type ControlType = 'toggle' | 'select' | 'number' | 'text' | 'tags'

export interface SelectOption {
  value: string
  /** i18n key for the option label; falls back to the raw value when absent. */
  labelKey?: string
}

export interface SettingDef {
  /** dot-path key in settings.json (e.g. `permissions.defaultMode`). */
  path: string
  /** Section grouping — drives the eyebrow the row renders under. */
  group: SettingGroup
  type: ControlType
  labelKey: string
  descKey: string
  /** Documented default (rendered as the "Default" hint; never written). */
  default?: unknown
  /** Docs deep-link (opened externally). */
  docs?: string
  /** Options for `select`. */
  options?: SelectOption[]
  /** Bounds for `number`. */
  min?: number
  max?: number
}

export type SettingGroup = 'general' | 'permissions' | 'interface'

export const SETTING_GROUPS: SettingGroup[] = ['general', 'permissions', 'interface']

const DOCS = 'https://docs.claude.com/en/docs/claude-code/settings'

export const SETTINGS_CATALOG: SettingDef[] = [
  {
    path: 'model',
    group: 'general',
    type: 'text',
    labelKey: 'claudeConfig.fields.model.label',
    descKey: 'claudeConfig.fields.model.desc',
    docs: DOCS
  },
  {
    path: 'cleanupPeriodDays',
    group: 'general',
    type: 'number',
    labelKey: 'claudeConfig.fields.cleanupPeriodDays.label',
    descKey: 'claudeConfig.fields.cleanupPeriodDays.desc',
    default: 30,
    min: 1,
    max: 3650,
    docs: DOCS
  },
  {
    path: 'includeCoAuthoredBy',
    group: 'general',
    type: 'toggle',
    labelKey: 'claudeConfig.fields.includeCoAuthoredBy.label',
    descKey: 'claudeConfig.fields.includeCoAuthoredBy.desc',
    default: true,
    docs: DOCS
  },
  {
    path: 'permissions.defaultMode',
    group: 'permissions',
    type: 'select',
    labelKey: 'claudeConfig.fields.defaultMode.label',
    descKey: 'claudeConfig.fields.defaultMode.desc',
    default: 'default',
    options: [
      { value: 'default', labelKey: 'claudeConfig.fields.defaultMode.optDefault' },
      { value: 'acceptEdits', labelKey: 'claudeConfig.fields.defaultMode.optAcceptEdits' },
      { value: 'plan', labelKey: 'claudeConfig.fields.defaultMode.optPlan' },
      { value: 'dontAsk', labelKey: 'claudeConfig.fields.defaultMode.optDontAsk' }
    ],
    docs: DOCS
  },
  {
    path: 'tui',
    group: 'interface',
    type: 'select',
    labelKey: 'claudeConfig.fields.tui.label',
    descKey: 'claudeConfig.fields.tui.desc',
    default: 'default',
    options: [
      { value: 'default', labelKey: 'claudeConfig.fields.tui.optDefault' },
      { value: 'fullscreen', labelKey: 'claudeConfig.fields.tui.optFullscreen' }
    ],
    docs: DOCS
  }
]

/** Top-level keys the catalog or Harnu itself owns — excluded from the raw/unknown
 *  block. `hooks`/`statusLine` are managed by their installers (rendered read-only,
 *  never editable here); the rest are covered by catalog controls.
 *
 *  Only **whole-object coverage** excludes a key: a top-level catalog entry
 *  (e.g. `model`, `tui`) means the control fully represents that key. A *nested*
 *  entry (e.g. `permissions.defaultMode`) covers ONE field of an object that may
 *  hold other on-disk keys (`permissions.allow`/`deny`/`ask`) the catalog has no
 *  control for — so its top-level key is NOT excluded, and the whole object still
 *  surfaces read-only in the Advanced block. Otherwise those sibling keys would
 *  be invisible in the UI ("lost setting"), which the drift safety valve (spec
 *  §11) exists to prevent. */
export function knownTopLevelKeys(): Set<string> {
  const keys = new Set<string>([
    'hooks',
    'statusLine',
    'statusLine_harnu',
    // Legacy backup keys (pre-rename): still recognized so an old install's keys are listed.
    'statusLine_capy',
    'statusLine_om2tab'
  ])
  for (const def of SETTINGS_CATALOG) {
    if (!def.path.includes('.')) keys.add(def.path)
  }
  return keys
}

/** Every full dot-path the catalog renders a control for. Used to decide whether
 *  an on-disk object is *fully* covered by controls (and can be hidden from the
 *  raw block) or still holds uncovered sub-keys that must surface read-only. */
export function catalogPaths(): Set<string> {
  return new Set(SETTINGS_CATALOG.map((d) => d.path))
}

/** Read a dot-path value out of a settings object (undefined if absent). */
export function getAtPath(obj: Record<string, unknown>, dotPath: string): unknown {
  const keys = dotPath.split('.')
  let node: unknown = obj
  for (const k of keys) {
    if (!node || typeof node !== 'object' || Array.isArray(node)) return undefined
    node = (node as Record<string, unknown>)[k]
  }
  return node
}
