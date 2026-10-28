// packages/tenant-store/src/export/cli.ts — the completeness check as a verb:
//
//   tsx packages/tenant-store/src/export/cli.ts verify <dir>
//
// Reads <dir>/manifest.json and the files it names from disk and prints one
// line per problem. Exit: 0 complete, 1 incomplete (each file named), 2 usage.
import { verifyExport } from './verify.js'

export function runVerify(argv: readonly string[], io: { out(l: string): void; err(l: string): void }): number {
  if (argv[0] !== 'verify' || argv.length !== 2 || !argv[1] || argv[1].startsWith('--')) {
    io.err('usage: export-cli verify <dir>')
    return 2
  }
  const r = verifyExport(argv[1])
  for (const p of r.problems) io.err(`EXPORT INCOMPLETE ${p.code} ${p.path}: ${p.detail}`)
  if (!r.ok) {
    io.err(`export check FAILED: ${r.problems.length} problem(s) in ${argv[1]}`)
    return 1
  }
  io.out(`export check ok: ${r.checked} file(s) present, non-empty, sha256 matches`)
  return 0
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  process.exitCode = runVerify(process.argv.slice(2), { out: (l) => console.log(l), err: (l) => console.error(l) })
}
