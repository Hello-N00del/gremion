#!/usr/bin/env node
// Post-condition for `.github/workflows/release-npm.yml`: read the package.json
// that is actually INSIDE the npm tarball and prove it is publishable.
//
// This exists because every property it checks is one that fails silently. A
// tarball whose `exports` still point at `./src/*.ts` publishes without error
// and then fails at the consumer's first `import`; a `private: true` manifest
// is caught by npm, but only after the build has burned; a missing `license`
// renders as UNLICENSED on the package page of an AGPL project.
//
// The one that actually motivated it: `publishConfig.exports` is a pnpm
// manifest override applied at PACK time. If the tarball is ever produced by
// something other than `pnpm pack` — `npm pack`, a future refactor of the
// workflow — the override is silently ignored and the src-pointing map ships.
// Nothing else in the pipeline would notice.
//
// Usage: node scripts/check-packed-manifest.mjs <path-to-extracted-package.json>

import { readFileSync } from 'node:fs'

const path = process.argv[2]
if (!path) {
  console.error('usage: check-packed-manifest.mjs <package.json>')
  process.exit(2)
}

const manifest = JSON.parse(readFileSync(path, 'utf8'))
const exportsJson = JSON.stringify(manifest.exports ?? null)
const problems = []

if (manifest.private) {
  problems.push('the packed manifest is still `"private": true` — npm publish would refuse it')
}
if (manifest.license !== 'AGPL-3.0-only') {
  problems.push(`license is ${JSON.stringify(manifest.license)}, expected "AGPL-3.0-only"`)
}
if (!manifest.exports) {
  problems.push('the packed manifest declares no `exports` map at all')
} else {
  if (exportsJson.includes('./src/')) {
    problems.push(
      `exports still point at src/ — the publishConfig override did not apply: ${exportsJson}`
    )
  }
  if (!exportsJson.includes('./dist/')) {
    problems.push(`exports do not point at dist/: ${exportsJson}`)
  }
  // Every subpath must carry types, or TypeScript consumers get `any` from a
  // package that does ship declarations — the worst of both.
  const missingTypes = Object.entries(manifest.exports)
    .filter(([, v]) => v && typeof v === 'object' && !('types' in v))
    .map(([k]) => k)
  if (missingTypes.length) {
    problems.push(`exports subpath(s) with no "types" condition: ${missingTypes.join(', ')}`)
  }
}
if (!manifest.repository) {
  problems.push('no `repository` field — npm provenance and the package page both need it')
}

if (problems.length) {
  for (const p of problems) console.error(`::error::${p}`)
  process.exit(1)
}

console.log(
  `packed manifest OK: ${manifest.name}@${manifest.version} ${manifest.license} ${exportsJson}`
)
