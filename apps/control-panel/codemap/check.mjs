// check.mjs - the entry of the CI check for the code map.
//
//   node codemap/check.mjs        (package.json: pnpm --filter control-panel codemap:check)
//
// The work is in check-core.mjs (read its header for what the check does and for the exit codes). This file imports
// only node modules and loads check-core.mjs with a dynamic import. A static import that fails ends the process with
// node's exit 1, and 1 is the code for a leak. Here a module that cannot be loaded is exit 3: the tool failed.
const EXIT_TOOL_FAILED = 3

try {
  const core = await import('./check-core.mjs')
  core.main()
} catch (err) {
  const why = String((err instanceof Error ? err.message : err) ?? '').replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A')
  console.error(`::error title=Code map::the check could not start: ${why}`)
  process.exitCode = EXIT_TOOL_FAILED
}
