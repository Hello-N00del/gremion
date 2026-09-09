// gremion-ui/scripts/tenant-provision.mjs
// The RUNNABLE entrypoint for the operator provisioning CLI. tenant-provision.ts
// transitively imports `$env/dynamic/private` (via registry.ts), which Node/tsx
// cannot resolve outside a SvelteKit server — a bare
// `tsx scripts/tenant-provision.ts …` dies with ERR_MODULE_NOT_FOUND. Mirror
// run-control-migrations.mjs EXACTLY: register the SvelteKit env shim FIRST, then
// import the CLI (which parses argv + runs `main()` at module top level).
import { registerHooks } from 'node:module'
import { resolve as shimResolve, load as shimLoad } from './sveltekit-env-shim.mjs'

registerHooks({ resolve: shimResolve, load: shimLoad })

// tenant-provision.ts dispatches on process.argv and runs main() at import time
// (it has its own top-level main().catch that sets process.exitCode), so the
// import IS the invocation — no exported main() to call here.
await import('./tenant-provision.ts')
