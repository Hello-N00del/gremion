// Found by the stack proof (stack-proof.sh up): in the esbuild bundle that is the
// image's entry (dist/index.js, argv[1]), tenant-store's dump CLI main guard
// (`realpath(argv[1]) === import.meta.url`) is TRUE because every module of the
// bundle shares the bundle's URL, so importing '@gremion/tenant-store/dump' ran
// the dump CLI on EVERY boot: `usage: cli.ts migrate ...` on stderr and a
// process.exitCode of 1 left behind in `serve` mode. Importing the dump module
// from a bundle must run nothing.
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildSync } from 'esbuild'
import { describe, expect, it } from 'vitest'

const PKG = fileURLToPath(new URL('../../', import.meta.url))

describe('the bundled entry', () => {
  it('importing tenant-store/dump in a bundle runs no CLI: no stderr, exit code 0', () => {
    const dir = mkdtempSync(join(PKG, '.t077-bundle-'))
    try {
      const entry = join(dir, 'entry.mjs')
      writeFileSync(entry, "import '@gremion/tenant-store/dump'\nconsole.log('imported')\n")
      const out = join(dir, 'index.js')
      buildSync({ entryPoints: [entry], bundle: true, platform: 'node', format: 'esm', target: 'node22', outfile: out, absWorkingDir: PKG, external: ['postgres'], logLevel: 'silent', nodePaths: [join(PKG, 'node_modules')] })
      const r = spawnSync(process.execPath, [out], { encoding: 'utf8', cwd: PKG })
      expect(r.stdout.trim(), r.stderr).toBe('imported')
      expect(r.stderr).toBe('')
      expect(r.status).toBe(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
