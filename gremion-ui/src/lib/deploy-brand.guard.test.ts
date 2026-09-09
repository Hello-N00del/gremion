import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * Institution-identity guard for DEPLOY surfaces — the sibling of
 * `brand.guard.test.ts`.
 *
 * `brand.guard.test.ts` scans `gremion-ui/src/**` only. Its header used to say
 * `docker/**` was "excluded by design" because operator-substituted templates
 * would false-positive on placeholder tokens — true for HOSTS and secrets, but
 * it also meant the three institution-IDENTITY literals were never checked
 * outside product source. They were not hypothetical: the shipped Keycloak
 * login theme carried `HS Harz` in all three message bundles and a
 * `@hs-harz.de` e-mail placeholder, and the guard that advertised
 * "no institution literal anywhere" returned green for years.
 *
 * So this guard scans every TRACKED file in the repository (not just product
 * source) for the institution-identity literals ONLY. It deliberately does NOT
 * check the product-name leg (`StuRaOS`): that leg belongs to
 * `brand.guard.test.ts` (for `gremion-ui/src/**`) and to
 * `gremion-public/src/lib/test/kernel-instance-leak.test.ts` (for the portal),
 * where it is now a hard zero-tolerance assertion. Re-asserting it over the
 * WHOLE tree here would need carve-outs for the Keycloak login theme, migration
 * `043` and the hygiene script's own banned-word list — a carve-out list that
 * long reads as coverage while quietly excluding what is not on it, so the gap
 * is recorded in KNOWN_ISSUES.md instead of papered over here.
 *
 * Test files are excluded: several of them assert that these literals are
 * ABSENT from rendered output and therefore must spell them out.
 *
 * cwd = gremion-ui/ when vitest runs, so the repo root is one level up.
 */

const REPO_ROOT = resolve(process.cwd(), '..')

// Institution IDENTITY only — zero tolerance, no allowlist. The product-name
// leg lives in brand.guard.test.ts as a tracked design carry-over.
const FORBIDDEN: { label: string; re: RegExp }[] = [
  { label: 'org short "HS Harz"', re: /HS Harz/ },
  { label: 'org name "Hochschule Harz"', re: /Hochschule Harz/ },
  { label: 'domain / matrix homeserver "hs-harz.de"', re: /hs-harz\.de/ },
]

const BINARY_EXT =
  /\.(png|jpe?g|gif|webp|avif|ico|svg|woff2?|ttf|otf|eot|pdf|zip|gz|tgz|jar|class|so|dll|exe|bin|lock)$/i

function isTestFile(path: string): boolean {
  const base = path.split('/').pop() ?? ''
  return /\.(test|spec)\.(ts|js|svelte)$/.test(base) || /(^|\/)(__fixtures__|fixtures)\//.test(path)
}

/**
 * Tracked files only — what actually becomes public. Fails loudly if git is
 * unavailable rather than silently scanning nothing.
 */
function trackedFiles(): string[] {
  const out = execFileSync('git', ['-C', REPO_ROOT, 'ls-files', '-z'], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
  return out.split('\0').filter(Boolean)
}

describe('institution-identity guard — deploy surfaces and the whole tracked tree', () => {
  const files = trackedFiles().filter((p) => !BINARY_EXT.test(p) && !isTestFile(p))

  it('scans a non-trivial number of tracked files', () => {
    // A guard that collected zero files passes vacuously. Assert the scan is real.
    expect(files.length).toBeGreaterThan(300)
  })

  it('includes the Keycloak theme, the realm template and the deploy config', () => {
    // Pin the surfaces the old `docker/**` exclusion left unchecked, so a future
    // narrowing of the file list cannot silently drop them again.
    const norm = new Set(files)
    expect(norm.has('docker/keycloak/themes/sturaos/login/messages/messages_de.properties')).toBe(
      true,
    )
    expect(norm.has('docker/keycloak/realm-export.base.json')).toBe(true)
    expect(norm.has('docker-compose.yml')).toBe(true)
  })

  for (const { label, re } of FORBIDDEN) {
    it(`no tracked non-test file carries the ${label} literal`, () => {
      const offenders: string[] = []
      for (const rel of files) {
        let text: string
        try {
          text = readFileSync(resolve(REPO_ROOT, rel), 'utf8')
        } catch {
          continue
        }
        if (re.test(text)) offenders.push(rel)
      }
      expect(
        offenders,
        `Hardcoded ${label} found outside product source. Institution identity is ` +
          `per-tenant: it belongs in the tenant's own realm/config at runtime, never ` +
          `in a shipped default:\n  ` +
          offenders.join('\n  '),
      ).toEqual([])
    })
  }
})
