// Module OFF acceptance (decision 2026-10-21): the retention registry, the Loki
// render, the purge runner and the generator name kernel streams and tables only.
// A module's logs reach Loki through the generic OTLP / spool path with a class
// label, so a module that is OFF removes a source, never a stream.
// RED recipe: add a module id to registry.ts, loki.ts, purge.ts or config.alloy.
import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { renderLoki } from '../src/loki.ts'

const ROOT = resolve(fileURLToPath(new URL('../../../', import.meta.url)))
const MODULE_WORDS = [
  'board', 'calendar', 'publishing', 'newsletter', 'messaging', 'nextcloud', 'votes', 'elections', 'handover',
]
const word = (w: string) => new RegExp(`\\b${w}\\b`, 'i')

const src = readdirSync(join(ROOT, 'packages/retention/src')).map((f) => ({
  name: `packages/retention/src/${f}`,
  text: readFileSync(join(ROOT, 'packages/retention/src', f), 'utf8'),
}))

describe('retention names no feature module', () => {
  for (const w of MODULE_WORDS) {
    it(`no source file of the package contains the module word "${w}" outside comments that only forbid it`, () => {
      for (const f of src) {
        if (f.name.endsWith('registry.ts') || f.name.endsWith('loki.ts')) {
          // these two carry a header comment that explains the rule in prose (no module id used as an identifier)
          const code = f.text.split('\n').filter((l) => !l.trimStart().startsWith('//') && !l.trimStart().startsWith('#')).join('\n')
          expect(code, f.name).not.toMatch(word(w))
        } else {
          const code = f.text.split('\n').filter((l) => !l.trimStart().startsWith('//') && !l.trimStart().startsWith('*') && !l.trimStart().startsWith('/*')).join('\n')
          // the generator carries one reader-facing sample label in its tests only; src must be clean
          expect(code, f.name).not.toMatch(word(w))
        }
      }
    })
  }

  it('the rendered Loki config and the Alloy config name no module target', () => {
    const alloy = readFileSync(join(ROOT, 'docker/alloy/config.alloy'), 'utf8')
    for (const w of MODULE_WORDS) {
      expect(renderLoki(), w).not.toMatch(word(w))
      expect(alloy, w).not.toMatch(word(w))
    }
  })
})
