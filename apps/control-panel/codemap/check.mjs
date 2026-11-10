// check.mjs - the CI check for the code map. It LISTS; it does not block.
//
//   node codemap/check.mjs        (package.json: pnpm --filter control-panel codemap:check)
//
// 1. runs extract.mjs in normal git mode into a temp folder under the system temp folder,
// 2. joins the written text to the graph (resolve.mjs): stale steps, stale areas, undescribed areas, ambiguous steps,
// 3. scans the generated page, ste-text.json and template.html for leaks (leak-scan.mjs),
// 4. runs ste-lint.mjs and reports the number of findings.
// With GITHUB_STEP_SUMMARY set it appends a markdown table; it prints a ::warning:: line for each stale item.
// The exit codes are distinct, so that a caller can tell a leak from a broken tool:
//   0  the check ran, stale items or not
//   1  a leak was found (a host name, an address or a credential in the page, the text or the template)
//   3  the tool itself failed (the extractor failed, a file cannot be read, the check crashed)
// A leak is reported by rule id and place, never by the matched text. scripts/ci-local/guards.mjs (the arm
// codemap-stale) reads these codes: only a leak fails there.
import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildMap } from './build.mjs'
import { findLeaks } from './leak-scan.mjs'
import { resolve } from './resolve.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))

export const EXIT_RAN = 0
export const EXIT_LEAK = 1
export const EXIT_TOOL_FAILED = 3

/** A workflow command message: % and line breaks must be escaped or the command is cut. */
export const escapeCommand = (s) => String(s).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A')

const lineOf = (source, index) => source.slice(0, index).split('\n').length
const stepWhat = (s) => (s.function ? `${s.file} · ${s.function}` : (s.nodeId ?? 'unknown'))

/**
 * Pure: everything the check says, from its inputs.
 * @param {{ graph: object, text: object, template: string, textSource: string, templateSource: string, commit: string, steFindings: {count:number, byRule:object} }} input
 */
export function analyse({ graph, text, template, textSource, templateSource, commit, steFindings }) {
  const r = resolve(graph, text)
  const lists = { staleSteps: r.staleSteps, staleAreas: r.staleAreas, undescribedAreas: r.undescribedAreas, ambiguousSteps: r.ambiguousSteps }
  const built = buildMap({ graph, text, template, commit })
  const leaks = []
  for (const l of built.leaks) leaks.push({ rule: l.rule, where: 'generated page' })
  for (const [where, source] of [['ste-text.json', textSource], ['template.html', templateSource]]) {
    for (const l of findLeaks(source)) leaks.push({ rule: l.rule, where: `${where}, line ${lineOf(source, l.index)}` })
  }

  const out = []
  const p = (s = '') => out.push(s)
  p('Code map check (it lists; it never blocks)')
  p(`commit: ${commit}`)
  p(`map: ${built.status.counts.functions} functions, ${built.status.counts.connections} connections`)
  p('')
  p(`stale steps: ${lists.staleSteps.length}`)
  for (const s of lists.staleSteps) p(`  - ${s.walkthrough} | step ${s.step} | ${s.file ?? ''} | ${s.function ?? s.nodeId ?? ''} | ${s.text}`)
  p(`stale areas: ${lists.staleAreas.length}`)
  for (const a of lists.staleAreas) p(`  - ${a}`)
  p(`undescribed areas: ${lists.undescribedAreas.length}`)
  for (const a of lists.undescribedAreas) p(`  - ${a}`)
  p(`ambiguous steps: ${lists.ambiguousSteps.length}`)
  for (const s of lists.ambiguousSteps) p(`  - ${s.walkthrough} | step ${s.step} | ${s.file} | ${s.function} | ${s.matches} matches, line ${s.line} used`)
  p(`STE findings: ${steFindings.count}${steFindings.count ? ' ' + JSON.stringify(steFindings.byRule) : ''}`)
  p(`leaks: ${leaks.length}`)
  for (const l of leaks) p(`  - ${l.rule} in ${l.where}`)

  const warnings = [
    ...lists.staleSteps.map((s) => `::warning title=Code map stale step::${escapeCommand(`${s.walkthrough}, step ${s.step}: ${stepWhat(s)} matches no function in the code`)}`),
    ...lists.staleAreas.map((a) => `::warning title=Code map stale area::${escapeCommand(`the text for ${a} matches no area in the code`)}`),
  ]
  const errors = leaks.map((l) => `::error title=Code map leak::${escapeCommand(`${l.rule} in ${l.where}`)}`)
  return { exitCode: leaks.length ? EXIT_LEAK : EXIT_RAN, report: out.join('\n'), lists, leaks, warnings, errors, steFindings, commit }
}

/** The table for GITHUB_STEP_SUMMARY. */
export function markdownSummary(r) {
  const cell = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ')
  const rows = [
    ...r.lists.staleSteps.map((s) => ['stale step', `${s.walkthrough}, step ${s.step}`, stepWhat(s)]),
    ...r.lists.staleAreas.map((a) => ['stale area', a, '']),
    ...r.lists.undescribedAreas.map((a) => ['undescribed area', a, '']),
    ...r.lists.ambiguousSteps.map((s) => ['ambiguous step', `${s.walkthrough}, step ${s.step}`, `${s.file} · ${s.function} (${s.matches} matches)`]),
  ]
  const md = ['## Code map', '', `Commit \`${r.commit}\`. STE findings: ${r.steFindings.count}. Leaks: ${r.leaks.length}.`, '']
  if (rows.length) {
    md.push('| Kind | Where | Detail |', '| --- | --- | --- |')
    for (const row of rows) md.push(`| ${row.map(cell).join(' | ')} |`)
  } else md.push('Text and code match.')
  return md.join('\n') + '\n'
}

function steLint(textPath, graphPath) {
  const res = spawnSync(process.execPath, [path.join(HERE, 'ste-lint.mjs'), textPath, graphPath], { encoding: 'utf8', env: { ...process.env, STE_SHOW: '0' } })
  const m = /^findings: (\d+)(?: (\{.*\}))?$/m.exec(res.stdout ?? '')
  // ste-lint exits 1 when it has findings and 0 when it has none; anything else is a crash.
  if (!m || (res.status !== 0 && res.status !== 1)) throw new Error(`ste-lint crashed (exit ${res.status})`)
  return { count: Number(m[1]), byRule: m[2] ? JSON.parse(m[2]) : {} }
}

function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'codemap-check-'))
  try {
    const graphPath = path.join(tmp, 'graph.json')
    const ex = spawnSync(process.execPath, ['--max-old-space-size=3072', path.join(HERE, 'extract.mjs'), '--out', graphPath, '--deps', path.resolve(HERE, '..')], {
      encoding: 'utf8',
      maxBuffer: 1 << 28,
      timeout: 10 * 60 * 1000,
    })
    if (ex.status !== 0) {
      console.error(`::error title=Code map::the extractor failed (exit ${ex.status ?? ex.signal})`)
      console.error(String(ex.stdout ?? '').split('\n').slice(-15).join('\n'))
      console.error(String(ex.stderr ?? '').split('\n').slice(-15).join('\n'))
      // not process.exit: it would skip the finally below and leave the temp folder behind
      process.exitCode = EXIT_TOOL_FAILED
      return
    }
    const read = (f) => fs.readFileSync(path.join(HERE, f), 'utf8')
    const graph = JSON.parse(fs.readFileSync(graphPath, 'utf8'))
    let commit = 'unknown'
    try {
      commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: HERE, encoding: 'utf8' }).trim()
    } catch { /* no git: the commit is unknown */ }
    const textSource = read('ste-text.json')
    const templateSource = read('template.html')
    const r = analyse({
      graph,
      text: JSON.parse(textSource),
      template: templateSource,
      textSource,
      templateSource,
      commit,
      steFindings: steLint(path.join(HERE, 'ste-text.json'), graphPath),
    })
    console.log(r.report)
    for (const w of r.warnings) console.log(w)
    for (const e of r.errors) console.log(e)
    if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, markdownSummary(r))
    console.log(r.exitCode === EXIT_LEAK ? `\nresult: a leak was found (exit ${EXIT_LEAK})` : `\nresult: the check ran (exit ${EXIT_RAN})`)
    process.exitCode = r.exitCode
  } catch (err) {
    console.error(`::error title=Code map::the check crashed: ${escapeCommand(err instanceof Error ? err.message : String(err))}`)
    process.exitCode = EXIT_TOOL_FAILED
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
