// Shared test helpers: the fixture vertical, a recording fake target, and the
// two source scanners the ratchet guards run (exported so a guard can be shown
// RED against a seeded violation).
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AccountResult, BodyRef, ExistingMembership, MemberImportTarget, Role } from '../src/index.ts'
import { loadVertical } from '../src/index.ts'

const here = dirname(fileURLToPath(import.meta.url))
export const FIXTURE_DIR = join(here, 'fixtures', 'verticals', 'fixture')
export const SRC_DIR = join(here, '..', 'src')

export const fixtureVertical = () => loadVertical((f) => readFileSync(join(FIXTURE_DIR, f), 'utf8'), 'fixture')

export const BODIES: BodyRef[] = [
  { id: 'b-assembly', name: 'Assembly' },
  { id: 'b-exec', name: 'Executive' },
  { id: 'b-ops', name: 'Operations' },
]

export function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n)
    return statSync(p).isDirectory() ? sourceFiles(p) : p.endsWith('.ts') ? [p] : []
  })
}

/** Offending import specifiers: SvelteKit, $lib/$app/$env aliases, the app's own tree. */
export function sveltekitImports(source: string): string[] {
  const specs = [...source.matchAll(/(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g)].map((m) => m[1]!)
  return specs.filter((s) => /^(\$lib|\$app|\$env|\$service-worker)(\/|$)/.test(s) || s.startsWith('@sveltejs/') || s === 'svelte' || s.startsWith('svelte/') || /gremion-ui/.test(s))
}

/** A vertical's name must never be spelled in this package's source (the vertical-literal ratchet). */
export const VERTICAL_LITERALS = /stura|studierend|referat|fachschaft|nextcloud-?stura/i
export function verticalLiterals(source: string): string[] {
  return [...source.matchAll(new RegExp(VERTICAL_LITERALS, 'gi'))].map((m) => m[0])
}

/** A module's id or path named in code: the import core must stay module-blind. */
export const MODULE_NAMES = /modules\/(board|calendar|newsletter|messages|files|votes|vault|finance|content)\b|@gremion\/(board|calendar|newsletter|messages|files|votes|vault|finance|content)\b/i

export class FakeTarget implements MemberImportTarget {
  users = new Map<string, string>() // email -> id
  members = new Map<string, ExistingMembership>() // `${body}|${user}`
  calls: string[] = []
  mails = 0
  rearmed: string[][] = []
  private n = 0

  preexisting(email: string, id = `u-${++this.n}`): void {
    this.users.set(email, id)
  }
  async findUserId(email: string) {
    return this.users.get(email) ?? null
  }
  async membership(bodyId: string, userId: string) {
    return this.members.get(`${bodyId}|${userId}`) ?? null
  }
  async ensureAccount(a: { email: string; firstName: string; lastName: string; role: string }): Promise<AccountResult> {
    this.calls.push(`account:${a.email}`)
    const have = this.users.get(a.email)
    if (have) return { userId: have, created: false, invited: false }
    const id = `u-${++this.n}`
    this.users.set(a.email, id)
    this.mails++
    return { userId: id, created: true, invited: true }
  }
  async addMembership(m: { bodyId: string; userId: string; role: Role }) {
    this.calls.push(`member:${m.bodyId}:${m.userId}:${m.role.key}`)
    this.members.set(`${m.bodyId}|${m.userId}`, { membershipType: m.role.membership_type, voting: m.role.voting })
  }
  async rearm(bodyIds: readonly string[]) {
    this.rearmed.push([...bodyIds])
  }
}
