// TASK-080-a brief G6: what docker-compose.app.yml gives the kernel-api service
// for the identity event relay. (scripts/check-pooled-stack.test.mjs renders the
// real projects; this holds the TEXT of the kernel-api block to the contract.)
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const COMPOSE = readFileSync(fileURLToPath(new URL('../../../../docker-compose.app.yml', import.meta.url)), 'utf8').replace(/\r\n/g, '\n')
const block = (name: string): string => {
  const start = COMPOSE.indexOf(`\n  ${name}:\n`)
  expect(start, `${name} is a service`).toBeGreaterThan(-1)
  const rest = COMPOSE.slice(start + 1)
  const end = rest.slice(2).search(/\n  [a-z][a-z0-9-]*:\n/)
  return end === -1 ? rest : rest.slice(0, end + 2)
}

describe('docker-compose.app.yml: kernel-api and the identity relay', () => {
  const svc = block('kernel-api')

  it('carries NATS_URL, NATS_SECRETS_DIR and the host collector label org.gremion.events-metrics=idt', () => {
    expect(svc).toMatch(/NATS_URL: nats:\/\/nats-\$\{STACK:\?STACK required\}:4222/)
    expect(svc).toMatch(/NATS_SECRETS_DIR: \/run\/secrets\/nats\n/)
    expect(svc).toMatch(/org\.gremion\.events-metrics: idt\n/)
  })

  it('has NO gremion.evict label (it serves no evict route; check-pooled-stack EVICT_IMPLEMENTERS)', () => {
    expect(svc.split('\n').filter((l) => !l.trim().startsWith('#')).join('\n')).not.toMatch(/gremion\.evict/)
  })

  it('mounts ONLY its own identity\'s seeds: the kernel-api subpath of nats-secrets, read-only, nothing wider', () => {
    const mounts = [...svc.matchAll(/source: nats-secrets\n([\s\S]*?)(?=\n      - |\n    [a-z])/g)]
    expect(mounts).toHaveLength(1)
    expect(mounts[0]![1]).toMatch(/target: \/run\/secrets\/nats\/kernel-api\n/)
    expect(mounts[0]![1]).toMatch(/read_only: true/)
    expect(mounts[0]![1]).toMatch(/subpath: kernel-api\n?/)
    expect(svc).not.toMatch(/nats-secrets:\/run\/secrets\/nats(:|\s)/)
  })

  it('the migrate one-shot publishes nothing: no NATS_URL, no seeds', () => {
    const m = block('kernel-api-migrate')
    expect(m).not.toMatch(/NATS_URL|nats-secrets/)
  })
})
