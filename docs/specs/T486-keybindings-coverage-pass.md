# T486 — Keybindings coverage pass

> Written 2026-10-14. Card: roadmap/T486. PRD: `docs/prds/T486-keybindings-coverage-pass.md`.
> Follow-up to T1 (`docs/specs/T1-customizable-keybindings.md`, PR #65). Every claim
> about current behavior below cites the code it was read from; the action inventory
> (§3) was re-derived from the components, not copied from the card's audit.
>
> **Revision 2 (2026-10-14, after orchestrator review).** Operator decisions folded in:
> `Cmd+Alt+S` (`view.settings.keybindings`), `Cmd+Shift+M` (`pane.toggleMaximize`) and
> `Cmd+Enter` (`session.openToSide`) are accepted; `session.fork` ships **unbound**; every
> Settings tab gets a `view.settings.<tab>` id. Esc gating rewritten (the
> `skipIfDefaultPrevented` design could not work, §6.1); the palette's enabled check
> split from the key-only text-entry guard (§9.1); U4 and U5 pre-split (§11). Three
> former open questions are now stated facts (§7.1, §4, §5.2).

## 1. Problem

T1 gave Harnu one keybindings table (`src/main/keybindings-core.ts:99-361`) and a
Settings pane over it, but the table only knows 26 rebindable actions plus 5 reserved
ones. About 60 user-invokable actions are click-only: the jump palette, closing a
takeover, every session and folder context-menu item, the footer pills, the helper
pane buttons, and every Settings tab. They have no id, so neither `keybindings.json`
nor the pane can reach them, and the command palette (six hand-written actions) cannot
find them either. This card adds 82 ids (80 new actions plus `nav.back` /
`nav.forward` moving into the table), for 113 rows in all.

Four defects sit on top:

1. The Keyboard Shortcuts pane renders raw i18n keys (§4).
2. The pane is a flat list with no search or grouping — unusable at ~108 visible rows.
3. The palette's hand-written actions have already drifted: its `mostRecentSession()`
   (`CommandPalette.vue:138-144`) does not skip folder terminals, while `App.vue`'s
   (`App.vue:451-459`) does.
4. `design.md` §6 "Takeover dismissal" says Esc dismisses a takeover "via the
   App-level `closeAll()`". `ui.closeAll()` (`stores/ui.ts:987-1000`) has no
   production caller — only tests call it — so the header X (`TakeoverShell.vue:45`)
   is the only keyboard-less way out today.

## 2. Goals and non-goals

**Goals.** Every user-invokable action has a table id (most unbound); a small set of
VS Code-parity defaults; a searchable grouped pane; a table-driven palette; chords in
tooltips; Esc closes takeovers; F6 pane focus; a terminal toggle; `nav.back` /
`nav.forward` rebindable.

**Non-goals.** MCP verbs (T485); new chord grammar (§10 proves none is needed); palette
visual redesign; `when`-clauses; rebinding `terminalKeymap.ts`; per-folder overrides;
localizing native menu labels; making the "not in terminal" marker platform-accurate
(§7.1 states why it is wrong off macOS; this card centralizes the predicate in
`isNotInTerminal(d)` so a follow-up can fix it in one place).

## 3. Action inventory

### 3.1 Conventions

- **Id** — stable string, `<group-ish>.<verb>`. Existing ids keep their names (T1
  `keybindings.json` files reference them).
- **Default** — canonical chord (`Cmd` = ⌘ on macOS, Ctrl elsewhere) or `unbound`.
  Defaults exist **only** where the card names one, plus three chords the spec picked
  and the operator accepted on 2026-10-14: `Cmd+Alt+S` (`view.settings.keybindings`),
  `Cmd+Shift+M` (`pane.toggleMaximize`), `Cmd+Enter` (`session.openToSide`, Ctrl+Enter
  off macOS). `session.fork` ships unbound (operator decision, same day).
- **Terminal** — the T1 terminal marker the pane shows (not the `useShortcuts` scope of §6.1), computed by `isNotInTerminal(d)`
  (`!d.menu && !d.shield`, exported from `keybindings-core.ts` in U5a): `global` = the
  descriptor is menu-backed or shielded (§7.4), so the action is designed to fire while
  a terminal holds focus; `not-in-terminal` = renderer-only. §7.1 states why `global`
  is only true on macOS for a menu-backed Ctrl+letter chord.
- **Menu** — has a native menu item in `src/main/menu.ts` (T1 `menu: true`).
- **Target** — what a context-dependent action acts on (§3.10 defines the rules).
- **Handler** — the function the existing button / menu item runs. The new binding
  calls that same function (extracted where it is component-local, §11), never a copy.

Paths are under `src/renderer/src/` unless they start with `src/main/`.

### 3.2 Sessions

| Id                           | Label (en)                       | Handler / where it lives                                                                                                | Default       | Terminal        | Menu |
| ---------------------------- | -------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ------------- | --------------- | ---- |
| `session.new`                | New session                      | `App.vue:489-502` → `sessions.newSessionInCurrentContext()`                                                             | `Cmd+N`       | global          | yes  |
| `session.newInFolder`        | New session in this folder…      | `Topbar.vue:399` (`onNewSessionClick` :211), `SidebarFolder.vue:638` → `ui.openNewSession(folder)` (`stores/ui.ts:596`) | unbound       | not-in-terminal | no   |
| `session.resumeLast`         | Resume last session              | `App.vue:677-685`                                                                                                       | `Cmd+Shift+R` | global          | yes  |
| `session.rename`             | Rename the selected session      | `App.vue:686-696` → `ui.triggerRenameFocus()`                                                                           | `Cmd+R`       | global          | yes  |
| `session.close`              | Close the current session tab    | `App.vue:697-712` → `sessions.clearSelection()`                                                                         | `Cmd+W`       | global          | yes  |
| `session.fork`               | Fork the session                 | `SessionMenu.vue:143-156` (`onFork`) → `sessions.createForkedSession` (`stores/sessions.ts:3375`)                       | unbound       | not-in-terminal | no   |
| `session.openToSide`         | Open the session to the side     | `SessionMenu.vue:177-190` (`onOpenInNewTab`) → `helpers.addResumeHelper` (`stores/helpers.ts:713`)                      | `Cmd+Enter`   | not-in-terminal | no   |
| `session.contextMenu`        | Open the context menu            | `ui.openMenu` (`stores/ui.ts:643`) / `ui.openFolderMenu` (:666), anchored per §8.3                                      | `Shift+F10`   | not-in-terminal | no   |
| `session.restart`            | Restart the session              | `SessionMenu.vue:207-210` → `sessions.reloadSession` (`stores/sessions.ts:2874`)                                        | unbound       | not-in-terminal | no   |
| `session.copyId`             | Copy session id                  | `SessionMenu.vue:274` (`onCopySessionId`)                                                                               | unbound       | not-in-terminal | no   |
| `session.copyTranscriptPath` | Copy transcript path             | `SessionMenu.vue:279-286`                                                                                               | unbound       | not-in-terminal | no   |
| `session.copyResumeCommand`  | Copy resume command              | `SessionMenu.vue:289-291`                                                                                               | unbound       | not-in-terminal | no   |
| `session.copyContextDigest`  | Copy context digest              | `SessionMenu.vue:299-317`                                                                                               | unbound       | not-in-terminal | no   |
| `session.toggleNoFlicker`    | Toggle no-flicker mode           | `SessionMenu.vue:398-404` → `sessions.toggleNoFlicker` (`stores/sessions.ts:1792`)                                      | unbound       | not-in-terminal | no   |
| `session.toggleArchived`     | Archive or unarchive the session | `SessionMenu.vue:345-352` → `sessions.archiveSession` (:2891) / `unarchiveSession` (:2918)                              | unbound       | not-in-terminal | no   |
| `session.delete`             | Delete the session…              | `SessionMenu.vue:366-389` (`onDelete`, keeps its `window.confirm`)                                                      | unbound       | not-in-terminal | no   |
| `session.retryBoot`          | Retry a failed start             | `SessionMenu.vue:218-246` (`onRetryFailure`)                                                                            | unbound       | not-in-terminal | no   |
| `session.dismiss`            | Dismiss a failed new session     | `SessionMenu.vue:253-255` → `sessions.closeSession` (:2826)                                                             | unbound       | not-in-terminal | no   |
| `session.closeTerminal`      | Close the folder terminal        | `SidebarFolder.vue:1138` → `sessions.closeFolderTerminal`                                                               | unbound       | not-in-terminal | no   |

### 3.3 Sidebar

| Id                                                               | Label (en)                     | Handler / where it lives                                                                                                   | Default                                                        | Terminal         | Menu |
| ---------------------------------------------------------------- | ------------------------------ | -------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- | ---------------- | ---- |
| `sidebar.jump`                                                   | Jump to a folder or session    | `Sidebar.vue:207-210` (`onSearchClick`) → `ui.openSidebarJumpPalette()` (`stores/ui.ts:747`) / `closeSidebarJumpPalette()` | `Cmd+Shift+F`                                                  | not-in-terminal¹ | no   |
| `sidebar.rescan`                                                 | Rescan folders                 | `Sidebar.vue:185` (click :272) → `sessions.rescan()`                                                                       | unbound                                                        | not-in-terminal  | no   |
| `sidebar.cycleDrillDepth`                                        | Cycle the sidebar drill depth  | `Sidebar.vue:287` → `sessions.cycleDrillDepth()`                                                                           | unbound                                                        | not-in-terminal  | no   |
| `sidebar.toggleCollapseAll`                                      | Collapse or expand all folders | `Sidebar.vue:197` (click :301)                                                                                             | unbound                                                        | not-in-terminal  | no   |
| `sidebar.hiddenFolders`                                          | Show hidden folders            | `Sidebar.vue:160` (`onHiddenClick`, click :315) → `ui.openSidebarHiddenPopover(rect)` (`stores/ui.ts:727`)                 | unbound                                                        | not-in-terminal  | no   |
| `sidebar.cursor.down` / `.up` / `.right` / `.left` / `.activate` | Sidebar cursor: …              | `App.vue:737-775`                                                                                                          | `ArrowDown` / `ArrowUp` / `ArrowRight` / `ArrowLeft` / `Enter` | not-in-terminal  | no   |

¹ Marked `not-in-terminal` by the T1 rule, but `Cmd+Shift+F` does fire over a focused
terminal: xterm produces no data for Ctrl/⌘+Shift+letter and lets the event bubble
(§7.1).

Two rules for `sidebar.jump`, both required:

- **It expands a collapsed sidebar first** (`layout.setSidebarCollapsed(false)`,
  `stores/layout.ts:175`). The Sidebar is hidden with `v-show` (`App.vue:984`) and the
  jump palette mounts inside it (`Sidebar.vue:376`), so opening the palette on a
  collapsed sidebar would open it invisibly. Closing the palette does not re-collapse.
- **It has no text-entry guard** (§9.1 `keysGuard`). The second press must close the
  palette while the palette's own input holds focus. The jump palette is not in the
  `'modal'` scope (`anyOverlayOpen`, `App.vue:75-82`), and its capture handler stops
  only Esc / arrows / Enter / Tab (`SidebarJumpPalette.vue:183-211`), so the chord still
  reaches the binding, which toggles like the search button does (`Sidebar.vue:207-210`).

### 3.4 Folders and repo groups

Folder actions target the active folder (§3.10); `folder.rename` targets the cursor row
first.

The folder and repo-group labels follow the visible menu wording, so a search types what
the menu shows; a toggle lists both of its menu labels (operator / orchestrator decision,
2026-10-20).

| Id                                 | Label (en)                                                                  | Handler / where it lives                                                                                | Default | Terminal        | Menu |
| ---------------------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | ------- | --------------- | ---- |
| `folder.add`                       | Add folder                                                                  | `App.vue:586-591` → `ui.openDialog('addFolder')`                                                        | `Cmd+O` | global          | yes  |
| `folder.browseFiles`               | Browse files                                                                | `App.vue:647-653` → `useFolderActions.browseFiles` (`composables/useFolderActions.ts:106`)              | unbound | global          | yes  |
| `folder.newTerminal`               | Open a terminal                                                             | `App.vue:654-660` → `useFolderActions.newTerminal` (:118)                                               | unbound | global          | yes  |
| `folder.openInFileManager`         | Open the active folder in the file manager                                  | `App.vue:626-632` → `useFolderActions.openInFileManager` (:63)                                          | unbound | global          | yes  |
| `folder.openInVSCode`              | Open the active folder in VS Code                                           | `App.vue:633-639` → `useFolderActions.openInVSCode` (:75)                                               | unbound | global          | yes  |
| `folder.openGithubPulls`           | Open pull requests on GitHub                                                | `App.vue:640-646` → `useFolderActions.openGithubPulls` (:94)                                            | unbound | global          | yes  |
| `folder.rename`                    | Rename the folder…                                                          | `FolderMenu.vue:432-436` → `ui.openRenameFolder` (`stores/ui.ts:626`)                                   | `F2`    | not-in-terminal | no   |
| `folder.newFolderTerminal`         | New terminal session in the folder                                          | `FolderMenu.vue:398-405` → `sessions.createFolderTerminal` (`stores/sessions.ts:3453`)                  | unbound | not-in-terminal | no   |
| `folder.toggleBranchAlias`         | Use branch as name / Use folder name                                        | `FolderMenu.vue:437-442` (`onToggleAliasFromBranch` :354) → `sessions.setFolderAliasFromBranch` (:3673) | unbound | not-in-terminal | no   |
| `folder.bootOptions`               | Startup options…                                                            | `FolderMenu.vue:443-448` → `ui.openClaudeBoot` (`stores/ui.ts:590`)                                     | unbound | not-in-terminal | no   |
| `folder.projectMemory`             | Project memory…                                                             | `FolderMenu.vue:452-457` (`onProjectMemory` :79) → `helpers.addMemoryHelper` (`stores/helpers.ts:786`)  | unbound | not-in-terminal | no   |
| `folder.memoryLocation`            | Store memory in…                                                            | `FolderMenu.vue:461-466` → `ui.openMemoryLocation` (`stores/ui.ts:638`)                                 | unbound | not-in-terminal | no   |
| `folder.newSubfolder`              | New folder…                                                                 | `FolderMenu.vue:490-496` → `ui.openNewFolder` (`stores/ui.ts:614`)                                      | unbound | not-in-terminal | no   |
| `folder.openSubfolder`             | Open subfolder…                                                             | `FolderMenu.vue:497-502` → `ui.openOpenSubfolder` (`stores/ui.ts:620`)                                  | unbound | not-in-terminal | no   |
| `folder.newWorktree`               | New worktree…                                                               | `FolderMenu.vue:506-516` → `ui.openNewWorktree` (`stores/ui.ts:608`)                                    | unbound | not-in-terminal | no   |
| `folder.worktreeMd`                | Create WORKTREE.md / Open WORKTREE.md                                       | `FolderMenu.vue:521-531` (`onWorktreeMd` :112-137)                                                      | unbound | not-in-terminal | no   |
| `folder.askAgentWorktreeMd`        | Ask an agent to write WORKTREE.md                                           | `FolderMenu.vue:532-537` → `sessions.dispatchCardSession` (:3104)                                       | unbound | not-in-terminal | no   |
| `folder.toggleIntercept`           | Intercept tool calls here / Stop intercepting here                          | `FolderMenu.vue:575-580` → `sessions.setFolderInterceptActive` (:3636)                                  | unbound | not-in-terminal | no   |
| `folder.toggleAutoOrganize`        | Turn on auto-organize / Turn off auto-organize                              | `FolderMenu.vue:583-594` → `sessions.setFolderAutoOrganize` (:3708)                                     | unbound | not-in-terminal | no   |
| `folder.toggleOrchestratorDefault` | New sessions start as Orchestrator / Stop starting sessions as Orchestrator | `FolderMenu.vue:597-604` → `sessions.setFolderOrchestratorDefault` (:3689)                              | unbound | not-in-terminal | no   |
| `folder.toggleHidden`              | Hide / Unhide folder                                                        | `FolderMenu.vue:605-617` → `sessions.dismissFolder` (:3599) / `unhideFolder` (:3609)                    | unbound | not-in-terminal | no   |
| `folder.removeWorktree`            | Remove worktree                                                             | `FolderMenu.vue:620-632` → `ui.openRemoveWorktree` (`stores/ui.ts:602`), which keeps its confirm dialog | unbound | not-in-terminal | no   |
| `folder.toggleOlder`               | Show older sessions / Hide older sessions                                   | `SidebarFolder.vue:624` (`peek('older')` :357) → `sessions.toggleRevealOlder`                           | unbound | not-in-terminal | no   |
| `folder.toggleArchived`            | Show archived / Hide archived                                               | `SidebarFolder.vue:624` (`peek('archived')`) → `sessions.toggleRevealArchived`                          | unbound | not-in-terminal | no   |
| `repoGroup.rename`                 | Rename group                                                                | `RepoGroupHeader.vue:87-90` → `ui.openRenameRepo` (`stores/ui.ts:632`)                                  | unbound | not-in-terminal | no   |
| `repoGroup.resetName`              | Reset name (group)                                                          | `RepoGroupHeader.vue:92-95` → `sessions.setGroupAlias(key, '')` (:980)                                  | unbound | not-in-terminal | no   |
| `repoGroup.cleanup`                | Cleanup… (repo)                                                             | `RepoGroupHeader.vue:104-109` → `ui.openCleanup(mainWorktreePath)` (`stores/ui.ts:809`)                 | unbound | not-in-terminal | no   |

### 3.5 Views (layout and popovers)

| Id                          | Label (en)                       | Handler / where it lives                                                                   | Default       | Terminal        | Menu                |
| --------------------------- | -------------------------------- | ------------------------------------------------------------------------------------------ | ------------- | --------------- | ------------------- |
| `view.toggleSidebar`        | Toggle the left sidebar          | `App.vue:534-546` → `layout.toggleSidebar()`                                               | `Cmd+B`       | global          | yes                 |
| `view.toggleHelper`         | Toggle the right split panel     | `App.vue:547-556` → `layout.toggleHelper()`                                                | `Cmd+Alt+B`   | global          | yes                 |
| `inbox.toggle`              | Toggle the Approval Inbox rail   | `App.vue:518-525` → `layout.toggleInboxRail()`                                             | `Cmd+Shift+A` | not-in-terminal | no                  |
| `view.fleetRail`            | Toggle the Fleet rail            | `App.vue:526-533` → `layout.toggleInboxRail()` (alias of `inbox.toggle`; `palette: false`) | `Cmd+Shift+B` | not-in-terminal | no                  |
| `inbox.open`                | Open the Approval Inbox          | `InboxRail.vue:297`, `CommandPalette.vue:226-232` → `layout.setInboxRailState('expanded')` | unbound       | not-in-terminal | no                  |
| `inbox.toggleOrder`         | Flip the Inbox order             | `InboxRail.vue:433` → `layout.toggleInboxRailOrder()`                                      | unbound       | not-in-terminal | no                  |
| `inbox.filter`              | Filter the Inbox by state        | `InboxRail.vue:456` (local `filterPopoverOpen`, lifted per §11 U4a)                        | unbound       | not-in-terminal | no                  |
| `inbox.showAll`             | Show every Inbox state           | `InboxRail.vue:485` → `layout.clearInboxRailStateFilter()`                                 | unbound       | not-in-terminal | no                  |
| `view.activity`             | Open Activity                    | `ActivityBell.vue:222` (`toggleBell` :62, local state, lifted)                             | unbound       | not-in-terminal | no                  |
| `view.missionProgress`      | Open mission progress            | `MissionPill.vue:108` (`toggle` :42, local state, lifted)                                  | unbound       | not-in-terminal | no                  |
| `view.pastedImages`         | Open pasted images               | `StatusFooter.vue:437` (`toggleImagesPopover` :353, local state, lifted)                   | unbound       | not-in-terminal | no                  |
| `view.claudeStatus`         | Open Claude service status       | `StatusFooter.vue:494` (local `statusOpen`, lifted)                                        | unbound       | not-in-terminal | no                  |
| `view.usagePanel`           | Open plan usage                  | `StatusFooter.vue:594` (`toggleFleetPopover` :366, local state, lifted)                    | unbound       | not-in-terminal | no                  |
| `view.settings`             | Open Settings                    | `App.vue:661-668` → `ui.openSettings()`                                                    | `Cmd+,`       | global          | yes                 |
| `view.settings.keybindings` | Open Keyboard Shortcuts settings | `ui.openSettings('keybindings')` (`stores/ui.ts:584`; tab id `SettingsDialog.vue:128`)     | `Cmd+Alt+S`   | global          | yes (new item, §10) |
| `view.settings.<tab>` × 19  | Open Settings: {tab name}        | `ui.openSettings(tab)` (`stores/ui.ts:584`), one id per remaining `SettingsTabId`          | unbound       | not-in-terminal | no                  |

**Settings tabs (operator decision, 2026-10-14: do not narrow scope).** Every
`SettingsTabId` (`stores/ui.ts:107-127`) gets an id. `keybindings` is the row above;
the other 19, all unbound, `menu: false`: `view.settings.general`, `.interceptor`,
`.appearance`, `.startup`, `.claudeConfig`, `.endpoints`, `.push`, `.voice`, `.mcp`,
`.skills`, `.mods`, `.memory`, `.hibernationPolicy`, `.usageHistory`, `.changelog`,
`.claudeCode`, `.cleanup`, `.containers`, `.prStack`. Each routes through
`ui.openSettings(tab)`. Their registrations in `App.vue` are generated from one
`SETTINGS_TAB_IDS` list (exported next to the `SettingsTabId` type) so a new tab cannot
ship without an id — a test asserts the list equals the union. Each gets its own
`keybindings.actions.view_settings_<tab>` label in both locales ("Open Settings:
General", …), because §4's `labelKeyFor` rule is one key per id. Edge: with Settings
already open the `'modal'` scope blocks the chord, and `ui.openSettings` reads the tab
only when the dialog opens (`SettingsDialog.vue:878-882`), so the chord is inert there
rather than switching tabs.

### 3.6 Takeovers

| Id                    | Label (en)                        | Handler / where it lives                                                                           | Default       | Terminal        | Menu |
| --------------------- | --------------------------------- | -------------------------------------------------------------------------------------------------- | ------------- | --------------- | ---- |
| `view.closeTakeover`  | Close the open view               | `TakeoverShell.vue:45` → `TakeoverHost.vue:69` → `ui.closeAllTakeovers()` (`stores/ui.ts:393`)     | `Escape`      | not-in-terminal | no   |
| `view.roadmap`        | Toggle the roadmap board          | `App.vue:612-618` → `useFolderActions.toggleRoadmap` (:46)                                         | unbound       | global          | yes  |
| `view.prStack`        | Toggle the PR Stack               | `App.vue:619-625` → `useFolderActions.togglePrStack` (:52)                                         | unbound       | global          | yes  |
| `view.review`         | Review the active folder's branch | `App.vue:592-606` → `ui.toggleReview`                                                              | `Cmd+Shift+D` | not-in-terminal | no   |
| `view.usageDashboard` | Toggle the usage overview         | `App.vue:669-676` → `ui.toggleUsageDashboard()`                                                    | unbound       | global          | yes  |
| `view.cleanup`        | Toggle Cleanup                    | `StatusFooter.vue:536` → `ui.toggleCleanup()` (`stores/ui.ts:905`)                                 | unbound       | not-in-terminal | no   |
| `view.scheduler`      | Toggle the Scheduler              | `StatusFooter.vue:570` → `ui.toggleScheduler()` (:892)                                             | unbound       | not-in-terminal | no   |
| `view.systemMonitor`  | Toggle the System Monitor         | `HeapGauge.vue:44` → `ui.toggleSystemMonitor()` (:888)                                             | unbound       | not-in-terminal | no   |
| `view.containers`     | Toggle Containers                 | `ui.toggleContainers()` (`stores/ui.ts:896`; no button since T443 folded it into the Cleanup pill) | unbound       | not-in-terminal | no   |

### 3.7 Panes

| Id                    | Label (en)                           | Handler / where it lives                                                                                                                                                                                                  | Default       | Terminal         | Menu |
| --------------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- | ---------------- | ---- |
| `pane.focusNext`      | Focus the next pane                  | new — §8.1                                                                                                                                                                                                                | `F6`          | global (shield)  | no   |
| `pane.focusPrev`      | Focus the previous pane              | new — §8.1                                                                                                                                                                                                                | `Shift+F6`    | global (shield)  | no   |
| `pane.toggleMaximize` | Maximize or restore the focused pane | `HelperPane.vue:828-838` (`onToggleMaximize` :597) and the twins in `MarkdownPane.vue:676`, `MemoryPane.vue:197`, `ExplorerPane.vue:536`, `DiagramPane.vue:1101` → `helpers.toggleMaximizePane` (`stores/helpers.ts:334`) | `Cmd+Shift+M` | not-in-terminal¹ | no   |
| `pane.close`          | Close the focused pane               | `HelperPane.vue:839-847` (`onClose` :591 → `helpers.removeHelper` :966), `MarkdownPane.vue:687` (:552, discard guard), `MemoryPane.vue:208`, `ExplorerPane.vue:547`, `DiagramPane.vue:1112` (:982, discard guard)         | unbound       | not-in-terminal  | no   |
| `terminal.toggle`     | Toggle the terminal pane             | new — §8.2                                                                                                                                                                                                                | unbound       | global (shield)  | no   |

¹ Fires over a focused helper terminal anyway: Ctrl/⌘+Shift+M is a Shift+letter chord
xterm lets bubble (§7.1).

### 3.8 App

| Id                                                            | Label (en)                        | Handler / where it lives                                               | Default                                           | Terminal                  | Menu |
| ------------------------------------------------------------- | --------------------------------- | ---------------------------------------------------------------------- | ------------------------------------------------- | ------------------------- | ---- |
| `app.search`                                                  | Open command palette              | `App.vue:503-508` → `ui.openPalette()`                                 | `Cmd+K`                                           | global                    | yes  |
| `project.switch`                                              | Switch project                    | `App.vue:578-585` → `ui.openPalette()` (`palette: false`)              | `Cmd+Shift+P`                                     | global                    | yes  |
| `nav.back`                                                    | Back to the previous session      | `App.vue:567-571` → `sessions.goBack()`; `src/main/menu.ts:211-215`    | `Cmd+[` on macOS, `Alt+ArrowLeft` elsewhere (§10) | global (shield off macOS) | yes  |
| `nav.forward`                                                 | Forward to the next session       | `App.vue:572-577` → `sessions.goForward()`; `src/main/menu.ts:216-220` | `Cmd+]` on macOS, `Alt+ArrowRight` elsewhere      | global (shield off macOS) | yes  |
| `app.openKeybindings`                                         | Open keybindings.json (reserved)² | `App.vue:509-517` → `keybindings.openInEditor()`                       | `Cmd+Alt+K`                                       | global                    | yes  |
| `app.reload` / `app.devtools` / `app.quit` / `app.fullscreen` | (reserved)                        | `src/main/menu.ts:306-340`                                             | `F5` / `F12` / `Cmd+Q` / `F11`                    | global                    | yes  |

² Today its label is "Open Keyboard Shortcuts" (`en.json:1184`), which would duplicate
`view.settings.keybindings`. U4b changes the en and pt-BR labels to "Open
keybindings.json", matching the relabeled native menu item (§10).

### 3.9 Deliberately not bindable

| Action                                                                                                                             | Where                                                                                | Why it stays click-only                                                                                                                                                                        |
| ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Remote control toggle                                                                                                              | `SessionMenu.vue:420-428`                                                            | Its menu row carries a security disclosure (`remoteControl.disclosure`) the user must read at the moment of enabling, and it restarts the session. A stray chord must not grant remote access. |
| Orchestrator toggle (session)                                                                                                      | `SessionMenu.vue:443-451`                                                            | Same rule: inline disclosure (`orchestrator.disclosure`) and a restart.                                                                                                                        |
| Block / unblock agent control                                                                                                      | `FolderMenu.vue:568-574`                                                             | Unblocking widens agent access to a folder. That stays a deliberate click.                                                                                                                     |
| Modes ▸ / Set parent folder ▸ / Clear parent folder                                                                                | `FolderMenu.vue:410-428`, `:543-567`                                                 | Need a pick from a dynamic list. Reachable by keyboard through `session.contextMenu` (Shift+F10) and the menu's own arrow-key flyout navigation (`FolderMenu.vue:700-766`).                    |
| Session menu "Roadmap board"                                                                                                       | `SessionMenu.vue:569-575`                                                            | Covered by `view.roadmap`.                                                                                                                                                                     |
| Sidebar filter clear (×)                                                                                                           | `Sidebar.vue:367`                                                                    | Esc inside the filter input already does it (`Sidebar.vue:360`).                                                                                                                               |
| Activity "Clear all", Inbox section toggles, per-row buttons (lineage, teammates, agents chevron, minicards, mission-grant Revoke) | `ActivityBell.vue:268`, `InboxRail.vue:666/715/600`, `SidebarFolder.vue:597/719/881` | Act inside an open popover or on one list item; not global commands.                                                                                                                           |
| Actions inside a takeover, dialog or Settings tab (Cleanup clean, PR Stack filters, Scheduler worker edit, pane "Reset all", …)    | the takeovers / `SettingsDialog.vue`                                                 | They operate on that surface's own state and selection. Opening each Settings tab is bindable (§3.5); the controls inside a tab are not.                                                       |

### 3.10 Target rules

- **Session actions** (`session.fork`, `.restart`, `.copy*`, `.toggleNoFlicker`,
  `.toggleArchived`, `.delete`, `.retryBoot`, `.dismiss`, `.closeTerminal`) target the
  **selected session** — what the Topbar shows. Each is `enabled()` only when the
  selected session passes the same visibility rule the Session menu applies to that
  item (`SessionMenu.vue:628-673`: synthetic sessions lose fork/restart/copy/archive/
  delete; retry/dismiss only for a failed or completed synthetic).
- **`session.openToSide` and `session.contextMenu`** are sidebar-navigation gestures:
  they target the **keyboard cursor row** when the cursor is on one (classic sidebar
  mode — the cursor is inert in drill mode, `App.vue:113-115`), else the selected
  session (`session.contextMenu` then falls back to the active folder's menu).
- **Folder actions** target `sessions.activeFolderPath` — the same rule as
  `useFolderActions` (every method no-ops with no active folder). `folder.rename` (F2)
  targets the cursor row first when it is a folder row; on a session or group cursor
  row it is a no-op (a session is renamed with `Cmd+R`, a group with
  `repoGroup.rename`).
- **Repo-group actions** target the cursor row when it is a group row, else the group
  that contains the active folder; no group → no-op.
- **Pane actions** target the **focused** helper pane (§8.1).
- Every action that acts on the sidebar or a selection carries a **`keysGuard`**
  (§9.1) of `!isTextEntryTarget()` (`App.vue:93-103`, moved to `lib/text-entry.ts` in
  U2) — notably `session.openToSide` (`Cmd+Enter`) and `folder.rename` (`F2`), which a
  text field may own. The guard applies to key presses only, never to the palette or
  the native menu (§9.1). `session.fork`'s guard also yields when focus is inside the
  Diagram pane (`[data-testid="diagram-pane"]`, `DiagramPane.vue:991`): that pane binds
  ⌘D / Ctrl+D to "duplicate selection" on a window bubble listener
  (`DiagramPane.vue:929-933`), so a user who binds `Cmd+D` to fork would otherwise get
  both.

## 4. Bug — raw i18n keys in Settings → Keyboard Shortcuts

**Symptom.** Every row reads `keybindings.actions.session.new` (and so on), in both
locales; conflict badges and the capture button's `aria-label` too.

**Root cause.** `KeybindingsPane.vue:44`, `:152` and `:173` build the key from the id:
`'keybindings.actions.' + b.id`. The ids contain dots, and the locale files store them
as **flat keys containing dots** under a nested `actions` object (`en.json:1153-1185`,
`pt-BR.json:1153-1185`: `"actions": { "session.new": … }`). vue-i18n resolves a key
as a dotted **path** (`resolveValue`), so `keybindings.actions.session.new` walks
`keybindings → actions → session → new` and misses at `session`. Its only fallback
looks the whole dotted string up at the root (`@intlify/core-base`,
`dist/core-base.mjs:1654-1657`: `format = message[key]`), which misses too, and `t`
returns the key. The descriptors' own `labelKey` fields (`keybindings-core.ts:106` …)
carry the same unresolvable path; nothing reads them today, which is why the pane
builds the key from the id. The pane test (`tests/keybindings-pane.test.ts`) never
renders the component, so CI never saw it.

**Why not nest the JSON.** Nesting (`"session": { "new": … }`) works for the current
ids but breaks on this card's `view.settings.keybindings`: `view.settings` would have
to be a string and an object at once.

**Fix shape (U1).**

1. `keybindings-core.ts` exports `labelKeyFor(id)`, which returns
   `'keybindings.actions.' + id.replaceAll('.', '_')`, and every descriptor's `labelKey` is derived from it
   (`session.new` → `keybindings.actions.session_new`,
   `view.settings.keybindings` → `keybindings.actions.view_settings_keybindings`).
2. `en.json` and `pt-BR.json` rename every `keybindings.actions` key to the
   underscore form, same values, same change (the `MessageSchema` parity rule).
3. Every consumer reads `descriptor.labelKey` / `resolved.labelKey`; nothing builds a
   key from an id again (the pane's three call sites, the palette, tooltips, T485).
4. A test (`tests/keybindings-labels.test.ts`) loads the real i18n catalog, asserts
   for **every** descriptor and **both** locales that `t(labelKey) !== labelKey`,
   and asserts `labelKey`s are unique (the `_` encoding could in theory fold
   `a.b_c` and `a_b.c`). A second test mounts `KeybindingsPane` with the real i18n
   instance and asserts no rendered text or `aria-label` starts with
   `keybindings.actions.`.

**Related bug (fix in U1, it is the same pane).** While a row is recording, `Esc` is
meant to cancel only the recording (`KeybindingsPane.vue:76`). Both the pane (`:95`)
and `SettingsDialog.vue` (registered `:893`, closing at `:870-875`) listen on the
window in the **capture** phase. Settings registered first, so its handler runs first
and closes the dialog; the pane's `stopPropagation` cannot help, because
`stopPropagation` never stops another listener on the same target. Fix: move
`recordingId` into the keybindings store and have SettingsDialog's Esc handler return
early while it is non-null.

## 5. Pane redesign — searchable, grouped, filterable

### 5.1 Descriptor additions (U1)

```ts
type KeybindingGroup = 'sessions' | 'sidebar' | 'folders' | 'views' | 'panes' | 'takeovers' | 'app'

interface KeyBindingDescriptor {
  // … T1 fields …
  group: KeybindingGroup
  /** false ⇒ never listed in the command palette (§9). Default true. */
  palette?: boolean
  /** Listed in the palette's empty-query view (§9). Default false. */
  paletteFeatured?: boolean
}
```

U1 also introduces a compact row constructor (`def(id, group, defaultKeys, opts)`) so
each later unit adds one line per action instead of eight; T1's field semantics are
unchanged. `shield`, `defaultKeysMac` and the exported `isNotInTerminal(d)` predicate
arrive in U5a (§7.4, §10); until then the pane keeps its inline `!b.menu`
(`KeybindingsPane.vue:193`), and U5a replaces it with the export.

### 5.2 Behavior

- **Search box** at the top of the pane (autofocus when the tab opens). Two match
  modes, picked per query:
  - **Chord mode** — if the trimmed query parses with `parseChord` and has a `+`, a
    modifier, an F-key or `Esc` (`Ctrl+J`, `ctrl+shift+f`, `F6`, `Esc`), or contains a
    macOS symbol (`⌘⇧⌥⌃`, which the matcher maps back to tokens), it is canonicalized
    and rows are kept whose **resolved** chord is equal under the platform fold
    (`scopeChordKey`, so `Ctrl+B` finds `Cmd+B` off macOS). This answers "what holds
    Ctrl+J?" exactly.
  - **Bare named key** — `parseChord` also accepts words like `delete`, `left`,
    `right`, `tab`, `home`, `end` and `space` as a chord with no modifier. Those are
    ambiguous with ordinary search words ("delete" must still find "Delete the
    session…", even though `session.delete` is unbound), so such a query returns the
    **union** of the chord-mode and text-mode result sets.
  - **Text mode** — otherwise, a case-insensitive substring match against the row's
    label (active locale), its rendered chord, and its id.
- **Group headers** in fixed order: Sessions, Sidebar, Folders, Views, Panes,
  Takeovers, App. Rows keep table order inside a group. A group with no visible row
  is hidden.
- **Filter chips**: Unbound (`keys === null`), Conflicts (`conflictsWith.length > 0`),
  Customized (`source !== 'default'`). Each shows its count over the whole table.
  Chips are independent toggles; active chips AND with each other and with the search.
- **Empty result**: one muted line.
- **Shield hint** (U5a): a row whose descriptor is shielded and has a chord shows a
  muted line under it naming that the chord is taken from the terminal.
- **Terminal-keeps hint** (U5a): a row that is _not_ shielded but is bound to a chord
  `terminalKeymap.ts` swallows (§7.1) shows a muted line saying the chord does not fire
  while a terminal has focus. `terminalKeymap.ts` exports its chord list as data
  (`TERMINAL_KEYMAP_CHORDS`) so the pane reads the same source the handler uses.
- **Recorder refuses unreachable chords** (U1). Confirmed from code: `useMagicKeys`
  builds its keys only from the lowercased `e.code` and `e.key` (`@vueuse/core`
  `dist/index.js:4800-4809`), so a Shift+punctuation chord (`Cmd+Shift+,`, where
  `e.key` is `<`) never matches, and on macOS an Option+letter chord fails the same way
  (Option rewrites `e.key`). For an action whose only path is that renderer watcher
  (`!menu`, and from U5a `!shield`), the recorder rejects such a chord, keeps the old
  one, and shows an inline line. A hand-edited `keybindings.json` entry still loads
  (no new warning code in this card).
- Reserved rows stay hidden, as in T1.
- Every existing row affordance (capture control, default reminder, "not in terminal",
  conflict badge, Reset, Unbind, Reset all, Open keybindings.json) is unchanged.

### 5.3 `design.md` §6 additions the implementation must make first

In `### Keyboard Shortcuts (Settings → Keyboard Shortcuts, T1 P4)` (`design.md:1109`):

1. The search field (reuse the Settings search input anatomy — no new token), its
   placeholder, the two match modes.
2. The seven group headers. **The Settings eyebrow rule wins** (`design.md:875-876`:
   Inter 11px/500 uppercase, `letter-spacing 0.06em`, `--text-3`), not the §3
   tokenized `.eyebrow` (`design.md:248-251`). The headers sit inside a Settings tab
   next to the pane's existing eyebrow, which already uses the Settings style inline
   (`KeybindingsPane.vue` header), and siblings must match. The edit says so
   explicitly.
3. The three filter chips (reuse the existing Badge / chip anatomy, §6 Badges;
   active = Accent badge) with counts.
4. The empty-result line.
5. The shield hint line, the terminal-keeps hint line and the recorder's refusal line
   (all `--text-4` 11px, same as the "default ⌘N" reminder).
6. Replace "One row per rebindable action (the 26 …)" with the new count and the
   statement that most rows ship unbound.

Copy (en, `design.md` §8 tone — short labels no trailing period, sentences with one):

| Key                                         | en                                                                     |
| ------------------------------------------- | ---------------------------------------------------------------------- |
| `keybindings.pane.search`                   | Search shortcuts or type a key combo                                   |
| `keybindings.pane.groups.sessions` … `.app` | Sessions · Sidebar · Folders · Views · Panes · Takeovers · App         |
| `keybindings.pane.chips.unbound`            | Unbound                                                                |
| `keybindings.pane.chips.conflicts`          | Conflicts                                                              |
| `keybindings.pane.chips.customized`         | Customized                                                             |
| `keybindings.pane.noMatch`                  | No shortcut matches.                                                   |
| `keybindings.pane.shieldHint`               | Taken from the terminal: the program running there never sees {chord}. |
| `keybindings.pane.terminalKeepsHint`        | The terminal keeps {chord}: it won't fire while a terminal has focus.  |
| `keybindings.pane.unreachable`              | {chord} can't fire for this action. Pick another shortcut.             |

`pt-BR.json` gets the same keys, translated, in the same change.

## 6. `view.closeTakeover` — Esc

### 6.1 Behavior

The binding:

```ts
{
  id: 'view.closeTakeover',
  scope: 'global',
  keys: kb('view.closeTakeover'),
  enabled: () => ui.activeView !== null && !ui.anyPopoverOpen,
  keysGuard: notInTextEntry, // §9.1 — key presses only
  handler: () => ui.closeAllTakeovers()
}
```

The handler is the exact door the X uses (`TakeoverHost.vue:69`), so the Review
takeover's `onClose` still disposes its companion pane (`stores/ui.ts:376-387`).
`menu: false`: an `Esc` accelerator in the native menu would take Esc from every
terminal.

**Why the binding cannot "see whether someone else handled Esc".** Revision 1 proposed
a `skipIfDefaultPrevented` flag; it does not work for real key presses. Chromium runs
a microtask checkpoint after each event listener returns, and Vue's watcher flush is a
microtask. So the `useMagicKeys` window listener (`useShortcuts.ts:202-207`,
registered first, from `App.vue:487`) fires its watcher, and the takeover closes,
**before** any listener registered later on the same target runs. Those later
listeners are the popovers' `onKeyStroke` handlers (`StatusFooter.vue:264/274/316`,
`MissionPill.vue:31`, `ActivityBell.vue:60`, `InboxRail.vue:175`,
`ImageLightbox.vue:94`) plus `CleanupView.vue:129` and `DiagramPane.vue:769`. One Esc
would close the popover _and_ the takeover. jsdom-dispatched events in unit tests can
hide this, so AC-17 and AC-20 also require a live check.

**What wins Esc, and how (U4a / U4b):**

1. **Popovers — gate on store state.** U4a lifts each footer/Topbar popover's open
   flag into `stores/ui.ts` (they are component-local today) and exposes
   `ui.anyPopoverOpen`: fleet usage, Claude status, pasted images, the image lightbox,
   Mission pill, Activity bell, and the Inbox filter. `view.closeTakeover`'s
   `enabled()` is false while it is true. The popover's own bubble-phase `onKeyStroke`
   handler still closes it, so one Esc closes exactly the popover. They are not moved
   to capture on purpose: a capture listener would take Esc from a focused terminal
   whenever a popover is open, and today xterm keeps it.
2. **Takeover-internal state — capture listeners that stop propagation, the dialog
   pattern** (`CardDetailModal.vue:512-518`):
   - `CleanupView.vue:941-950` moves its Esc branch to a window **capture** listener,
     with `stopPropagation` only when it cleared a selection or deselected a block. Its
     existing "skip while a cleanup dialog is open" guard stays. The dialogs register
     later and also listen in capture, so without that guard Cleanup would run first.
   - `DiagramPane.vue:945` does the same for its Esc branch only, still gated by
     `hasFocus()` (`:898`). Its other keys stay on the bubble listener.
   - Element-level handlers already run before any window listener, so they only need
     `stopPropagation` when they consume Esc: `PrStackCanvas.vue:353-363` when it
     cleared a filter, and the Roadmap dispatch-confirm overlay
     (`RoadmapBoard.vue:1344`, add `.stop`).

Edge cases:

| Situation                                                                                                                                                                                                                                              | Result                                                                  | Why                                                                                                                                                                                                                                                                                      |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No takeover open                                                                                                                                                                                                                                       | Nothing; the key passes through                                         | `enabled()` false                                                                                                                                                                                                                                                                        |
| A dialog is open (app dialogs, Settings, Card detail/create, Cleanup's seven confirms, Containers remove)                                                                                                                                              | Esc closes the dialog only                                              | Each dialog's Esc is a window **capture** listener that calls `stopPropagation` (e.g. `CardDetailModal.vue:512-518`, `CleanupGuidedDialog.vue:191`), so the bubble-phase `useMagicKeys` never sees it; app dialogs also push the `'modal'` scope (`App.vue:75-86`)                       |
| Command palette, jump palette, a session / folder / repo-group context menu, the Hidden popover                                                                                                                                                        | Closes that surface only                                                | Capture + `stopPropagation` (`CommandPalette.vue:342`, `SidebarJumpPalette.vue:185`, `SessionMenu.vue:745`, `FolderMenu.vue:702`, `RepoGroupHeader.vue:80`, `SidebarDrillView.vue:194`, `SidebarHiddenPopover.vue:270`)                                                                  |
| A footer / Topbar popover (fleet usage, status, images, lightbox, Mission pill, Activity bell, Inbox filter)                                                                                                                                           | Closes the popover only                                                 | Its bubble-phase `onKeyStroke` closes it; `view.closeTakeover` is disabled while `ui.anyPopoverOpen` (rule 1 above). The flag is still true when the binding's watcher runs, because the popover's listener runs after it                                                                |
| Takeover-internal state: Cleanup selection/block (`CleanupView.vue:941-950`), PR Stack filter clear (`PrStackCanvas.vue:353-363`), Roadmap dispatch confirm (`RoadmapBoard.vue:1344`), Diagram selection beside Roadmap/Review (`DiagramPane.vue:945`) | Esc peels that layer only; the next Esc closes the takeover             | Capture + `stopPropagation`, or element-level `stopPropagation`, when the handler consumed Esc (rule 2 above)                                                                                                                                                                            |
| Focus in a text field inside the takeover (PR Stack filter, Review textareas, Scheduler prompt, Topbar title rename)                                                                                                                                   | The field handles Esc; the takeover stays                               | The binding's `keysGuard` (`notInTextEntry`); several fields also `.stop` (`PrStackFilterBar.vue:335`, `ReviewPane.vue:728/774`, `SchedulerPromptField.vue:114-120`)                                                                                                                     |
| Focus in a terminal — a helper xterm beside Roadmap or Review (`App.vue:407-411`)                                                                                                                                                                      | Esc goes to the program (Claude Code uses it to cancel); takeover stays | xterm emits ESC and cancels the event (`@xterm/xterm/src/common/input/Keyboard.ts:105-111`, `browser/CoreBrowserTerminal.ts:1321-1328`). The main terminal cannot hold focus under a takeover (`App.vue:397-401` blurs it; its layer is `inert`). No shield is added for Esc, on purpose |
| Folder View                                                                                                                                                                                                                                            | Nothing                                                                 | It is selection-driven, not a takeover (`design.md` §6 "Takeover dismissal")                                                                                                                                                                                                             |
| Settings recording a chord                                                                                                                                                                                                                             | Recording cancels; Settings stays (§4 fix)                              | —                                                                                                                                                                                                                                                                                        |

`design.md` §6 "Takeover dismissal" (`design.md:4256-4257`) must be corrected in U4b:
Esc dismisses through the `view.closeTakeover` binding (rebindable), not through
`closeAll()`. `ui.closeAll()` is either deleted (it is unwired) or kept for tests; the
implementer decides and says which in the PR. U4b also reconciles two user docs that
already promise Esc: `docs/user/cleanup.md:13` (Esc closes Cleanup — true once this
ships) and `docs/user/canvas.md:73` (Esc clears the canvas selection — still true, now
without also closing a takeover behind it). The TakeoverShell X tooltip becomes
"Close (Esc)" through §9.2.

## 7. Terminal interaction

### 7.1 What xterm does with each key (facts the defaults rest on)

From `@xterm/xterm` 6.0.0 (`src/common/input/Keyboard.ts`, `src/browser/CoreBrowserTerminal.ts`):

- **Ctrl+letter** (no Shift/Alt/Meta) → a C0 control byte to the PTY, event cancelled
  (`Keyboard.ts:308-310`; cancel at `CoreBrowserTerminal.ts:1095-1099`). Ctrl+J is
  LF (0x0A).
- **Ctrl+Shift+letter** → no data (`Keyboard.ts:308` requires `!ev.shiftKey`), so
  `_keyDown` returns `true` without cancelling (`CoreBrowserTerminal.ts:1066-1068`) and
  the event bubbles to `window`, except the chords `terminalKeymap.ts` swallows (next
  bullet).
- **`terminalKeymap.ts` swallows** (`preventDefault` + `stopPropagation`,
  `terminalKeymap.ts:66-70`) ⌘C / ⌘V and Ctrl+Shift+C / Ctrl+Shift+V (`:77-87`),
  Shift+Enter (`:92-101`), Ctrl+Backspace and Shift+Backspace (`:105-114`), and
  Ctrl/⌘ with `=`, `-` or `0` (`:117-130`). Any of these bound to an app action is
  **dead while a terminal has focus** unless the action is shielded. The pane's
  terminal-keeps hint (§5.2) and `docs/user/sessions.md` say so.
- **⌘+letter on macOS** → no data except ⌘A (select all); bubbles.
- **``Ctrl+` ``** (keyCode 192) → matches no branch; no data; bubbles.
- **F1–F12, Escape, Enter (with or without Ctrl/⌘)** → an escape sequence or CR to the
  PTY, cancelled.
- **Linux/Windows menu accelerators fire only for a key the page left unhandled**
  (`App.vue:807-812`, `menu.ts:203-210`) — so any key xterm cancels never reaches the
  native menu either.
- **Consequence, stated as fact (formerly OQ-1):** on Linux/Windows a menu-backed
  Ctrl+letter chord does **not** fire while a terminal has focus. xterm sends the
  control byte (Ctrl+N → `^N`) and cancels the event (`Keyboard.ts:308-310`,
  `cancel()` at `CoreBrowserTerminal.ts:1095-1099`), and the `onNavKeydown` comment
  (`App.vue:807-812`) records that an accelerator never fires for a key xterm handled.
  Conversely a renderer-only Ctrl+Shift+letter chord (`Cmd+Shift+A`) **does** fire.
  So T1's "not in terminal" marker, now `isNotInTerminal(d)`, is accurate only on
  macOS. Fixing it is a follow-up (a pure `reachesOverTerminal(chord, d, mac)`
  modeled on this section); a live check on Linux is optional confirmation, not a
  prerequisite.

### 7.2 What each new default does over a focused terminal

| Default                      | Over a focused terminal (Linux/Windows) | Over a focused terminal (macOS) | Loses anything?                                                        |
| ---------------------------- | --------------------------------------- | ------------------------------- | ---------------------------------------------------------------------- |
| `Cmd+Shift+F` jump           | Fires (bubbles)                         | Fires (bubbles)                 | No — xterm sends nothing                                               |
| `Esc` close takeover         | Program gets ESC                        | Program gets ESC                | No — not shielded                                                      |
| `F6` / `Shift+F6` pane focus | Fires (shield)                          | Fires (shield)                  | Yes: F6 no longer reaches the program. No common TUI binding; accepted |
| `Cmd+Shift+M` maximize       | Fires (bubbles)                         | Fires (bubbles)                 | No                                                                     |
| `Cmd+Enter` open to side     | Program gets CR                         | Program gets CR                 | No — not shielded; fires only outside a terminal                       |
| `Shift+F10` context menu     | Program gets the F10 sequence           | same                            | No — not shielded                                                      |
| `F2` rename folder           | Program gets F2                         | same                            | No                                                                     |
| `Cmd+Alt+S` settings tab     | Program gets ESC+^S; menu does not fire | Native menu fires               | No                                                                     |

On a Mac keyboard the F-key defaults (`F2`, `F6`, `Shift+F6`, `Shift+F10`) fire only
with **Fn** held unless the user turned on "Use F1, F2, etc. keys as standard function
keys" (F2 is brightness, F6 Do Not Disturb on Apple Silicon, F10 mute). None collides
with a system shortcut, so they stay as defaults; `docs/user/sessions.md` and the pane's
macOS hint say "Fn+F6". `F2` is not VS Code parity on macOS (VS Code renames with
Enter there); it stays because Enter is `sidebar.cursor.activate`. `F11`
(`app.fullscreen`, reserved, from T1) is Show Desktop with Fn on macOS and never
fires; a `Ctrl+Cmd+F` mac default is cheap once `defaultKeysMac` lands (U5a) and is a
follow-up, not part of this card. A mac-specific default for the F-key actions would
need `defaultKeysMac` earlier than U5a; this card does not take that on.

`Cmd+Alt+S` is not VS Code parity either (Save All there on macOS), and Ctrl+Alt is
AltGr on some Windows layouts (Polish AltGr+S types ś); it is already accepted, and
the Windows manual pass (AC-48) checks it on such a layout.

`session.fork` ships unbound, so it has no row here. A user who binds `Cmd+D` gets
Ctrl+D (EOF) inside a terminal on Linux/Windows, a fork elsewhere, and on macOS a fork
over the terminal too (⌘D bubbles); the Diagram pane's own ⌘D wins inside that pane
(§3.10).

### 7.3 `terminal.toggle` and the Ctrl+J hazard

`terminal.toggle` **ships unbound** (operator decision, 2026-10-14). Whoever binds it
must know:

- It is **shielded** (§7.4): whatever chord it holds is caught on `window` in the
  capture phase, before xterm, in every terminal pane. That is required — state 2 of
  §8.2 ("already focused → collapse") happens _while a terminal has focus_, and xterm
  would otherwise eat the key.
- **Binding it to `Ctrl+J` (or `Cmd+J` read on Linux/Windows) takes LF from every
  terminal.** In Claude Code LF inserts a newline; in bash/zsh readline it is
  accept-line (runs the command); in vim insert mode it is a newline. `Shift+Enter`
  still sends LF (`terminalKeymap.ts:92-101`), so Claude Code users keep a newline key;
  shell users lose Ctrl+J as an Enter alias.
- `Cmd+J` on macOS is safe (xterm ignores ⌘J). ``Ctrl+` `` is safe everywhere: xterm
  produces nothing for it. The shield matches the **physical** key (`e.code`, via
  `chordFromEvent`), so on a non-US layout it is the key in the US backquote position;
  a dead-key layout cannot break it.
- The pane shows the shield hint (§5.2) on the row once a chord is bound; the user docs
  (`docs/user/sessions.md`) get the same warning. The docs write the safe chord as
  ``Ctrl+` `` and never ``Cmd+` ``: every default in this spec is written `Cmd+…`, so
  readers copy it, and ⌘` is macOS's "move focus to next window" and never reaches
  Harnu.

### 7.4 The generic shield (U5a)

A descriptor field `shield: true` on `pane.focusNext`, `pane.focusPrev`,
`terminal.toggle`, `nav.back`, `nav.forward`. One window **capture** `keydown` listener
in `App.vue` replaces `onNavKeydown` (`App.vue:818-831`):

1. Return unless `activeScope() === 'global'` (dialogs, palette, menus keep their keys).
2. Build the event's chord with `chordFromEvent(e, { mac: isMac })` and compare its
   `scopeChordKey('global', …, isMac)` with each shielded action's resolved chord.
3. On a match:
   - **menu-backed and off macOS** (`nav.*`): `stopPropagation()` only. The key stays
     _unhandled_, so the native accelerator fires and dispatches through
     `shortcut:fired`; and not calling `preventDefault` keeps the Alt release from
     toggling the auto-hidden menu bar — today's `onNavKeydown` contract, now driven by
     the resolved chord instead of a literal Alt+←/→.
   - **otherwise**: `preventDefault()` + `stopPropagation()` +
     `dispatchShortcut(id, 'shield')`, a new export of `useShortcuts` that runs
     `dispatch` (honoring `enabled()` and the menu/keys coalescing — `'shield'` is a
     third source; `keysGuard` does not apply to it, §9.1).
4. Shielded renderer-only actions get **no** `useMagicKeys` watcher, so one press
   dispatches once.

Known limit, documented in the pane hint: a user who binds a shielded renderer-only
action to an Alt chord off macOS may see the menu bar toggle on Alt release (the
`preventDefault` branch).

## 8. Panes

### 8.1 Pane focus model — `pane.focusNext` / `pane.focusPrev`

There is no focused-pane concept today (`stores/helpers.ts` has none; nothing moves
focus between the main terminal and helper panes). `useTerminalFocus`
(`composables/useTerminalFocus.ts`) already tracks which **xterm** pane ids hold focus
(`MAIN_PANE_ID = 'main'` + helper ids); U5b generalizes it into a pane-focus registry:

- Every focus region registers `{ id, el, focus(), close?() }`: the main
  `TerminalPane` (`'main'`, `focus` = `live.term.focus()`, `TerminalPane.vue:946`);
  each `HelperPane` (`live.term.focus()`, `HelperPane.vue:249`); `MarkdownPane`,
  `MemoryPane`, `ExplorerPane` (root element with `tabindex="-1"`); `DiagramPane`
  (`focusBody`, `DiagramPane.vue:903`). Each root carries `data-focus-region="<id>"`.
  `close` is the pane's own close handler, so discard guards hold (`MarkdownPane.vue:552`,
  `DiagramPane.vue:982`).
- **The ring** is a pure function (`lib/pane-ring.ts`, unit-tested) of app state:
  1. `'main'` when `showTerminalForeground` (`App.vue:376-378`);
  2. then the current worktree's helper panes in stack order, when the helper stack is
     shown (`showHelperStack`, `App.vue:407-411`) and not collapsed
     (`layout.helperCollapsed`); while a pane is maximized
     (`helpers.maximizedPaneIdForCurrentWorktree`, `stores/helpers.ts:296`), only that
     pane (the others are 24px headers).
- **Current** = the region whose element contains `document.activeElement`.
- `pane.focusNext`: current found → next, wrapping; not found (focus in the sidebar,
  Topbar, a takeover body, `<body>`) → first. `pane.focusPrev` mirrors it (not found →
  last). Empty ring → no-op. A ring of one re-focuses it.
- Shielded (§7.4) so it works from inside a terminal — the main use. Works from a text
  field too (VS Code does the same). Inert under `'modal'` scope.
- Takeover open: the main terminal is not in the ring; helper panes beside Roadmap /
  Review are. A takeover with no helper stack (Usage Dashboard, Cleanup, …) → empty ring.
- Non-xterm panes need a visible focus indicator (`design.md` §6 addition, U5b): a
  1px `--accent-line` inset outline on the pane root when it holds focus. xterm panes
  show their own cursor and need none.

### 8.2 `terminal.toggle`

Precondition: `helpers.currentWorktreePath` is set (else no-op). `shell` = the first
`type: 'shell'` pane in the current stack.

1. **No shell pane** → `helpers.addShellHelper(wt, wt)` (`stores/helpers.ts:696`). The
   add reveals a collapsed panel (`paneRevealTick`, `App.vue:440-443`) and the new
   xterm focuses itself on create (`HelperPane.vue:462`).
2. **Shell pane exists and holds focus** → `layout.setHelperCollapsed(true)`; focus
   moves to `'main'` when it is in the ring, else focus is left on `<body>`.
3. **Shell pane exists, not focused** → `layout.setHelperCollapsed(false)`; if another
   pane is maximized, restore it; focus the shell pane.

Notes: "collapse" hides the **whole** helper panel — Harnu has no per-pane collapse,
unlike VS Code's panel. `folder.newTerminal` keeps its current behavior (always appends
a new shell pane, `stores/helpers.ts:696` has no dedup — the `shell` registry entry
has no `dedupKey`, `lib/pane-registry.ts:64-67`); `terminal.toggle` is the reuse path.
If a takeover that does not host the helper stack covers the main pane (anything but
Roadmap / Review), states 1 and 3 call `ui.closeAllTakeovers()` first — the same
"focusing means dismiss" rule `sessions.select()` follows (`design.md` §6).

### 8.3 `session.contextMenu` — Shift+F10

- Target (§3.10): cursor row → selected session → active folder.
- Session target → `ui.openMenu({ sessionId, x, y })`; folder target →
  `ui.openFolderMenu({ projectPath, x, y })`. `x, y` = the row element's bounding
  rect, bottom-left — the keyboard-anchor fallback `SidebarDrillView.vue:108-114`
  already uses. Rows gain `data-sidebar-row="<kind>:<id>"` so the handler can find the
  rect; a row not in the DOM falls back to the sidebar's top-left; a collapsed sidebar
  falls back to the Topbar title.
- The menus already support the keyboard once open: `SessionMenu.vue:743-769` (Esc,
  ↑/↓, Enter, focus on item 0), `FolderMenu.vue:700-766` (plus → / Enter into flyouts).
- **Group cursor row → documented no-op (scope decision).** The repo-group menu is
  component-local state (`RepoGroupHeader.vue:45`, `SidebarDrillView.vue:151-224`), not
  in the `ui` store, so a keyboard opener cannot reach it. This card leaves it a
  no-op and says so in `docs/user/sessions.md`; the group's own actions are still
  bindable (`repoGroup.*`, §3.4). Lifting the state into the store is a follow-up.
- Shift+F10 is not shielded: with a terminal focused it belongs to the program.
- Chromium may also synthesize a native `contextmenu` event for Shift+F10 at the
  focused element (§13 OQ-3). Both paths end in the `ui` store's menu mutex, so at most
  one menu can be open; AC-34 checks it.

### 8.4 `pane.toggleMaximize` / `pane.close`

- `pane.toggleMaximize` (`Cmd+Shift+M`, accepted by the operator 2026-10-14): focused
  helper pane → `toggleMaximizePane(wt, id)`; focus stays in it. No helper pane focused but one is maximized → restore it.
  Otherwise no-op. (The card left the chord to the spec: VS Code has no single-chord
  default for this; ⌘⇧M / Ctrl+Shift+M is free in Harnu, and as a Shift+letter chord it
  bubbles out of xterm, so it needs no shield.)
- `pane.close` (unbound): the focused pane's registered `close()`; focus then moves to
  the next ring region, else `'main'`.

## 9. Command palette and tooltips

### 9.1 Table-driven palette (U6)

Replace the six hand-written actions (`CommandPalette.vue:176-235`) with rows generated
from the table:

- **Source**: every descriptor with `palette !== false` that has a renderer
  registration. `palette: false` on: `app.search`, `project.switch` (both just open the
  palette), `view.fleetRail` (alias of `inbox.toggle`), `sidebar.cursor.*`,
  `session.contextMenu`, `pane.focusNext`, `pane.focusPrev`, `pane.toggleMaximize`,
  `pane.close` (focus-dependent: the palette's focus trap restores focus on close,
  `useFocusTrap`, so "the focused pane" is not knowable at activation), and the
  main-only reserved ids (`app.reload`, `app.devtools`, `app.quit`, `app.fullscreen`;
  `app.openKeybindings` stays — it has a renderer handler).
- **Visible**: only rows whose registration's `enabled()` is true when the palette
  renders (`isShortcutEnabled(id)`, new export of `useShortcuts`).
- **`enabled()` vs `keysGuard` — the split that makes "visible" honest.** While the
  palette is open its input holds focus, and `activate()` runs the handler _before_
  `close()` (`CommandPalette.vue:331-334`). If text-entry checks lived in `enabled()`,
  every action guarded by `!isTextEntryTarget()` — `session.openToSide`,
  `folder.rename`, `view.closeTakeover`, all sidebar and selection actions, and
  `session.fork` once bound — would read as disabled and be hidden. So U2 splits the
  binding's predicates:
  - `enabled(): boolean` — **context only** (a selection exists, a takeover is open,
    no popover is open, …). Evaluated for every source: keys, menu, shield, palette.
  - `keysGuard?: () => boolean` — **focus conflicts only** (`notInTextEntry`, plus
    `session.fork`'s Diagram-pane yield). `dispatch` evaluates it only when the source
    is `'keys'`, where the press really came from the focused element. It never runs
    for `'menu'` (a native accelerator already fires in text fields today), `'shield'`
    (F6 deliberately works from a text field), or `'palette'`.
    U2 moves the existing `!isTextEntryTarget()` clauses of `sidebar.cursor.*`
    (`App.vue:741-773`) into `keysGuard`, and moves `isTextEntryTarget` into
    `lib/text-entry.ts` as `notInTextEntry`. The palette keeps today's activation order
    (handler, then close). A handler that opens another floating surface (the jump
    palette, a dialog) relies on the existing `ui` mutex, exactly as `action:addFolder`
    does today.
- **Label**: `t(labelKey)`. **Accelerator**: the resolved chord rendered for the
  platform (the existing `Item.accelerator` slot, `CommandPalette.vue:98-99,493-496`),
  live through `keybindings.resolved`.
- **Activation**: `invokeShortcut(id)` — a new `useShortcuts` export that runs the
  first `'global'` registration for `id`, checking `enabled()` but **not** `keysGuard`
  and **not** the active scope (the palette's own `'modal'` scope is still on the stack
  at activation). Coalescing does not apply (source `'palette'`).
- **Empty query** shows only `paletteFeatured` rows — `session.new`, `folder.add`,
  `session.resumeLast`, `inbox.toggle`, `inbox.open`, i.e. today's set minus
  `project.switch` — so the empty palette does not become a 90-row list. Typing
  searches every eligible row (the existing fuzzy matcher, on the label).
- **Icon**: one icon per group (Sessions `Sparkles`, Sidebar `Search`, Folders
  `Folder`, Views `LayoutGrid`, Panes `PanelRight`, Takeovers `Maximize2`, App
  `Command`), recorded in `design.md` §6 "Command palette" (`design.md:6922`).
- Recents, Folders and Sessions sections are unchanged. The `palette.actions.*` i18n
  keys the six rows used are deleted from both locales.
- This fixes the drift in §1 (item 3) by construction: "Resume last session" now runs
  `App.vue`'s handler.

### 9.2 Chords in tooltips (U6)

Every button below appends its action's resolved chord to its native `title`
(Harnu's tooltips are all native `title` attributes — there is no tooltip component):
`"Toggle the left sidebar (Ctrl+B)"` style (`⌘B` on macOS), via `keybindings.withChord(label, id)` →
`t('keybindings.withChord', { label, chord })` = `"{label} ({chord})"`; with no chord,
the plain label. Reactive on `keybindings.resolved`, so a rebind updates every tooltip
live.

| Button                                                      | Title at                                                                           | Action                                                                                           |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Sidebar toggle                                              | `Topbar.vue:279`                                                                   | `view.toggleSidebar`                                                                             |
| New session here                                            | `Topbar.vue:396`                                                                   | `session.newInFolder`                                                                            |
| Roadmap / PR Stack / Review                                 | `Topbar.vue:413`, `:429`, `:447`                                                   | `view.roadmap`, `view.prStack`, `view.review`                                                    |
| Open folder / VS Code / GitHub pulls / Browse files / Split | `Topbar.vue:458`, `:468`, `:481`, `:491`, `:501`                                   | `folder.openInFileManager`, `.openInVSCode`, `.openGithubPulls`, `.browseFiles`, `.newTerminal`  |
| Helper panel toggle                                         | `Topbar.vue:515`                                                                   | `view.toggleHelper`                                                                              |
| Mission pill / Activity bell                                | `MissionPill.vue:103`, `ActivityBell.vue:216`                                      | `view.missionProgress`, `view.activity`                                                          |
| Rescan / drill / collapse all / hidden / search             | `Sidebar.vue:270`, `:285`, `:297`, `:312`, `:343`                                  | `sidebar.rescan`, `.cycleDrillDepth`, `.toggleCollapseAll`, `.hiddenFolders`, `.jump`            |
| Settings (footer)                                           | `Sidebar.vue:475`                                                                  | `view.settings`                                                                                  |
| New session (+) on a folder row                             | `SidebarFolder.vue:636`                                                            | `session.newInFolder`                                                                            |
| Images / status / heap / cleanup / scheduler                | `StatusFooter.vue:435`, `:492`, `HeapGauge.vue:42`, `StatusFooter.vue:534`, `:564` | `view.pastedImages`, `view.claudeStatus`, `view.systemMonitor`, `view.cleanup`, `view.scheduler` |
| Inbox expand / order / minimize                             | `InboxRail.vue:291`, `:431`, `:538`                                                | `inbox.open`, `inbox.toggleOrder`, `inbox.toggle`                                                |
| Takeover close X                                            | `TakeoverShell.vue:43-44`                                                          | `view.closeTakeover`                                                                             |
| Pane maximize / close                                       | `HelperPane.vue:828-848` and the four pane twins                                   | `pane.toggleMaximize`, `pane.close`                                                              |

Context-menu items already show chord hints only for rename (`SessionMenu.vue:464-468`
and `:870-875`). U6 extends the same hint slot to every menu item that now has an id
with a resolved chord (Rename folder → `F2` by default; Fork only once the user binds
it), and replaces the "no `shortcut` hint until … a real global Cmd+D binding" comment
at `SessionMenu.vue:520-522` with the resolved-chord lookup.

U6 also rewrites the palette paragraph of `docs/user/sessions.md` (`:89-91`), which
says the palette offers "a fixed set of actions"; after U6 that is false.

`design.md` §6 "Keyboard shortcuts (`<kbd>`)" gains the tooltip rule: _a button whose
action has a resolved chord appends it in parentheses to its tooltip; never a literal._

## 10. Chord grammar: no sequences; `nav.*` rebindable

**Sequences are not supported, and this card does not add them.**
`parseChord` returns `sequence-unsupported` for any whitespace in the string
(`keybindings-core.ts:469`); `resolveKeybindings` turns that into a warning and drops
the entry (`:896-901`); `useShortcuts` wires one `useMagicKeys` combo per chord with no
pending-prefix state (`useShortcuts.ts:456-491`); and an Electron accelerator is a
single chord. So `Ctrl+K Ctrl+S` cannot be a default. `view.settings.keybindings` gets
the single chord **`Cmd+Alt+S`** (proposed by the spec, accepted by the operator
2026-10-14) (S for shortcuts; next
to the reserved `Cmd+Alt+K` that opens the raw file), **menu-backed**: a new native
**"Keyboard Shortcuts…"** item (under **View** on Linux/Windows; on macOS right after
`Settings…` in the app menu, `menu.ts:94-105`, where Mac users look for preferences). The existing View item that opens the JSON
(`menu.ts:297-304`, `app.openKeybindings`) is relabeled **"Open keybindings.json"**,
mirroring VS Code's "Keyboard Shortcuts" vs "Keyboard Shortcuts (JSON)". Menu-backed
also sidesteps a renderer trap on macOS: Option changes `e.key` for letters, which can
leave a renderer-only `Cmd+Alt+<letter>` watcher dead (§5.2, confirmed from code). Note
`ui.openSettings('keybindings')` does not switch tabs if Settings is already open
(`SettingsDialog.vue:878-882` reads the tab only on open) — and with Settings open the
`'modal'` scope blocks the binding anyway, so the chord is inert there.

**`nav.back` / `nav.forward` become rebindable (U5a). Cost: moderate, ~150–200 lines.**
They are fixed today because the default is platform-split (`menu.ts:11-18`):
`Cmd+[` / `Cmd+]` on macOS, `Alt+Left` / `Alt+Right` elsewhere, and the off-macOS chord
needs a capture-phase handler (`App.vue:818-823`). What it takes:

1. Descriptor field `defaultKeysMac?: string | null` and one helper
   `defaultKeysFor(d, mac)`. Every reader of `defaultKeys` switches to it:
   `resolveKeybindings` (`keybindings-core.ts:921`, and the reserved set at `:800`),
   `menu.ts`'s `accel()` (`menu.ts:53`), the pane's "default" reminder, EmptyState.
   `ResolvedBinding.defaultKeys` becomes the platform default.
2. Two table rows with `menu: true`, `shield: true`; `menu.ts:211-220` reads `a('nav.back')`
   / `a('nav.forward')`; the `ShortcutActionId` widening at `menu.ts:29` goes away.
3. `App.vue`'s two nav bindings read `kb()`; `onNavKeydown` is deleted — the generic
   shield (§7.4) reproduces it from the resolved chord.
4. Tests: platform-split default resolution, a mac-written override loading unchanged
   on Linux, the shield's no-`preventDefault` branch.

Mouse buttons 3/4 (`App.vue:794-802`) stay fixed — they are not keybindings.

## 11. Implementation plan — stacked units

Each unit is one PR of ≤ ~500 lines, stacked on the previous (`create_worktree` with
`base` = the previous unit's branch). Every unit touches the four hub files —
`src/main/keybindings-core.ts`, `src/renderer/src/App.vue`, `en.json` and `pt-BR.json`
— so no two units can share a wave: **one unit per wave, eight waves.** Each hub file
therefore has exactly one owner per wave. The shared non-hub files are also touched
by one unit per wave:

- `src/main/menu.ts`: U4b, then U5a.
- `composables/useShortcuts.ts`: U2 (`keysGuard`), U5a (`dispatchShortcut`), U6
  (`invokeShortcut`, `isShortcutEnabled`).
- `stores/ui.ts`: U4a (popover state), U4b (`SETTINGS_TAB_IDS`, `closeAll`).
- `stores/keybindings.ts`: U1 (`recordingId`), U6 (`withChord`).
- `KeybindingsPane.vue`: U1, U5a.
- `docs/user/sessions.md`: U2, U3, U4a, U4b, U5a, U5b, U6.

Each unit carries its own `CHANGELOG.md` entry, its `design.md` §6 edits **before** its
UI change, and its `docs/user/` edits. None touches `src/main/mcp/tool-catalog.ts`, so
no `docs/harnu-features.md` bump (T1 precedent; T485 owns the agent-facing side).

| Wave | Unit                                    | Scope                                                                                                                                                                                                                                                                               | Files owned (beyond the hubs)                                                                                                                                                                                                                                                                                                                                                                                    | ACs                                                       | Depends on |
| ---- | --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- | ---------- |
| 1    | **U1 — labels + pane**                  | §4 fix (`labelKeyFor`, locale key rename) and the Esc-while-recording bug; §5.1 fields (`group`, `palette`, `paletteFeatured`) + `def()` for the existing 31 rows; pane search / groups / chips; recorder refuses unreachable chords (`!menu` rule)                                 | `KeybindingsPane.vue`, `SettingsDialog.vue` (Esc guard only), `stores/keybindings.ts`, `design.md` §6 Keyboard Shortcuts, `docs/user/settings.md`, `tests/keybindings-labels.test.ts`, `tests/keybindings-pane-view.test.ts`                                                                                                                                                                                     | AC-1–AC-8, AC-10, AC-50                                   | —          |
| 2    | **U2 — sessions + sidebar**             | §3.2 + §3.3 new ids (20); `enabled()` / `keysGuard` split (§9.1) incl. migrating `sidebar.cursor.*`; `useSessionActions` extracted from `SessionMenu.vue` (menu and bindings call it); `session.contextMenu` anchoring + `data-sidebar-row`; `sidebar.jump`'s two rules             | `composables/useShortcuts.ts`, `lib/text-entry.ts` (new), `composables/useSessionActions.ts` (new), `SessionMenu.vue`, `Sidebar.vue`, `SidebarFolder.vue`, `RepoGroupHeader.vue` (row attribute only), `design.md` §6 `<kbd>` table + Sidebar jump palette, `docs/user/sessions.md`                                                                                                                              | AC-11–AC-14 (these ids), AC-15, AC-32–AC-34, AC-37, AC-52 | U1         |
| 3    | **U3 — folders + repo groups**          | §3.4 new ids (21); `useFolderMenuActions(path)` extracted from `FolderMenu.vue` / `RepoGroupHeader.vue`; `folder.rename` F2                                                                                                                                                         | `composables/useFolderMenuActions.ts` (new), `FolderMenu.vue`, `RepoGroupHeader.vue`, `SidebarDrillView.vue` (group menu shares the extraction), `docs/user/sessions.md`                                                                                                                                                                                                                                         | AC-11–AC-14 (these ids), AC-35, AC-37                     | U2         |
| 4    | **U4a — views + popover state**         | §3.5 inbox and popover ids (9: `inbox.open`, `.toggleOrder`, `.filter`, `.showAll`, `view.activity`, `.missionProgress`, `.pastedImages`, `.claudeStatus`, `.usagePanel`); each popover's open flag (and the lightbox's) lifted into `stores/ui.ts`; `ui.anyPopoverOpen`            | `stores/ui.ts`, `ActivityBell.vue`, `MissionPill.vue`, `StatusFooter.vue`, `ImageLightbox.vue`, `InboxRail.vue`, `docs/user/sessions.md`                                                                                                                                                                                                                                                                         | AC-11–AC-14 (these ids), AC-37, AC-54                     | U3         |
| 5    | **U4b — takeovers, Esc, Settings tabs** | §3.6 new ids (5); `view.closeTakeover` per §6.1 (store gate + capture / `stopPropagation` edits); `view.settings.keybindings` + 19 `view.settings.<tab>` ids from `SETTINGS_TAB_IDS`; native View item + relabel; `app.openKeybindings` label change                                | `stores/ui.ts` (`SETTINGS_TAB_IDS`, `closeAll`), `CleanupView.vue`, `DiagramPane.vue` (Esc branch only), `PrStackCanvas.vue`, `RoadmapBoard.vue`, **`src/main/menu.ts`**, `design.md` §6 Takeover dismissal, `docs/user/sessions.md`, `docs/user/cleanup.md`, `docs/user/canvas.md`                                                                                                                              | AC-11–AC-14 (these ids), AC-16–AC-21, AC-36, AC-37, AC-49 | U4a        |
| 6    | **U5a — shield + nav**                  | §7.4 shield replacing `onNavKeydown`; `dispatchShortcut`; core fields `shield`, `defaultKeysMac`, helpers `defaultKeysFor`, `isNotInTerminal`; `nav.*` rows (§10); `TERMINAL_KEYMAP_CHORDS` export; pane shield / terminal-keeps hints; recorder rule widened to `!menu && !shield` | `composables/useShortcuts.ts`, `lib/terminalKeymap.ts` (data export only), `KeybindingsPane.vue`, `EmptyState.vue` (`defaultKeysFor`), **`src/main/menu.ts`**, `design.md` §6 `<kbd>` nav rows + hint lines, `docs/user/sessions.md`                                                                                                                                                                             | AC-9, AC-44, AC-45, AC-51, AC-53                          | U4b        |
| 7    | **U5b — panes + terminal toggle**       | pane-focus registry + `lib/pane-ring.ts`; §3.7 ids (5); `terminal.toggle` (§8.2)                                                                                                                                                                                                    | `composables/useTerminalFocus.ts` (→ pane-focus registry), `lib/pane-ring.ts` (new), `TerminalPane.vue`, `HelperPane.vue`, `MarkdownPane.vue`, `MemoryPane.vue`, `ExplorerPane.vue`, `DiagramPane.vue` (register only), `design.md` §6 helper-pane focus indicator, `docs/user/sessions.md` (Ctrl+J hazard)                                                                                                      | AC-11–AC-14 (these ids), AC-22–AC-31                      | U5a        |
| 8    | **U6 — palette + tooltips**             | §9.1 generated palette (`invokeShortcut`, `isShortcutEnabled`); §9.2 tooltips (`withChord`) on every listed button; menu-item chord hints                                                                                                                                           | `CommandPalette.vue`, `composables/useShortcuts.ts`, `stores/keybindings.ts` (`withChord`), `Topbar.vue`, `Sidebar.vue`, `SidebarFolder.vue`, `StatusFooter.vue`, `HeapGauge.vue`, `InboxRail.vue`, `MissionPill.vue`, `ActivityBell.vue`, `TakeoverShell.vue`, `SessionMenu.vue`, `FolderMenu.vue`, the five pane headers, `design.md` §6 Command palette + `<kbd>` tooltip rule, `docs/user/sessions.md:89-91` | AC-38–AC-43                                               | U5b        |

AC-46–AC-48 apply to every unit.

Size notes: U4 and U5 are pre-split (revision 2). U4b and U2 are the largest
remaining. U4b's 20 Settings-tab rows are one `def()` line each plus one generated
registration, so they cost ~45 lines with the locale keys. If U2 passes ~500 lines,
`session.contextMenu` (the anchoring work) moves into U3 and nothing else moves.

Why this order: U1 must come first (every later label depends on `labelKeyFor`, and the
pane must be usable before the table grows to 113 rows). U2 lands the `keysGuard` split
that every guarded action after it relies on. U4b's Esc gate needs U4a's
`ui.anyPopoverOpen`. U5b's `terminal.toggle` needs U5a's shield. U6 must be last so the
palette and tooltips cover the whole table.

## 12. Acceptance criteria

- [ ] AC-1 — Every Settings → Keyboard Shortcuts row, conflict badge and capture `aria-label` shows the human label in `en` and `pt-BR`; no rendered text starts with `keybindings.actions.` — verify: test
- [ ] AC-2 — Every descriptor's `labelKey` comes from `labelKeyFor`, resolves to a non-key string in both locales, and is unique — verify: test
- [ ] AC-3 — Esc while a row is recording cancels the recording and leaves Settings open — verify: test
- [ ] AC-4 — Typing text in the pane's search keeps only rows whose label (active locale), rendered chord or id contains it, case-insensitively; `delete` finds "Delete the session…" although `session.delete` is unbound — verify: test
- [ ] AC-5 — Typing a chord (`Ctrl+J`, `ctrl+shift+f`, `F6`, `⌘K`) keeps exactly the rows whose resolved chord equals it under the platform fold; a bare named key (`delete`, `left`) returns the union of the chord and text matches — verify: test
- [ ] AC-6 — Rows appear under Sessions, Sidebar, Folders, Views, Panes, Takeovers, App, in that order; empty groups are hidden — verify: test
- [ ] AC-7 — The Unbound, Conflicts and Customized chips each filter by their rule, show a whole-table count, and AND with each other and the search — verify: test
- [ ] AC-8 — A search with no match shows "No shortcut matches." — verify: test
- [ ] AC-9 — A shielded action with a chord shows the shield hint naming that chord — verify: test
- [ ] AC-10 — `design.md` §6 Keyboard Shortcuts section documents search, groups, chips, empty line and shield hint before the UI ships — verify: review
- [ ] AC-11 — Every id in §3 exists in `KEYBINDINGS` with its §3 group, default, `menu` and `shield` values; every other new id ships `defaultKeys: null` — verify: test
- [ ] AC-12 — Every non-reserved table id has exactly one `'global'` registration in `App.vue` (an enumeration test) — verify: test
- [ ] AC-13 — `resolveKeybindings(null)` reports zero conflicts and no default lands on a reserved chord, on both platform folds — verify: test
- [ ] AC-14 — The §3.9 actions have no table id — verify: review
- [ ] AC-15 — `Cmd+Shift+F` (Ctrl+Shift+F off macOS) opens the jump palette from the global scope, including with a terminal focused; a second press closes it; a collapsed sidebar is expanded first — verify: test + manual
- [ ] AC-16 — Esc with a takeover open and focus outside a text field and a terminal closes it exactly like the X, including Review companion disposal — verify: test
- [ ] AC-17 — Esc with a dialog, palette, menu, jump palette or popover open closes only that surface, including a popover open over a takeover — verify: test + manual (live app: jsdom does not reproduce Chromium's per-listener microtask checkpoint, §6.1)
- [ ] AC-18 — Esc typed in a helper terminal beside Roadmap or Review reaches the program and the takeover stays — verify: manual
- [ ] AC-19 — Esc in a text field inside a takeover never closes the takeover — verify: test
- [ ] AC-20 — Esc consumed by takeover-internal state (Cleanup selection, PR Stack filter, Roadmap dispatch confirm, Diagram selection) peels that layer only; the next Esc closes the takeover — verify: test + manual (live app, same reason as AC-17)
- [ ] AC-21 — `design.md` §6 "Takeover dismissal" describes Esc through `view.closeTakeover`, not `closeAll()` — verify: review
- [ ] AC-22 — F6 moves focus main terminal → helper panes in stack order → wrap; Shift+F6 reverses; both work while an xterm holds focus — verify: test (ring) + manual (terminal)
- [ ] AC-23 — The ring excludes a covered main terminal, a collapsed panel and non-maximized panes while one is maximized; focus outside the ring goes to the first (F6) or last (Shift+F6) region; an empty ring is a no-op — verify: test
- [ ] AC-24 — F6 / Shift+F6 do nothing while the `'modal'` scope is active — verify: test
- [ ] AC-25 — A focused non-xterm pane shows the `design.md` focus indicator — verify: visual
- [ ] AC-26 — `Cmd+Shift+M` toggles maximize on the focused helper pane; with none focused it restores a maximized pane; otherwise it does nothing — verify: test
- [ ] AC-27 — `pane.close` closes the focused pane through that pane's own close path (a dirty Markdown or Diagram pane keeps its discard guard) — verify: test
- [ ] AC-28 — `terminal.toggle` ships with no default chord — verify: test
- [ ] AC-29 — `terminal.toggle` adds a shell pane when none exists, reveals and focuses an existing one, and collapses the panel when that pane already holds focus — verify: test
- [ ] AC-30 — With `terminal.toggle` bound, the chord works while a terminal holds focus and no longer reaches the PTY — verify: manual
- [ ] AC-31 — The Ctrl+J/LF hazard and the safe ``Ctrl+` `` alternative are documented in `docs/user/sessions.md` — verify: review
- [ ] AC-32 — `session.fork` ships with no default chord; once bound, it forks the selected session with the Session menu's behavior (toasts on failure), does nothing on a key press in a text field or inside the Diagram pane (whose own ⌘D duplicates), and bound to `Cmd+D` on Linux lets Ctrl+D in a focused terminal still reach the PTY — verify: test + manual
- [ ] AC-33 — `Cmd+Enter` (Ctrl+Enter off macOS) opens the cursor session (else the selected one) to the side through `addResumeHelper`, with its no-op rules — verify: test
- [ ] AC-34 — `Shift+F10` opens the Session menu or Folder menu for the §3.10 target, anchored at the row's rect, keyboard-navigable, and exactly one menu opens per press, on Linux and Windows (Chromium synthesizes `contextmenu` on both) — verify: test + manual
- [ ] AC-35 — `F2` opens Rename folder for the cursor folder row, else the active folder, and does nothing on a session or group cursor row — verify: test
- [ ] AC-36 — `Cmd+Alt+S` and View → "Keyboard Shortcuts…" open Settings on the Keyboard Shortcuts tab; the JSON menu item and the `app.openKeybindings` label read "Open keybindings.json" in `en` (and its translation in `pt-BR`) — verify: test + manual
- [ ] AC-37 — Each new session / folder / sidebar / view id runs the same function its button or menu item runs (a shared composable, no copied handler) — verify: review
- [ ] AC-38 — The palette's Actions section is generated from the table; typing any eligible action's label — bound or unbound, including actions whose `keysGuard` would block a key press from a text field (`session.openToSide`, `folder.rename`, `view.closeTakeover`, the sidebar and selection actions) — lists it whenever its `enabled()` context holds, and Enter runs its registered handler — verify: test
- [ ] AC-39 — Each palette action row shows its resolved chord, updated live after a rebind — verify: test
- [ ] AC-40 — With an empty query the palette shows only the featured actions; Recents, Folders and Sessions behave as before — verify: test
- [ ] AC-41 — An action whose `enabled()` is false is not listed — verify: test
- [ ] AC-42 — Palette "Resume last session" skips folder terminals — verify: test
- [ ] AC-43 — Every §9.2 button's tooltip reads "Label (Chord)" with the resolved chord, updates live on rebind, and is the plain label when unbound — verify: test
- [ ] AC-44 — `nav.back` / `nav.forward` are table rows with platform defaults (⌘[ / ⌘] on macOS, Alt+← / Alt+→ elsewhere); a rebind updates both the native accelerator and the renderer; off macOS the bound chord is still kept from xterm without toggling the menu bar — verify: test + manual
- [ ] AC-45 — `onNavKeydown` is gone; the generic shield is the only capture-phase key handler for shielded actions — verify: review
- [ ] AC-46 — Each unit adds its `CHANGELOG.md` entry, its `design.md` §6 edits (named in §5.3, §6.1, §8.1, §9, §10) before the UI, and its `docs/user/` edits — including the palette paragraph of `docs/user/sessions.md:89-91` (U6), `docs/user/cleanup.md:13` and `docs/user/canvas.md:73` (U4b) — verify: review
- [ ] AC-47 — `npm run typecheck`, `npm run lint`, the unit tests and `npm run build` pass on every unit — verify: test
- [ ] AC-48 — Linux manual pass before merge: new hints render `Ctrl`/`Shift`/`Alt`; `Ctrl+Shift+F`, `F6` and `Ctrl+Shift+M` fire over a focused terminal; the rebuilt GTK menu shows the new View item. Windows manual pass: Shift+F10 opens one menu, and `Cmd+Alt+S` (Ctrl+Alt+S) fires on an AltGr layout — verify: manual
- [ ] AC-49 — Every `SettingsTabId` has a `view.settings.<tab>` id (only `keybindings` bound, to `Cmd+Alt+S`) that opens Settings on that tab through `ui.openSettings(tab)`; a test asserts `SETTINGS_TAB_IDS` equals the union — verify: test
- [ ] AC-50 — The recorder refuses a chord that can never fire for that action (Shift+punctuation, or Option+letter on macOS, for a renderer-only action), keeps the previous chord and shows the refusal line — verify: test
- [ ] AC-51 — A non-shielded row bound to a chord `terminalKeymap.ts` swallows shows the terminal-keeps hint, read from `TERMINAL_KEYMAP_CHORDS` — verify: test
- [ ] AC-52 — A `keysGuard` blocks only `'keys'` dispatches: a guarded action does nothing on a key press in a text field but runs from the palette, the native menu and the shield — verify: test
- [ ] AC-53 — `isNotInTerminal(d)` is exported from `keybindings-core.ts` and is the only source of the pane's "not in terminal" marker — verify: test
- [ ] AC-54 — Each lifted popover opens from its id and still opens / closes from its own button and Esc exactly as before; `ui.anyPopoverOpen` is true while any of them (or the lightbox) is open — verify: test

## 13. Open questions

Still open — each needs a live check during its implementing unit:

- **OQ-3 — Shift+F10 and Chromium's synthesized `contextmenu`.** Unknown whether
  Electron's Chromium on Linux **and Windows** (we ship `build:win`; Chromium on
  Windows synthesizes `contextmenu` for Shift+F10) dispatches a `contextmenu` event for Shift+F10 at the
  focused element. The `ui` menu mutex caps it at one menu; confirm in U2's manual
  pass (AC-34).
- **OQ-8 — F6 in Electron.** Assumed to have no built-in Chromium focus-traversal
  binding in a frameless Electron window. Confirm in U5b's manual pass (AC-22).

Resolved in revision 2 (kept here so the ids stay traceable):

- OQ-1 → fact, §7.1 (Ctrl+letter does not fire over a focused terminal off macOS).
- OQ-2 → fact, §5.2 (unreachable chords; the recorder now refuses them, AC-50).
- OQ-4 → operator accepted `Cmd+Alt+S`, `Cmd+Shift+M` and `Cmd+Enter`.
- OQ-5 → operator decision: `session.fork` ships unbound.
- OQ-6 → scope decision, §8.3 (Shift+F10 on a group row is a documented no-op).
- OQ-7 → fact, §4 (Esc while recording closes Settings today; the fix stays).
