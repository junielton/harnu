/**
 * Shared types of the command channel (T389 P2W1 §7.2, §7.4): who caused a command, why `enqueue`
 * refuses one, and how a command ends. Types only; nothing here runs.
 */

import type { Command, CommandName, ErrorCode, Sid } from './contract'

export type CommandCause =
  | { kind: 'operator'; gesture: string } // constructed only inside an ipcMain handler
  | { kind: 'verb'; verb: string; callId?: string } // constructed only inside an MCP handler
  | { kind: 'internal'; subsystem: string } // main-process code with no external trigger

export type EnqueueRefusal =
  | 'NO_BINDING'
  | 'NO_LEASE'
  | 'STICKY_LEGACY'
  | 'HEADLESS'
  | 'EXTERNAL'
  | 'FEATURE_OFF'
  | 'MODE_SHADOW'
  | 'ORIGIN_DENIED'
  | 'TARGET_DENIED'
  | 'FOLDER_BLOCKED'
  | 'BAD_ARGS'
  | 'QUEUE_FULL'
  | 'SID_UNSETTLED'

export type CmdState = 'queued' | 'delivered' | 'resulted' | 'expired' | 'lost' | 'dropped'

export type DropWhy =
  'lease-lost' | 'rebound' | 'host-shutdown' | 'cancelled' | 'session-end' | 'revoked'

export type CommandOutcome =
  | { state: 'resulted'; ok: boolean; code?: ErrorCode; message?: string; data?: unknown }
  | { state: 'expired' } // never delivered by expiresAt
  | { state: 'lost' } // delivered, no result by resultDeadline
  | {
      state: 'dropped'
      why: DropWhy
      delivered: boolean // whether the mod's cursor ever covered it
    }

export interface QueuedCommand {
  command: Command
  cause: CommandCause
  sidAtEnqueue: Sid
  state: CmdState
  resultDeadline: number // expiresAt + CMD_RESULT_GRACE_MS[name]
  outcome?: CommandOutcome
}

/** A command that just reached a final state, for the shell to resolve and audit. */
export interface Settlement {
  item: QueuedCommand
  outcome: CommandOutcome
}

export type { CommandName }
