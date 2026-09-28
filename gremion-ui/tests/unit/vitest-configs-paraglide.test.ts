// R26-TRAIN4-FIX r3 (house review MEDIUM): TASK-062 made hooks.server.ts import
// $lib/i18n/server/i18n-handle, which imports the GENERATED, gitignored
// src/lib/i18n/paraglide/{server,runtime,messages}.js. Only a Vite config that
// runs paraglideVitePlugin compiles that directory, so every config that can
// load hooks.server (or anything under $lib/i18n) must carry the plugin, or a
// run on a clean checkout fails with
//   Cannot find module '../paraglide/server.js' imported from .../i18n-handle.ts
// (observed under vitest.integration.config.ts before this fix).
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const APP = join(__dirname, '..', '..')

describe('every Vite/Vitest config compiles the Paraglide catalogue', () => {
  it.each(['vite.config.ts', 'vitest.integration.config.ts', 'vitest.deselection.config.ts'])('%s', (file) => {
    const src = readFileSync(join(APP, file), 'utf8')
    expect(src).toMatch(/import \{ paraglideVitePlugin \} from '@inlang\/paraglide-js'/)
    expect(src).toMatch(/import paraglideOptions from '\.\/src\/lib\/i18n\/paraglide-options\.js'/)
    // First in the list: the generated modules must exist before SvelteKit's
    // plugin (and the test files) resolve them.
    expect(src).toMatch(/plugins: \[paraglideVitePlugin\(paraglideOptions\), /)
  })
})
