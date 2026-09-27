// TASK-045: if vitestSubcheck ever falls back to a hard-coded script name
// instead of the testScript it was given, THIS is what would run instead of
// fake-reporter.mjs -- it exits non-zero and writes no report, so the test
// fails loudly rather than silently reading a stale/absent file.
process.exit(17)
