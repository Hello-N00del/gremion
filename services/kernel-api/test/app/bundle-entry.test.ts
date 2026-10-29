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
  // Found by the image-level proof (image-proof.sh up, TASK-080-a round 3): 080-a pulled @nats-io/nkeys into the bundle,
  // whose tweetnacl does a CommonJS require("crypto"); an ESM esbuild bundle has no `require`, so the container died at
  // import time ("Dynamic require of crypto is not supported") and restarted forever -- the whole kernel API down --
  // while every test, which runs from the checkout, stayed green. The REAL build options bundle the REAL entry, and the
  // result must reach the config check (it is started with an empty environment, so it must refuse for a missing variable).
  it('the service bundle, built with the package build options, starts: with no environment it stops at the config check, not at an import error', async () => {
    const { buildOptions } = await import('../../esbuild.config.mjs')
    const dir = mkdtempSync(join(PKG, '.t080-bundle-'))
    try {
      const out = join(dir, 'index.js')
      buildSync({ ...buildOptions(out), absWorkingDir: PKG, logLevel: 'silent' })
      const r = spawnSync(process.execPath, [out], { encoding: 'utf8', cwd: PKG, env: { PATH: process.env.PATH ?? '' } })
      expect(r.stderr).not.toMatch(/Dynamic require|Cannot find (module|package)|ERR_MODULE_NOT_FOUND/)
      expect(r.stderr).toMatch(/TENANT_PROXY_SHARED_SECRET|is not set/)
      expect(r.status).not.toBe(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 60_000)

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
