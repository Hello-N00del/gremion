#!/usr/bin/env node
// TASK-077 stack-proof: two Keycloak realm import files (realm-a, realm-b) made
// from the REAL docker/keycloak/realm-export.base.json -- placeholders filled,
// plus (test copy only, the repo file is untouched) a direct-grant test user per
// realm, the gremion-ui client's secret and direct-grant flag, and a second
// client `t077-plain` WITHOUT the kernel-api audience mapper (its token must be
// refused: no gremion-kernel-api in aud).
// usage: make-realms.mjs <outDir> <clientSecret> <userPassword>
import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const [outDir, clientSecret, userPassword] = process.argv.slice(2)
if (!outDir || !clientSecret || !userPassword) throw new Error('usage: make-realms.mjs <outDir> <clientSecret> <userPassword>')
const REALM_FILE = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../../docker/keycloak/realm-export.base.json')
mkdirSync(outDir, { recursive: true })

for (const key of ['a', 'b', 'c']) {
  const name = `realm-${key}`
  const raw = readFileSync(REALM_FILE, 'utf8')
    .replaceAll('__REALM_NAME__', name)
    .replaceAll('__APEX_DOMAIN__', 'localhost')
    .replaceAll('__SSL_REQUIRED__', 'none')
    .replace(/__[A-Z_]*SECRET__|__SMTP_PASSWORD__/g, 'x'.repeat(24))
    .replaceAll('__SMTP_PORT__', '25')
    .replaceAll('__SMTP_FROM__', `${key}@example.org`)
    .replaceAll('__SMTP_HOST__', 'localhost')
    .replace(/__SMTP_[A-Z]+__/g, 'false')
  // the template carries fixed object ids (authenticator configs, ...): two realms in one
  // Keycloak need distinct ones, so every UUID is remapped consistently inside this realm
  const ids = new Map()
  const doc = JSON.parse(raw.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, (u) => ids.get(u) ?? ids.set(u, randomUUID()).get(u)))
  const ui = doc.clients.find((c) => c.clientId === 'gremion-ui')
  if (!ui) throw new Error('realm template has no gremion-ui client')
  ui.directAccessGrantsEnabled = true
  ui.secret = clientSecret
  doc.clients.push({ clientId: 't077-plain', enabled: true, publicClient: true, directAccessGrantsEnabled: true, standardFlowEnabled: false, protocol: 'openid-connect' })
  doc.users.push({
    username: `${key}user`, enabled: true, emailVerified: true, email: `${key}user@example.org`, firstName: key.toUpperCase(), lastName: 'User',
    credentials: [{ type: 'password', value: userPassword, temporary: false }],
  })
  writeFileSync(join(outDir, `${name}.json`), JSON.stringify(doc))
}
console.log(`wrote realm-a.json realm-b.json realm-c.json to ${outDir}`)
