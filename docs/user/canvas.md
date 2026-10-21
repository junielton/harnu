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

## Styling shapes

Select one or more shapes in **Select** and a small **Properties** panel appears at the left edge of the board, under the zoom controls (or under the toolbar when the toolbar has wrapped onto its own row). Click an option and it applies to everything you have selected, straight away. The panel shows for any selection of shapes, even ones that take no styling: those get the Layers buttons described below. It is a floating panel, so it stays put when you pan or zoom.

| Group            | Options                                         | What it changes                                                                 |
| ---------------- | ----------------------------------------------- | ------------------------------------------------------------------------------- |
| **Color**        | Default, Accent, Green, Amber, Red, Muted       | The outline, a soft tint inside the shape, and the label colour where it helps. |
| **Stroke**       | Solid, Dashed, Dotted                           | The outline pattern.                                                            |
| **Stroke width** | Thin, Regular, Bold                             | How heavy the outline is.                                                       |
| **Corners**      | Sharp, Round                                    | Square or rounded corners (boxes only).                                         |
| **Text size**    | Small, Medium, Large, Extra large (11 to 20 px) | The size of the label.                                                          |
| **Align**        | Left, Center, Right                             | Where the label sits across the shape.                                          |
| **Opacity**      | 25%, 50%, 75%, 100%                             | How see-through the shape and its label are.                                    |

The first option of each group (Default, Solid, Regular, Round, Medium, Center, 100%) is how a shape looks before you style it, so a board drawn earlier looks exactly as it did.

**The panel only shows what every selected shape accepts.** Not every shape takes every group:

| Shape                | Takes                                                   |
| -------------------- | ------------------------------------------------------- |
| **Box**              | Everything.                                             |
| **Ellipse, diamond** | Everything except Corners.                              |
| **Text**             | Color, Text size, Align and Opacity.                    |
| **Image**            | Opacity only.                                           |
| **Card**             | Nothing: a card always draws in Harnu's own card style. |

Select a box and a text label together and you get Color, Text size, Align and Opacity, the groups both accept. Add a card to that selection and the style groups are left out of the panel, because a card accepts nothing; only Layers remains. A card on its own, or **Ctrl/⌘ + A**, shows Layers alone for the same reason. Select only arrows and the panel is not shown; arrows that are part of a larger selection are simply left out, because arrows cannot be styled or restacked yet.

A few things worth knowing:

- **A text label has no frame**, so its Color changes the colour of the words themselves. Default keeps the usual grey; Muted is a dimmer grey.
- **When the selected shapes disagree** about a group (one dashed, one solid), none of that group's options is highlighted. Click one and every selected shape takes it.
- **One change is one undo step.** **Ctrl/⌘ + Z** takes back the last pick, whatever it was and however many shapes it touched.
- **Colours follow the theme.** A tone is stored as a name (`green`, not a hex colour), so the same board looks right in dark and light, and switching theme keeps your selection and its resize handles.
- **Labels do not wrap.** A long label on a small shape can run past its edge, more so at Large and Extra large. Make the shape bigger or the text smaller. A diamond is the tightest: its left and right labels line up inside the diamond's inner area, but a long word can still stick out of its slanted sides.
- **Tinted shapes are slightly see-through**, so the dot grid, or an arrow passing behind a shape, shows through the tint.
- **In a narrow pane** (under about 384 px wide) the panel folds into a single **palette** button (**Show properties**). Click it to open the panel in place and click it again to fold it away. Layers is in there too.
- **Hovering is not an edit.** Moving the pointer over shapes adds no undo step and never marks the board as having unsaved changes.

Styles are saved in the board file when you press **Save**, with the shape they belong to. A session can set the same styles when it draws or edits (see [Agent control](agent-control.md#drawing-on-a-canvas)), and it merges them into what is there, so asking it to recolour a box does not undo the dashed outline you gave it. A board with styles still opens in an older Harnu, which shows the shapes in their default look and keeps the styles if you save it there. An agent in an older build that rewrites a shape's `props` wholesale can drop them, though.

### Layers

When shapes overlap, the one drawn on top is the one in front. The **Layers** group, at the bottom of the Properties panel, changes that for whatever you have selected. It has four buttons:

| Button             | What it does                                                 |
| ------------------ | ------------------------------------------------------------ |
| **Send to back**   | Puts the selection behind every other shape.                 |
| **Send backward**  | Moves the selection back past the next shape it overlaps.    |
| **Bring forward**  | Moves the selection forward past the next shape it overlaps. |
| **Bring to front** | Puts the selection in front of every other shape.            |

A few things worth knowing:

- **Forward and backward step past a shape you can see.** They skip shapes that do not overlap the selection, so one click always changes what is on screen. Two boxes that only touch along an edge do not count as overlapping.
- **Arrows always draw under shapes.** They are never restacked, and there is no layer button for them; sending a box to the back still leaves it above every arrow.
- **One move is one undo step**, also when you restack several shapes at once, and the selection keeps its own order. A move that would change nothing (the shape is already in front, or nothing overlaps it) does nothing: no undo step and no unsaved dot.
- **Stacking values are written only when they have to be.** They go into the file after you restack something, or when you add a shape to a board that already has stacking values, and then every shape gets one. A board without any stacking values that you only move, resize, rename or restyle is saved with no new keys.
- **A session can do the same.** `draw_canvas` accepts a `zIndex` on a node; see [Agent control](agent-control.md#drawing-on-a-canvas).
- **Older Harnu versions keep the order.** A restacked board opens in an older Harnu with the same look. A shape drawn there on such a board has no stacking value and shows up near the bottom after you reload it; restack it here to fix that.

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

Saving also keeps any extra data stored inside an arrow's `props`. If an arrow in the file carries such data (styling, for example), opening the board, editing something else and saving writes it back untouched, rather than quietly dropping it. Extra data anywhere else on an arrow is not kept. An arrow you delete, save, and then bring back with undo and save again keeps its label, its routing and that extra data.

If a save is refused, the pane says why and **the file on disk is left exactly as it was** — your work is still in front of you, nothing was half-written. The usual reason is something the board cannot represent; see the refusal table below.

## When the file changes while you have it open

Harnu watches the file. What happens next depends on whether you have unsaved edits:

- **No unsaved edits** — the board redraws itself immediately and your view does not move. This is the common case, and it is what you see when a session changes the board while you have it open: there is nothing to reload, and your next Save keeps the session's change.
- **Unsaved edits** — the pane **does not** touch your work. A warning strip replaces the filename: _This canvas changed on disk._ with a **Reload** action. Reload discards your edits (it asks first); ignoring it and pressing **Save** instead writes your version over whatever changed, and that is the point of telling you.

The same holds while a pane is still opening: it starts reading only once Harnu is watching the file, so a session's write in that moment shows up in the pane (or as the strip) instead of being lost. If the watch is not ready within about 3 seconds, the pane opens anyway rather than leave you waiting, and Harnu checks the file again once the watch is ready: a write that landed in between still shows up.

Your own Save never triggers either case on the pane that made it. If the **same file is open in two panes**, the pane you saved from stays quiet, but the other pane treats your Save like any other change: it redraws (no unsaved edits) or shows the strip (unsaved edits). So the other pane's next Save does not silently write over yours. If that pane had unsaved edits and you press **Save** there anyway, over the warning strip, its version overwrites your other pane's Save: that is the same choice as saving over any change, and the strip is there to warn you.

Narrow windows exist. Harnu hears about a write only after the file settles, roughly 100–250 ms later, and a Save made in that fraction of a second wins:

- If you press **Save** before the pane has heard about a session's write, your Save wins and the session's change is overwritten.
- If you save in one pane and then in the other within that window, the later Save wins, and the first pane redraws to show it.

This is the same last-writer-wins rule as saving over the warning strip. The panes and the file agree afterwards.

Every node and edge records whether **you** or **the agent** created it, and that record is written the moment you draw the thing. Copying an agent's box makes the copy yours; moving or renaming an agent's box does not — the stamp says who first put it there, not who touched it last.

Themes apply live: switch theme with a canvas open and it recolours in place. Nothing reloads, the view does not move, your selection stays, and unsaved edits are kept.

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
- **Diamonds and ellipses are hit as rectangles.** The Eraser and the Arrow treat them as the rectangle around them, so a press or stroke in the empty corner just outside the outline still counts as the shape.
- **Copy and paste between canvases** isn't there; **Ctrl/⌘ + D** duplicates within one board.
- **Arrows cannot be styled.** Colour, dashes and weight apply to shapes only; an arrow always draws in the accent colour.
- **A node kind Harnu doesn't know** — a component from a _newer_ build than yours — renders as a dashed box, so an unfamiliar board still opens instead of failing. You can move and delete it, and saving keeps it the kind it was, so opening it in the newer build shows it properly again.
