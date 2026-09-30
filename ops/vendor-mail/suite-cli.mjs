#!/usr/bin/env node
// TASK-015: the `vendor-mail` verify suite as its own process.
//
// scripts/verify/verify.mjs runs this file (SUITE_REGISTRY['vendor-mail'])
// instead of importing ./suite.mjs: scripts/verify must load from a copy of
// that directory alone (its space-path CLI tests copy only scripts/verify), so
// no module under it may statically import from ops/. A missing or broken
// ops/vendor-mail is then this suite's own FAIL, never verify's crash.
//
// Output contract: the LAST stdout line is
//   VENDOR-MAIL-SUITE <JSON of runVendorMailSuite()>
// and the exit code is 0 whenever that line was printed (the verdict is the
// JSON, judged by lib/guard.mjs). A throw exits non-zero with no result line,
// which verify reports as unparseable.
// Nothing is exported: importing this file RUNS the suite.
import { runVendorMailSuite } from './suite.mjs'

process.stdout.write(`VENDOR-MAIL-SUITE ${JSON.stringify(runVendorMailSuite())}\n`)
