// gremion-ui/src/lib/server/boundary/contracts-schema.ts
// P0.4: structural validation of the checked-in contract docs. Pure node module.
import { z } from 'zod'

const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'] as const
const PATH_ITEM_EXTRA = ['parameters', 'summary', 'description'] as const

const responsesSchema = z.record(
  z.string().regex(/^[1-5]\d\d$|^default$/, 'response keys must be status codes or "default"'),
  z.looseObject({ description: z.string().optional() }),
)
const operationSchema = z.looseObject({
  summary: z.string().min(1),
  responses: responsesSchema,
})
const infoSchema = z.looseObject({ title: z.string().min(1), version: z.string().min(1) })

const openApiDocSchema = z.looseObject({
  openapi: z.string().regex(/^3\.1\.\d+$/, 'must be OpenAPI 3.1.x'),
  info: infoSchema,
  paths: z.record(z.string().startsWith('/', 'paths must start with /'), z.looseObject({})),
  components: z.looseObject({}).optional(),
})

const asyncApiDocSchema = z.looseObject({
  asyncapi: z.literal('3.0.0'),
  info: infoSchema,
  channels: z.record(z.string(), z.looseObject({ address: z.string().min(1) })),
  operations: z.record(z.string(), z.looseObject({
    action: z.enum(['send', 'receive']),
    channel: z.looseObject({ $ref: z.string() }),
  })),
  components: z.looseObject({}).optional(),
})

function zodProblems(r: z.ZodSafeParseResult<unknown>): string[] {
  return r.success ? [] : r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`)
}

export function validateOpenApiDoc(doc: unknown): string[] {
  const problems = zodProblems(openApiDocSchema.safeParse(doc))
  if (problems.length > 0) return problems
  const d = doc as { paths: Record<string, Record<string, unknown>> }
  for (const [p, item] of Object.entries(d.paths)) {
    const methods = Object.keys(item).filter((k) => (HTTP_METHODS as readonly string[]).includes(k))
    if (methods.length === 0) problems.push(`${p}: path item has no operations`)
    for (const k of Object.keys(item)) {
      if (!(HTTP_METHODS as readonly string[]).includes(k) && !(PATH_ITEM_EXTRA as readonly string[]).includes(k)) {
        problems.push(`${p}: unknown path-item key '${k}'`)
      }
    }
    for (const m of methods) {
      problems.push(...zodProblems(operationSchema.safeParse(item[m])).map((x) => `${p}.${m}.${x}`))
    }
  }
  return problems
}

export function validateAsyncApiDoc(doc: unknown): string[] {
  return zodProblems(asyncApiDocSchema.safeParse(doc))
}

/** Walk the doc; every local '#/…' $ref must resolve to an existing node. */
export function collectUnresolvedRefs(doc: unknown): string[] {
  const unresolved: string[] = []
  const resolve = (ref: string): boolean => {
    if (!ref.startsWith('#/')) return true // external refs out of scope (we use none)
    let node: unknown = doc
    for (const seg of ref.slice(2).split('/')) {
      const key = seg.replace(/~1/g, '/').replace(/~0/g, '~')
      if (typeof node !== 'object' || node === null || !(key in (node as Record<string, unknown>))) return false
      node = (node as Record<string, unknown>)[key]
    }
    return true
  }
  const walk = (n: unknown): void => {
    if (Array.isArray(n)) { n.forEach(walk); return }
    if (typeof n === 'object' && n !== null) {
      for (const [k, v] of Object.entries(n)) {
        if (k === '$ref' && typeof v === 'string' && !resolve(v)) unresolved.push(v)
        walk(v)
      }
    }
  }
  walk(doc)
  return unresolved
}
