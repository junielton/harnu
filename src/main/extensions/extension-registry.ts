/**
 * Extension registry fold (T137 — Extension SDK Phase 1).
 *
 * Mirrors `detect/manifest-registry.ts`'s builtins-then-overrides fold, except
 * extensions have no builtin tier to layer over — every entry is user-installed
 * content. {@link buildExtensionRegistry} takes the raw scan result (one entry
 * per `~/.claude/capy-extensions/<id>/` folder) and folds it into the flat
 * lists each consuming surface reads: the combined theme list (for the theme
 * store) and a `kind → absolute template path` map (for `loadBoardTemplate`).
 *
 * Pure (no fs) — the shell (`extensions-loader.ts`) does the directory read +
 * `JSON.parse` and hands the raw scan result here.
 */

import { join } from 'node:path'
import type { CardKind } from '../roadmap-core'
import {
  parseBoardTemplateContributions,
  parseExtensionManifest,
  parseModeContributions,
  parseThemeContributions,
  type ExtensionTheme
} from './extension-manifest-core'

/** One `~/.claude/capy-extensions/<id>/` folder as read off disk. */
export interface ScannedExtension {
  /** The folder name — the extension's canonical id. */
  id: string
  /** Absolute path to the extension's folder (board template paths resolve against it). */
  dirPath: string
  /** `JSON.parse`d `manifest.json`, or `undefined` if it was missing/unreadable/invalid JSON. */
  raw: unknown
}

/** A resolved board-template override: which extension contributed it, and where to read it from. */
export interface BoardTemplateOverride {
  extensionId: string
  absolutePath: string
}

/** A validated `contributes.modes` entry with its doc path resolved to absolute (T138). */
export interface ResolvedExtensionMode {
  id: string
  rawId: string
  extensionId: string
  extensionLabel: string
  label: string
  icon: string
  /** Absolute path to the contract .md file — read fresh at spawn time, never cached. */
  docPath: string
}

export interface ExtensionRegistry {
  themes: readonly ExtensionTheme[]
  boardTemplates: ReadonlyMap<CardKind, BoardTemplateOverride>
  modes: readonly ResolvedExtensionMode[]
}

const EMPTY_REGISTRY: ExtensionRegistry = { themes: [], boardTemplates: new Map(), modes: [] }

/**
 * Fold every scanned extension into the flat registry. Extensions are folded
 * in the order given (the shell sorts by folder name for determinism); when
 * two extensions contribute the same board-template `kind`, the LAST one in
 * scan order wins — same "last write visible" property a directory listing
 * already has, just made explicit here instead of accidental.
 *
 * A structurally-invalid manifest drops the WHOLE extension (logged via
 * `onReject`); within a valid manifest, each `contributes` key — and each
 * entry within it — is validated independently, so one broken theme never
 * takes out a sibling theme or the pack's board templates.
 */
export function buildExtensionRegistry(
  scanned: readonly ScannedExtension[],
  onReject?: (reason: string) => void
): ExtensionRegistry {
  if (scanned.length === 0) return EMPTY_REGISTRY

  const themes: ExtensionTheme[] = []
  const boardTemplates = new Map<CardKind, BoardTemplateOverride>()
  const modes: ResolvedExtensionMode[] = []

  for (const entry of scanned) {
    if (entry.raw === undefined) continue // unreadable/invalid JSON — already logged by the shell
    const parsed = parseExtensionManifest(entry.raw, entry.id)
    if (!parsed.ok) {
      onReject?.(parsed.error)
      continue
    }
    const { manifest } = parsed
    themes.push(
      ...parseThemeContributions(
        manifest.contributesRaw.themes,
        manifest.id,
        manifest.label,
        onReject
      )
    )
    const templates = parseBoardTemplateContributions(
      manifest.contributesRaw.boardTemplates,
      onReject
    )
    for (const [kind, relPath] of Object.entries(templates) as [CardKind, string][]) {
      boardTemplates.set(kind, {
        extensionId: manifest.id,
        absolutePath: join(entry.dirPath, relPath)
      })
    }
    for (const m of parseModeContributions(
      manifest.contributesRaw.modes,
      manifest.id,
      manifest.label,
      onReject
    )) {
      modes.push({
        id: m.id,
        rawId: m.rawId,
        extensionId: m.extensionId,
        extensionLabel: m.extensionLabel,
        label: m.label,
        icon: m.icon,
        docPath: join(entry.dirPath, m.doc)
      })
    }
  }

  return { themes, boardTemplates, modes }
}
