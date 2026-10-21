#!/usr/bin/env node
// events -- see packages/events/src/cli.ts. The package is TypeScript run in
// place (like nats-auth in the migrate image); tsx loads it.
import { tsImport } from 'tsx/esm/api'

const { main } = await tsImport('../src/cli.ts', import.meta.url)
try {
  process.exitCode = await main(process.argv.slice(2))
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err))
  process.exitCode = 1
}
