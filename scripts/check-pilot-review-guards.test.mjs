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

test('no recipient address reaches the publishing send-failure log', () => {
  const src = read('modules/publishing/src/dispatch.ts')
  assert.doesNotMatch(src, /send to \$\{email\}/)
  assert.match(src, /mailErrorFields\(err\)/, 'the failure log names the cause fields')
})

test('a failed send names its cause in every log, and never logs the error text', () => {
  const content = read('modules/content/src/dispatch.ts')
  assert.match(content, /email send \(post \$\{postId\}\) failed`, mailErrorFields\(err\)/)
  const route = read('modules/publishing/app/routes/api/internal/newsletter/send-mail/+server.ts')
  assert.match(route, /SMTP send failed', cause\)/)
  assert.doesNotMatch(route, /err\.message|err\.response/)
})

test('the content leaf warns at startup when the mail callback secret is unset', () => {
  assert.match(
    read('modules/content/src/index.ts'),
    /if \(!process\.env\.INTERNAL_NEWSLETTER_SECRET\) \{\s*console\.warn\(/,
  )
})
