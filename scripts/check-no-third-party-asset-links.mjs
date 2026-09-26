#!/usr/bin/env node
// Third-party font/icon CDN guard — TASK-007, TRD-337.
//
// TRD-337: no web or mobile surface may request a font or icon from a
// third-party host. gremion-ui's fonts and icons were already self-hosted
// (#177: @fontsource + hand-rolled inline-SVG Icon.svelte); gremion-public's
// fonts were not (fixed alongside this guard). Neither app has ever used an
// icon *package* — a future one (an icon-font kit, an SVG-sprite CDN, a
// Google Fonts Material Symbols link, etc.) would land as exactly the shape
// this checks for: an absolute-URL <link href="..."> tag.
//
// Pure function over file TEXT, not a live network trace — see
// tests/e2e/support/no-third-party-network.ts in each app for the runtime
// proof. This one exists so the RED proof does not depend on mutating a real
// file (same idiom as scripts/check-postgres-major.mjs / .test.mjs, B37).
//
// Run:  node scripts/check-no-third-party-asset-links.mjs <file> [<file> ...]
// Test: node --test scripts/check-no-third-party-asset-links.test.mjs

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const LINK_RE = /<link\b[^>]*\bhref\s*=\s*"([^"]+)"[^>]*>/gi

/**
 * @param {string} text HTML (or Svelte template) source text.
 * @param {string} [label] identifies the source in problem messages.
 * @returns {string[]} one problem string per third-party <link href="..."> found; [] if none.
 */
export function findThirdPartyAssetLinks(text, label = '<input>') {
  const problems = []
  let m
  LINK_RE.lastIndex = 0
  while ((m = LINK_RE.exec(text))) {
    const href = m[1]
    if (/^https?:\/\//i.test(href)) {
      problems.push(
        `${label}: third-party <link href="${href}"> — fonts and icons must be ` +
          `self-hosted (TASK-007 / TRD-337), found no allowlist entry for this host`
      )
    }
  }
  return problems
}

/** @param {string} filePath */
export function checkFile(filePath) {
  return findThirdPartyAssetLinks(readFileSync(filePath, 'utf8'), filePath)
}

// House idiom (check-postgres-major.mjs) — a raw `file://${process.argv[1]}`
// string concat never round-trips on Windows (drive-letter + backslash paths)
// nor on POSIX when the path needs percent-encoding, so it silently never
// matched and the CLI exited 0 with no output regardless of input (TASK-007
// review r1, MEDIUM — proven by scripts/check-no-third-party-asset-links.test.mjs's
// spawned-CLI cases).
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]
if (isMain) {
  const files = process.argv.slice(2)
  if (files.length === 0) {
    console.error('usage: check-no-third-party-asset-links.mjs <file> [<file> ...]')
    process.exit(2)
  }
  const problems = files.flatMap(checkFile)
  if (problems.length > 0) {
    console.error(problems.join('\n'))
    process.exit(1)
  }
  console.log(`OK — no third-party asset <link> in ${files.length} file(s)`)
}
