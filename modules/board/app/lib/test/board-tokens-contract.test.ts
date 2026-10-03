import { describe, test, expect } from 'vitest'
import { readFileSync, readdirSync, statSync, existsSync } from 'fs'
import { join } from 'path'

// Guard for the Deck-board "phantom token" regression (Deck Board audit §1):
// the board components were authored against a CSS-variable vocabulary that
// does NOT exist in app.css (--space-*, --text, --text-muted, --danger,
// --warn, --shadow-sm, --accent-contrast, --accent-strong, bare --radius*).
// CSS silently drops an undefined var(), so spacing collapsed to 0 and
// semantic colours fell back to inherited black. This test fails the build if
// any of those names creep back into the board surface. Mirrors the
// pill-icon-contract.test.ts walk pattern.
//
// Correct repo tokens (app.css :root): --s-1..--s-8, --ink / --ink-muted,
// --r-xs/sm/md/lg, --sh-1/2/3, --rust(/-soft/-ink), --ember(/-soft/-ink),
// --paper (text on accent), --accent-ink (text on -soft).

const FORBIDDEN = /var\(\s*--(space|text|danger|warn|shadow-sm|shadow-lg|accent-contrast|accent-strong|radius)\b/

function walkSvelte(dir: string): string[] {
  const out: string[] = []
  if (!existsSync(dir)) return out
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry)
    if (statSync(p).isDirectory()) out.push(...walkSvelte(p))
    else if (entry.endsWith('.svelte')) out.push(p)
  }
  return out
}

describe('board phantom-token contract', () => {
  const roots = [
    join(__dirname, '../components/board'),
    join(__dirname, '../../routes/tasks'),
  ]
  const files = roots.flatMap(walkSvelte)

  test('there are board surface files to check', () => {
    expect(files.length).toBeGreaterThan(0)
  })

  for (const file of files) {
    test(`${file.split(/[\\/]/).slice(-2).join('/')} uses only real app.css tokens`, () => {
      const src = readFileSync(file, 'utf8')
      const offenders = src
        .split('\n')
        .map((line, i) => ({ line, n: i + 1 }))
        .filter(({ line }) => FORBIDDEN.test(line))
      expect(
        offenders,
        `phantom design tokens found — use the repo names (--s-*, --ink, --ink-muted, ` +
          `--r-md, --sh-1, --rust(-soft/-ink), --ember(-soft/-ink), --paper, --accent-ink):\n` +
          offenders.map((o) => `  L${o.n}: ${o.line.trim()}`).join('\n'),
      ).toHaveLength(0)
    })
  }
})
