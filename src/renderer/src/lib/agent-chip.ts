/**
 * The agent connection chip's view model (T474 U1, spec §7.3): which of the states the pane
 * header shows, with what words, and whether it can be clicked or disconnected. Pure — the
 * component renders the answer and owns no logic of its own.
 */
import type { LiveWord } from './agent-activity'

/** What the chip needs to know about the terminal (main's projection, plus the pane). */
export interface ChipTerminal {
  origin: 'agent' | 'operator'
  ownerSessionId: string | null
  disconnected: boolean
  exited: boolean
  /** An agent holds a write lease on an operator-opened terminal. */
  leaseActive: boolean
}

/** What the sessions store says about the owner, or `null` when it knows no such session. */
export interface ChipOwner {
  title: string
  /** The owner's `claude` process is parked by the hibernation policy. */
  parked: boolean
}

export interface ChipView {
  /** `agentTerminal.*` key of the label. */
  labelKey:
    | 'connectedTo'
    | 'connectedToClosed'
    | 'connectedToAgent'
    | 'canType'
    | 'canTypeAnon'
    | 'readingAnon'
  /** Params for the label (`{ session }`), when it has any. */
  params?: { session: string }
  /** Show `(parked)` after the label. */
  parked: boolean
  /** The session a click selects; `null` = the chip is not a button. */
  clickSessionId: string | null
  /** The Disconnect button is offered. */
  disconnectable: boolean
}

/**
 * The chip to show, or `null` for none. A disconnected or exited terminal has no chip; an
 * operator-opened one has a chip only while an agent can type in it (lease) or is reading it.
 */
export function chipView(
  t: ChipTerminal,
  owner: ChipOwner | null,
  word: LiveWord
): ChipView | null {
  if (t.disconnected || t.exited) return null

  if (t.origin === 'agent') {
    if (t.ownerSessionId === null) {
      return view('connectedToAgent', undefined, false, null, true)
    }
    if (owner === null) {
      // Owner named, but the sessions store has no such session: it was closed (or never was).
      return view('connectedToClosed', undefined, false, null, true)
    }
    return view('connectedTo', { session: owner.title }, owner.parked, t.ownerSessionId, true)
  }

  if (t.leaseActive) {
    return owner && t.ownerSessionId
      ? view('canType', { session: owner.title }, owner.parked, t.ownerSessionId, true)
      : view('canTypeAnon', undefined, false, null, true)
  }
  // Reads on an operator terminal: transient, and unidentifiable, so nothing to disconnect.
  if (word === 'reading' || word === 'typing') {
    return view('readingAnon', undefined, false, null, false)
  }
  return null
}

function view(
  labelKey: ChipView['labelKey'],
  params: ChipView['params'],
  parked: boolean,
  clickSessionId: string | null,
  disconnectable: boolean
): ChipView {
  return { labelKey, ...(params ? { params } : {}), parked, clickSessionId, disconnectable }
}
