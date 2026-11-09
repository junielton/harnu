#!/usr/bin/env node
/**
 * The fake `claude`, plus one JSON line in S3_LISTING_LOG per invocation: what its working
 * directory held when the session started. The directory is gone once the session ends, so
 * this is the only moment a test can see it.
 */
import { appendFileSync, readFileSync, readdirSync } from 'node:fs'

const cwd = process.cwd()
const files = readdirSync(cwd)
const bundle = files.includes('bundle.md') ? readFileSync('bundle.md', 'utf8') : null
appendFileSync(process.env.S3_LISTING_LOG, `${JSON.stringify({ cwd, files, bundle })}\n`)

await import('../fake-claude.mjs')
