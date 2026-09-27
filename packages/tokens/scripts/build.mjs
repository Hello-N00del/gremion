#!/usr/bin/env node
// @gremion/tokens build (UX-032 web target).
//
//   node scripts/build.mjs                  validate + lint, write dist/gremion.css
//                                           (:root and .dark custom properties) and
//                                           dist/palettes.json (per-palette overrides)
//   node scripts/build.mjs --write <css>    also rewrite the /* tokens:generated */
//                                           fences in a consumer stylesheet
//   node scripts/build.mjs --check <css>    exit 1 when that stylesheet's fences are
//                                           missing, misplaced or stale (verify hook)
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { buildCss, buildPalettes, checkFences, loadTokens, syncFences } from '../src/build.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
/** @param {string} flag */
const argOf = (flag) => {
  const i = args.indexOf(flag)
  if (i === -1) return null
  const v = args[i + 1]
  if (!v) {
    console.error(`[tokens] ${flag} needs a stylesheet path`)
    process.exit(2)
  }
  return resolve(process.cwd(), v)
}

const sets = loadTokens()
const built = buildCss(sets)
const palettes = buildPalettes(sets.base)

const check = argOf('--check')
if (check) {
  const problems = checkFences(readFileSync(check, 'utf8'), built)
  if (problems.length > 0) {
    console.error(`[tokens] ${check}:\n  ${problems.join('\n  ')}`)
    process.exit(1)
  }
  console.log(`[tokens] ${check}: generated blocks in sync (${built.light.length} light, ${built.dark.length} dark declarations)`)
  process.exit(0)
}

/** @param {import('../src/build.js').Declarations} decls */
const block = (decls) => decls.map(([n, v]) => `  ${n}: ${v};`).join('\n')
mkdirSync(join(root, 'dist'), { recursive: true })
writeFileSync(join(root, 'dist', 'gremion.css'), `:root {\n${block(built.light)}\n}\n\n.dark {\n${block(built.dark)}\n}\n`)
writeFileSync(join(root, 'dist', 'palettes.json'), `${JSON.stringify(palettes, null, 2)}\n`)
console.log(`[tokens] dist/gremion.css: ${built.light.length} light, ${built.dark.length} dark declarations`)
console.log(`[tokens] dist/palettes.json: ${Object.keys(palettes).length} palettes`)

const write = argOf('--write')
if (write) {
  const css = readFileSync(write, 'utf8')
  const next = syncFences(css, built)
  if (next !== css) writeFileSync(write, next)
  console.log(`[tokens] ${write}: ${next === css ? 'already in sync' : 'generated blocks rewritten'}`)
}
