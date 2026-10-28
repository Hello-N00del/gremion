import { createHash } from 'node:crypto'

/**
 * Integration-test helper (TASK-033-a): audit_log.user_id carries a CHECK
 * (migration 0061) that accepts a lowercase uuid or a `<token>-service`
 * principal, so a test's readable actor name ("u1", "member-1") becomes a
 * deterministic uuid. The same name always maps to the same uuid, so a test can
 * compare what it wrote with what it reads back. Not a runtime module.
 */
export function actor(name: string): string {
  const h = createHash('sha1').update(`audit-test-actor:${name}`).digest('hex')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`
}
