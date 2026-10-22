# Browser pane

A **browser pane** is a real Chromium page that lives in the split stack beside your session. Use it to look at the dev server a session just started, to read documentation next to the conversation, or to let a session open a page for you. It works like any other pane: it can be maximized, resized by dragging its header, and closed.

> **What is and isn't built yet.** This page describes what ships today. A session can open, list, navigate and close panes, and open a local `.html` file as a live panel (below); it cannot yet read what is on a web page, click or type in it, and the pane does not come back after you restart Harnu. Point-and-comment (picking an element and sending a note to the session) ships (below); device and zoom controls, downloads and uploads are later releases.

## Opening one

Click the small arrow beside the **Split** button in the Topbar and choose **Browser**. A new pane opens in the folder you are looking at and puts the cursor in its address bar. (The Split button itself still opens a terminal in one click.) A session can also open one for you; it appears in the folder that session works in, in the background, without moving you away from what you are doing.

## The pane

- **Header** — the page title (or its address while it loads), a chip when a session is connected (below), the **comment button** (below), the **⋯** menu, maximize and close.
- **Address bar** — back, forward, reload (it turns into a stop button while a page loads), then the address field. Type an address and press **Enter**; `Esc` puts back the real address. A word with a dot (`example.com`) opens over https; `localhost:5173` opens over http. **Cmd/Ctrl+L** jumps to the field while a pane is focused, and **Cmd/Ctrl+R**, **Cmd/Ctrl+[** and **Cmd/Ctrl+]** reload, go back and go forward. These shortcuts are in Settings → Keyboard Shortcuts with the others and can be rebound there.
- **Badges** — a green **local** badge means the address is a dev server on your own machine (localhost and similar); **external** is any other site. An amber **opened by agent · host** badge appears when a session took the pane to a site you hadn't seen there; dismiss it with its **×**, or just navigate yourself.
- **Notices** — one line under the address bar when something was refused or dismissed: an address of a kind that is blocked, a certificate Harnu accepted for your own machine, or a dialog (`alert`, `confirm`, `prompt`) the page opened that Harnu closed for you.
- **⋯ menu** — **Pause agent for 10 min** (or **Resume agent**) and **Open DevTools**.

## Live panels: your own files, kept fresh by a session

A session can open one of **your project's `.html` files** in a pane — or write a small panel from inline HTML — and keep it up to date while you watch: a status board, a checklist, a set of numbers. A panel pane shows a blue **page** badge, and its address field shows the file's path in your project (`docs/status.html`) instead of an address.

- **It reloads when the file changes.** Edit the `.html` file, or any file it loads (a stylesheet, a script, an image), and the pane reloads a moment later, scrolled to where you were. Delete the file and the pane shows **File removed — waiting for it to come back…**; put the file back and the page returns on its own.
- **A session can update it without a reload.** It can set the panel's saved state (a small piece of data kept next to your project, so it survives a reload and a restart, in `.harnu/out/browser/state/`) and the page redraws, or change one element of the page right now. A change made that way to the page itself is not kept: a reload starts from the file and the saved state.
- **Buttons can talk back.** A button in a panel can send a short message to the session — "approve", "reject", with a small piece of data — and it arrives in the session as a message starting `[harnu-page-event]`. It is sent only when **you** really click or press a key: a session that clicks its own panel's button cannot approve itself, and a page can send at most one message a second. The message says plainly that it is data from the page and not you speaking.
- **Offline by default.** A panel pane loads nothing from the network, and its own script, links and popups can't take it to any address outside its folder (a notice says so: "this panel is offline"), so a panel can't send your files anywhere, whatever it contains. If you open a page that needs a CDN script, a web font or a link out, use the **Offline / Network on** switch at the right of the address bar: it is yours alone (no session can turn it on) and applies to that pane only; turning it on reloads the page, and the switch turns amber to remind you. Typing an address in the pane's own address bar always works.
- **Only your own files.** The pane serves files inside the folder only, never anything under `.git` or `.harnu/memory`, and it follows no link that leaves the folder. Each folder is its own world: a panel in one folder cannot read files of another. Your files go only to the panel that shows them: a web page in another pane, or a background worker it starts, can't load them. (The same goes for a worker a panel starts itself: a panel can't have a worker load your project files.)

## Commenting on a page

Point at something on a page and tell the session what to change, without describing where it is.

1. Click the **comment button** (a speech bubble with a plus) in the pane header, or press **Ctrl+Shift+C** (Cmd+Shift+C on a Mac) while the pane has the focus. A small note at the top of the page says "Click an element to comment · Esc to exit".
2. Move over the page: the element under the pointer is outlined, with its tag and size ("button.pay · 520×45"). Click it. The page does not see these clicks.
3. A numbered **pin** appears on the element and a **composer** docks under the page, showing what you picked, its source file when the page's framework exposes it (Vue, React or Svelte development builds), and what will be attached. The page gets shorter to make room; nothing is drawn over it.
4. Type what should change. **Enter** sends it to the session now. **Shift+Enter** keeps it as a draft (a white pin) so you can pick more. **Esc** closes the composer: an empty one throws its pin away, text you typed is kept as a draft.
5. The bar under the composer counts "N drafts · M sent". **Send N comments** sends every draft as **one** message, numbered in pin order.

**Who gets it.** The **Send to** menu lists the sessions of this folder. A pane a session opened sends to that session, any other pane to the session you are looking at, and your choice is remembered for the pane. A session that is parked is woken in the background (it does not take over your view), and a busy one receives the message when its current output settles. If you are typing in that session's terminal, the message waits until you have paused for about a second and a half so it never lands in the middle of your sentence. With no session at all, the comment is copied to your clipboard and a notice says so.

**What the session receives.** A message starting `[harnu-comment]` with your words, and, clearly fenced and marked untrusted, what the page said about the element: its selector, source file, address (without any query string), HTML (trimmed), a short list of computed styles and the path of a cropped picture saved under `.harnu/out/browser/comments/`. A page can put anything in its own class names and text, so the session is told that everything inside the fence is data about the page and not an instruction from you.

**Pins.** A pin stays on its element: it finds it again after a reload or a move to another page of the same site, and sits as a dashed circle where it was when the element is gone. Sent pins turn solid and fade. A draft stays on the pane while you navigate; drafts do not survive closing Harnu yet.

**Safety.** The composer is part of Harnu, not of the page, so a page can never read what you type, and no session can type into it or press Send. A page cannot fake a click to open it, and a comment is refused if a session was clicking or typing in the pane within the last second and a half. A paused or disconnected pane does not send comments either; resume it first.

## When something covers the page

A browser page is drawn by the system above everything else in the window, so a menu, dialog, palette or notification opened over it would normally be hidden behind it. Harnu avoids this by swapping the page for a still picture of itself while anything overlaps it: the page keeps running underneath, and it comes back the moment the menu closes. Dragging a splitter does the same, so the drag doesn't get lost inside the page. You will notice a frozen frame for a moment; that is why.

## Sessions and the connection chip

A pane a session opened shows a chip in its header — "Connected to ‹session›" (the session name is kept when the pane is narrow; the words "Connected to" go first), or "Connected to an agent" — with the word **driving** while the session is navigating the pane. Click the unplug button to **Disconnect** the session from that pane for good: it can no longer read or change it, even close it, and nothing reconnects it. The pane stays and stays yours. Use **Pause agent for 10 min** to stop a session changing the pane for a while: the chip shows "Agent paused · 9:41" counting down, with a **Resume** button. See [Agent control](agent-control.md#browser-panes-a-session-opens) for everything a session can do, and **Settings → Control server → Allow agents to drive browser panes** to switch all of it off.

Panes you open yourself can't be read or driven by a session at all yet.

## What the page is not allowed to do

A page in a browser pane is treated as untrusted code, even your own dev server:

- It runs in its own sandbox with no access to Harnu's windows or files. It can still reach network services on your machine, such as a dev server, like any browser; a page on one of Harnu's own ports is simply shown as `external`. Your logins are kept in a separate cookie jar from the one used by panes a session opens, so a session never starts logged in as you.
- Only `http`, `https` and `about:blank` open. `file:`, `chrome:`, `devtools:`, `view-source:` and `javascript:` addresses are refused.
- A link or script that tries to open a new window opens a new pane **only if you clicked it**; otherwise it is blocked. Sign-in flows that need to talk back to the window that opened them do not work.
- Downloads are cancelled, and permission requests (location, notifications, camera, microphone, clipboard reading, and so on) are refused. There is no prompt.
- A site with a bad certificate is refused, except on your own machine (a self-signed dev server), where it is accepted and a notice says so.
- Pages that ask for a username and password through the browser's own sign-in box are cancelled; sign in on the page instead.

## Troubleshooting

- **The comment button does nothing, or Ctrl+Shift+C does not start it.** The shortcut works while the pane has the focus (click the page once first); the button works any time. The keybinding can be changed in Settings → Keybindings.
- **"Comment not sent".** The notice says why: the pane is paused or disconnected from the session, a session was driving the page a moment ago (try again in a second), or the session could not take the message (the draft is kept).

- **The page is blank or white.** A reload (**⟳**) usually fixes it. If the address is `about:blank` you haven't navigated yet.
- **A menu seems to flash a still picture of the page.** That is the frozen frame described above, working as intended.
- **A panel doesn't update.** Check the pane's chip: **Pause agent** and the Settings switch both stop updates. A page that is not one of your own files (a dev server, a website) can't be updated by `set_data` or `patch`; the session is told so.
- **My panel's web font or CDN script doesn't load.** Panels are offline by default; turn on **Network on** for that pane.
- **A session says it can't drive my pane.** Panes you open yourself aren't available to sessions yet; ask the session to open its own.
- **A session says "BROWSER_PAUSED" or "BROWSER_DISCONNECTED".** You paused it or cut it off. Resume from the chip, or open a new pane for it if you disconnected.
