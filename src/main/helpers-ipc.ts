import { ipcMain } from 'electron'
import {
  getHelpersForWorktree,
  setHelpersForWorktree,
  removeHelpersForWorktree,
  type WorktreeHelperState
} from './helpers-store'

/**
 * Register IPC handlers for the helpers persistence layer. Called from
 * `src/main/index.ts` inside the `app.whenReady` block, after
 * `registerPtyHandlers` (no strict ordering required, just convention).
 *
 * Three handlers:
 *   - `helpers:get` — renderer asks for a worktree's saved state on visit
 *   - `helpers:set` — renderer pushes the full state after a debounced
 *     mutation (drag resize, add/remove/promote helpers)
 *   - `helpers:removeWorktree` — explicit cascade target, called from
 *     the user-projects remove handler (F12)
 */
export function registerHelpersHandlers(): void {
  ipcMain.handle('helpers:get', async (_e, args: { worktreePath: string }) => {
    return getHelpersForWorktree(args.worktreePath)
  })

  ipcMain.handle(
    'helpers:set',
    async (_e, args: { worktreePath: string; state: WorktreeHelperState }) => {
      await setHelpersForWorktree(args.worktreePath, args.state)
    }
  )

  ipcMain.handle('helpers:removeWorktree', async (_e, args: { worktreePath: string }) => {
    await removeHelpersForWorktree(args.worktreePath)
  })
}
