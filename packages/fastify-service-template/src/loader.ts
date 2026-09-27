// THE route loader. This is the only module in the template that registers a
// route (the grep test in test/scaffold.test.ts holds that): every
// route a template service answers is either an operation of its OpenAPI spec,
// looked up by operationId in the handler table, or one of PLATFORM_ROUTES.
//
// Q1 (brief §5): fastify-openapi-glue@4.11.5 was probed first and rejected.
// On the template fixture it (a) turned the multipart/form-data request body
// into a body schema, so every streamed upload answered 400 "body must be
// object"; (b) invented an operationId (makeOperationId) for an operation that
// has none; (c) registered a request-time "not implemented" stub for a missing
// handler instead of failing boot. (b) and (c) are the two failures this
// template exists to refuse, so this own loader replaces it.
import type { FastifyInstance, FastifyReply, FastifyRequest, RouteHandlerMethod } from 'fastify'
import { ServiceBootError } from './errors.ts'
import { armUploadLimit } from './upload.ts'
import { listOperations, routeKey, type JsonObject, type OpenApiDocument, type SpecOperation } from './spec.ts'

/** A handler for one spec operation. Plain Fastify handler signature. */
export type OperationHandler = RouteHandlerMethod

export type HandlerTable = Record<string, OperationHandler>

export interface PlatformRoute {
  method: string
  /** Path in spec form (`{param}`), the same form routes:check compares. */
  path: string
}

/**
 * Routes every template service answers without the spec declaring them.
 * routes:check exempts exactly these (by METHOD + path) and nothing else.
 * This is the seam for later platform routes (TASK-035's D4 evict lands here).
 */
export const PLATFORM_ROUTES: readonly PlatformRoute[] = Object.freeze([
  Object.freeze({ method: 'GET', path: '/healthz' }),
])

const PLATFORM_HANDLERS: Record<string, OperationHandler> = {
  'GET /healthz': async () => ({ status: 'ok' }),
}

const MULTIPART = 'multipart/form-data'

/**
 * `/a/{id}` -> `/a/:id` (find-my-way syntax). A literal `:` in the spec path
 * (a custom method, `/a/{id}:archive`) is escaped as `::` first, or the router
 * would read it as the start of a second parameter. find-my-way ends a
 * parameter NAME only at `-`, `.`, `/` or `(`, so a parameter directly
 * followed by a literal colon gets a regex terminator `(^[^:]+)`; without it
 * the parameter would be named `id::archive`.
 */
export function toFastifyPath(specPath: string): string {
  return specPath
    .replace(/:/g, '::')
    .replace(/\{([^}/]+)\}(?=::)/g, ':$1(^[^:]+)')
    .replace(/\{([^}/]+)\}/g, ':$1')
}

/**
 * Check the spec's operations against the handler table. Every problem is
 * collected and thrown together: missing operationId, duplicated operationId,
 * missing handler, a handler that is not a function, and a handler for an
 * operationId the spec does not declare.
 */
export function checkHandlerTable(ops: SpecOperation[], handlers: HandlerTable): void {
  const problems: string[] = []
  if (!handlers || typeof handlers !== 'object') {
    throw new ServiceBootError(['handlers must be an object keyed by operationId'])
  }
  const seen = new Map<string, string>()
  for (const op of ops) {
    const key = routeKey(op.method, op.path)
    if (op.operationId === undefined) {
      problems.push(`${key} has no operationId; the template routes by operationId and does not invent one`)
      continue
    }
    const first = seen.get(op.operationId)
    if (first) {
      problems.push(`duplicate operationId "${op.operationId}" on ${first} and ${key}`)
      continue
    }
    seen.set(op.operationId, key)
    if (!Object.hasOwn(handlers, op.operationId)) {
      problems.push(`no handler for operationId "${op.operationId}" (${key})`)
    } else if (typeof handlers[op.operationId] !== 'function') {
      problems.push(`handler for operationId "${op.operationId}" (${key}) is not a function`)
    }
  }
  for (const id of Object.keys(handlers)) {
    if (!seen.has(id) && !ops.some((op) => op.operationId === id)) {
      problems.push(`handler "${id}" matches no operationId in the spec`)
    }
  }
  if (problems.length) throw new ServiceBootError(problems)
}

function parametersSchema(params: JsonObject[], location: string): JsonObject | undefined {
  const selected = params.filter((p) => p.in === location)
  if (selected.length === 0) return undefined
  const properties: JsonObject = {}
  const required: string[] = []
  for (const p of selected) {
    // HTTP header names are case-insensitive; Fastify hands them over lower-cased.
    const name = location === 'header' ? String(p.name).toLowerCase() : String(p.name)
    properties[name] = (p.schema as JsonObject | undefined) ?? {}
    if (p.required === true || location === 'path') required.push(name)
  }
  return { type: 'object', properties, ...(required.length ? { required } : {}) }
}

function isJsonMediaType(mediaType: string): boolean {
  const base = mediaType.split(';')[0].trim().toLowerCase()
  return base === 'application/json' || base.endsWith('+json')
}

/** Build the Fastify route schema for one operation. Response schemas stay ON (brief §5). */
function routeSchema(op: SpecOperation): { schema: JsonObject; multipart: boolean } {
  const schema: JsonObject = {}
  const params = parametersSchema(op.parameters, 'path')
  const querystring = parametersSchema(op.parameters, 'query')
  const headers = parametersSchema(op.parameters, 'header')
  if (params) schema.params = params
  if (querystring) schema.querystring = querystring
  if (headers) schema.headers = headers

  let multipart = false
  const body = op.operation.requestBody as JsonObject | undefined
  const content = (body?.content ?? {}) as Record<string, JsonObject>
  const jsonBodies = Object.entries(content).filter(([mt, media]) => isJsonMediaType(mt) && media.schema)
  if (Object.keys(content).some((mt) => mt.toLowerCase().startsWith(MULTIPART))) multipart = true
  // A multipart body is streamed to the handler (@fastify/multipart), never
  // parsed into request.body, so it gets no body schema: validating the
  // stream's absent body would reject every upload.
  if (jsonBodies.length === 1 && Object.keys(content).length === 1) {
    schema.body = jsonBodies[0][1].schema
  } else if (jsonBodies.length > 0) {
    schema.body = { content: Object.fromEntries(jsonBodies.map(([mt, media]) => [mt, { schema: media.schema }])) }
  }

  const response: JsonObject = {}
  for (const [status, res] of Object.entries((op.operation.responses ?? {}) as Record<string, JsonObject>)) {
    const resContent = (res?.content ?? {}) as Record<string, JsonObject>
    const typed = Object.entries(resContent).filter(([, media]) => media && media.schema)
    if (typed.length === 0) continue
    response[status.toLowerCase()] = {
      content: Object.fromEntries(typed.map(([mt, media]) => [mt, { schema: media.schema }])),
    }
  }
  if (Object.keys(response).length) schema.response = response
  return { schema, multipart }
}

/**
 * Register every spec operation and every platform route on `app`.
 * `doc` must already be $ref-inlined (spec.ts inlineRefs) and the handler
 * table already checked (checkHandlerTable).
 */
export function registerRoutes(
  app: FastifyInstance,
  doc: OpenApiDocument,
  handlers: HandlerTable,
  uploadCeilingBytes: number,
): void {
  const ops = listOperations(doc)
  const specKeys = new Set(ops.map((op) => routeKey(op.method, op.path)))
  for (const op of ops) {
    const { schema, multipart } = routeSchema(op)
    const handler = handlers[op.operationId as string]
    app.route({
      method: op.method as 'GET',
      url: toFastifyPath(op.path),
      schema,
      ...(multipart
        ? {
            preHandler: async (request: FastifyRequest, reply: FastifyReply) => {
              armUploadLimit(request, reply, uploadCeilingBytes)
            },
          }
        : {}),
      handler,
    })
  }
  for (const platform of PLATFORM_ROUTES) {
    const key = routeKey(platform.method, platform.path)
    // A spec that declares a platform route owns it (and must supply its handler).
    if (specKeys.has(key)) continue
    app.route({ method: platform.method as 'GET', url: toFastifyPath(platform.path), handler: PLATFORM_HANDLERS[key] })
  }
}
