# T485 — `list_keybindings` MCP verb + keybindings section in harnu-features

> Written 2026-10-14; revision 2 the same day, after orchestrator review. Card:
> roadmap/T485. **Ships after T486 U5b** (`docs/specs/T486-keybindings-coverage-pass.md`
> §11). That is the one dependency, stated once. U5b is the last T486 unit that adds
> table ids, so the verb lists the full inventory, and by then every T486 export it
> reads exists: `labelKeyFor` and `group` (U1), `defaultKeysFor` and
> `isNotInTerminal` (U5a).

## 1. Problem

A session asked "what is the shortcut for X?" or "bind Ctrl+J to the terminal" has
no source of truth. It guesses from `design.md` (which lists defaults, not the
user's overrides), or from memory. Both are wrong the moment the operator rebinds
anything. The resolved table already exists in the main process
(`getResolvedKeybindings()`, `src/main/keybindings.ts:70`); the session just cannot
read it, and `docs/harnu-features.md` never mentions `keybindings.json`.

## 2. Goal

1. One read verb, `list_keybindings`, that returns every action in the resolved
   table plus the absolute path of `keybindings.json` and the file's current
   warnings.
2. A short `docs/harnu-features.md` section telling a session where the file lives,
   its shape, and that it rebinds by editing that file after reading ids from the
   verb.
3. The human-facing twin in `docs/user/agent-control.md`, and a CHANGELOG entry.

## 3. Decisions already taken (2026-10-14, operator)

| #   | Decision                            | Reason                                                                                                                                                                                                                                                                                                                                                                                                  |
| --- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D-1 | **No `set_keybinding` write verb.** | `keybindings.json` is hot-reloaded (chokidar watch, `src/main/keybindings.ts`), and every bad entry already becomes a named warning instead of a failure (`resolveKeybindings`, `keybindings-core.ts:827`). Editing the file is enough; a verb would only add the validation the next `list_keybindings` call already reports (`warnings`). Small gain, one more mutating surface to gate and document. |
| D-2 | **No `invoke_action` verb.**        | An agent firing UI actions (open a takeover, collapse the sidebar, focus a pane) would drive the operator's screen from outside. That breaks Harnu's never-steal-focus rule — the same rule that makes `open_file` open panes in the background and suppresses `speak` while the operator looks at the session.                                                                                         |

## 4. Verb shape

### 4.1 Catalog entry (`src/main/mcp/tool-catalog.ts`)

```ts
{
  name: 'list_keybindings',
  description:
    "List Harnu's keyboard shortcuts as the operator has them right now: every action id in the keybindings table with its English label, the resolved chord (canonical form plus how it renders on macOS and elsewhere), its default, whether the operator customized or unbound it, whether it is reserved (cannot be rebound), whether a bound chord reaches the app while the terminal has focus, and which other actions share its chord. Also returns the absolute path of keybindings.json and the warnings Harnu raised while reading it. Read-only. To rebind, edit that file — an array of { \"key\", \"command\" } entries, one per command, \"key\": null unbinds — and call this verb again to confirm the change and read any new warning.",
  inputSchema: z.object({}),
  mutates: false,
  op: 'list_keybindings'
}
```

- **No `folder` argument.** Keybindings are global (T1 R1: no per-folder
  overrides). The plan-input translator is the folder-less one `get_fleet` uses
  (`() => ({})`, `src/main/mcp/plan-input.ts:43`), so `FOLDER_NOT_ALLOWED` can never
  fire; only `SERVER_DISABLED` refuses it.
- **No `discloses`.** The absolute path is the point of the verb — the session has
  to edit that file. It lives beside `settings.json`, never inside a project, so it
  carries no project content. (`get_fleet` redacts paths because they name the
  operator's repos; this one names Harnu's config directory.)
- **Not `alwaysLoad`.** It is not a core verb; it surfaces through tool search
  like `list_workers`.

### 4.2 ACK

```jsonc
{
  "ok": true,
  "path": "/home/user/.config/Harnu/keybindings.json", // absolute; may not exist yet
  "fileExists": true,
  "platform": "linux", // process.platform
  "mac": false, // what `Cmd` means here: false ⇒ Cmd = Ctrl
  "warnings": [
    // KeybindingWarning[] from the last resolve, verbatim
    { "code": "reserved-chord", "command": "view.review", "key": "Cmd+Q" }
  ],
  "actions": [
    {
      "id": "session.new",
      "label": "New session", // English, always (en.json), whatever the app locale
      "group": "sessions", // T486 group, see T486 spec §5.1
      "keys": "Cmd+N", // resolved canonical chord, null when unbound / no default
      "display": { "mac": "⌘N", "other": "Ctrl+N" }, // null when keys is null
      "defaultKeys": "Cmd+N", // platform default (T486 `defaultKeysFor`), or null
      "source": "default", // "default" | "override" | "unbound"
      "customized": false, // source !== "default"
      "reserved": false,
      "notInTerminal": false, // the same predicate the Settings pane badges
      "conflictsWith": [] // other ids sharing this chord in this scope
    }
  ]
}
```

Field rules:

- `actions` lists **every** row of `KEYBINDINGS`, reserved ones included (the
  resolved table's `list` filters reserved rows out — `keybindings-core.ts:919` — so
  the handler joins `KEYBINDINGS` with `resolved.byId`; a reserved row reports its
  default with `source: "default"`). Order = table declaration order.
- `label` is read from `src/renderer/src/i18n/en.json` through the descriptor's
  `labelKey` (main already imports JSON — `resolveJsonModule` is on in the
  `@electron-toolkit` base config, and `src/main/companion/host.ts` imports a JSON
  file), resolving the `labelKey` that T486's `labelKeyFor` produces (T486 §4). A
  missing label falls back to the id, never to the raw key.
- `display` is the chord rendered for both platforms: `renderChordString(chord, { mac: true })`
  and `{ mac: false }`. Both are always returned: the session may be advising an operator
  on another machine. `keys` / `defaultKeys` are resolved for the **host**, so for a row
  still on its default `display` renders each platform's own default (T486 U5a's
  `defaultKeysFor(d, mac)`: `nav.back` is `⌥←` on Linux and `⌘[` on macOS, whichever
  host answers); for a user override it is the host's chord rendered both ways, which is
  the best the file can say, since `keybindings.json` holds one chord per id.
- `notInTerminal` is `isNotInTerminal(d)`, exported from `keybindings-core.ts` by T486
  U5a (`!d.menu && !d.shield`), the same predicate the Settings pane badges. It is a
  **best guess**, and T486 §7.1 states why: on Linux/Windows a menu-backed Ctrl+letter
  chord may not fire over a focused terminal (xterm consumes it), and a renderer-only
  Ctrl+Shift+letter chord may. If a follow-up makes the predicate platform-aware,
  this field follows for free.
- `warnings` is the resolve's `warnings` array verbatim. An unparseable file is one
  `not-array` warning with `detail: "invalid JSON"`; the defaults still apply.
- Source of the table: `getResolvedKeybindings()` (the main-process cache the menu
  is built from). If it is `null` (never seeded — not expected after startup), the
  handler resolves synchronously via `loadResolvedKeybindingsSync`. The verb never
  fails for a missing or broken file.

### 4.3 Plumbing (the established read-verb path, e.g. `list_containers`)

| File                                  | Change                                                                            |
| ------------------------------------- | --------------------------------------------------------------------------------- |
| `src/main/mcp/tool-catalog.ts`        | `MCP_OPS` entry + the catalog entry above                                         |
| `src/main/mcp/validate.ts`            | `parseListKeybindings` — accepts `{}` only (unknown keys refused, like siblings)  |
| `src/main/mcp/plan-input.ts`          | `list_keybindings: translateGetFleet`-style folder-less translator                |
| `src/main/mcp/tool-handlers.ts`       | `listKeybindingsHandler`, registered in the handler map                           |
| `src/main/mcp/keybindings-listing.ts` | new, pure: `buildKeybindingsListing(resolved, { mac, path, fileExists, labels })` |
| `src/main/scheduler-core.ts`          | add `'list_keybindings'` to `OBSERVE_ALLOW_VERBS` (§5)                            |

The listing builder is pure and takes the labels map as input, so the unit test
needs neither electron nor the filesystem.

## 5. Observe allowlist: yes

Add `list_keybindings` to `OBSERVE_ALLOW_VERBS` (`src/main/scheduler-core.ts:346`).

- It is read-only and writes nothing.
- It discloses no project content: the one path is Harnu's own config file, and an
  observe tick already has an unrestricted `Read` tool, so the path gives it nothing
  it could not already find.
- Unlike `list_workers` (kept off the list on purpose), it opens no escalation
  path: knowing a shortcut cannot mint, enumerate or change any heartbeat.
- It has a real use: a watchdog can report "your keybindings.json has 2 ignored
  entries" from `warnings`.

## 6. `docs/harnu-features.md` — exact text

Two edits, plus the version-marker bump (`<!-- harnu-features vN -->` → `vN+1`,
dated the day it lands).

**6.1 Verb index.** Add `list_keybindings` to the "The rest surface when you search
your tools for them:" sentence (after `list_cleanup`), or
`tests/harnu-features-verb-roster.test.ts` fails.

**6.2 New section**, inserted after the "Workspace cleanup" section and before
"**Worktrees.**":

```markdown
**Keyboard shortcuts — `list_keybindings`, then edit `keybindings.json`.** When the
user asks what a shortcut is, or asks you to change one, never answer from memory or
from `design.md`: the user may have rebound it. Call `list_keybindings()` (no
arguments). It returns every action `id` with its English `label`, the resolved
chord in canonical form (`keys`) and as it renders on macOS and elsewhere
(`display.mac` / `display.other`), the default, `source` (`default`, `override`,
`unbound`), `reserved` (cannot be rebound), `notInTerminal`, `conflictsWith`, the
absolute `path` of `keybindings.json` and the `warnings` Harnu raised reading it.
Treat `notInTerminal` as a best guess, not a promise: it is the Settings pane's
marker. On Linux and Windows a Ctrl+letter chord may not fire while a terminal has
focus even when it reads `false`, and a Ctrl+Shift+letter chord may fire even when it
reads `true`. When it matters, tell the user to try it.

To rebind, edit that file — there is no write verb. It is a JSON array (comments
allowed) of `{ "key": "<chord>", "command": "<id>" }`, one entry per command, last one
wins. `"key": null` unbinds a default. Chords are written `Cmd+Shift+P` style: `Cmd`
means ⌘ on macOS and Ctrl everywhere else, so one file works on both; `Ctrl`, `Alt`,
`Shift` are literal. Two-chord sequences (`Ctrl+K Ctrl+S`) are not supported. The
file is watched: a save applies at once, no restart. Reserved actions (`app.quit`,
`app.reload`, `app.devtools`, `app.fullscreen`, `app.openKeybindings`) and their
chords cannot be taken; such an entry is ignored. A bad entry never breaks the file —
it is dropped with a named warning — so call `list_keybindings` again after you save
and read `warnings` to confirm your change took. The file lives outside the project,
so expect your editor tool to ask the user for permission. If the user wants the
point-and-click route instead, point them at **Settings → Keyboard Shortcuts**.
```

Editorial check against `/harnu-awareness`: second person, actionable, names the
ACK fields the agent reads, states the one refusal-like outcome (an ignored entry)
and how to detect it. It does not describe internals (chokidar, the resolve).

## 7. User docs

`docs/user/agent-control.md` — a new `## Asking a session about shortcuts` section
after "Watching workspace cleanup":

> A session can read your keyboard shortcuts exactly as you have them — every
> action, its current chord, its default, whether you changed or removed it, and
> any shortcut two actions are fighting over — plus where your `keybindings.json`
> lives and any line in it Harnu ignored. So "what's the shortcut for the roadmap
> board?" gets your answer, not the factory default. To change a shortcut, the
> session edits `keybindings.json` itself (your editor-permission prompt applies,
> since the file is outside your project); the change applies the moment it saves,
> and the session re-reads the list to confirm it took. There is no way for a
> session to press a shortcut or click a button for you. A read-only Scheduler
> worker can read the list too. See [Customizing shortcuts](sessions.md#customizing-shortcuts).

## 8. CHANGELOG

Under `### Added` for the landing date:

> - Sessions can now read your keyboard shortcuts as you have them — every action,
>   its current and default chord, conflicts, and any ignored line in
>   `keybindings.json` — and change one by editing that file.

## 9. Testing

- `tests/mcp-keybindings-listing.test.ts` (new) — pure builder: every `KEYBINDINGS`
  id present once, in order; reserved rows present with `reserved: true`; an
  override row reports `source: "override"`, `customized: true`; an unbound row
  `keys: null`, `display: null`; `display` renders both platforms; a label missing
  from the map falls back to the id; warnings pass through verbatim.
- `tests/mcp-tool-catalog.test.ts` — the existing catalog invariants cover the new
  entry (name ⇔ op, schema).
- `tests/harnu-features-verb-roster.test.ts` — passes only with §6.1 done.
- `tests/scheduler-observe-no-shell.test.ts` / the observe allowlist tests — the
  verb is allowed, every other new verb is still denied.
- `scripts/ci/awareness-gate.mjs` and `scripts/ci/user-docs-gate.mjs` go green
  because §6 and §7 touch their files.

## 10. Acceptance criteria

- [ ] AC-1 — `list_keybindings({})` returns `ok: true`, the absolute `keybindings.json` path, `fileExists`, `platform`, `mac`, `warnings` and one `actions` row per `KEYBINDINGS` entry in table order — verify: test
- [ ] AC-2 — Each row carries `id`, English `label`, `group`, `keys`, `display.{mac,other}`, `defaultKeys`, `source`, `customized`, `reserved`, `notInTerminal`, `conflictsWith` — verify: test
- [ ] AC-3 — Reserved actions are listed with `reserved: true` and their default chord — verify: test
- [ ] AC-4 — After the operator rebinds an action in Settings, the next call reports the new `keys` with `source: "override"` without a restart — verify: manual
- [ ] AC-5 — A `keybindings.json` entry Harnu ignores appears in `warnings` with its code; the call still succeeds — verify: test
- [ ] AC-6 — No `label` is ever a raw i18n key (`keybindings.actions.…`) — verify: test
- [ ] AC-7 — The verb takes no arguments and refuses unknown ones; it is never refused `FOLDER_NOT_ALLOWED` — verify: test
- [ ] AC-8 — An `observe` Scheduler tick may call `list_keybindings`; the observe allowlist test passes — verify: test
- [ ] AC-9 — A test asserts `MCP_OPS` contains neither `set_keybinding` nor `invoke_action` — verify: test
- [ ] AC-10 — `docs/harnu-features.md` carries the §6.2 section, lists the verb in the index, and its version marker is bumped — verify: test (verb roster) + review
- [ ] AC-11 — `docs/user/agent-control.md` has the §7 section and `CHANGELOG.md` the §8 entry — verify: review
- [ ] AC-12 — `npm run typecheck`, `npm run lint`, `npm run test` pass — verify: test

## 11. Open questions

None. The former OQ-1 (`notInTerminal` accuracy) is now a stated fact in T486 §7.1,
and §4.2 and §6.2 word the field as a best guess accordingly.
