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

- **Boxes** are labelled rounded rectangles. **Ellipses** and **diamonds** are labelled too, and look like boxes with a different outline: use an ellipse for a state or a start/end point, and a diamond for a decision in a flow. **Text** nodes are bare labels with no frame, for annotations. **Image** nodes show a picture stored next to the canvas in `assets/`.
- **Arrows** are routed around your boxes rather than drawn straight through them, and they carry their own label.
- The dotted grid behind everything is what makes panning legible — without it, dragging an empty area looks like nothing happening.

## The toolbar

A small bar floats at the top of the board, next to the zoom controls. Each button is a **tool**, and the tool decides what a click or a drag on the board does. You start on **Select**.

| Tool          | Shortcut     | What it does                                                                                                      |
| ------------- | ------------ | ----------------------------------------------------------------------------------------------------------------- |
| **Lock**      | **Q**        | Keeps the tool you picked after you draw something (see below).                                                   |
| **Hand**      | **H**        | Drag anywhere to move the board. Nothing is selected or moved, even if you start on a box.                        |
| **Select**    | **V**, **1** | The default. Click to select, drag on empty board to select everything inside a rectangle, drag a box to move it. |
| **Rectangle** | **R**, **2** | Click to place a box, or drag to draw one to the size you want.                                                   |
| **Diamond**   | **D**, **3** | Click to place a diamond, or drag to draw one to the size you want.                                               |
| **Ellipse**   | **O**, **4** | Click to place an ellipse, or drag to draw one to the size you want.                                              |
| **Arrow**     | **A**, **5** | Drag from one shape to another to connect them.                                                                   |
| **Text**      | **T**, **6** | Click anywhere to place a bare label and type.                                                                    |
| **Eraser**    | **E**, **0** | Click a box or arrow to delete it, or drag across several to delete them all.                                     |

Hover a button to see its shortcut. The active tool is highlighted, and a short hint under the bar tells you what it does; each hint goes away after you have used that tool once.

Shortcuts only work while the canvas pane has focus, never while you are typing a name, and never together with **Ctrl/⌘** or **Alt** — so **Ctrl/⌘ + D** (duplicate), **Ctrl/⌘ + A** and the rest keep their usual meaning.

**After you create something, Harnu goes back to Select**, so you draw one thing and are straight back to moving things around. Turn on **Lock** (the padlock, or **Q**) to stay on the tool for as long as you want; press it again to let go.

**Esc** backs out one step at a time: it cancels a shape or arrow you are in the middle of making, otherwise it switches to Select, otherwise it clears the selection.

In a very narrow pane the toolbar wraps onto extra rows underneath rather than running off the edge or sitting on top of the zoom controls.

## Moving around

- **Hold Space and drag** to pan, from any tool. Letting go of Space puts you back on the tool you were using. The toolbar keeps showing that tool while you pan.
- **Right-click and drag** to pan, in every tool.
- Or pick the **Hand** tool and drag.
- **Ctrl** (or **⌘**) **+ scroll** to zoom. A plain scroll is left alone deliberately, so the canvas never fights the pane you are scrolling.
- The floating cluster in the top-left has **Fit to view**, **zoom out**, the current percentage, and **zoom in**.

Fit runs when the board first opens, and when you press it. It does **not** run on a reload — if the file changes while you are reading it, the board redraws and your view stays exactly where you put it.

## Drawing

What a click or a drag does depends on the tool:

| Tool          | Click on empty board                        | Drag on empty board                                                            | Click a box                                                     | Drag from a box                                                 |
| ------------- | ------------------------------------------- | ------------------------------------------------------------------------------ | --------------------------------------------------------------- | --------------------------------------------------------------- |
| **Select**    | Clears the selection.                       | Draws a selection rectangle around whatever it touches.                        | Selects it.                                                     | Moves it, and anything else selected.                           |
| **Hand**      | Nothing.                                    | Pans the board.                                                                | Nothing.                                                        | Pans the board; the box does not move.                          |
| **Rectangle** | Places a standard-size box on the spot.     | Draws a box to the size you dragged (never smaller than a small minimum).      | Places a new box on top of it.                                  | Draws a new box over it; the old one stays put.                 |
| **Diamond**   | Places a standard-size diamond on the spot. | Draws a diamond to the size you dragged (never smaller than a small minimum).  | Places a new diamond on top of it.                              | Draws a new diamond over it; the old one stays put.             |
| **Ellipse**   | Places a standard-size ellipse on the spot. | Draws an ellipse to the size you dragged (never smaller than a small minimum). | Places a new ellipse on top of it.                              | Draws a new ellipse over it; the old one stays put.             |
| **Arrow**     | Nothing.                                    | Nothing — an arrow must start on a shape.                                      | Starts an arrow from that box.                                  | Rubber-bands an arrow; let go on another shape to connect them. |
| **Text**      | Places a label and opens it for typing.     | Same as a click.                                                               | On a text label, edits it. On a box, places a new label on top. | Nothing.                                                        |
| **Eraser**    | Nothing.                                    | Everything the pointer crosses fades; letting go deletes all of it.            | Deletes it.                                                     | Same as a drag on empty board.                                  |

A few things worth knowing:

- **A new box, diamond, ellipse or label opens its name field straight away** — just type. **Enter** keeps the name, **Esc** throws it away. Leave a new text label empty and it disappears; a new box, diamond or ellipse stays, unnamed.
- **An arrow only ever joins two shapes.** Let go anywhere else, or back on the shape you started from, and nothing is made. The arrow can start from anywhere on a shape, not only from its four dots.
- **The eraser is one undo step.** A single stroke can remove many things at once, arrows attached to erased boxes go with them, and one **Ctrl/⌘ + Z** brings them all back. **Esc** during a stroke cancels it and nothing is deleted. If you let go outside the pane, the stroke still finishes and deletes what it marked.
- **A shape you let go of outside the pane is still drawn**, to the size you dragged. An arrow let go outside is cancelled.
- **Shapes may overlap.** Placing or drawing a shape on top of another one is allowed.
- **Shapes snap to a grid** as you move them, so a drag lands on the nearest grid step rather than exactly where you let go.

Everything else:

| To do this            | Do this                                                                                                       |
| --------------------- | ------------------------------------------------------------------------------------------------------------- |
| Rename something      | **Double-click** it in Select, Hand or Arrow. **Enter** keeps the new name, **Esc** throws it away.           |
| Place a label quickly | **Double-click** empty board in Select.                                                                       |
| Connect two things    | Use the Arrow tool, or in Select hover a box and drag from one of the four dots on its edge onto another box. |
| Select several        | Drag a rectangle round them in Select (no modifier needed), or **Ctrl/⌘ + A** for everything.                 |
| Add to a selection    | **Shift + drag** a rectangle, or **Shift** or **Ctrl/⌘ + click** a box to toggle it in or out.                |
| Resize                | Select a shape and drag one of its handles.                                                                   |
| Delete                | Select, then **Delete** or **Backspace** — or use the Eraser. Arrows attached to a deleted box go with it.    |
| Duplicate             | Select, then **Ctrl/⌘ + D**.                                                                                  |
| Add an image          | Paste a screenshot onto the board, or drag an image file onto it.                                             |
| Undo / redo           | **Ctrl/⌘ + Z** and **Ctrl/⌘ + Shift + Z**, or the two arrows in the header.                                   |
| Clear the selection   | **Esc**, or a plain click on empty board in Select.                                                           |

**Renaming in the shape tools and Text.** In Rectangle, Diamond, Ellipse and Text the very first click already places a shape, so a double-click on an existing box places a new shape and opens it for typing instead of renaming the box underneath. To rename a shape that is already there, double-click it in Select (or Hand, or Arrow). In the Eraser, the first press deletes the box.

A short drag counts as a click, not a box — you can click around without littering the canvas. Switching tools never touches your undo history.

Undo history is **per pane and not saved**. Close the canvas or reload it and the history is gone; the file holds a drawing, not a timeline. The same goes for the tool: each pane starts on Select, and your choice is not written into the file.

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

**Shapes.** A session can draw boxes, ellipses and diamonds (a flow's decisions are natural diamonds), plus text labels, cards and images. They are the same shapes the toolbar gives you, so anything it draws can be moved, resized and renamed like something you drew yourself.

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

Saving also keeps what it does not understand. If an arrow in the file carries extra data from a newer version of Harnu (styling, for example), opening the board, editing something else and saving writes that data back untouched, rather than quietly dropping it.

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
- **Arrows cannot float free.** An arrow always joins two shapes; there is no way to draw one that starts or ends on empty board.
- **A small set of shapes.** Boxes, ellipses, diamonds and text labels; there are no other outlines (triangles, cylinders, and so on) yet.
- **Copy and paste between canvases** isn't there; **Ctrl/⌘ + D** duplicates within one board.
- **Stacking order** (bring to front / send to back) has no gesture; a board written with one keeps it.
- **A node kind Harnu doesn't know** — a component from a _newer_ build than yours — renders as a dashed box, so an unfamiliar board still opens instead of failing. You can move and delete it, and saving keeps it the kind it was, so opening it in the newer build shows it properly again.
