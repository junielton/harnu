# Canvas pane

A **canvas** is a whiteboard that lives in your worktree as a file. Harnu opens it in a pane beside the terminal, so you can look at a diagram while you talk to the agent about it — rather than putting the drawing on top of the conversation.

You draw on it, and so does the agent. A session can put a diagram, a screenshot or a summary card straight onto the board (see [When the agent draws](#when-the-agent-draws)), and what it draws is yours to move, rename, rewire and delete — not a picture you have to ask it to redo. [What is not built yet](#what-is-not-built-yet) at the bottom says plainly what is still missing.

## Opening one

A canvas is any file named `<something>.harnucanvas.json`. There are two ways in:

- **You open it.** Open the **Browse files** pane from the Topbar and click the **eye** icon on that row — the same gesture that opens any other file, routed to the canvas pane instead of the text viewer.
- **The agent opens it for you.** When an agent hands you a file with `open_file`, a `*.harnucanvas.json` lands in the canvas pane rather than the text viewer. It opens **in the background**, exactly like any other file an agent opens: the pane appears in the folder that asked for it and is badged as unseen — it never yanks you away from what you were looking at.

The name is what decides this, and it has to be the whole `.harnucanvas.json` ending. An ordinary `.json` file — `package.json`, `tsconfig.json`, a file that merely happens to be called `harnucanvas.json` — keeps opening as plain text, from either route. Boards saved under the old name, `<something>.capycanvas.json`, still open and save exactly as before; only new boards get the `.harnucanvas.json` name.

A canvas whose contents are broken still opens **in the canvas pane**, showing the refusal explained in [When it can't open a file](#when-it-cant-open-a-file). It never silently falls back to the text viewer, so what you get told is what is actually wrong with the board.

Where those files live, and why they are per-worktree and gitignored by default, is covered in [Folders and worktrees](folders-and-worktrees.md#canvas-files-in-a-worktree).

Ask a session to draw something and it creates the file for you, then opens this pane on it — that is the usual way you get your first canvas. To write one by hand instead:

```json
{
  "capycanvas": 1,
  "meta": { "title": "Scratch board" },
  "nodes": [
    { "id": "n-1", "shape": "box", "x": 40, "y": 40, "label": "Browser", "origin": "operator" },
    { "id": "n-2", "shape": "box", "x": 320, "y": 200, "label": "Main", "origin": "operator" },
    {
      "id": "n-3",
      "shape": "text",
      "x": 40,
      "y": 220,
      "label": "one PTY per session",
      "origin": "operator"
    }
  ],
  "edges": [{ "id": "e-1", "source": "n-1", "target": "n-2", "label": "IPC", "origin": "operator" }]
}
```

Save that as `.harnu/out/canvas/board.harnucanvas.json` inside a worktree and open it — that path is also the board a session draws on by default.

## Reading the board

- **Boxes** are labelled rounded rectangles. **Text** nodes are bare labels with no frame, for annotations. **Image** nodes show a picture stored next to the canvas in `assets/`.
- **Arrows** are routed around your boxes rather than drawn straight through them, and they carry their own label.
- The dotted grid behind everything is what makes panning legible — without it, dragging an empty area looks like nothing happening.

## Moving around

- **Right-click and drag** to pan. (A plain drag draws a box — see below — so panning moved to the right button.)
- **Ctrl** (or **⌘**) **+ scroll** to zoom. A plain scroll is left alone deliberately, so the canvas never fights the pane you are scrolling.
- The floating cluster in the top-left has **Fit to view**, **zoom out**, the current percentage, and **zoom in**.

Fit runs when the board first opens, and when you press it. It does **not** run on a reload — if the file changes while you are reading it, the board redraws and your view stays exactly where you put it.

## Drawing

| To do this          | Do this                                                                                |
| ------------------- | -------------------------------------------------------------------------------------- |
| Draw a box          | Drag on empty board. The box appears with its name field already open — just type.     |
| Rename something    | Double-click it. **Enter** keeps the new name, **Esc** throws it away.                 |
| Connect two things  | Hover a box, then drag from one of the four dots on its edge onto another box.         |
| Select one thing    | Click it.                                                                              |
| Select several      | **Shift + drag** a rectangle around them, or **Ctrl/⌘ + A** for everything.            |
| Resize              | Select a box and drag one of its handles.                                              |
| Move                | Drag it. Arrows stay attached and re-route themselves around whatever is in the way.   |
| Delete              | Select, then **Delete** or **Backspace**. Arrows attached to a deleted box go with it. |
| Duplicate           | Select, then **Ctrl/⌘ + D**.                                                           |
| Add an image        | Paste a screenshot onto the board, or drag an image file onto it.                      |
| Undo / redo         | **Ctrl/⌘ + Z** and **Ctrl/⌘ + Shift + Z**, or the two arrows in the header.            |
| Clear the selection | **Esc**, or a plain click on empty board.                                              |

A short drag on empty board counts as a click, not a box — you can click around without littering the canvas.

Undo history is **per pane and not saved**. Close the canvas or reload it and the history is gone; the file holds a drawing, not a timeline.

## Images

Paste a screenshot (**Ctrl/⌘ + V**) or drag an image file onto the board and it becomes an image node. Both gestures do exactly the same thing.

**The picture is not stored inside the canvas file.** Harnu copies the bytes into an `assets/` folder next to the canvas and the board keeps a short pointer — `assets/board-1.png`. That matters more than it sounds: the whole canvas file is rewritten every time you save, so a screenshot living inside it would be re-written, in full, on every save. A few real screenshots would make the file too big to open at all.

A few consequences worth knowing:

- **The image file is written the moment you paste**, before you save. It has to be — the picture only exists in the clipboard for that instant. The _node_ is still unsaved work like anything else, so if you never save, you are left with an unused file in a gitignored folder. Harnu does not delete it, on purpose: deleting a file you could still undo your way back to is worse than a few stale bytes.
- **Names are Harnu's, not yours.** The copy is called `<canvas>-<n>.<ext>`, and a second paste never overwrites the first.
- **Six images per paste, 2 MB each.** Over either limit, the whole paste is refused rather than partly done — nothing is written.
- **A dropped or pasted file that isn't an image is ignored.**
- An image node whose file is missing shows a dashed placeholder with its name rather than a broken picture.

## When the agent draws

Ask a session for a picture — an architecture map, a flow, a plan in boxes, a mockup — and it draws it here instead of into the transcript. What lands on the board is **editable**: move a box, rename it, wire two together, delete the ones that are wrong, then Save. The full agent-side story is in [Agent control](agent-control.md#drawing-on-a-canvas); what matters at this end is what you will see.

**Screenshots and generated images.** A session can put a PNG or SVG it produced onto the board as an image node. The bytes are copied into `assets/` next to the canvas exactly like one you paste yourself, and the board keeps only the short pointer — so a board full of screenshots is still a small, fast file.

**Cards.** Some things are not a box with a word in it. A session can also place a **card**: a titled panel with an optional subtitle, a status pill and a paragraph of body text. It is a real piece of Harnu's interface sitting on the board — it uses the app's own type and colours, and it recolours with the rest of the app when you switch theme, because it is drawn by Harnu rather than pasted in as a picture.

A card is a good fit for a deliverable summary, a screen in a flow, or a decision with a state attached to it. The status word is yours to choose; Harnu tints the pill when it recognises the word — green for _done_ / _ready_ / _shipped_ / _ok_ / _passed_, amber for _wip_ / _in progress_ / _review_ / _pending_, red for _blocked_ / _failed_ / _error_ — and leaves it plain grey for anything else. An unfamiliar word is shown as written, never dropped.

**The agent writes a card's contents, never its markup.** What a session can put in the file is a shape _name_ and plain text fields; how that draws is Harnu's code, not the session's. There is deliberately no way for a session to hand Harnu a piece of HTML to render — so a card can never do anything other than be a card, whatever the text inside it says.

A card behaves like every other node: drag it, resize it, connect it, delete it, undo it. Double-clicking renames it, and the name you type becomes its title if the session did not set one.

## Saving

Nothing you draw touches the file until you press **Save** (the disk icon in the header, or **Ctrl/⌘ + S**). While you have unsaved work, an accent-coloured **•** sits next to the filename and the Save button lights up.

Because nothing is written until you save:

- **Closing a canvas with unsaved edits does not close it.** You get a toast saying there are unsaved edits, with a **Discard** action. Only pressing Discard actually closes the pane. Reload and re-targeting the pane go through the same guard.
- **An agent reading the file sees the last thing you saved**, never your work in progress. That is deliberate — an unsaved edit is not a decision yet.

If a save is refused, the pane says why and **the file on disk is left exactly as it was** — your work is still in front of you, nothing was half-written. The usual reason is something the board cannot represent; see the refusal table below.

## When the file changes while you have it open

Harnu watches the file. What happens next depends on whether you have unsaved edits:

- **No unsaved edits** — the board redraws itself immediately and your view does not move. This is the common case.
- **Unsaved edits** — the pane **does not** touch your work. A warning strip replaces the filename: _This canvas changed on disk._ with a **Reload** action. Reload discards your edits (it asks first); ignoring it and pressing **Save** instead writes your version over whatever changed, and that is the point of telling you.

Every node and edge records whether **you** or **the agent** created it, and that record is written the moment you draw the thing. Copying an agent's box makes the copy yours; moving or renaming an agent's box does not — the stamp says who first put it there, not who touched it last.

Themes apply live: switch theme with a canvas open and it recolours in place. Nothing reloads, the view does not move, and unsaved edits are kept.

## When it can't open a file

The pane refuses rather than guessing, and says which of these it is:

| What you see                                 | What happened                                                                                                                                        |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| _This canvas file isn't valid_               | The JSON is malformed, or the board breaks a rule (an arrow pointing at a node that isn't there, two things sharing an id, a node with no `origin`). |
| _Couldn't save this canvas_                  | The save was refused. The file on disk is untouched.                                                                                                 |
| _This canvas was written by a newer version_ | The file's schema version is one this build doesn't know. It is refused, never half-read.                                                            |
| _This file is outside Harnu's known folders_ | The path isn't inside a folder Harnu tracks.                                                                                                         |
| _This canvas is too large to open_           | Over 2 MB, or over 2,000 nodes or edges.                                                                                                             |
| _Canvas file not found_                      | The file was moved or deleted.                                                                                                                       |

## What is not built yet

- **There is one kind of card, and you cannot make new kinds yourself.** The card described above is the only component node Harnu ships; adding another is a code change, not a setting. That is the trade for the guarantee that no session can define how something on your board draws.
- **You cannot edit a card's fields in the pane.** Renaming sets its title; the subtitle, status and body come from the file — edit it directly, or ask the session that drew it.
- **You cannot rename an arrow.** Arrow labels can only be written into the file by hand. This is deliberate for now: it keeps Harnu's reading of a label and the drawing library's copy of it from ever disagreeing, which is the bug that would have an agent tell you an arrow says something it no longer says.
- **Unused images are never cleaned up.** Delete an image node, or paste one and never save, and its file stays in `assets/`. Under `.harnu/out/canvas/` — the default board — that folder is gitignored, so it costs you nothing but disk. Under `docs/canvas/` it is **not**: that is a tracked path, so its `assets/` is tracked too, and stale binaries there will follow you into a commit unless you delete them.
- **Copy and paste between canvases** isn't there; **Ctrl/⌘ + D** duplicates within one board.
- **Stacking order** (bring to front / send to back) has no gesture; a board written with one keeps it.
- **A node kind Harnu doesn't know** — a component from a _newer_ build than yours — renders as a dashed box, so an unfamiliar board still opens instead of failing. You can move and delete it, and saving keeps it the kind it was, so opening it in the newer build shows it properly again.
