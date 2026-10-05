# ADR-0012 — Can Capy redistribute espeak-ng (GPLv3) inside a packaged Kokoro backend?

**Status:** **Accepted — option C (runtime opt-in download)**
**Date:** 2026-08-26 · **decided 2026-09-02** · implemented in T241
**Author:** Claude (drafting), from the T237 research half
**Deciders:** operator. The decision is recorded in §9; §6 was the recommendation it accepted.
**Technical context:** `src/renderer/src/lib/speech*.ts`, `src/main/speech*.ts`, `electron-builder.yml`, `package.json` (`"license": "MIT"`)

> Gated card **T241** (bundled Kokoro backend), which is now **unblocked and built** on
> option C. It gates **nothing** in T237: the system-command backend that shipped has no
> espeak-ng dependency, direct or transitive.

---

## 1. The question in one paragraph

Capy is MIT and ships a packaged Electron binary. A bundled offline voice would use
`kokoro-js`, which is Apache-2.0, with Apache-2.0 weights. But `kokoro-js` depends on
`phonemizer`, and `phonemizer` — while declaring `"license": "Apache-2.0"` — ships a
compiled **espeak-ng** inside its own JavaScript bundle. espeak-ng is **GPL-3.0-or-later**.
So the question is not "is Kokoro permissively licensed" (it is), it is: **may Capy put a
GPLv3 work inside the `.AppImage` / `.deb` / `.dmg` / `.exe` it distributes, and if so at
what cost?**

## 2. What was verified (facts, not recollection)

Everything here was checked against the registry and the upstream sources on 2026-08-26.

| Claim                                                  | Verified how                                                                           | Result                                                                                                                                                                                                            |
| ------------------------------------------------------ | -------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `kokoro-js@1.2.1` is Apache-2.0                        | `npm view kokoro-js`                                                                   | Apache-2.0, author `hexgrad`, contributor `Xenova`                                                                                                                                                                |
| `kokoro-js` depends on `phonemizer`                    | `npm view kokoro-js dependencies`                                                      | `phonemizer ^1.2.1`, `@huggingface/transformers ^3.5.1` — no opt-out, no peer/optional                                                                                                                            |
| `phonemizer@1.2.1` declares Apache-2.0                 | `npm view phonemizer`                                                                  | `"license": "Apache-2.0"`, author `Xenova`                                                                                                                                                                        |
| `phonemizer` actually ships espeak-ng                  | tarball extracted and inspected                                                        | `dist/phonemizer.js` is **1.32 MB** and inlines an Emscripten build of espeak-ng as a base64 WASM blob; 144 `espeak` occurrences; the package ships `types/espeakng.worker.d.ts` for the worker module            |
| The only licence file `phonemizer` ships is Apache-2.0 | `package/LICENSE`, 201 lines                                                           | Apache-2.0 text only — **no GPLv3 text, no espeak-ng copyright notice, no written offer of source**. The repo tree (`xenova/phonemizer.js`) has a single `LICENSE`; the README never mentions espeak-ng's licence |
| espeak-ng is GPLv3                                     | `espeak-ng/espeak-ng` `COPYING` + README                                               | "eSpeak NG Text-to-Speech is released under the **GPL version 3 or later** licence" (one BSD-2 file, `getopt.c`, is the sole exception)                                                                           |
| Upstream has been asked and has not answered           | `hexgrad/kokoro` issue **#247**, "[Question] GPL implications of espeak-ng dependency" | Opened 2025-08-06, **still OPEN**, no maintainer ruling. A contributor points to an unreleased `misaki` transformer G2P; the reporter observes `misaki` still ships an `espeak.py`                                |
| The permissive drop-in replacement is dead             | `NeuralVox/OpenPhonemizer`                                                             | BSD-3-Clause-Clear, but the repo is **archived** (last push 2026-03-15). Not a maintainable dependency                                                                                                            |

**The single most important fact:** `phonemizer`'s declared licence is wrong about the
bytes it ships. A downstream redistributor does not get to rely on that declaration —
the espeak-ng copyright holders' terms govern, not an npm manifest field written by a
third party. Capy inherits the obligation, not the mislabel.

## 3. Why this is a _combined work_, not mere aggregation

The FSF's test is whether the parts are "separate programs" or one program. Against
espeak-ng-in-`phonemizer`:

- It is **not** a separate program invoked at arm's length. It is a WASM module compiled
  into the same JS bundle, instantiated by our code, in our process, and called
  synchronously through a function-call-shaped API.
- The only distance is that `phonemizer` runs it in a **Web Worker**. That is the
  strongest argument for the permissive reading — a worker is a separate JS realm talking
  over `postMessage`, which superficially resembles the "separate processes exchanging
  messages" pattern the FSF treats as aggregation. It is arguable, and it is only
  arguable: same address space at the OS level, shipped in one artifact, useless apart,
  and built by us into one product. No court and no FSF statement has blessed the
  worker-boundary reading. **Do not bet a distributed binary on it.**

Conclusion of the analysis: if Capy bundles it, **Capy distributes a combined work that
must be offered under GPLv3**. MIT is GPL-compatible, so the combination is _lawful_ —
what changes is the licence the _binary_ goes out under, not whether it may exist.

## 4. What accepting it would actually cost

Capy's source is already public and MIT, which removes most of the usual pain. The real,
non-obvious costs:

1. **The packaged binary becomes GPLv3 as a whole.** Capy's own files can stay MIT in the
   repo; the shipped artifact carries GPLv3 terms. Every release must ship the GPLv3 text,
   the espeak-ng copyright notice, and a working offer of _corresponding source_ for the
   espeak-ng build — which `phonemizer` does not provide, so Capy would have to reconstruct
   and host it. **We would be curing someone else's compliance defect, per release.**
2. **It is one-way.** GPLv3 forecloses ever shipping a closed, paid or OEM-embedded Capy
   variant containing that code. Unwinding later means re-cutting releases.
3. **GPLv3 §6 installation information** (the anti-tivoisation clause) attaches if Capy is
   ever shipped on a locked-down appliance. Not today's problem; a real future one.
4. **Store distribution risk.** GPLv3 is incompatible with the Apple App Store's terms.
   Not a channel Capy uses today — a door that closes.
5. **Downstream redistributors inherit it**, including anyone repackaging Capy.

## 5. The options, priced

| #   | Option                                                                                                                                          | GPL exposure for Capy                                                                                         | Cost                                                                                                                             | Does the operator get an offline voice?                                    |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| A   | **Refuse.** Keep only the system-command backend that shipped in T237.                                                                          | None                                                                                                          | Zero                                                                                                                             | No — the operator installs their own TTS (`speak-notify`, `espeak`, `say`) |
| B   | **Accept.** Bundle it and relicense the distributed binary GPLv3.                                                                               | Full, permanent                                                                                               | Per-release compliance work, incl. hosting espeak-ng corresponding source; forecloses a closed variant                           | Yes, offline, zero setup                                                   |
| C   | **Runtime opt-in download.** Ship no model and no phonemizer; on first use, with explicit consent, fetch `kokoro-js` + weights into `userData`. | None _by Capy_ — the user performs the combination on their own machine, and Capy never distributes GPL bytes | Moderate: a downloader, integrity checks, ~92 MB of weights, an offline/air-gapped failure path, a consent screen                | Yes, after a one-time download                                             |
| D   | **Replace the phonemizer.** Fork `kokoro-js` onto a permissive G2P.                                                                             | None                                                                                                          | High and open-ended: `OpenPhonemizer` is archived; no maintained permissive JS G2P was found; a fork is ours to maintain forever | Eventually, maybe                                                          |

Note on **C**: this is the ordinary "the app fetches an optional plugin" pattern, and it is
what removes Capy from the distribution chain — the FSF is unenthusiastic about designs
whose only purpose is to combine, but the obligation attaches to whoever _distributes_, and
under C that is the user, to themselves. It is materially safer than B and materially less
final. It is not zero-argument.

## 6. Recommendation (a recommendation, not a decision)

**Recommended: C — runtime opt-in download — with A as the standing fallback.** It gets the
operator a bundled-quality offline voice without Capy ever shipping a GPLv3 byte, keeps the
MIT binary MIT, and is reversible; the cost is a downloader and a consent screen, not a
licence change. **A is the correct choice if the offline voice is not worth a downloader** —
T237's system-command backend already covers the operator's own machine today, which is
where the whole voice feature is being proven.

**Recommended against: B**, not because it is unlawful — it is lawful — but because it is
permanent, it makes Capy responsible for espeak-ng compliance that upstream skipped, and it
buys convenience at the price of every future distribution option. **D is not viable now**:
the one permissive replacement found is archived.

## 7. What the operator had to decide

> Answered on 2026-09-02 — see §9. Kept as written so the questions the decision
> answered stay legible next to the answers.

1. **A, B, C or D for T241?** If B, accept that the shipped artifact is GPLv3 and that
   per-release compliance (licence text, notices, corresponding-source hosting) becomes a
   release-checklist item.
2. **If C: is a ~92 MB first-use download acceptable**, and what happens on an air-gapped
   machine — silent fallback to the system command, or a visible refusal?
3. **Is a lawyer wanted before B?** The analysis above is an engineer's reading of public
   licences, not legal advice. The combined-work conclusion is the mainstream reading; the
   Web-Worker counter-argument in §3 is the only thing a lawyer might weigh differently.

## 8. Sources

- [`kokoro-js` on npm](https://www.npmjs.com/package/kokoro-js) · [`phonemizer` on npm](https://www.npmjs.com/package/phonemizer) — declared licences and dependency graph
- [`xenova/phonemizer.js`](https://github.com/xenova/phonemizer.js/) — single Apache-2.0 `LICENSE`, no espeak-ng notice
- [`espeak-ng/espeak-ng`](https://github.com/espeak-ng/espeak-ng) — `COPYING` (GPLv3) and the README's "License Information"
- [hexgrad/kokoro issue #247](https://github.com/hexgrad/kokoro/issues/247) — the unanswered upstream GPL question
- [thewh1teagle/kokoro-onnx issue #120](https://github.com/thewh1teagle/kokoro-onnx/issues/120) — the same problem in the Python ecosystem
- [rhasspy/piper-phonemize issue #17](https://github.com/rhasspy/piper-phonemize/issues/17) — the precedent: espeak-ng linkage is why Piper is GPL
- [NeuralVox/OpenPhonemizer](https://github.com/NeuralVox/OpenPhonemizer) — the permissive drop-in, archived

---

## 9. The decision (2026-09-02)

**Option C — runtime opt-in download. Nothing ships in the installer.**

### The reasoning, as the operator gave it

The earlier standing fallback (option A: keep only the system-command backend) is
**dropped**. The default Linux TTS — `espeak` / `spd-say`, which is what a machine with
nothing installed actually has — sounds bad enough that shipping it as _the_ experience
would fail the "is being read to useful?" test for the wrong reason: the operator would
conclude the feature is useless when what is useless is the voice. So there is no
automatic fallback chain across platforms. **If you want a good voice, you download it.**

### The answers to §7

1. **A, B, C or D?** → **C.**
2. **Is a ~92 MB first-use download acceptable, and what happens air-gapped?** → Yes,
   and the real figure is **~119 MB** (see below). Air-gapped is a **visible refusal**,
   not a silent fallback: the backend reports `model-missing` through the engine's own
   state and stays quiet. Nothing downloads implicitly.
3. **A lawyer before B?** → Moot. B was not chosen.

### The trap this decision exists to avoid

The dangerous artifact is **not** the 92 MB of weights — those are Apache-2.0 and
harmless. The GPL lives in `phonemizer`. So the obvious-looking split — _bundle the
library, download the model_ — is **option B in disguise**, and it relicenses the whole
shipped binary as GPLv3 while looking like a tidy engineering compromise.

Therefore: **the download fetches the CODE as well as the weights.** `kokoro-js`,
`phonemizer`, `@huggingface/transformers` and the ONNX runtime are all fetched at
runtime into `userData`, and none of them appears in `package.json` or in the packaged
build.

### What was actually built (T241)

- A `kokoro` backend behind T237's existing seam — one new member in `SpeechBackendId`,
  one new module, one line in `speech-registry.ts`. The queue, the mute, the focus gate
  and every caller are unchanged.
- A runtime installer (`src/main/speech-kokoro{,-plan}.ts`) that mirrors jsDelivr's
  browser-ready `/+esm` module graph plus the Hub model files into
  `<userData>/voice-kokoro/`, served back to the renderer over a `capy-voice://`
  protocol. Resumable, cancellable, removable.
- Download size, in the honest tiers a consent step should quote: **~2.4 MB** of module
  code · **~21.6 MB** ONNX WASM runtime · **92.4 MB** `model_quantized.onnx` (q8) ·
  **511 KB** per voice. **≈119 MB** for a first install.
- **The compliance claim is mechanical, not asserted.** `scripts/ci/voice-licence-gate.mjs`
  runs after the build in CI and fails it if `kokoro-js` or `phonemizer` appear in the
  dependency tree, in a static import, or as vendor payload inside `out/**` or a packaged
  `app.asar`. It looks for symbols from the real packages (`eSpeakNGWorker`,
  `generate_from_ids`, …) rather than package names, because Capy's own consent copy
  legitimately names the packages.

### What is still not solved

- **Portuguese does not work and is not implied.** `kokoro-js` hardcodes `en-us`/`en-gb`
  and exports only the 28 English voices. The model does have `pf_dora`, `pm_alex` and
  `pm_santa`, and the bundled phonemizer can phonemise Portuguese — but unlocking them
  needs a fork of the language map, which T241 did not do. `pt-BR` is rendered as
  **unavailable with a reason**, never silently broken.
- **Upstream's own compliance defect is untouched.** `phonemizer` still declares
  Apache-2.0 while shipping GPLv3 bytes, and
  [hexgrad/kokoro#247](https://github.com/hexgrad/kokoro/issues/247) is still open.
  Option C removes Capy from the distribution chain; it does not fix the mislabel, and it
  does not make the operator's own copy less GPL.
