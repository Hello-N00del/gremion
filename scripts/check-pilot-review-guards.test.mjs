import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8')

test('Collabora accepts exactly one literal WOPI host, with no regex metacharacters', () => {
  const m = read('docker-compose.yml').match(/aliasgroup1:\s*"([^"]+)"/)
  assert.ok(m, 'aliasgroup1 is set')
  assert.doesNotMatch(new URL(m[1]).hostname, /[*+?()[\]|]/)
  assert.ok(!/[*+?()[\]|]/.test(m[1]), `aliasgroup1 is literal: ${m[1]}`)
})

test('the content leaf can authenticate its mail callbacks', () => {
  const app = read('docker-compose.app.yml')
  const svc = app.slice(app.indexOf('\n  content-service:'), app.indexOf('\n  newsletter-service:'))
  assert.match(svc, /INTERNAL_NEWSLETTER_SECRET/, 'content-service receives the callback secret')
  assert.match(read('modules/content/src/index.ts'), /process\.env\.INTERNAL_NEWSLETTER_SECRET/)
})

test('no recipient address reaches a send-failure log or error text', () => {
  assert.doesNotMatch(read('modules/content/src/dispatch.ts'), /email send to \$\{email\}/)
  assert.doesNotMatch(read('modules/publishing/app/routes/api/internal/newsletter/send-mail/+server.ts'), /send failed', \{ to,/)
  assert.doesNotMatch(read('modules/content/src/kernel-client.ts'), /to=\$\{msg\.to\}/)
  assert.doesNotMatch(read('modules/publishing/src/kernel-client.ts'), /to=\$\{msg\.to\}/)
})
