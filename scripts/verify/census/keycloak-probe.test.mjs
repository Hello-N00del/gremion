// TASK-036 TDD item 11 (brief Q3): the honest Keycloak probe. The healthcheck
// is read out of docker-compose.yml's keycloak block (compose `$$` unescaped
// to `$`), pointed at a stub management port, and run with bash: a stub
// answering 503 / DOWN must make it exit non-zero. A bare socket connect
// cannot tell "the JVM bound a port" from "Keycloak is ready".
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { test } from 'node:test'
import { promisify } from 'node:util'
import { parse } from 'yaml'
import { REPO_ROOT } from './render.mjs'

const execFileP = promisify(execFile)
const compose = parse(readFileSync(path.join(REPO_ROOT, 'docker-compose.yml'), 'utf8'))
const keycloak = compose.services.keycloak

function probeScript(port) {
  const t = keycloak.healthcheck.test
  let script
  if (t[0] === 'CMD-SHELL') script = t[1]
  else if (t[0] === 'CMD' && t[1] === 'bash' && t[2] === '-c') script = t[3]
  else throw new Error(`unexpected keycloak healthcheck form: ${JSON.stringify(t)}`)
  return script.replaceAll('$$', '$').replace(/\/dev\/tcp\/127\.0\.0\.1\/\d+/g, `/dev/tcp/127.0.0.1/${port}`)
}

async function runAgainst(status, body) {
  const seen = []
  const server = http.createServer((req, res) => {
    seen.push(req.url)
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(body)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  try {
    await execFileP('bash', ['-c', probeScript(port)], { timeout: 20_000 })
    return { code: 0, seen }
  } catch (err) {
    return { code: err.code ?? 1, seen }
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
}

const UP = '{\n    "status": "UP",\n    "checks": [\n    ]\n}'
const DOWN = '{\n    "status": "DOWN",\n    "checks": [\n    ]\n}'

test('keycloak enables its health endpoints on the management port root', () => {
  assert.equal(keycloak.environment.KC_HEALTH_ENABLED, 'true')
  assert.equal(keycloak.environment.KC_HTTP_MANAGEMENT_RELATIVE_PATH, '/')
})

test('the probe exits non-zero against a 503 DOWN stub', async () => {
  const r = await runAgainst(503, DOWN)
  assert.notEqual(r.code, 0, 'the keycloak healthcheck passed against a 503 / DOWN management endpoint')
})

test('the probe exits non-zero against a 200 whose body is DOWN', async () => {
  assert.notEqual((await runAgainst(200, DOWN)).code, 0)
})

test('the probe asks /health/ready and passes only on 200 + "status": "UP"', async () => {
  const r = await runAgainst(200, UP)
  assert.equal(r.code, 0)
  assert.deepEqual(r.seen, ['/health/ready'])
})
