// A readiness probe for a Postgres container has to reach the FINAL server.
//
// The official image starts Postgres twice: a temporary server for initdb and
// the init scripts, listening on the unix socket only (listen_addresses=''),
// then the server the container keeps. `pg_isready` without a host goes over
// the socket and is answered by the temporary server, so a wait built on it
// returns too early and the next statement meets a server that is shutting
// down, or no socket at all. Nothing but the final server listens on TCP:
// a probe that names a TCP host cannot be answered early.
//
// This scan holds every tracked script, test, compose file and workflow to
// that. The behavioural half is `gremion-ui/scripts/fresh-init-proof.sh
// --wait-self-check`, which holds a real container in the init phase.
//
// Run: node --test scripts/check-postgres-readiness.test.mjs
import assert from 'node:assert/strict'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { trackedTextFiles } from './check-postgres-major.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SELF = 'scripts/check-postgres-readiness.test.mjs'

// Not scanned: prose, and the cluster manifests, whose probes describe a
// long-running server to the scheduler (the consumer there waits over TCP on
// its own, k8s/base/keycloak/deployment.yaml).
const OUT_OF_SCOPE = [/\.md$/, /^docs\//, /^k8s\//]

// Files that name the probe without a TCP host and are right to. One reason
// each; an entry that no longer matches anything fails the last test below.
const ALLOWED = new Map([
  ['test/integration/health.bats', 'asserts the state of a stack that is already up; nothing waits on it'],
  ['scripts/check-postgres-major.test.mjs', 'a compose fixture string for another guard, never run'],
])

const COMMENT = /^\s*(#|\/\/|\/?\*)/
// `*pg_isready*` is a `case` pattern in a docker stand-in, not a probe.
const STUB_PATTERN = /\*pg_isready\*/
// The host operand in shell form (`-h 127.0.0.1`, `--host=db`) and in argv
// form (`'pg_isready', '-h', '127.0.0.1'`).
const HOST = /pg_isready\b.*?(?:[\s'"])(?:-h|--host)(?:=|['"]?[\s,]+['"]?)([^\s'",\]]+)/

/** Lines of `text` that probe over the unix socket: `[{ line, text }]`. */
function socketOnlyProbes(text) {
  const out = []
  text.split('\n').forEach((raw, i) => {
    if (!/\bpg_isready\b/.test(raw) || COMMENT.test(raw) || STUB_PATTERN.test(raw)) return
    const host = HOST.exec(raw)?.[1]
    // A host that is a path is a socket directory, i.e. still the socket.
    if (!host || host.startsWith('/')) out.push({ line: i + 1, text: raw.trim() })
  })
  return out
}

function scanTree() {
  const files = trackedTextFiles(ROOT).filter((f) => f.path !== SELF && !OUT_OF_SCOPE.some((re) => re.test(f.path)))
  const probing = files.filter((f) => /\bpg_isready\b/.test(f.text))
  const hits = probing.flatMap((f) => socketOnlyProbes(f.text).map((h) => ({ path: f.path, ...h })))
  return { probing, hits }
}

test('a probe without a TCP host is reported, in every form the tree uses', () => {
  const old = [
    'timeout 90 bash -c "until docker exec $NAME pg_isready -U postgres >/dev/null 2>&1; do sleep 2; done"',
    '      test: ["CMD-SHELL", "pg_isready -U $${POSTGRES_USER}"]',
    '          --health-cmd "pg_isready -U gremion"',
    "    const r = sh('docker', ['exec', NAME, 'pg_isready', '-U', user, '-d', 'postgres'], { allowFail: true })",
    '    until docker exec "${STACK}-pg" pg_isready -qU postgres 2>/dev/null; do sleep 2; done',
    '  docker exec "$NAME" pg_isready -h /var/run/postgresql -U postgres',
    '              command: ["pg_isready"]',
  ]
  for (const line of old) assert.equal(socketOnlyProbes(line).length, 1, `not reported: ${line}`)
  assert.deepEqual(socketOnlyProbes(`ok\n${old[0]}\nok`), [{ line: 2, text: old[0] }])
})

test('a probe that names a TCP host passes, and so do comments and stub patterns', () => {
  const fine = [
    'ready_probe() { docker exec "$NAME" pg_isready -q -h 127.0.0.1 -U postgres >/dev/null 2>&1; }',
    '    test: ["CMD-SHELL", "pg_isready -h 127.0.0.1 -U \\"$${POSTGRES_USER}\\""]',
    '          --health-cmd "pg_isready -h 127.0.0.1 -U gremion"',
    "    ready = sh('docker', ['exec', names.pg, 'pg_isready', '-h', '127.0.0.1', '-U', user], { allowFail: true })",
    '  pg_isready --host=127.0.0.1 --username=postgres',
    '              until pg_isready -h postgres -p 5432 -U $(KC_DB_USERNAME); do',
    '# a socket-only pg_isready passes against the temporary server',
    '  // pg_isready answers during the entrypoint\'s temporary server',
    '      *pg_isready*|*"SELECT 1"*) exit 0 ;;',
  ]
  for (const line of fine) assert.deepEqual(socketOnlyProbes(line), [], `reported: ${line}`)
})

test('the tree: every Postgres readiness probe names a TCP host', () => {
  const { probing, hits } = scanTree()
  // Vacuity floor: a scan that opened nothing reports nothing.
  assert.ok(probing.length >= 15, `only ${probing.length} files name pg_isready -- the scan is not seeing the tree`)
  assert.ok(probing.some((f) => f.path === 'gremion-ui/scripts/fresh-init-proof.sh'), 'the fresh-init proof was not scanned')
  const offending = hits.filter((h) => !ALLOWED.has(h.path))
  assert.deepEqual(
    offending.map((h) => `${h.path}:${h.line}: ${h.text}`),
    [],
    'these probes go over the unix socket, which the image\'s temporary init server answers; name the TCP host (-h 127.0.0.1)',
  )
})

test('every allowed file still needs its entry', () => {
  const { hits } = scanTree()
  const stale = [...ALLOWED.keys()].filter((p) => !hits.some((h) => h.path === p))
  assert.deepEqual(stale, [], 'these entries match no socket-only probe any more; remove them')
})
