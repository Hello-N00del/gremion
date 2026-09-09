// src/lib/server/modules/server-init.generated.test.ts
// Session-A inversion A1 — staleness guard for the server-init barrel.
//
// Mirrors src/lib/modules/registry.test.ts's manifest-barrel staleness guard
// EXACTLY: the committed server-init.generated.ts MUST byte-equal a fresh
// `node scripts/build-module-server-init.mjs --stdout` run. If a module
// adds/removes/renames its register.server.ts (a server-init contributor)
// without re-running the codegen, this fails — the generated side-effect import
// barrel cannot silently drift from the register.server.ts files it scans.
import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

// gremion-ui/ package root (this test lives at src/lib/server/modules/).
const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..')
const CODEGEN = join(PKG_ROOT, 'scripts', 'build-module-server-init.mjs')
const BARREL = join(PKG_ROOT, 'src', 'lib', 'server', 'modules', 'server-init.generated.ts')

describe('A1 codegen — generated server-init barrel is the single registration source', () => {
  // STALENESS GUARD: the committed server-init.generated.ts MUST byte-equal a
  // fresh codegen run. If a register.server.ts file is added/removed/renamed
  // without re-running `node scripts/build-module-server-init.mjs`, this fails —
  // the generated barrel cannot silently drift from the register.server.ts set.
  it('committed server-init.generated.ts byte-equals a fresh codegen --stdout run', () => {
    // Compare content, not line endings: the codegen always emits LF, but the
    // committed barrel may be checked out CRLF on Windows (core.autocrlf=true).
    // .gitattributes pins *.generated.ts to eol=lf so the working tree normally
    // matches; this normalization keeps the guard meaningful (it still catches
    // any real content/order drift) regardless of a contributor's checkout EOL.
    const norm = (s: string) => s.replace(/\r\n/g, '\n')
    const fresh = execFileSync('node', [CODEGEN, '--stdout'], { cwd: PKG_ROOT, encoding: 'utf-8' })
    const committed = readFileSync(BARREL, 'utf-8')
    expect(norm(committed)).toBe(norm(fresh))
  })
})
