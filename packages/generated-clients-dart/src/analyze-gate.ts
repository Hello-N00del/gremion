// packages/generated-clients-dart/src/analyze-gate.ts
//
// The `dart analyze --no-fatal-warnings` gate and the two ways generated
// output could switch it off without anyone noticing: an analysis_options.yaml
// that excludes lib/** or re-maps a diagnostic, and in-file `// ignore:`
// comments. All three are pure functions over text. The pipeline
// (src/pipeline.ts) runs the real analyzer and feeds its output here.
import { load } from 'js-yaml'
import type { GeneratedFiles } from './codegen-drift.ts'

export interface AnalyzeVerdict { ok: boolean; errors: number; warnings: number; infos: number; problems: string[] }

const SUMMARY = /^(?:No issues found!|(\d+) issues? found\.)\s*$/m

/** Pass = the analyzer exited 0, printed its summary line (so it really ran
 *  over something), printed zero `error -` lines, and the counted lines add
 *  up to its own summary (a format change cannot silently hide errors from
 *  the line parse). Warnings and infos are counted, never fatal. */
export function evaluateAnalyze(i: { exitOk: boolean; output: string }): AnalyzeVerdict {
  const lines = i.output.split(/\r?\n/)
  const errorLines = lines.filter((l) => /^\s*error - /.test(l))
  const warnings = lines.filter((l) => /^\s*warning - /.test(l)).length
  const infos = lines.filter((l) => /^\s*info - /.test(l)).length
  const problems: string[] = []
  const m = SUMMARY.exec(i.output)
  if (!m) problems.push('dart analyze printed no summary line ("No issues found!" / "N issues found.") — the analyzer did not run to completion')
  else {
    const reported = m[1] === undefined ? 0 : Number(m[1])
    const counted = errorLines.length + warnings + infos
    if (reported !== counted) problems.push(`dart analyze reported ${reported} issue(s) but ${counted} error/warning/info line(s) were parsed — output format not understood`)
  }
  if (!i.exitOk) problems.push('dart analyze --no-fatal-warnings exited non-zero')
  for (const l of errorLines) problems.push(`dart analyze: ${l.trim()}`)
  return { ok: problems.length === 0, errors: errorLines.length, warnings, infos, problems }
}

/** Diagnostics generated code may re-map in analysis_options.yaml, each
 *  reviewed: none is error-severity. Anything else fails, so a generator bump
 *  that starts downgrading a real error cannot land silently. */
const ALLOWED_ERROR_REMAPS: Record<string, string> = {
  deprecated_member_use_from_same_package: 'ignore', // warning-level: the generated models call their own @deprecated members
}

/** Codes generated files may `// ignore:` / `// ignore_for_file:`. */
const ALLOWED_IGNORES = new Set([
  'deprecated_member_use_from_same_package', // warning
  'type=lint', // all lints (info level)
  'unused_element', // warning
  'unused_import', // warning
])

const LIB_PROBES = ['lib/a.dart', 'lib/src/a.dart', 'lib/src/api/a.dart', 'lib/src/model/a.dart', 'lib/src/model/a.g.dart', 'lib/src/auth/a.dart']

function globToRegExp(glob: string): RegExp {
  let re = ''
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]
    if (c === '*' && glob[i + 1] === '*') { re += '.*'; i++; if (glob[i + 1] === '/') i++ }
    else if (c === '*') re += '[^/]*'
    else if (c === '?') re += '[^/]'
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`^${re}$`)
}

export function checkAnalysisOptions(text: string): string[] {
  let doc: unknown
  try {
    doc = load(text)
  } catch (e) {
    return [`analysis_options.yaml does not parse: ${(e as Error).message.split('\n')[0]}`]
  }
  if (doc === null || doc === undefined) return []
  if (typeof doc !== 'object' || Array.isArray(doc)) return ['analysis_options.yaml is not a mapping']
  const problems: string[] = []
  const top = doc as Record<string, unknown>
  if ('include' in top) problems.push(`analysis_options.yaml: "include: ${String(top.include)}" — an included file could exclude lib/** or re-map diagnostics out of this check's sight`)
  const analyzer = (top.analyzer ?? {}) as Record<string, unknown>
  const exclude = analyzer.exclude ?? []
  if (!Array.isArray(exclude)) problems.push('analysis_options.yaml: analyzer.exclude is not a list')
  else {
    for (const raw of exclude) {
      const pat = String(raw).replace(/^\.\//, '')
      if (/^(lib\b|\*|\?|\{)/.test(pat) || LIB_PROBES.some((p) => globToRegExp(pat).test(p))) {
        problems.push(`analysis_options.yaml: analyzer.exclude "${pat}" can exclude files under lib/ from the analyze gate`)
      }
    }
  }
  const errors = (analyzer.errors ?? {}) as Record<string, unknown>
  if (typeof errors !== 'object' || Array.isArray(errors)) problems.push('analysis_options.yaml: analyzer.errors is not a mapping')
  else {
    for (const [code, sev] of Object.entries(errors)) {
      if (sev === 'error') continue // raising a severity never weakens the gate
      if (ALLOWED_ERROR_REMAPS[code] !== sev) {
        problems.push(`analysis_options.yaml: analyzer.errors re-maps "${code}" to "${String(sev)}", which is not on the reviewed allowlist (src/analyze-gate.ts)`)
      }
    }
  }
  return problems
}

export function checkIgnoreComments(files: GeneratedFiles): string[] {
  const problems: string[] = []
  for (const [rel, bytes] of files) {
    if (!rel.endsWith('.dart')) continue
    for (const m of bytes.toString('utf8').matchAll(/\/\/\s*ignore(?:_for_file)?\s*:\s*([^\n]*)/g)) {
      for (const code of m[1].split(',').map((c) => c.trim()).filter(Boolean)) {
        if (!ALLOWED_IGNORES.has(code)) problems.push(`${rel}: ignores "${code}", which is not on the reviewed allowlist (src/analyze-gate.ts)`)
      }
    }
  }
  return problems
}
