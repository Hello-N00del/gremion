// gremion#6 docs gap: the provisioner reads RELAY_SMTP_* (realm-doc.ts
// mailTransportFromEnv). Every key it reads must be documented in .env.example
// and docs/ENVIRONMENT.md, and the password documented as a secret REF.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (p) => readFileSync(path.join(ROOT, p), 'utf8')

const src = read('gremion-ui/src/lib/server/tenant/provisioner/realm-doc.ts')
const keys = [...new Set([...src.matchAll(/get\('((?:RELAY_|MAIL_|PLATFORM_)[A-Z_]+)'\)/g)].map((m) => m[1]))].toSorted()

test('the guard sees the relay keys (not vacuous)', () => {
  for (const k of ['MAIL_TRANSPORT', 'RELAY_SMTP_HOST', 'RELAY_SMTP_PORT', 'RELAY_SMTP_USER', 'RELAY_SMTP_PASSWORD_REF']) {
    assert.ok(keys.includes(k), k)
  }
})

// Two tests, a loop inside each: scripts/verify/suites/unit.mjs compares node's collected count with the
// number of `test(` declarations, and a `test(` inside a loop declares 1 and collects N (judged
// unparseable). The messages name the file that failed.
test('.env.example and docs/ENVIRONMENT.md document every mail-transport key the provisioner reads', () => {
  for (const file of ['.env.example', 'docs/ENVIRONMENT.md']) {
    const text = read(file)
    const missing = keys.filter((k) => !text.includes(k))
    assert.deepEqual(missing, [], `${file} does not document: ${missing.join(', ')}`)
  }
})
test('.env.example and docs/ENVIRONMENT.md say the relay password is a secret ref and an inline value is ignored', () => {
  for (const file of ['.env.example', 'docs/ENVIRONMENT.md']) {
    const text = read(file)
    assert.match(text, /RELAY_SMTP_PASSWORD_REF/, file)
    assert.match(text, /inline[\s\S]{0,60}ignored/i, file)
  }
})
