// TASK-044 (brief Q6, section 9): the two small inputs that let a scratch
// stack's running proof create a customer WITH modules through the real
// level-1 gate (no allow gate in src/).
import postgres from 'postgres'
import type { DpiaSpec } from '@gremion/provisioning'

/** The stack names a scratch proof runs under (t043-<sha8>, t044-<sha8>, ...). */
const SCRATCH_STACK = /^t\d{3}[a-z]?-[0-9a-f]{8}$/
/** The per-stack platform database alias (docker-compose.app.yml: postgres-${STACK}). */
const STACK_HOST = /^postgres-(t\d{3}[a-z]?-[0-9a-f]{8})$/

/**
 * Q6: `scratch-fixture:` isolation evidence is accepted only when the caller
 * names a scratch stack (GREMION_SCRATCH_FIXTURES) AND the platform database
 * host is that same stack's alias. Fails closed: an unset opt-in, a
 * production-looking stack or host, another stack's alias or an unparseable
 * URL is false. A production host's stack is never a tNNN-<sha8> name.
 */
export function scratchFixturesAllowed(stack: string | undefined, platformUrl: string | undefined, productionStack?: string): boolean {
  if (!stack || !SCRATCH_STACK.test(stack) || !platformUrl) return false
  // The scratch stack must not be the production stack (GREMION_PRODUCTION_STACK).
  if (productionStack !== undefined && productionStack === stack) return false
  const host = poolHost(platformUrl)
  return host !== null && STACK_HOST.exec(host)?.[1] === stack
}

/**
 * The single TCP host the pool would connect to, derived with the SAME parser
 * the pool uses (postgres.js options): new URL() takes the host after the LAST
 * @, postgres.js after the FIRST @ and splits on commas, so the two disagree on
 * crafted URLs. Null unless exactly one TCP host (no list, no unix socket).
 */
function poolHost(url: string): string | null {
  try {
    const sql = postgres(url, { max: 0 }) // lazy: constructing connects to nothing
    const { host, path } = sql.options as unknown as { host: string[]; path: string | false }
    void sql.end({ timeout: 0 }).catch(() => undefined)
    if (path || !Array.isArray(host) || host.length !== 1 || !host[0]) return null
    return host[0]
  } catch {
    return null
  }
}

/** --dpia-json: {"<module>": {requiresDpia, reasonCodes, documentRef}} (the library validates the values). */
export function parseDpiaMap(text: string): Record<string, DpiaSpec> {
  let j: unknown
  try {
    j = JSON.parse(text)
  } catch {
    throw new Error('--dpia-json is not JSON')
  }
  if (!j || typeof j !== 'object' || Array.isArray(j)) throw new Error('--dpia-json must hold one object {"<module>": {requiresDpia, reasonCodes, documentRef}}')
  const out: Record<string, DpiaSpec> = {}
  for (const [moduleKey, v] of Object.entries(j)) {
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error(`--dpia-json: the decision for ${moduleKey} must be an object {requiresDpia, reasonCodes, documentRef}`)
    const d = v as Partial<DpiaSpec>
    out[moduleKey] = { requiresDpia: d.requiresDpia as DpiaSpec['requiresDpia'], reasonCodes: Array.isArray(d.reasonCodes) ? d.reasonCodes : [], documentRef: d.documentRef as string }
  }
  return out
}
