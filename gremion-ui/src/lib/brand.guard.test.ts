import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { extname, join, relative, resolve } from 'node:path'

/**
 * Brand-neutralization guard — §6-P2.2 / design §3.4 "no institution literal
 * anywhere" (P2.1c T15, widened from the v5 component-scoped guard).
 *
 * Institution-specific strings live in exactly one place: the per-tenant config
 * (`lib/server/config.ts` is now NEUTRAL — the default tenant's real values live
 * in its materialized `config.json`, written by `tenant-provision materialize-config`).
 * Components/server code read them via `resolveBrand(page.data.brand)` /
 * `requireBrand()`, never inline. Re-tenanting StuRaOS for another council must
 * NOT mean hunting hardcoded institution strings through the source tree.
 *
 * SCAN SCOPE (T15): widened from COMPONENT_ROOTS to ALL of `gremion-ui/src/**`
 * (every `.svelte`/`.ts`/`.js`/`.css`), excluding test files and fixtures. This
 * is the §6-P2.2 "anywhere" requirement: a new server module, i18n string, or
 * stylesheet that inlines an institution literal now fails CI, not just a
 * component.
 *
 * cwd = gremion-ui/ when vitest runs (see vite.config.ts), so dirs resolve
 * relative to process.cwd().
 *
 * OUT OF SCOPE — `docker/**` realm/compose templates: those are
 * operator-substituted DEPLOY config (placeholders the provisioner fills per
 * tenant), not product source, so scanning them for HOSTS or secrets would flag
 * legitimate template tokens. The institution-IDENTITY literals are a different
 * matter and are NOT exempt: the shipped Keycloak login theme carried `HS Harz`
 * and an `@hs-harz.de` placeholder while this guard reported green. They are now
 * checked across the whole tracked tree by the sibling guard in
 * `deploy-brand.guard.test.ts`. This file's scope stays `gremion-ui/src/**`.
 *
 * FORBIDDEN list (UNCHANGED from the v5 guard, per T15): `StuRaOS`, `HS Harz`,
 * `Hochschule Harz`, `stura.hs-harz.de`. The allowlist starts — and stays —
 * EMPTY: every hit must be FIXED, not allowlisted.
 *
 * The three institution-IDENTITY literals (HS Harz / Hochschule Harz /
 * stura.hs-harz.de) were confined to `config.ts` and are cleared by its
 * neutralization — they carry ZERO tolerance and assert clean repo-wide.
 *
 * THE PRODUCT-NAME CARRY-OVER IS CLOSED (0.1.0 public flip).
 *
 * "StuRaOS" used to be an ESCALATED, design-review-pending exception: it still
 * appeared in non-test source as user-facing copy and operational strings, so
 * the offending files were snapshotted into a finite `STURAOS_KNOWN_DIRTY` set
 * and the guard only asserted that no NEW file carried the literal. That set
 * carried its own tripwire — it failed the moment it went empty or a pinned
 * file went clean — precisely so that whoever cleared the last offender had to
 * delete the exception rather than let it rot.
 *
 * That happened. The last six carriers (`src/app.css`, `src/hooks.server.ts`,
 * `src/lib/i18n/{de,en}.ts`, `src/lib/server/config.ts` and
 * `src/routes/api/setup/test-smtp/+server.ts`) were cleared in the same commit
 * that deleted the set, the two exception tests and this paragraph's
 * predecessor. `StuRaOS` is now in the HARD zero-tolerance FORBIDDEN loop
 * beside the institution literals: any occurrence in scanned source fails, with
 * no allowlist and no exception. The list must never grow one back.
 */

// T15: scan ALL of src/** — every source extension, not just components.
const SCAN_ROOT = resolve(process.cwd(), 'src')
const SCANNED_EXTENSIONS = new Set(['.svelte', '.ts', '.js', '.css'])

// FORBIDDEN list — UNCHANGED from the v5 guard (T15). Each is the verbatim
// displayed string a re-tenant would have to change. All four assert HARD
// (zero tolerance, empty allowlist): the three institution-IDENTITY literals
// always did, and the product name "StuRaOS" joined them when its carry-over
// exception was closed for 0.1.0 (see header).
const FORBIDDEN: { label: string; re: RegExp }[] = [
  { label: 'product "StuRaOS"', re: /StuRaOS/ },
  { label: 'org short "HS Harz"', re: /HS Harz/ },
  { label: 'org name "Hochschule Harz"', re: /Hochschule Harz/ },
  { label: 'domain / matrix homeserver "stura.hs-harz.de"', re: /stura\.hs-harz\.de/ },
]

// NO source file may carry an institution literal. Empty allowlist — and it
// stays empty: every hit is fixed or escalated, never allowlisted.
const ALLOWLIST_BASENAMES = new Set<string>([])

function isTestFile(absPath: string): boolean {
  const base = absPath.replace(/\\/g, '/').split('/').pop() ?? ''
  return base.endsWith('.test.ts') || base.endsWith('.test.svelte') || base.endsWith('.test.js')
}

function isFixture(absPath: string): boolean {
  const norm = absPath.replace(/\\/g, '/')
  return /\/__fixtures__\//.test(norm) || /\/fixtures\//.test(norm)
}

function isAllowlisted(absPath: string): boolean {
  const base = absPath.replace(/\\/g, '/').split('/').pop() ?? ''
  return ALLOWLIST_BASENAMES.has(base)
}

/** Recursively collect scannable source files under a root dir. */
function collectSources(dir: string, out: string[]): void {
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return
  }
  for (const name of entries) {
    if (name === 'node_modules' || name.startsWith('.')) continue
    const full = join(dir, name)
    const st = statSync(full)
    if (st.isDirectory()) {
      if (name === '__fixtures__' || name === 'fixtures') continue
      collectSources(full, out)
    } else if (
      SCANNED_EXTENSIONS.has(extname(name)) &&
      !isTestFile(full) &&
      !isFixture(full) &&
      !isAllowlisted(full)
    ) {
      out.push(full)
    }
  }
}

const rel = (abs: string) => relative(process.cwd(), abs).replace(/\\/g, '/')

describe('brand neutralization — no institution literal anywhere in src (§6-P2.2)', () => {
  const files: string[] = []
  collectSources(SCAN_ROOT, files)

  it('finds source files to scan (widened to all of src/**)', () => {
    // Sanity guard: a silently-empty scan makes the test useless. The widened
    // scope (.ts + .svelte + .css) is far larger than the old component-only set.
    expect(files.length).toBeGreaterThan(200)
  })

  // All four FORBIDDEN literals — the three institution-IDENTITY strings and the
  // retired product name — are hard zero-tolerance with an empty allowlist.
  for (const { label, re } of FORBIDDEN) {
    it(`no source file inlines the ${label} literal`, () => {
      const offenders: string[] = []
      for (const file of files) {
        if (re.test(readFileSync(file, 'utf8'))) offenders.push(rel(file))
      }
      expect(
        offenders,
        `Hardcoded ${label} found. Institution identity is per-tenant — it lives ` +
          `only in the tenant config.json (resolveBrand / requireBrand), never inline:\n  ` +
          offenders.join('\n  '),
      ).toEqual([])
    })
  }
})
