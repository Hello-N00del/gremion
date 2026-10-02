#!/usr/bin/env node
// nats-auth — see packages/nats-auth/src/cli.ts. The package is TypeScript
// run in place (like the rest of the workspace in the migrate image); tsx
// loads it, because @gremion/ports uses syntax Node's type stripping refuses.
import { tsImport } from 'tsx/esm/api'

const { main } = await tsImport('../src/cli.ts', import.meta.url)
try {
  process.exitCode = await main(process.argv.slice(2))
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err))
  process.exitCode = 1
}
