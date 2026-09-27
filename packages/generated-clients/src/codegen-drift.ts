// packages/generated-clients/src/codegen-drift.ts
//
// T6: the codegen check. Fails, NAMING THE FILE, on: a hand edit, a spec
// changed without regeneration, or a missing output. All three collapse to
// one observable condition — the committed output no longer equals what
// `generateClientSource()` (src/codegen.ts) produces from the CURRENT spec —
// which is deliberate: regenerating is the only fix for any of the three, so
// one check that recomputes the real answer is more honest than a manifest
// that could itself drift from the truth it is meant to police.
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { GENERATED_CLIENTS, generateClientSource, type GeneratedClientSpec } from './codegen.js'

function normalize(s: string): string {
  return s.replace(/\r\n/g, '\n').trimEnd()
}

/** `specs` defaults to the real registry; tests pass a scratch list pointed
 *  at a fixture tree so a hand edit / stale spec / missing output can be
 *  proven without touching the real generated client. */
export function checkCodegenDrift(repoRoot: string, specs: GeneratedClientSpec[] = GENERATED_CLIENTS): string[] {
  const problems: string[] = []
  for (const spec of specs) {
    const outPath = join(repoRoot, spec.outputFile)
    if (!existsSync(outPath)) {
      problems.push(`${spec.outputFile}: missing output — run \`pnpm --filter @gremion/generated-clients generate\` (spec: ${spec.specFile})`)
      continue
    }
    let expected: string
    try {
      expected = generateClientSource(repoRoot, spec)
    } catch (e) {
      // execFileSync's error carries the child's exit status and signal; its
      // message ("Command failed: ...") does not say which, so a crash, a
      // non-zero exit and a kill (e.g. under machine load) all read the same
      // without them (R26-FLAKES, R27 residual).
      const { status, signal, message } = e as Error & { status?: number | null, signal?: string | null }
      problems.push(
        `${spec.outputFile}: codegen tool errored generating from ${spec.specFile} `
        + `(exit status ${status ?? 'none'}, signal ${signal ?? 'none'}): ${message}`,
      )
      continue
    }
    const actual = readFileSync(outPath, 'utf8')
    if (normalize(expected) !== normalize(actual)) {
      problems.push(
        `${spec.outputFile}: does not match what ${spec.specFile} generates today — either the file was `
        + `hand-edited, or the spec changed without regeneration. Run \`pnpm --filter @gremion/generated-clients generate\`.`,
      )
    }
  }
  return problems
}
