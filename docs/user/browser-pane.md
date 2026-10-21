# Browser pane

A **browser pane** is a real Chromium page that lives in the split stack beside your session. Use it to look at the dev server a session just started, to read documentation next to the conversation, or to let a session open a page for you. It works like any other pane: it can be maximized, resized by dragging its header, and closed.

> **What is and isn't built yet.** This page describes what ships today. A session can open, list, navigate and close panes; it cannot yet read what is on the page, click, type, or open a local `.html` file for you, and the pane does not come back after you restart Harnu. Point-and-comment (picking an element and sending a note to the session), device and zoom controls, downloads and uploads are later releases.

## Opening one

Click the small arrow beside the **Split** button in the Topbar and choose **Browser**. A new pane opens in the folder you are looking at and puts the cursor in its address bar. (The Split button itself still opens a terminal in one click.) A session can also open one for you; it appears in the folder that session works in, in the background, without moving you away from what you are doing.

## The pane

- **Header** — the page title (or its address while it loads), a chip when a session is connected (below), the **⋯** menu, maximize and close.
- **Address bar** — back, forward, reload (it turns into a stop button while a page loads), then the address field. Type an address and press **Enter**; `Esc` puts back the real address. A word with a dot (`example.com`) opens over https; `localhost:5173` opens over http. **Cmd/Ctrl+L** jumps to the field while a pane is focused, and **Cmd/Ctrl+R**, **Cmd/Ctrl+[** and **Cmd/Ctrl+]** reload, go back and go forward. These shortcuts are in Settings → Keyboard Shortcuts with the others and can be rebound there.
- **Badges** — a green **local** badge means the address is a dev server on your own machine (localhost and similar); **external** is any other site. An amber **opened by agent · host** badge appears when a session took the pane to a site you hadn't seen there; dismiss it with its **×**, or just navigate yourself.
- **Notices** — one line under the address bar when something was refused or dismissed: an address of a kind that is blocked, a certificate Harnu accepted for your own machine, or a dialog (`alert`, `confirm`, `prompt`) the page opened that Harnu closed for you.
- **⋯ menu** — **Pause agent for 10 min** (or **Resume agent**) and **Open DevTools**.

## When something covers the page

A browser page is drawn by the system above everything else in the window, so a menu, dialog, palette or notification opened over it would normally be hidden behind it. Harnu avoids this by swapping the page for a still picture of itself while anything overlaps it: the page keeps running underneath, and it comes back the moment the menu closes. Dragging a splitter does the same, so the drag doesn't get lost inside the page. You will notice a frozen frame for a moment; that is why.

## Sessions and the connection chip

A pane a session opened shows a chip in its header — "Connected to ‹session›", or "Connected to an agent" — with the word **reading** or **driving** while the session works. Click the unplug button to **Disconnect** the session from that pane for good: it can no longer read or change it, even close it, and nothing reconnects it. The pane stays and stays yours. Use **Pause agent for 10 min** to stop a session changing the pane for a while: the chip shows "Agent paused · 9:41" counting down, with a **Resume** button. See [Agent control](agent-control.md#browser-panes-a-session-opens) for everything a session can do, and **Settings → Control server → Allow agents to drive browser panes** to switch all of it off.

Panes you open yourself can't be read or driven by a session at all yet.

## What the page is not allowed to do

A page in a browser pane is treated as untrusted code, even your own dev server:

- It runs in its own sandbox with no access to Harnu's windows, files or ports. Your logins are kept in a separate cookie jar from the one used by panes a session opens, so a session never starts logged in as you.
- Only `http`, `https` and `about:blank` open. `file:`, `chrome:`, `devtools:`, `view-source:` and `javascript:` addresses are refused.
- A link or script that tries to open a new window opens a new pane **only if you clicked it**; otherwise it is blocked. Sign-in flows that need to talk back to the window that opened them do not work.
- Downloads are cancelled, and permission requests (location, notifications, camera, microphone, clipboard reading, and so on) are refused. There is no prompt.
- A site with a bad certificate is refused, except on your own machine (a self-signed dev server), where it is accepted and a notice says so.
- Pages that ask for a username and password through the browser's own sign-in box are cancelled; sign in on the page instead.

## Troubleshooting

- **The page is blank or white.** A reload (**⟳**) usually fixes it. If the address is `about:blank` you haven't navigated yet.
- **A menu seems to flash a still picture of the page.** That is the frozen frame described above, working as intended.
- **A session says it can't drive my pane.** Panes you open yourself aren't available to sessions yet; ask the session to open its own.
- **A session says "BROWSER_PAUSED" or "BROWSER_DISCONNECTED".** You paused it or cut it off. Resume from the chip, or open a new pane for it if you disconnected.
