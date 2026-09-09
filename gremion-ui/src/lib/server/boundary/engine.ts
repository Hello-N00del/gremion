// P0.4 boundary-lint runner: file list in, violations out. Pure node module.
import { scanSqlForCrossSchemaFk } from './sql-fk-scan'
import { scanImports, underPrefix } from './import-scan'
import { FK_ALLOWLIST, IMPORT_RULES } from './rules'

export interface LintInput { file: string; content: string } // file = POSIX rel path from gremion-ui/
export interface LintViolation { file: string; line: number; message: string }
export interface LintResult { violations: LintViolation[]; unusedAllow: string[] }

const isSql = (f: string) =>
  (underPrefix(f, 'migrations') || underPrefix(f, 'migrations-control')) && f.endsWith('.sql')
const isLintableTs = (f: string) =>
  underPrefix(f, 'src') && f.endsWith('.ts') &&
  !f.endsWith('.test.ts') && !f.endsWith('.d.ts') &&
  !underPrefix(f, 'src/lib/server/boundary/fixtures')

export function runBoundaryLint(inputs: LintInput[]): LintResult {
  const violations: LintViolation[] = []
  const usedFkAllow = new Set<string>()
  const usedImportAllow = new Set<string>()
  // Allow-handling lives HERE (scanners run allow-free) so the engine can tell
  // "allow entry absorbed a real match" (used) from "allow entry matched
  // nothing" (stale) — the real-tree test fails on stale entries.
  const rulesAllowFree = IMPORT_RULES.map((r) => ({ ...r, allow: [] as string[] }))

  for (const { file, content } of inputs) {
    if (isSql(file)) {
      for (const v of scanSqlForCrossSchemaFk(file, content, [])) {
        const allowed = FK_ALLOWLIST.find(
          (a) => (file === a.file || file.endsWith(`/${a.file}`)) && v.table === a.table && v.ref === a.ref,
        )
        if (allowed) { usedFkAllow.add(`${allowed.table}->${allowed.ref}`); continue }
        violations.push({
          file, line: v.line,
          message: `R-FK: new cross-schema FK ${v.table} -> ${v.ref} (design §3.1 forbids new finance<->public FKs; the 3 ratified FKs in 013 are the only exceptions)`,
        })
      }
    } else if (isLintableTs(file)) {
      for (const v of scanImports(file, content, rulesAllowFree)) {
        const rule = IMPORT_RULES.find((r) => r.id === v.rule)
        if (rule && rule.allow.includes(file)) { usedImportAllow.add(`${rule.id}:${file}`); continue }
        violations.push({
          file, line: v.line,
          message: `${v.rule}: '${v.specifier}' crosses a service boundary (design §7 "no cross-service imports"). Fix the dependency direction or — only with design sign-off — add a commented allow entry in boundary/rules.ts.`,
        })
      }
    }
  }

  const unusedAllow: string[] = []
  for (const a of FK_ALLOWLIST) {
    if (!usedFkAllow.has(`${a.table}->${a.ref}`)) unusedAllow.push(`fk:${a.file}:${a.table}->${a.ref}`)
  }
  for (const r of IMPORT_RULES) {
    for (const a of r.allow) if (!usedImportAllow.has(`${r.id}:${a}`)) unusedAllow.push(`${r.id}:${a}`)
  }
  return { violations, unusedAllow }
}
