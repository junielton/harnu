# Voice — having Harnu read things to you

Harnu can speak. It is a third notification channel, next to the chime and the OS
notification — not a replacement for either — and it is **off until you turn it
on**.

The rule it follows is "only speak what you cannot see": a session speaking on
its own initiative stays quiet for the session you are already looking at, and
anything you explicitly asked to have read to you is read regardless. Utterances
are queued rather than mixed, so two sessions asking to be heard at the same time
take turns instead of talking over each other, and a single mute silences what is
playing and drops everything waiting behind it.

## Where to turn it on

Two places, and they are the same switch.

- **Settings → General → Notifications**, directly under **Sound**. That is the
  one-line version: it lets Harnu speak and does nothing else. It never starts a
  download.
- **Settings → Voice** is the full pane: the engine, the download, the voices,
  what it says, and which sessions are allowed to use it.

There is also a **Mute** next to the master switch. Mute is instant — it stops
what is playing and drops everything queued behind it — and it is separate from
the master switch on purpose, so silencing the room for ten minutes doesn't make
you set the whole thing up again afterwards.

There are two engines.

## 1. Your own TTS command (the default)

Harnu runs a text-to-speech command you already have on your machine and hands it
the sentence. The default is the voice your OS ships: `say` on macOS and
`spd-say -w` (speech-dispatcher, preinstalled on most Linux desktops) on Linux. You
can point it at anything else — `espeak`, `espeak-ng -s 150`, your own script.

Windows has no default: its built-in voice is only reachable through PowerShell,
and passing spoken text to PowerShell would let that text run as code. Set a
command of your own in Settings → Voice; until then the system-command engine
stays silent.

Nothing is downloaded and nothing extra is installed. If the command is missing,
Harnu says so through the voice engine's own state and stays quiet — it never
breaks the session that asked for it.

One thing worth knowing: Harnu considers an utterance finished when the command
**exits**. A command that backgrounds its own playback and returns immediately
(plain `spd-say` without `-w` does exactly this) cannot be serialised by anyone, so
utterances may still overlap in the speakers. Configure a blocking command (`say`,
`spd-say -w`, `espeak`) if you want real one-at-a-time behaviour.

## 2. The offline voice (Kokoro) — a download you opt into

The system command is only as good as whatever TTS your machine happens to have,
and on a stock Linux box that is usually not good. The offline voice is the
alternative: a neural text-to-speech model that runs locally, sounds far better,
and works with the network off.

It is **not** in the installer. Harnu downloads it, once, when you ask it to.

### What gets downloaded

About **119 MB**, in four parts:

| Part          | Size     | What it is                                   |
| ------------- | -------- | -------------------------------------------- |
| Engine code   | ~2.4 MB  | `kokoro-js`, `phonemizer`, transformers.js   |
| ONNX runtime  | ~21.6 MB | The WebAssembly that actually runs the model |
| Model weights | 92.4 MB  | Kokoro-82M, 8-bit quantised                  |
| One voice     | 511 KB   | Add more later; each is another 511 KB       |

It all lands in Harnu's own application-data directory, under `voice-kokoro/`.
The exact path is shown before you confirm.

### Why the download includes the code, not just the model

This is deliberate and it is the whole design. `kokoro-js` is Apache-2.0 and so
are the weights — those are not the problem. Its dependency `phonemizer` declares
Apache-2.0 but ships a compiled copy of **espeak-ng**, which is **GPLv3**. If
Harnu put that inside the `.AppImage` / `.deb` / `.dmg` / `.exe` it distributes,
the whole shipped binary would have to go out under GPLv3.

So Harnu ships none of it. Your machine fetches it, for your own use, and Harnu
stays MIT. Bundling only the library and downloading only the model would look
tidier and would not work — the library is the part that carries the GPL.

The full reasoning is [`docs/adr/0012`](../adr/0012-espeak-ng-gpl-exposure-in-a-bundled-kokoro-backend.md).
A CI gate fails the build if either package ever ends up inside a release.

### Nothing downloads behind your back

Turning voice on does not start a download. Selecting the offline engine does not
start a download. The only thing that starts a download is you pressing the
button, after a screen that states the size, the contents, the destination and
the licence terms.

If you select the offline voice with nothing downloaded, Harnu tells you it hasn't
been downloaded yet and stays quiet. It never falls back to a worse voice without
telling you, and it never quietly fetches 119 MB on a metered connection.

### Interrupting and removing it

- **Cancel** a download and it leaves nothing behind — no half-file, no
  half-installed engine. Cancelling while adding a voice to a working install
  leaves that install alone.
- **A crash or a quit** mid-download is different: the partial file survives and
  the next attempt picks up where it stopped instead of re-fetching 92 MB.
- **Remove** it and the disk is reclaimed; Harnu returns to exactly the state it
  was in before you downloaded anything.

### It speaks English only

The offline voice has 28 voices, American and British English, and that is the
whole list. Portuguese is shown as unavailable, with the reason.

This is a limit of `kokoro-js`, not of the model or of the download: the library
hardcodes every voice to `en-us` or `en-gb`. The Kokoro model does contain
Portuguese voices, and the phonemizer that comes with it can pronounce
Portuguese — but reaching them needs a change to the library itself, which Harnu
has not made. **Downloading more will not add Portuguese.** If you need Harnu to
speak Portuguese today, use the system-command engine with a Portuguese TTS on
your machine.

### Attribution

`kokoro-js`, `@huggingface/transformers` and the Kokoro-82M weights are
Apache-2.0. `onnxruntime-web` is MIT. `phonemizer` declares Apache-2.0 but embeds
espeak-ng, which is GPL-3.0-or-later. All of this is stated on the consent screen
before anything is fetched.

## Choosing a voice

The offline engine has **28 voices** and they are listed as voices, not as
models. That distinction is the whole shape of the download: the 92 MB model is
shared infrastructure that arrives once and then disappears from the screen,
while each voice is a separate file of about **511 KB**. Adding a second voice is
half a megabyte, not another 92.

Each row shows the voice's name, its id, its locale, the grade its authors gave
it, and its size. A voice you already have offers **Use** — which both selects it
and speaks the phrase in it, so you find out what you picked instead of guessing
from a name. The voice already in use offers **Preview** instead, to hear it again
without changing anything. A voice you don't have yet offers **Get**, which
downloads that one file. `af_heart` is the default and the only A-graded voice on
the list.

Twenty-eight rows is a lot of screen, so the list scrolls inside a short box
rather than pushing everything below it off the page. The voice currently in use
is named on the line just above the list and stays there however far you scroll,
and opening the tab scrolls the list straight to it.

## What it says

This is the part that makes voice worth more than the chime you already have.

A chime tells you _something_ happened. Only a sentence tells you **which
session** and **what** — and that is the difference between glancing back at the
screen and not having to. So the phrase is yours to write:

```
Phrase   {folder} — {session} {event}
→        harnu — feat t216 is waiting for you
```

Three placeholders are understood — `{folder}`, `{session}` and `{event}` — and
anything else you type in braces is dropped rather than read aloud. A value that
has nothing in it yet (a session with no summary) takes its separator with it, so
the sentence degrades to the parts that do have content instead of speaking a
dangling dash. There is a live preview under the field and a **Test** button that
speaks it.

Both placeholders are also cleaned up before they are spoken, so the sentence
sounds like something a person would say rather than an identifier read out
letter by letter. A folder that is really a branch slug or worktree name
(`card-BUG-117-kokoro-synthesis-…`) becomes plain words (`bug 117, kokoro
synthesis…`); a full path is trimmed to its last segment; and a session with no
real summary yet — just a raw id — is treated the same as "nothing in it yet"
rather than having its UUID read aloud.

The three events — **Needs input**, **Completed**, **Failed** — are the same ones
the notifications use, shown here so you don't have to go looking for them. Voice
rides the notification decision rather than keeping a second set of switches you
would have to keep in sync: if a notification is off, it isn't spoken either.

One thing worth knowing: voice rides the **same decision** the notifications
make. If the OS-notifications master switch (Settings → General → Notifications)
is off, nothing is spoken either — the Voice tab says so rather than leaving you
to work it out from the silence.

## What Test tells you

Test is the one button in Harnu whose entire output is sound, which is the one
output you cannot see. So it says out loud, in text, what it is doing.

- The moment you press it, the button spins and a line appears. The click is
  acknowledged before any audio exists — which matters most on the first press
  with the offline voice, where Harnu is loading the voice and the line says so.
- While the sentence is playing, the line says it is speaking.
- When it finishes, the line says what actually happened:
  - **Spoken** — it played through to the end. This is the only line that
    mentions your volume, because it is the only case where your speakers are
    the one thing left that could explain a silence.
  - **Nothing was spoken**, and why: voice is switched off, voice is muted, or
    the phrase came out empty. None of those is a fault — they are Harnu doing
    what you asked — and they used to look exactly like a broken feature.
  - **Stopped** — something cut it short, usually you muting mid-sentence.
  - A **failure** naming what failed: a command that isn't on your PATH, a voice
    that was never downloaded, no audio device. Harnu never guesses that your
    volume is down; if it does not know why, it says that instead.

Pressing Test again while one is still playing does nothing, on purpose. Harnu
plays utterances one after another, so a second press would not interrupt the
first — it would queue a second sentence behind it. Every speak button in the tab
is greyed out until the current one finishes. The per-voice **Use** and
**Preview** buttons report themselves exactly the same way.

## When it can't speak

If an utterance fails — the command isn't installed, the model isn't downloaded,
there's no audio device — Harnu does two things and neither of them is a popup:

1. It **falls back to the chime**, so a notification you would otherwise have
   missed still makes a sound.
2. It shows a line at the top of the Voice pane saying **why**.

That is deliberate. Failing loudly on every notification would be worse than the
problem; failing silently with no way to find out what happened would be worse
still. So the sound is covered and the reason is one click away.

## Disk

Once something is installed, the bottom of the Voice pane shows how much space it
is using and exactly where, with a **Remove** button. Removing reclaims all of it
and puts Harnu back where it was before you downloaded anything — the engine falls
back to the system command, and nothing is left behind.

## Sessions asking to be heard

Everything above is the engine — how Harnu makes sound at all. A **session** asking
to speak has a second gate on top of it: agent speech is off until you turn it on,
globally or per folder, and an explicit per-folder mute beats the global. A folder
you have blocked for agents is silent whatever the voice settings say.

Both gates have to be open. If a session reports that it spoke and you heard
nothing, the usual reason is that the engine's own switch above is off — the
session is told that explicitly rather than being left to assume it was heard.

The **Sessions** block in the Voice pane is where you see that state instead of
guessing at it. The switch sets the global default. Under it, Harnu lists only the
folders that carry a **deliberate exception** — one you set, or one blocked for
agents — because listing every folder would bury the handful that were actually
decided. Each row says in words whether it is _inherited_, _set on_, _set off_ or
_blocked_, and the control shows the same thing in colour: an explicit choice is
filled in, an inherited one only gets a soft border. That contrast is the point.
A folder that speaks because it inherited the global and a folder that speaks
because somebody turned it on must not look identical, or you can never find the
folder you muted last month.

Two things the pane will not do:

- **Turning the global on does not write anything into your folders.** It sets
  one value. Every explicit choice you made, in either direction, survives it —
  a folder you muted on purpose stays muted.
- **It cannot un-block a folder.** A folder blocked for agents shows as
  silent-and-locked with no control to click. Voice is not a back door into a
  folder you closed; unblock it from the folder's own menu if that is what you
  want.

**Clear exceptions** removes every per-folder override at once and leaves the
global exactly as it was — the way back to pure inheritance.

The full rules — including the length cap, the per-session rate limit, and why a
spoken line is deliberately _not_ a notification you can find again — are in
[Agent control](agent-control.md#sessions-talking-out-loud).
