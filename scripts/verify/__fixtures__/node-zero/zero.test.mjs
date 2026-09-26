// TASK-045 fixture: a node:test file with NO top-level test( declarations.
// `node --test` on this file alone exits 0 and reports it as ONE synthetic
// passing test (the file itself) -- captured as this task's pre-guard RED
// evidence: `node --test --test-reporter=tap zero.test.mjs` -> `# tests 1`,
// `# pass 1`, exit 0. See scripts/verify/verify.zero-collected.test.mjs and
// the TASK-045 commit message for the dated transcript.
export const notATest = true
