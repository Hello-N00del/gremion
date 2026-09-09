// gremion-ui/scripts/boundary-lint.ts
// P0.4 boundary-lint CLI. Modes:
//   --staged            lint files staged in git (content from the index) — pre-commit
//   --all               lint the whole tree — periodic run / manual audit
//   --coverage-report   informational: print missing/phantom ops (no exit 1)
//   --contracts         enforcing: validate both OpenAPI docs + ref closure + coverage; exit 1 on any problem
//   --gate-self-test    verify the oasdiff gate works: breaking fixture → detected; compatible fixture → clean
// Run: pnpm -C gremion-ui exec tsx scripts/boundary-lint.ts --staged
import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join, relative } from 'node:path'
import { runBoundaryLint, type LintInput } from '../src/lib/server/boundary/engine'
import { runOasdiffBreaking, gateStagedSpecs } from './contracts-gate'

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' })
}

const repoRoot = git(['rev-parse', '--show-toplevel'], process.cwd()).trim()
const gremionUi = join(repoRoot, 'gremion-ui')

/** The kernel's OpenAPI documents, DISCOVERED rather than listed.
 *
 *  This was a hardcoded pair — governance + finance. The carve removed
 *  contracts/kernel/openapi.finance.json with the finance module, so both modes
 *  below died on an unhandled ENOENT: the enforcing contracts gate could not run
 *  at all, and nothing noticed, because nothing executes it. Discovery keeps the
 *  list true as modules come and go; the vacuity guard keeps a gate that scans
 *  nothing from reporting OK, which is the failure mode this one already had.
 */
function kernelOpenApiFiles(): string[] {
  const dir = join(repoRoot, 'contracts', 'kernel')
  const found = existsSync(dir)
    ? readdirSync(dir).filter((f) => f.startsWith('openapi.') && f.endsWith('.json')).sort()
    : []
  if (found.length === 0) {
    console.error(
      '[contracts] no contracts/kernel/openapi.*.json found — this gate would have validated ' +
        'NOTHING and reported OK. Restore the document(s) or delete the gate; do not let it pass empty.',
    )
    process.exit(1)
  }
  return found.map((f) => `kernel/${f}`)
}


/** The kernel's AsyncAPI documents, DISCOVERED rather than listed.
 *
 *  This was `const asyncApiFiles = ['kernel/asyncapi.provisioning.json']` with an
 *  `existsSync` skip, i.e. carving an AsyncAPI doc away left the gate green and
 *  silent — the same defect the OpenAPI leg above was fixed for. Discovery plus
 *  the vacuity refusal keeps the list true and keeps a gate that scans nothing
 *  from reporting OK.
 *
 *  SCOPE is contracts/kernel/ only, deliberately. contracts/calendar/ and
 *  contracts/content/ describe module leaves that ship in their own repositories
 *  and are validated by no mode; see KNOWN_ISSUES.md. Widening this to the whole
 *  contracts/ tree today would fail on a `collectUnresolvedRefs` false positive
 *  (the content spec's channel $refs are percent-encoded), which is a defect in
 *  the ref collector, not in the spec.
 */
function kernelAsyncApiFiles(): string[] {
  const dir = join(repoRoot, 'contracts', 'kernel')
  const found = existsSync(dir)
    ? readdirSync(dir).filter((f) => f.startsWith('asyncapi.') && f.endsWith('.json')).sort()
    : []
  if (found.length === 0) {
    console.error(
      '[contracts] no contracts/kernel/asyncapi.*.json found — this gate would have validated ' +
        'NOTHING and reported OK. Restore the document(s) or delete the gate; do not let it pass empty.',
    )
    process.exit(1)
  }
  return found.map((f) => `kernel/${f}`)
}

function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) yield* walk(p)
    else yield p
  }
}

function collectAll(): LintInput[] {
  const out: LintInput[] = []
  for (const top of ['migrations', 'migrations-control', 'src']) {
    const dir = join(gremionUi, top)
    if (!existsSync(dir)) continue
    for (const abs of walk(dir)) {
      const rel = relative(gremionUi, abs).split('\\').join('/')
      if (rel.endsWith('.sql') || rel.endsWith('.ts')) out.push({ file: rel, content: readFileSync(abs, 'utf8') })
    }
  }
  return out
}

function collectStaged(): LintInput[] {
  const staged = git(['diff', '--cached', '--name-only', '--diff-filter=ACMR'], repoRoot)
    .split('\n').map((s) => s.trim()).filter(Boolean)
  const out: LintInput[] = []
  for (const repoRel of staged) {
    if (!repoRel.startsWith('gremion-ui/')) continue
    const rel = repoRel.slice('gremion-ui/'.length)
    if (!rel.endsWith('.sql') && !rel.endsWith('.ts')) continue
    out.push({ file: rel, content: git(['show', `:${repoRel}`], repoRoot) })
  }
  return out
}

const mode = process.argv[2]

if (mode === '--coverage-report') {
  const { listKernelRoutes, specOpsFromDocs, compareCoverage } = await import('../src/lib/server/boundary/route-coverage')
  const routes = listKernelRoutes(join(gremionUi, 'src/routes'))
  const docs = kernelOpenApiFiles().map((f) => JSON.parse(readFileSync(join(repoRoot, 'contracts', f), 'utf8')))
  const { missingInSpec, extraInSpec } = compareCoverage(routes, specOpsFromDocs(docs))
  console.log(`[coverage] routes: ${routes.length} files | missing in spec: ${missingInSpec.length} | phantom in spec: ${extraInSpec.length}`)
  for (const x of missingInSpec) console.log(`  missing: ${x}`)
  for (const x of extraInSpec) console.log(`  phantom: ${x}`)
  // Informational BY DESIGN — this mode is the human-readable coverage dump.
  // The ENFORCING path is `--contracts`, which pushes the same missing/phantom
  // ops into `problems` and exits 1.
  process.exit(0)
}

if (mode === '--contracts') {
  const { validateOpenApiDoc, validateAsyncApiDoc, collectUnresolvedRefs } = await import('../src/lib/server/boundary/contracts-schema')
  const { listKernelRoutes, specOpsFromDocs, compareCoverage } = await import('../src/lib/server/boundary/route-coverage')
  const openApiFiles = kernelOpenApiFiles()
  const docs = openApiFiles.map((f) => JSON.parse(readFileSync(join(repoRoot, 'contracts', f), 'utf8')))
  const problems: string[] = []
  for (let i = 0; i < openApiFiles.length; i++) {
    for (const p of validateOpenApiDoc(docs[i])) problems.push(`${openApiFiles[i]}: ${p}`)
    for (const p of collectUnresolvedRefs(docs[i])) problems.push(`${openApiFiles[i]}: unresolved $ref ${p}`)
  }
  // AsyncAPI docs — DISCOVERED, like the OpenAPI list above, and non-empty by
  // construction: kernelAsyncApiFiles() exits 1 rather than validate nothing.
  const asyncApiFiles = kernelAsyncApiFiles()
  let asyncDocsValidated = 0
  for (const f of asyncApiFiles) {
    const asyncDoc = JSON.parse(readFileSync(join(repoRoot, 'contracts', f), 'utf8'))
    for (const p of validateAsyncApiDoc(asyncDoc)) problems.push(`${f}: ${p}`)
    for (const p of collectUnresolvedRefs(asyncDoc)) problems.push(`${f}: unresolved $ref ${p}`)
    asyncDocsValidated++
  }
  const routes = listKernelRoutes(join(gremionUi, 'src/routes'))
  const { missingInSpec, extraInSpec } = compareCoverage(routes, specOpsFromDocs(docs))
  for (const x of missingInSpec) problems.push(`missing in spec: ${x}`)
  for (const x of extraInSpec) problems.push(`phantom in spec: ${x}`)
  if (problems.length > 0) {
    console.error(`[contracts] ${problems.length} problem(s):\n` + problems.map((p) => `  ${p}`).join('\n'))
    process.exit(1)
  }
  const totalDocs = docs.length + asyncDocsValidated
  console.log(`[contracts] OK (${routes.length} routes · ${totalDocs} docs validated)`)
  process.exit(0)
}

if (mode === '--gate-self-test') {
  const fixtureDir = join(repoRoot, 'contracts/fixtures/oasdiff')
  const base = readFileSync(join(fixtureDir, 'base.json'), 'utf8')
  const breaking = readFileSync(join(fixtureDir, 'breaking.json'), 'utf8')
  const compatible = readFileSync(join(fixtureDir, 'compatible.json'), 'utf8')
  let ok = true
  // Assert 1: breaking fixture must be detected
  const breakRes = runOasdiffBreaking(base, breaking)
  console.log(`[gate-self-test] breaking fixture via ${breakRes.tool}:\n${breakRes.output}`)
  if (!breakRes.breaking) {
    console.error('[gate-self-test] FAIL: breaking fixture was NOT detected')
    ok = false
  } else {
    console.log('[gate-self-test] PASS: breaking fixture detected')
  }
  // Assert 2: compatible fixture must NOT be detected as breaking
  const compatRes = runOasdiffBreaking(base, compatible)
  console.log(`[gate-self-test] compatible fixture via ${compatRes.tool}:\n${compatRes.output}`)
  if (compatRes.breaking) {
    console.error('[gate-self-test] FAIL: compatible fixture was incorrectly flagged as breaking')
    ok = false
  } else {
    console.log('[gate-self-test] PASS: compatible fixture clean')
  }
  // Assert 3 (Task 10) is GONE, not disabled: it diffed
  // contracts/fixtures/oasdiff/newsletter-{base,breaking}.json to prove the gate
  // also covered contracts/newsletter/. Both the newsletter module and its
  // fixtures left with the carve, so this mode died on an unhandled ENOENT —
  // the same carved-away-hardcoded-filename defect fixed in kernelOpenApiFiles()
  // above. There is nothing left for it to prove: gateStagedSpecs() now matches
  // contracts/kernel/ only.
  process.exit(ok ? 0 : 1)
}

if (mode !== '--staged' && mode !== '--all') {
  console.error('usage: boundary-lint.ts --staged | --all | --coverage-report | --contracts | --gate-self-test')
  process.exit(2)
}

const inputs = mode === '--staged' ? collectStaged() : collectAll()
const res = runBoundaryLint(inputs)

// unusedAllow is only meaningful on a full-tree run (staged subsets legitimately
// miss allow entries) — report it as a FAILURE in --all, ignore in --staged.
const failures = [...res.violations.map((v) => `${v.file}:${v.line}  ${v.message}`)]
if (mode === '--all') failures.push(...res.unusedAllow.map((u) => `stale allowlist entry: ${u}`))
if (mode === '--staged') failures.push(...gateStagedSpecs(repoRoot))

if (failures.length > 0) {
  console.error(`[boundary-lint] ${failures.length} problem(s):\n` + failures.map((f) => `  ${f}`).join('\n'))
  process.exit(1)
}
console.log(`[boundary-lint] OK (${inputs.length} file(s) checked, mode ${mode})`)
