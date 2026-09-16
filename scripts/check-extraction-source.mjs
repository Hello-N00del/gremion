#!/usr/bin/env node
// Frozen extraction-source guard — spec B 2.4, unit B00-extraction-source-freeze.
//
// Every assertion here is a POST-CONDITION on committed content: the doc's own
// bytes, the module.json files on disk, and scripts/assemble.mjs's own source.
// Never an exit code, never "the command ran".
//
// The contract's helpers live in scripts/lib/extraction-source.mjs (one
// implementation, imported by D2's validator too) and are re-exported here so
// scripts/assemble.mjs has one import to make — the wiring the guard checks for.
//
// Run:  node scripts/check-extraction-source.mjs [--modules-root <dir>] [--allow-zero] [--print]
// Test: node --test scripts/check-extraction-source.test.mjs

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  DOC_PATH,
  SHA_RE,
  KERNEL_ROOT,
  parseFrozenExtractionSource,
  readFrozenExtractionSource,
} from './lib/extraction-source.mjs'

export { DOC_PATH, SHA_RE, KERNEL_ROOT, parseFrozenExtractionSource, readFrozenExtractionSource }
