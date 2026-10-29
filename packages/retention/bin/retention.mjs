#!/usr/bin/env node
// packages/retention/bin/retention.mjs -- thin entry; the code is src/cli.ts (Node strips the types).
import { main } from '../src/cli.ts'

process.exitCode = await main(process.argv.slice(2))
