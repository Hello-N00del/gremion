// services/finance/src/bank/xsd-validator.ts
// TASK-009 lane C / R23-7 — leaf port of
// gremion-ui/.../services/money/xsd-validator.ts. Real EPC pain.001.001.09 XSD
// validation via xmllint-wasm (libxml2 compiled to WebAssembly — pure-JS
// install, no native compile). The native oracle inlines the schema text via
// Vite's `?raw` import (SvelteKit-only); the leaf is a plain Node/esbuild
// service with no Vite loader, so this reads the vendored XSD from disk
// instead — same schema file (__fixtures__/pain.001.001.09.xsd, copied
// byte-for-byte from the native fixture), same validator, same behaviour.
// xmllint-wasm spawns a Node Worker per validate call, so no state is shared
// across requests.

import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { validateXML } from 'xmllint-wasm'
import { FinanceUnprocessableError } from '../store/index.js'

const HERE = dirname(fileURLToPath(import.meta.url))
let cachedXsd: string | undefined

function loadXsd(): string {
  if (cachedXsd === undefined) {
    cachedXsd = readFileSync(join(HERE, '__fixtures__', 'pain.001.001.09.xsd'), 'utf-8')
  }
  return cachedXsd
}

/** Validate a SEPA pain.001.001.09 XML document against the EPC XSD. Throws
 *  FinanceUnprocessableError (route -> 422, mirrors the native
 *  SepaSchemaValidationError) on the first error xmllint reports, surfacing the
 *  offending element name when the diagnostic includes it. Resolves with no
 *  value on success. */
export async function xsdValidatePain001(xml: string): Promise<void> {
  const result = await validateXML({
    xml: [{ fileName: 'sepa-export.xml', contents: xml }],
    schema: [{ fileName: 'pain.001.001.09.xsd', contents: loadXsd() }],
  })
  if (result.valid) return

  const first = result.errors[0]
  const detail = first?.message ?? result.rawOutput ?? 'unknown XSD failure'
  const element = extractOffendingElement(first)
  throw new FinanceUnprocessableError(
    `SEPA XSD validation failed${element ? ` at ${element}` : ''}: ${detail}`,
  )
}

/** Best-effort element-name extraction from xmllint diagnostics (mirror of the
 *  native validator's helper). */
function extractOffendingElement(
  err: { message: string; loc: { fileName: string; lineNumber: number } | null } | undefined,
): string {
  if (!err) return ''
  const m = err.message.match(/Element\s+'(?:\{[^}]*\})?([^']+)'/)
  if (m && m[1]) return m[1]
  return err.loc ? `line ${err.loc.lineNumber}` : ''
}
