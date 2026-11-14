/**
 * Per-section size + collapsed state for the sidebar's stacked sections (T702, design.md §6
 * "Sidebar sections"). One module-level store keyed by section id, mirrored to `localStorage`
 * (`om2tab.sidebarSection.<id>`): because the state lives here and not in the component, it
 * survives a section hiding itself (Return here renders nothing when empty) and coming back.
 *
 * Reads and writes never throw: a blocked or full `localStorage` degrades to in-memory state.
 */
import { computed, reactive, type ComputedRef } from 'vue'
import {
  DEFAULT_SECTION_STATE,
  parseSectionState,
  sectionStorageKey,
  serializeSectionState,
  type SectionState
} from '../lib/sidebar-section'

const states = reactive<Record<string, SectionState>>({})

function load(id: string): SectionState {
  let raw: string | null = null
  try {
    raw = localStorage.getItem(sectionStorageKey(id))
  } catch {
    /* blocked storage: start from the default */
  }
  return parseSectionState(raw)
}

function stateOf(id: string): SectionState {
  if (!(id in states)) states[id] = load(id)
  return states[id]
}

function persist(id: string): void {
  try {
    localStorage.setItem(sectionStorageKey(id), serializeSectionState(stateOf(id)))
  } catch {
    /* quota / private mode: the in-memory state stays authoritative */
  }
}

export interface SidebarSectionState {
  /** Stored height in px, or `null` when the operator never dragged it (content-sized). */
  height: ComputedRef<number | null>
  collapsed: ComputedRef<boolean>
  setHeight(height: number | null): void
  toggleCollapsed(): void
  /** Double-click on the handle: forget the dragged height (the collapsed flag is untouched). */
  reset(): void
}

export function useSidebarSection(id: string): SidebarSectionState {
  stateOf(id)
  return {
    height: computed(() => stateOf(id).height),
    collapsed: computed(() => stateOf(id).collapsed),
    setHeight(height) {
      stateOf(id).height = height
      persist(id)
    },
    toggleCollapsed() {
      const s = stateOf(id)
      s.collapsed = !s.collapsed
      persist(id)
    },
    reset() {
      stateOf(id).height = DEFAULT_SECTION_STATE.height
      persist(id)
    }
  }
}

/** Test seam: forget every loaded section, as a page reload does to module state. */
export function resetSidebarSectionsForTests(): void {
  for (const id of Object.keys(states)) delete states[id]
}
