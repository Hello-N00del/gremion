// Test doubles for the two functions the package takes as PARAMETERS (brief Q3):
// the host normaliser and the reserved-host predicate. They are deliberately
// strict re-statements, not imports — the package must not import gremion-ui.
// reserved-labels.test.ts pins RESERVED_LABELS to gremion-ui's list.
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
export const REPO_ROOT = join(PKG_ROOT, '..', '..')

export const APEX = 'example.org'

export const RESERVED_LABELS: readonly string[] = JSON.parse(
  readFileSync(join(PKG_ROOT, 'fixtures', 'reserved-labels.json'), 'utf8'),
) as string[]

export function normaliseHost(raw: string): string | null {
  const t = raw.trim()
  if (!t || /[,\s]/.test(t) || !/^[A-Za-z0-9.:-]+$/.test(t)) return null
  let h = t
  const c = t.indexOf(':')
  if (c !== -1) {
    if (!/^[0-9]{1,5}$/.test(t.slice(c + 1))) return null
    h = t.slice(0, c)
  }
  h = h.toLowerCase()
  if (h.endsWith('.')) h = h.slice(0, -1)
  if (!h || h.length > 253) return null
  if (h.split('.').some((l) => l.length === 0 || l.length > 63)) return null
  return h
}

export function isReservedHost(host: string): boolean {
  const reserved = [APEX, ...RESERVED_LABELS.map((l) => `${l}.${APEX}`)]
  return reserved.includes(host)
}

export const deps: {
  normaliseHost: (raw: string) => string | null
  isReservedHost: (host: string) => boolean
  certResolver: string
} = { normaliseHost, isReservedHost, certResolver: 'le-http' }
