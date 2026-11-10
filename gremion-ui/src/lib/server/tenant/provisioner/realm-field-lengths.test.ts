import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// Keycloak stores these client fields in varchar(255). A longer value fails realm creation with
// "Database operation failed", on the first customer, with nothing naming the field.
const CAPPED = new Set(['description', 'name', 'rootUrl', 'baseUrl', 'adminUrl', 'clientId'])

function overlong(node: unknown, path: string, out: string[]): void {
  if (Array.isArray(node)) {
    node.forEach((v, i) => overlong(v, `${path}[${i}]`, out))
  } else if (node !== null && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      if (CAPPED.has(k) && typeof v === 'string' && v.length > 255) out.push(`${path}.${k} (${v.length})`)
      overlong(v, `${path}.${k}`, out)
    }
  }
}

describe('realm template field lengths', () => {
  it('keeps every capped field within the Keycloak column size', () => {
    const file = resolve(__dirname, '../../../../../../docker/keycloak/realm-export.base.json')
    const out: string[] = []
    overlong(JSON.parse(readFileSync(file, 'utf8')), '$', out)
    expect(out).toEqual([])
  })
})
