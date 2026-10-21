#!/usr/bin/env node
// node --test scripts/check-kernel-api-reader-wired.test.mjs
//
// TASK-077: deploy step 7 (kernel-api-migrate) and the kernel-api service connect
// to the control DB as KERNEL_API_DB_USER. No operator path used to create that
// role (ensureKernelApiReader was called only by tests), so the first deploy
// failed at step 7. `gremion-tenant init` (tenant-provision.ts cmdInit, running
// in the compose `tenant-create` one-shot) is the operator path; this guard
// pins that the one-shot is given the role's name+password and cmdInit calls
// ensureKernelApiReader with them. A source-level pin: the behaviour itself is
// proven by the kernel-api harness against a real PG (ensureKernelApiReader)
// and, end to end, by the deploy proof.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8')

function serviceBlock(text, name) {
  const start = text.search(new RegExp(`^  ${name}:`, 'm'))
  assert.ok(start >= 0, `service ${name} not found`)
  const rest = text.slice(start + 1)
  const next = rest.search(/^  [a-z][\w-]*:/m)
  return next < 0 ? rest : rest.slice(0, next)
}

test('compose tenant-create passes KERNEL_API_DB_USER and a required KERNEL_API_DB_PASSWORD to init', () => {
  const b = serviceBlock(read('docker-compose.app.yml'), 'tenant-create')
  assert.match(b, /^\s+KERNEL_API_DB_USER: \$\{KERNEL_API_DB_USER:-gremion_kernel_api\}/m)
  assert.match(b, /^\s+KERNEL_API_DB_PASSWORD: \$\{KERNEL_API_DB_PASSWORD:\?/m)
})

test('gremion-tenant init (cmdInit) ensures the kernel API reader from those variables', () => {
  const src = read('gremion-ui/scripts/tenant-provision.ts')
  const init = src.slice(src.indexOf('async function cmdInit'), src.indexOf('// ── create phases'))
  assert.match(init, /reqEnv\('KERNEL_API_DB_USER'\)/)
  assert.match(init, /reqEnv\('KERNEL_API_DB_PASSWORD'\)/)
  assert.match(init, /ensureKernelApiReader\(/)
  assert.match(src, /ensureKernelApiReader[^\n]*from '@gremion\/tenant-store\/lifecycle'|import \{[^}]*ensureKernelApiReader[^}]*\} from '@gremion\/tenant-store\/lifecycle'/)
})
