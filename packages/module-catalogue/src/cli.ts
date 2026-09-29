// packages/module-catalogue/src/cli.ts — the logic behind bin/check.mjs.
//
//   --check <modules root>   validate every module.json under the root against
//                            the compose file; fails on any problem and on a
//                            root with no module directory
//   --compose <file>         default: the kernel's docker-compose.yml
//   --emit-ops <file>        after a clean check, write the derived ops facts
//                            (backup servers, colour-gated jobs, platform
//                            databases per server) as JSON
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { parseArgs } from 'node:util'
import { checkCatalogue, KERNEL_ROOT } from './catalogue.ts'
import { readCompose } from './compose.ts'
import { buildCatalogueOps } from './runtime.ts'

export const USAGE = 'usage: node packages/module-catalogue/bin/check.mjs --check <modules root> [--compose <docker-compose.yml>] [--emit-ops <file>]'

export interface CliIo {
  out: (line: string) => void
  err: (line: string) => void
}

/** Returns the exit code: 0 clean, 1 problems, 2 bad arguments. */
export function runCli(argv: readonly string[], io: CliIo): number {
  let values: { check?: string; compose?: string; 'emit-ops'?: string }
  try {
    ;({ values } = parseArgs({
      args: [...argv],
      options: { check: { type: 'string' }, compose: { type: 'string' }, 'emit-ops': { type: 'string' } },
      strict: true,
      allowPositionals: false,
    }))
  } catch (err) {
    io.err(`[module-catalogue] bad arguments — ${(err as Error).message}`)
    io.err(USAGE)
    return 2
  }
  if (values.check === undefined || values.check === '') {
    io.err('[module-catalogue] --check <modules root> is required: without it nothing is inspected')
    io.err(USAGE)
    return 2
  }
  let result
  let compose
  try {
    compose = readCompose(values.compose ?? join(KERNEL_ROOT, 'docker-compose.yml'))
    result = checkCatalogue(values.check, { compose })
  } catch (err) {
    io.err(`[module-catalogue] 1 problem(s):`)
    io.err(`  x ${(err as Error).message}`)
    return 1
  }
  if (result.problems.length) {
    io.err(`[module-catalogue] ${result.problems.length} problem(s):`)
    for (const p of result.problems) io.err(`  x ${p}`)
    return 1
  }
  io.out(`[module-catalogue] OK — ${result.valid} of ${result.directories} module directories under ${result.root} carry a valid module.json; every module:* server is claimed exactly once`)
  const target = values['emit-ops']
  if (target !== undefined) {
    const ops = buildCatalogueOps(result.modules, compose)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, `${JSON.stringify(ops, null, 2)}\n`)
    io.out(`[module-catalogue] wrote ${target}: backup ${ops.backupPostgresServices.join(' ')}; colour-gated jobs ${ops.colourGatedJobs.join(',') || '(none)'}`)
  }
  return 0
}
