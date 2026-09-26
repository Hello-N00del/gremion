// packages/generated-clients-dart/src/check-cli.ts
//
// The whole of `codegen:check` except resolving the real tools (that is
// tools/check.mjs, a thin shim), so the wiring is unit-tested: the
// hand-written-client scan runs in evidence mode and its problems join the
// drift problems, and the one verdict comes from finalizeCheck in real-tree
// mode (M >= 1, N == M).
import { checkDartCodegenDrift, finalizeCheck, type GenerateFn, type Verdict } from './codegen-drift.ts'
import { scanForHandWrittenClients } from './hand-client-scan.ts'

export function runCheck(repoRoot: string, generate: GenerateFn): Verdict {
  const scan = scanForHandWrittenClients(repoRoot, { requireEvidence: true })
  const drift = checkDartCodegenDrift(repoRoot, { generate })
  const v = finalizeCheck({ ...drift, problems: [...drift.problems, ...scan.problems] }, { requireSurfaces: true })
  return { ...v, summary: `${v.summary}; scanned ${scan.filesScanned} Dart file(s) outside the surface packages against ${scan.keys} path key(s)` }
}
