#!/usr/bin/env node
// scripts/migrations/runner/suite-cli.mjs -- TASK-075: the `expand-contract`
// verify suite as its own process.
//
// scripts/verify/verify.mjs runs this file (SUITE_REGISTRY['expand-contract'])
// instead of importing ./suite.mjs: scripts/verify must load from a copy of
// that directory alone (its space-path CLI tests copy only scripts/verify), so
// no module under it may statically import from scripts/migrations (the
// TASK-015 vendor-mail precedent). A missing or broken runner/ is then this
// suite's own FAIL, never verify's crash.
//
// Output contract: the LAST stdout line is
//   EXPAND-CONTRACT-SUITE <JSON of runExpandContractSuite()>
// and the exit code is 0 whenever that line was printed (the verdict is the
// JSON, judged by scripts/verify/lib/guard.mjs). A throw exits non-zero with
// no result line, which verify reports as unparseable.
// Nothing is exported: importing this file RUNS the suite.
import { runExpandContractSuite } from './suite.mjs'

process.stdout.write(`EXPAND-CONTRACT-SUITE ${JSON.stringify(runExpandContractSuite())}\n`)
