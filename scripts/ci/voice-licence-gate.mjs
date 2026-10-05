#!/usr/bin/env node
// CLI for the voice licence gate (T241, ADR-0012 option C). Runs after the
// build in CI: the packaged artifact must contain no `kokoro-js` and no
// `phonemizer`, because the latter inlines a GPLv3 espeak-ng and shipping it
// would relicense Harnu's binary. Every rule (and why it looks for symbols
// rather than package names) is documented in `voice-licence-core.mjs`.
//
// Env:
//   VOICE_LICENCE_REQUIRE_ARTIFACT   '1' to fail when there is no build output
//                                    to scan. CI sets it; a local run without a
//                                    build still checks the dependency tree.

import { formatVerdict, voiceLicenceVerdict } from './voice-licence-core.mjs'

const repoRoot = process.cwd()
const requireArtifact = process.env.VOICE_LICENCE_REQUIRE_ARTIFACT === '1'

const verdict = await voiceLicenceVerdict({ repoRoot, requireArtifact })
console.log(formatVerdict(verdict, repoRoot))
process.exit(verdict.ok ? 0 : 1)
