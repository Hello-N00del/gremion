// pnpm --filter @gremion/fastify-service-template scaffold --spec <file> --out <dir> [--name <name>]
//
// Relative paths resolve against the directory pnpm was invoked from
// (INIT_CWD), not this package's directory, so a repo-root invocation can say
// `--spec contracts/... --out services/...`.
import { resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { scaffoldService } from '../scaffold.ts'

const USAGE = 'usage: scaffold --spec <openapi-3.1.json> --out <dir> [--name <package-name-suffix>]'

function parse(): { spec?: string; out?: string; name?: string } {
  try {
    return parseArgs({
      options: { spec: { type: 'string' }, out: { type: 'string' }, name: { type: 'string' } },
      strict: true,
    }).values
  } catch (e) {
    console.error(`[scaffold] ${(e as Error).message}\n${USAGE}`)
    process.exit(2)
  }
}

const values = parse()
if (!values.spec || !values.out) {
  console.error(USAGE)
  process.exit(2)
}

const base = process.env.INIT_CWD ?? process.cwd()
try {
  const result = scaffoldService({ spec: resolve(base, values.spec), out: resolve(base, values.out), name: values.name })
  console.log(`[scaffold] ${result.outDir}: ${result.files.length} file(s), ${result.operations.length} operation(s), no route file`)
  for (const f of result.files) console.log(`  ${f}`)
} catch (e) {
  console.error(`[scaffold] FAILED: ${(e as Error).message}`)
  process.exit(1)
}
