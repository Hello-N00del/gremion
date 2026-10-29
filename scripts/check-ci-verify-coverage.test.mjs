#!/usr/bin/env node
// node --test suite for scripts/check-ci-verify-coverage.mjs.
//
// Same idiom as scripts/check-ci-docker-filter.test.mjs: the guard is shown
// passing on the REAL .github/workflows/ci.yml and then FAILING on a copy of it
// with one violation planted, one planted violation per test. A guard that was
// never seen failing is not a guard, and a plant that edits nothing proves
// nothing, so every plant asserts that its replacement applied.
//
// Every test is its own `test(` declaration: scripts/verify/suites/unit.mjs
// cross-checks node's collected count against the declared one, and a `test(`
// inside a loop reads as "declares 1, collected N" and is judged unparseable.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { checkCiText, loadRegistry, MIN_VERIFY_INVOCATIONS, parseWorkflow, verifyInvocations, yamlUnavailableReason } from './check-ci-verify-coverage.mjs'
import { INTEGRATION_PARTS } from './verify/suites/integration.mjs'
import { UNIT_PARTS } from './verify/suites/unit.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const GUARD = join(ROOT, 'scripts', 'check-ci-verify-coverage.mjs')
const CI = readFileSync(join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8')
const REGISTRY = await loadRegistry()

/** ci.yml with `from` replaced by `to`, asserting the plant applied exactly once. */
function plant(from, to, ci = CI) {
  const n = ci.split(from).length - 1
  assert.equal(n, 1, `the plant target must occur exactly once in ci.yml, found ${n}: ${from.slice(0, 80)}`)
  return ci.replace(from, to)
}

const problemsOf = (ci) => checkCiText(ci, REGISTRY).problems
const joined = (ci) => problemsOf(ci).join('\n')

// Strings the plants edit; asserted to exist by plant() itself.
const STRICT_RUN = 'run: node scripts/verify/check-record.mjs "$SHA"\n'
const ALLOW_IF = "        if: ${{ github.event_name == 'pull_request' && needs.verify-census.result == 'skipped' }}\n"

test('the real ci.yml passes: every required suite is run by exactly one leg', () => {
  assert.equal(yamlUnavailableReason(), undefined, 'this suite needs the yaml package (pnpm install)')
  const r = checkCiText(CI, REGISTRY)
  assert.deepEqual(r.problems, [])
  assert.ok(r.invocations >= MIN_VERIFY_INVOCATIONS, `only ${r.invocations} verify invocations`)
})

test('the registry the guard checks against is read from the code, not copied', () => {
  assert.deepEqual(REGISTRY.unitParts, Object.keys(UNIT_PARTS))
  assert.deepEqual(REGISTRY.integrationParts, Object.keys(INTEGRATION_PARTS))
  assert.ok(REGISTRY.requiredSuites.includes('unit') && REGISTRY.requiredSuites.includes('integration') && REGISTRY.requiredSuites.includes('census'))
})

test('composite suites are covered by the real part keys: every unit:<part> and integration:<part> is named in ci.yml', () => {
  const names = new Set(verifyInvocations(parseWorkflow(CI)).flatMap((i) => i.names))
  for (const p of Object.keys(UNIT_PARTS)) assert.ok(names.has(`unit:${p}`), `ci.yml names no unit:${p}`)
  for (const p of Object.keys(INTEGRATION_PARTS)) assert.ok(names.has(`integration:${p}`), `ci.yml names no integration:${p}`)
})

test('a unit part that no leg runs is reported by name', () => {
  const p = joined(plant(',unit:kernel-api', ''))
  assert.match(p, /required suite "unit" is not covered: no leg runs unit:kernel-api/)
})

test('an integration part that no leg runs is reported by name', () => {
  const p = joined(plant(',integration:events', ''))
  assert.match(p, /required suite "integration" is not covered: no leg runs integration:events/)
})

test('a plain required suite that no leg runs is reported', () => {
  const p = joined(plant('run: node scripts/verify/verify.mjs --only census', 'run: node scripts/verify/verify.mjs --only render-guards'))
  assert.match(p, /required suite "census" is run by no leg/)
})

test('a suite run by two legs is reported, naming both', () => {
  const p = joined(plant('--only integration:vitest,integration:fresh-init', '--only integration:vitest,integration:fresh-init,isolation'))
  assert.match(p, /"isolation" is run 2 times \(verify-unit-packages, verify-integration-db\)/)
})

test('a name that is no suite and no part is reported (a typo would be "dropped from the registry" only at run time)', () => {
  const p = joined(plant('--only unit:ui,unit:module-lane', '--only unit:ui,unit:module-laen'))
  assert.match(p, /names "unit:module-laen"/)
  assert.match(p, /required suite "unit" is not covered: no leg runs unit:module-lane/)
})

test('the whole unit suite plus one of its parts is reported as ambiguous', () => {
  const p = joined(plant('--only unit:modules,unit:node,unit:bats', '--only unit,unit:modules,unit:node,unit:bats'))
  assert.match(p, /"unit" is run whole AND as part\(s\)/)
})

test('a leg that uploads a record but is missing from the gate needs is reported', () => {
  const p = joined(plant('      - verify-integration-brokers\n', ''))
  assert.match(p, /verify-integration-brokers uploads a record-\* artifact but verify-gate does not need it/)
})

test('a leg that runs verify but uploads no record is reported', () => {
  const p = joined(plant('name: record-verify-census', 'name: census-output'))
  assert.match(p, /verify-census runs verify but uploads no record-\* artifact/)
})

test('--allow-missing in a step whose if is not pull-request-only is reported', () => {
  const p = joined(plant(ALLOW_IF, ''))
  assert.match(p, /--allow-missing appears in a step whose `if` does not require github\.event_name == 'pull_request'/)
})

test('--allow-missing added to the strict step is reported', () => {
  const p = joined(plant(STRICT_RUN, 'run: node scripts/verify/check-record.mjs "$SHA" --allow-missing census\n'))
  assert.match(p, /--allow-missing appears in a step whose `if` does not require github\.event_name == 'pull_request'/)
})

test('any other flag on check-record.mjs is reported', () => {
  const p = joined(plant(STRICT_RUN, 'run: node scripts/verify/check-record.mjs "$SHA" --ignore-failures\n'))
  assert.match(p, /check-record\.mjs is called with --ignore-failures/)
})

test('losing the strict check-record call altogether is reported', () => {
  const p = joined(plant(STRICT_RUN, 'run: echo skipped "$SHA"\n'))
  assert.match(p, /no step calls `check-record\.mjs <sha>` without a flag/)
})

test('a strict call that only runs on pull requests is reported', () => {
  const p = joined(
    plant("        if: ${{ github.event_name != 'pull_request' || needs.verify-census.result == 'success' }}\n", "        if: ${{ github.event_name == 'pull_request' }}\n"),
  )
  assert.match(p, /the strict check-record\.mjs call has an `if` that does not run it on pushes and manual runs/)
})

test('continue-on-error on a job is reported', () => {
  const p = joined(plant('    name: "Verify: render and ops suites"\n', '    name: "Verify: render and ops suites"\n    continue-on-error: true\n'))
  assert.match(p, /verify-render-ops sets continue-on-error/)
})

test('continue-on-error on a step is reported', () => {
  const p = joined(plant('      - name: Combine the legs\' records\n', "      - name: Combine the legs' records\n        continue-on-error: true\n"))
  assert.match(p, /Combine the legs' records\) sets continue-on-error/)
})

test('`|| true` on a leg\'s verify call is reported (a red suite would read as green)', () => {
  const p = joined(plant('run: node scripts/verify/verify.mjs --only census', 'run: node scripts/verify/verify.mjs --only census || true'))
  assert.match(p, /verify-census step \d+ \(.*\): `node scripts\/verify\/verify\.mjs --only census \|\| true` swallows a failing exit status/)
})

test('`|| :` in the gate is reported', () => {
  // A block scalar: a plain `... || :` at end of line is not valid YAML (the colon reads as a mapping).
  const combine = 'run: node scripts/verify/combine-records.mjs --in-dir "$RUNNER_TEMP/verify-records" --sha "$SHA"'
  const p = joined(plant(combine, `run: |
          ${combine.slice(5)} || :`))
  assert.match(p, /verify-gate step \d+ \(Combine the legs' records\): `.*\|\| :` swallows a failing exit status/)
})

test('`set +e` in the gate is reported', () => {
  const p = joined(plant('          set -euo pipefail\n          # Vacuity floor', '          set +e\n          # Vacuity floor'))
  assert.match(p, /verify-gate step \d+ \(Every verify leg must have succeeded\): `set \+e` swallows a failing exit status/)
})

// ── `set +e` in every spelling that turns errexit off ───────────────────────
const GATE_SET = '          set -euo pipefail\n          # Vacuity floor'
const gateSet = (spelling) => plant(GATE_SET, `          ${spelling}\n          # Vacuity floor`)

test('`set +ex` in the gate is reported (errexit off, xtrace on)', () => {
  assert.match(joined(gateSet('set +ex')), /Every verify leg must have succeeded\): `set \+ex` swallows a failing exit status/)
})

test('`set +eu` in the gate is reported', () => {
  assert.match(joined(gateSet('set +eu')), /`set \+eu` swallows a failing exit status/)
})

test('`set +euo pipefail` in the gate is reported', () => {
  assert.match(joined(gateSet('set +euo pipefail')), /`set \+euo pipefail` swallows a failing exit status/)
})

test('`set +o errexit` in the gate is reported', () => {
  assert.match(joined(gateSet('set +o errexit')), /`set \+o errexit` swallows a failing exit status/)
})

test('`set +x` and `set +u` do not turn errexit off and are not reported', () => {
  assert.deepEqual(problemsOf(gateSet('set +x')), [])
  assert.deepEqual(problemsOf(gateSet('set +u')), [])
})

// ── a `shell:` that drops -e (GitHub's `bash {0}` is the documented fail-fast opt-out) ──
const COMBINE_NAME = "      - name: Combine the legs' records\n"
const CENSUS_JOB_NAME = '    name: "Verify: render and ops suites"\n'
const stepShell = (shell) => plant(COMBINE_NAME, `${COMBINE_NAME}        shell: ${shell}\n`)

test('a step-level `shell: bash {0}` in the gate is reported', () => {
  assert.match(joined(stepShell('bash {0}')), /Combine the legs' records\): `shell: bash \{0\}` drops -e/)
})

test('a step-level `shell: pwsh` in the gate is reported', () => {
  assert.match(joined(stepShell('pwsh')), /`shell: pwsh` drops -e/)
})

test('a step-level `shell: python` in a leg is reported', () => {
  const p = joined(plant('        run: node scripts/verify/verify.mjs --only census', '        shell: python\n        run: node scripts/verify/verify.mjs --only census'))
  assert.match(p, /verify-census step \d+ \(Run verify\): `shell: python` drops -e/)
})

test('a job-level `defaults.run.shell: bash {0}` on a record-producing leg is reported', () => {
  const p = joined(plant(CENSUS_JOB_NAME, `${CENSUS_JOB_NAME}    defaults:\n      run:\n        shell: bash {0}\n`))
  assert.match(p, /verify-render-ops sets defaults\.run\.shell: bash \{0\}, which drops -e/)
})

test('a job-level `defaults.run.shell` on the gate is reported', () => {
  const p = joined(plant('    name: Verify gate\n', '    name: Verify gate\n    defaults:\n      run:\n        shell: bash {0}\n'))
  assert.match(p, /verify-gate sets defaults\.run\.shell: bash \{0\}, which drops -e/)
})

test('a workflow-level `defaults.run.shell: bash {0}` is reported', () => {
  const p = joined(plant('\njobs:\n', '\ndefaults:\n  run:\n    shell: bash {0}\n\njobs:\n'))
  assert.match(p, /the workflow sets defaults\.run\.shell: bash \{0\}, which drops -e/)
})

test('a `shell:` that keeps -e (bash, sh, or a template passing -e) is not reported', () => {
  assert.deepEqual(problemsOf(stepShell('bash')), [])
  assert.deepEqual(problemsOf(stepShell('sh')), [])
  assert.deepEqual(problemsOf(stepShell('bash --noprofile --norc -eo pipefail {0}')), [])
  assert.deepEqual(problemsOf(stepShell('bash -e {0}')), [])
})

// ── a verdict command followed by `||`, in a condition, or negated ──────────
const COMBINE_RUN = 'run: node scripts/verify/combine-records.mjs --in-dir "$RUNNER_TEMP/verify-records" --sha "$SHA"'
const COMBINE_CMD = COMBINE_RUN.slice('run: '.length)
const combineBlock = (...lines) => plant(COMBINE_RUN, `run: |\n${lines.map((l) => `          ${l}`).join('\n')}`)

test('a leg\'s verify call followed by `|| echo` is reported', () => {
  const p = joined(plant('run: node scripts/verify/verify.mjs --only census', 'run: node scripts/verify/verify.mjs --only census || echo "census failed"'))
  assert.match(p, /verify-census step \d+ \(.*\): `node scripts\/verify\/verify\.mjs --only census \|\| echo "census failed"` swallows a failing exit status/)
})

test('a verify call followed by `&& echo ok || echo bad` is reported', () => {
  const p = joined(plant('run: node scripts/verify/verify.mjs --only census', 'run: node scripts/verify/verify.mjs --only census && echo ok || echo bad'))
  assert.match(p, /swallows a failing exit status/)
})

test('a verify call piped through tee and then `||` is reported', () => {
  const p = joined(plant('run: node scripts/verify/verify.mjs --only census', 'run: node scripts/verify/verify.mjs --only census | tee census.log || echo bad'))
  assert.match(p, /swallows a failing exit status/)
})

test('the gate\'s combine call followed by `|| exit 0` is reported', () => {
  assert.match(joined(combineBlock(`${COMBINE_CMD} || exit 0`)), /combine-records\.mjs .* \|\| exit 0` swallows a failing exit status/)
})

test('a `||` on a backslash-continued verify call is reported (the line is judged whole)', () => {
  const p = joined(combineBlock(`${COMBINE_CMD} \\`, '  || echo failed'))
  assert.match(p, /swallows a failing exit status/)
})

test('the strict check-record call followed by `|| echo` is reported', () => {
  const p = joined(plant(STRICT_RUN, 'run: node scripts/verify/check-record.mjs "$SHA" || echo "not green"\n'))
  assert.match(p, /check-record\.mjs "\$SHA" \|\| echo "not green"` swallows a failing exit status/)
})

test('`|| true` inside backticks is reported', () => {
  assert.match(joined(combineBlock('x=`git rev-parse HEAD || true`', COMBINE_CMD)), /x=`git rev-parse HEAD \|\| true`` swallows a failing exit status/)
})

test('`|| true` inside `$( )` is reported', () => {
  assert.match(joined(combineBlock('x=$(git rev-parse HEAD || true)', COMBINE_CMD)), /x=\$\(git rev-parse HEAD \|\| true\)` swallows a failing exit status/)
})

test('a verdict call inside `$( )` followed by `|| true` is reported', () => {
  assert.match(joined(combineBlock(`x=$(${COMBINE_CMD} || true)`)), /swallows a failing exit status/)
})

test('`if ! <combine-records>; then` is reported', () => {
  const p = joined(combineBlock(`if ! ${COMBINE_CMD}; then`, '  exit 0', 'fi'))
  assert.match(p, /`if ! node scripts\/verify\/combine-records\.mjs .*; then` tests a verdict command in a condition/)
})

test('`if <verify>; then` is reported', () => {
  const p = joined(plant('run: node scripts/verify/verify.mjs --only census', 'run: |\n          if node scripts/verify/verify.mjs --only census; then echo ok; fi'))
  assert.match(p, /tests a verdict command in a condition/)
})

test('a bare negated `! <check-record>` is reported', () => {
  const p = joined(plant(STRICT_RUN, 'run: |\n          ! node scripts/verify/check-record.mjs "$SHA"\n'))
  assert.match(p, /`! node scripts\/verify\/check-record\.mjs "\$SHA"` tests a verdict command in a condition/)
})

test('an `if [ ... ]` test that merely precedes a verdict call on its own line is not reported', () => {
  assert.deepEqual(problemsOf(combineBlock('if [ -z "$SHA" ]; then exit 1; fi', COMBINE_CMD)), [])
})

// ── the gate step that checks every leg's result keeps a non-narrowing `if` ──
const LEGS_NAME = '      - name: Every verify leg must have succeeded\n'
const legsIf = (cond) => plant(LEGS_NAME, `${LEGS_NAME}        if: ${cond}\n`)

test('an `if` narrowed onto the every-leg-succeeded step is reported (a skipped step checks nothing)', () => {
  const p = joined(legsIf("${{ github.event_name != 'pull_request' }}"))
  assert.match(p, /Every verify leg must have succeeded\) has `if: github\.event_name != 'pull_request'`; the step that checks every leg's result must have no `if`/)
})

test('`if: false` on the every-leg-succeeded step is reported', () => {
  assert.match(joined(legsIf('false')), /has `if: false`; the step that checks every leg's result/)
})

test('a renamed every-leg-succeeded step keeps its `if` pinned (it is found by toJSON(needs), not by name)', () => {
  const renamed = plant(LEGS_NAME, "      - name: Look at the legs\n        if: ${{ false }}\n")
  assert.match(joined(renamed), /Look at the legs\) has `if: false`/)
})

test('a gate with no step reading toJSON(needs) is reported', () => {
  const p = joined(plant('NEEDS_JSON: ${{ toJSON(needs) }}', "NEEDS_JSON: '{}'"))
  assert.match(p, /verify-gate has no step that reads toJSON\(needs\)/)
})

test('an every-leg-succeeded step with no `if`, always() or !cancelled() is accepted', () => {
  assert.deepEqual(problemsOf(CI), [])
  assert.deepEqual(problemsOf(legsIf('${{ always() }}')), [])
  assert.deepEqual(problemsOf(legsIf('${{ !cancelled() }}')), [])
})

test('a docker diagnostic or cleanup with `|| true` is tolerated, but not when it carries the verify call', () => {
  assert.deepEqual(problemsOf(CI), [])
  const p = joined(plant('run: docker rm -f nats-js || true', 'run: docker rm -f nats-js; node scripts/verify/verify.mjs --only census || true'))
  assert.match(p, /swallows a failing exit status/)
})

test('a verify-gate job `if` narrowed beyond !cancelled() is reported (a skipped required check reads as passing)', () => {
  const p = joined(plant('    if: ${{ !cancelled() }}\n    timeout-minutes: 15\n', "    if: ${{ !cancelled() && needs.verify-static.result == 'success' }}\n    timeout-minutes: 15\n"))
  assert.match(p, /verify-gate has `if: !cancelled\(\) && needs\.verify-static\.result == 'success'`; it must be `!cancelled\(\)`/)
})

test('a verify-gate job with no `if` is reported (a failed leg would skip it)', () => {
  const p = joined(plant('    if: ${{ !cancelled() }}\n    timeout-minutes: 15\n', '    timeout-minutes: 15\n'))
  assert.match(p, /verify-gate has `if: \(none\)`/)
})

test('a weakening clause ANDed onto the strict check-record step\'s `if` is reported', () => {
  const p = joined(
    plant(
      "        if: ${{ github.event_name != 'pull_request' || needs.verify-census.result == 'success' }}\n",
      "        if: ${{ (github.event_name != 'pull_request' || needs.verify-census.result == 'success') && github.actor != 'renovate[bot]' }}\n",
    ),
  )
  assert.match(p, /the strict check-record\.mjs call has `if: .*renovate\[bot\]'`; it must be exactly/)
})

test('a weakening clause ORed into the strict check-record step\'s `if` is reported', () => {
  const p = joined(
    plant(
      "        if: ${{ github.event_name != 'pull_request' || needs.verify-census.result == 'success' }}\n",
      "        if: ${{ github.event_name != 'pull_request' || needs.verify-census.result == 'success' || github.event_name == 'workflow_call' && false }}\n",
    ),
  )
  assert.match(p, /the strict check-record\.mjs call has `if: .*workflow_call.*`; it must be exactly/)
})

test('a missing verify-gate job is reported', () => {
  const p = joined(plant('  verify-gate:\n', '  verify-gate-renamed:\n'))
  assert.match(p, /there is no verify-gate job/)
})

test('the vacuity floor: a workflow with too few verify invocations fails even with nothing else wrong', () => {
  const tiny = 'jobs:\n  verify-gate:\n    needs: []\n    steps:\n      - run: node scripts/verify/check-record.mjs "$SHA"\n'
  const p = joined(tiny)
  assert.match(p, new RegExp(`found 0 verify invocation\\(s\\), fewer than the floor of ${MIN_VERIFY_INVOCATIONS}`))
})

test('a workflow that does not parse is a reported failure, not a crash or a pass', () => {
  const p = joined('jobs: [unclosed\n')
  assert.match(p, /ci\.yml does not parse/)
})

test('the CLI exits 0 on the real ci.yml and prints what it checked', () => {
  const r = spawnSync(process.execPath, [GUARD], { cwd: ROOT, encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /\[ci-verify-coverage\] OK -- \d+ verify invocation\(s\)/)
})

test('the CLI exits 1 on a planted violation and names it on stderr', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ci-verify-coverage-'))
  try {
    const file = join(dir, 'ci.yml')
    writeFileSync(file, plant('run: node scripts/verify/verify.mjs --only census', 'run: node scripts/verify/verify.mjs --only render-guards'))
    const r = spawnSync(process.execPath, [GUARD, '--ci', file], { cwd: ROOT, encoding: 'utf8' })
    assert.equal(r.status, 1)
    assert.match(r.stderr, /required suite "census" is run by no leg/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the CLI rejects an unknown argument', () => {
  const r = spawnSync(process.execPath, [GUARD, '--nope'], { cwd: ROOT, encoding: 'utf8' })
  assert.equal(r.status, 1)
  assert.match(r.stderr, /unknown argument: --nope/)
})

// The runner-policy idiom (scripts/ci-local/yaml-unavailable.test.mjs): a child node whose
// resolver refuses `yaml`, which is exactly what a missing node_modules/yaml looks like.
test('with the yaml package unimportable the CLI fails closed, naming the cause', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ci-verify-coverage-yaml-'))
  try {
    const hook = join(dir, 'block-yaml.mjs')
    writeFileSync(
      hook,
      `import { registerHooks } from 'node:module'
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'yaml' || specifier.startsWith('yaml/')) {
      const err = new Error("Cannot find package 'yaml' imported from " + context.parentURL + ' (blocked by the test hook)')
      err.code = 'ERR_MODULE_NOT_FOUND'
      throw err
    }
    return nextResolve(specifier, context)
  },
})
`,
    )
    const env = { ...process.env }
    delete env.NODE_TEST_CONTEXT
    const r = spawnSync(process.execPath, ['--import', pathToFileURL(hook).href, GUARD], { cwd: ROOT, encoding: 'utf8', env })
    assert.equal(r.status, 1)
    assert.match(r.stderr, /the 'yaml' package could not be imported/)
    assert.doesNotMatch(r.stdout, /OK --/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
