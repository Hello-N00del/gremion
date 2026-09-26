// Test 5 (unit half): the `dart analyze` gate. Zero `error -` lines AND exit
// 0 AND a summary line that proves the analyzer ran; warnings are counted and
// logged, never fatal. Plus the two ways generated code could switch the gate
// off: analysis_options.yaml (excluding lib/**, downgrading a diagnostic) and
// in-file ignore comments. The real-analyzer half is pipeline.integration.test.ts.
import { describe, it, expect } from 'vitest'
import { checkAnalysisOptions, checkIgnoreComments, evaluateAnalyze } from './analyze-gate.ts'

const CLEAN = 'Analyzing out...\nNo issues found!\n'
const WARN = [
  'Analyzing out...',
  '',
  "warning - lib/src/api.dart:7:8 - Unused import: 'x'. Try removing the import directive. - unused_import",
  'info - lib/src/b.dart:1:1 - Something. - some_lint',
  '',
  '2 issues found.',
].join('\n')
const ERR = [
  'Analyzing out...',
  '',
  "  error - lib/src/broken.dart:1:9 - Expected to find ';'. - expected_token",
  "warning - lib/src/api.dart:7:8 - Unused import: 'x'. - unused_import",
  '',
  '2 issues found.',
].join('\n')

describe('evaluateAnalyze', () => {
  it('passes a clean run', () => {
    expect(evaluateAnalyze({ exitOk: true, output: CLEAN })).toMatchObject({ ok: true, errors: 0, warnings: 0 })
  })
  it('passes warnings and counts them', () => {
    expect(evaluateAnalyze({ exitOk: true, output: WARN })).toMatchObject({ ok: true, errors: 0, warnings: 1, infos: 1 })
  })
  it('fails on any `error -` line even if the exit code said 0', () => {
    const v = evaluateAnalyze({ exitOk: true, output: ERR })
    expect(v.ok).toBe(false)
    expect(v.errors).toBe(1)
    expect(v.problems.join('\n')).toContain('lib/src/broken.dart:1:9')
  })
  it('fails on a non-zero exit even with no error lines', () => {
    expect(evaluateAnalyze({ exitOk: false, output: CLEAN }).ok).toBe(false)
  })
  it('fails when the output shows the analyzer never ran (no summary line)', () => {
    expect(evaluateAnalyze({ exitOk: true, output: '' }).ok).toBe(false)
    expect(evaluateAnalyze({ exitOk: true, output: 'dart: command not found' }).ok).toBe(false)
  })
  it('fails when the counted lines disagree with the summary (a narrowed parse)', () => {
    expect(evaluateAnalyze({ exitOk: true, output: 'Analyzing out...\nERROR|x|y\n1 issue found.\n' }).ok).toBe(false)
  })
})

describe('checkAnalysisOptions', () => {
  const GEN = 'analyzer:\n  language:\n    strict-inference: true\n  exclude:\n    - test/*.dart\n  errors:\n    deprecated_member_use_from_same_package: ignore\n'
  it('accepts what openapi-generator 7.12.0 emits', () => {
    expect(checkAnalysisOptions(GEN)).toEqual([])
  })
  it.each([['lib/**'], ['lib/src/*.dart'], ['**/*.g.dart'], ['**'], ['lib/src/model/**'], ['/work/out/lib/**'], ['[l]ib/**'], ['test/../lib/**'], ['./lib/a.dart']])('rejects excluding %s', (pat) => {
    expect(checkAnalysisOptions(`analyzer:\n  exclude:\n    - '${pat}'\n`).join('\n')).toMatch(/exclude/)
  })
  it('rejects re-mapping any diagnostic not on the reviewed allowlist', () => {
    expect(checkAnalysisOptions('analyzer:\n  errors:\n    invalid_assignment: ignore\n').join('\n')).toMatch(/invalid_assignment/)
    expect(checkAnalysisOptions('analyzer:\n  errors:\n    undefined_identifier: info\n').join('\n')).toMatch(/undefined_identifier/)
  })
  it('rejects an unparsable file and an include it cannot see through', () => {
    expect(checkAnalysisOptions('analyzer: [').length).toBeGreaterThan(0)
    expect(checkAnalysisOptions('include: package:lints/recommended.yaml\n').join('\n')).toMatch(/include/)
  })
})

describe('checkIgnoreComments', () => {
  it('accepts the codes openapi-generator 7.12.0 emits', () => {
    const f = new Map([['lib/a.dart', Buffer.from('// ignore_for_file: deprecated_member_use_from_same_package,type=lint\n// ignore_for_file: unused_element\n// ignore_for_file: unused_import\n')]])
    expect(checkIgnoreComments(f)).toEqual([])
  })
  it('names a file that ignores anything else', () => {
    const f = new Map([['lib/a.dart', Buffer.from('x; // ignore: invalid_assignment\n')], ['lib/b.dart', Buffer.from('// ignore_for_file: unused_element, undefined_method\n')]])
    const p = checkIgnoreComments(f).join('\n')
    expect(p).toMatch(/lib\/a\.dart.*invalid_assignment/)
    expect(p).toMatch(/lib\/b\.dart.*undefined_method/)
  })
})
