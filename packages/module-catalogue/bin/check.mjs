#!/usr/bin/env node
// @gremion/module-catalogue CLI: `--check <modules root>` and `--emit-ops <file>`.
// Runs the TypeScript sources under plain node (type stripping; the sources
// use erasable syntax only). Logic and tests: src/cli.ts, test/cli.test.ts.
import { runCli } from '../src/cli.ts'

process.exitCode = runCli(process.argv.slice(2), {
  out: (line) => console.log(line),
  err: (line) => console.error(line),
})
