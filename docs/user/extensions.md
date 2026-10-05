# Extensions

Harnu can load small user-installed extensions from `~/.claude/capy-extensions/` — no fork, no rebuild, no code execution. This first phase covers two contribution kinds: **themes** and **board templates**. They're pure data (a JSON manifest + a couple of files), so the worst case of a broken extension is an ugly theme or a missing template — never a security risk.

## Installing an extension

Create a folder under `~/.claude/capy-extensions/` named after your extension's id, with a `manifest.json` inside:

```
~/.claude/capy-extensions/my-pack/
  manifest.json
  templates/
    bug.md
```

```json
{
  "id": "my-pack",
  "label": "My pack",
  "version": "1.0.0",
  "contributes": {
    "themes": [
      {
        "id": "solarized-harnu",
        "label": "Solarized Harnu",
        "dark": true,
        "tokens": { "bg": "#002b36", "...": "... 36 tokens total" }
      }
    ],
    "boardTemplates": {
      "bug": "./templates/bug.md"
    }
  }
}
```

The manifest's `id` must match the folder name exactly — this stops one extension from silently overwriting another's identity. Harnu picks up a new or edited extension **within about a second, with no app restart** — the folder is watched the same way `~/.claude/detectors/` already is.

## Themes

A theme contribution needs the same 36 tokens every built-in theme defines (20 UI colors + the 16-color terminal ANSI palette) — Harnu validates this **strictly**: a theme missing even one token is dropped (logged, not silently patched with a default), while every other theme in the pack still loads. Once installed, it shows up in **Settings → Appearance** in the same grid as the built-in themes, with a small puzzle-piece badge marking it as extension-installed (hover it to see which extension installed it). Selecting it recolors the whole app **and the terminal** immediately, exactly like a built-in theme.

If you uninstall an extension (delete its folder) while one of its themes is active, Harnu falls back to the default theme automatically rather than leaving the app pointed at colors that no longer exist.

## Board templates

An extension can override the delegation-packet template Harnu seeds a new card with for a given kind (`scout`, `bug`, `feature`, `review`, `chore`) — see [Roadmap board](roadmap-board.md) for what a card's body normally looks like. Point `contributes.boardTemplates.<kind>` at a Markdown file (relative to the extension's own folder) and every new card of that kind in **every repo's board** starts from it instead of Harnu's bundled template. If the extension's template file goes missing, Harnu quietly falls back to the bundled one for that kind — a broken override never blocks card creation.

## Modes

An extension can contribute a **mode** — a distributable session "process" the same way `Modes ▸ Learning` works today. Add a `modes/` folder and point `contributes.modes` at it:

```json
"contributes": {
  "modes": [
    { "id": "code-reviewer", "label": "Code reviewer", "icon": "shield-check", "doc": "./modes/code-reviewer.md" }
  ]
}
```

`doc` is a Markdown file (relative to the extension's folder) whose entire content becomes the contract appended to the session's system prompt the moment you pick it from `Modes ▸` — exactly like the builtin Learning mode. `icon` is optional, from a small documented set (`graduation-cap`, `bot`, `sparkles`, `shield-check`); anything else falls back to the default icon.

Every extension-contributed mode shows a small puzzle-piece badge in the `Modes ▸` menu (hover it to see which extension installed it) and in a session's hover preview — it is never shown as if it were a built-in mode.

**Security note:** a mode's doc is _prompt injection by design_ — that's the feature, the same way `Modes ▸ Learning`'s bundled contract already is. It is held to the same trust class as the rest of this page (you installed it). It is **text only**: no matter what a mode's Markdown contains, it can never change a session's permission mode or any other launch flag — those are owned exclusively by Harnu's own boot-argument builder, which a mode's doc never touches.

## What's not here yet

Any extension kind that runs code (custom MCP verbs, sandboxed panes) is a later phase — see the Extension SDK study/ADR under `docs/adr/` and `docs/specs/` if you're curious about the roadmap. Nothing in this phase executes anything an extension author wrote; it's all read as inert data.
