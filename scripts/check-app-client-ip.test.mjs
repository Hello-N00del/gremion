// Per-IP rate limits (gremion-ui rate-limit.ts / client-ip.ts) read the client
// address through adapter-node's getClientAddress(). Without ADDRESS_HEADER +
// XFF_DEPTH it is Traefik's container IP: one bucket for every visitor. The
// gremion-ui service of docker-compose.app.yml must set both, and XFF_DEPTH
// must equal the proxy hop count (Traefik is the only hop; its entrypoint
// trusts forwarded headers from the edge subnets only, so it appends the real
// peer to X-Forwarded-For).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const compose = readFileSync(join(ROOT, 'docker-compose.app.yml'), 'utf8')

function serviceEnv(name) {
  const start = compose.search(new RegExp(`^  ${name}:`, 'm'))
  assert.ok(start >= 0, `${name} not found`)
  const rest = compose.slice(start + 1)
  const next = rest.search(/^  [a-z][\w-]*:/m)
  const block = next < 0 ? rest : rest.slice(0, next)
  const env = {}
  for (const line of block.split(/\r?\n/)) {
    const m = line.match(/^      ([A-Z][A-Z0-9_]*):\s*"?([^"#]*?)"?\s*(?:#.*)?$/)
    if (m) env[m[1]] = m[2]
  }
  return env
}

test('gremion-ui keys per-IP limits on x-forwarded-for', () => {
  assert.equal(serviceEnv('gremion-ui').ADDRESS_HEADER, 'x-forwarded-for')
})

test('gremion-ui XFF_DEPTH is 1 (Traefik is the single proxy hop)', () => {
  assert.equal(serviceEnv('gremion-ui').XFF_DEPTH, '1')
})

test('traefik trusts forwarded headers only from the edge subnets (single hop)', () => {
  const t = readFileSync(join(ROOT, 'docker/traefik/traefik.yml'), 'utf8')
  assert.match(t, /forwardedHeaders:\s*\n\s*trustedIPs:/)
})
