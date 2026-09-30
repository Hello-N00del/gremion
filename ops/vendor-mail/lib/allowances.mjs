// TASK-015: allowances.json, read and shape-checked in one place.
import { readFileSync } from 'node:fs'
import path from 'node:path'

export const ALLOWANCES_PATH = path.join(import.meta.dirname, '..', 'allowances.json')

export function loadAllowances(file = ALLOWANCES_PATH) {
  const doc = JSON.parse(readFileSync(file, 'utf8'))
  if (doc?.schemaVersion !== 1 || !Array.isArray(doc.separation) || typeof doc.principals !== 'object') {
    throw new Error(`${path.basename(file)}: not a schemaVersion 1 allowances document`)
  }
  for (const a of doc.separation) {
    for (const k of ['id', 'connectorFile', 'connectorKey', 'vendorGroup', 'vendorKey']) {
      if (typeof a[k] !== 'string' || !a[k]) throw new Error(`allowances.json separation entry lacks ${k}`)
    }
  }
  const p = doc.principals
  if (typeof p.vendorRealms !== 'object' || !Array.isArray(p.vendorPrincipals) || !Array.isArray(p.transitional)) {
    throw new Error('allowances.json principals section is malformed')
  }
  return doc
}
