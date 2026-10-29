// services/kernel-api/esbuild.config.mjs -- the one place the service bundle is configured (`pnpm build` runs this file;
// test/app/bundle-entry.test.ts builds the SAME options to a temp file and starts the result).
//
// The bundle is ESM, but some bundled dependencies are CommonJS and `require` a Node built-in (@nats-io/nkeys -> tweetnacl
// -> require("crypto")). An ESM bundle has no `require`: esbuild's shim then throws "Dynamic require of crypto is not
// supported" at import time. The banner gives the bundle a real `require` (createRequire) which the shim picks up.
import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const EXTERNAL = ['fastify', '@fastify/multipart', 'ajv', 'ajv-formats', 'jose', 'postgres']

/** @param {string} [outfile]  @returns {import('esbuild').BuildOptions} */
export const buildOptions = (outfile = 'dist/index.js') => ({
  entryPoints: ['src/main.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  outfile,
  external: EXTERNAL,
  banner: { js: "import { createRequire as __gremionCreateRequire } from 'node:module';\nconst require = __gremionCreateRequire(import.meta.url);" },
})

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  await build({ ...buildOptions(), logLevel: 'info' })
}
