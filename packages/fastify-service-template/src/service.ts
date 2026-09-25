// createService({ spec, handlers, config }): a Fastify instance whose routes
// come from the spec (loader.ts), with the platform upload ceiling, RFC 9457
// error bodies and an onRoute collector that records the ACTUAL route table
// (what routes:check diffs against the spec).
import Fastify, { type FastifyError, type FastifyInstance, type FastifyServerOptions } from 'fastify'
import multipart from '@fastify/multipart'
import { STATUS_CODES } from 'node:http'
import { resolveUploadCeiling } from './ceiling.ts'
import { checkHandlerTable, registerRoutes, type HandlerTable, type OperationHandler } from './loader.ts'
import { checkRequestMediaTypes, registerJsonMediaTypes } from './media-types.ts'
import { PROBLEM_TYPES, sendProblem } from './problem.ts'
import { inlineRefs, listOperations, loadSpec, routeKey, type SpecSource } from './spec.ts'
import { uploadLimitWasHit } from './upload.ts'
import { createValidatorCompiler } from './validation.ts'

export interface ServiceConfig {
  /**
   * Upload ceiling in bytes: file payload for multipart, whole body otherwise.
   * Unset = 50 MiB. A number or a decimal-digit string (an env var); any
   * other value refuses to boot (InvalidUploadCeilingError).
   */
  uploadCeilingBytes?: unknown
  /** Passed to Fastify. Defaults to false (the scaffolded main.ts turns it on). */
  logger?: FastifyServerOptions['logger']
}

export interface CreateServiceOptions {
  /** The committed OpenAPI 3.1 document, or a path/URL to its JSON file. */
  spec: SpecSource
  /** One handler per operationId, no more, no fewer. */
  handlers: HandlerTable
  config?: ServiceConfig
}

interface ServiceState {
  routeTable: string[]
  uploadCeilingBytes: number
}

const STATE = new WeakMap<FastifyInstance, ServiceState>()

const TOO_LARGE_CODES = new Set(['FST_REQ_FILE_TOO_LARGE', 'FST_ERR_CTP_BODY_TOO_LARGE'])

function state(app: FastifyInstance): ServiceState {
  const s = STATE.get(app)
  if (!s) throw new Error('not a template service: this instance was not made by createService()')
  return s
}

/**
 * The route table as registered, one `METHOD /path{param}` key per route and
 * method, in registration order, duplicates kept. Complete after `ready()`.
 */
export function getRouteTable(app: FastifyInstance): string[] {
  return [...state(app).routeTable]
}

export function getUploadCeilingBytes(app: FastifyInstance): number {
  return state(app).uploadCeilingBytes
}

/**
 * `/a/:id` -> `/a/{id}` (spec form), for comparing a Fastify URL with a spec
 * path. `::` is find-my-way's escaped literal colon and maps back to `:`.
 */
export function toSpecPath(fastifyUrl: string): string {
  return fastifyUrl.replace(/::|:([A-Za-z0-9_]+)(\([^)]*\))?/g, (_match, name: string | undefined) =>
    name === undefined ? ':' : `{${name}}`,
  )
}

/** Handler stub: 501 problem+json until the operation is implemented. */
export function notImplemented(operationId: string): OperationHandler {
  return async (_request, reply) =>
    sendProblem(reply, {
      type: PROBLEM_TYPES.notImplemented,
      title: 'Not Implemented',
      status: 501,
      detail: `Operation "${operationId}" is declared in the spec but not implemented yet.`,
    })
}

export function createService(options: CreateServiceOptions): FastifyInstance {
  const config = options.config ?? {}
  const uploadCeilingBytes = resolveUploadCeiling(config.uploadCeilingBytes)
  const doc = inlineRefs(loadSpec(options.spec))
  const ops = listOperations(doc)
  checkHandlerTable(ops, options.handlers)
  const jsonMediaTypes = checkRequestMediaTypes(ops)

  const app = Fastify({
    logger: config.logger ?? false,
    bodyLimit: uploadCeilingBytes,
    // No implicit HEAD twin per GET: the route table is exactly the spec.
    exposeHeadRoutes: false,
  })
  registerJsonMediaTypes(app, jsonMediaTypes)
  const routeTable: string[] = []
  STATE.set(app, { routeTable, uploadCeilingBytes })

  // Installed first, on the root, so it sees every route registered after it
  // (the loader's, the platform's, and any hand-written one, in any plugin).
  app.addHook('onRoute', (route) => {
    const methods = Array.isArray(route.method) ? route.method : [route.method]
    for (const m of methods) routeTable.push(routeKey(m, toSpecPath(route.url ?? route.path)))
  })

  app.setValidatorCompiler(createValidatorCompiler(doc))

  app.setErrorHandler((error: FastifyError, request, reply) => {
    if (TOO_LARGE_CODES.has(error.code)) {
      return sendProblem(reply, {
        type: PROBLEM_TYPES.payloadTooLarge,
        title: 'Payload Too Large',
        status: 413,
        detail: `The upload exceeds the configured ceiling of ${uploadCeilingBytes} bytes.`,
        limitBytes: uploadCeilingBytes,
      })
    }
    if (error.validation) {
      return sendProblem(reply, {
        type: PROBLEM_TYPES.validation,
        title: 'Bad Request',
        status: 400,
        detail: error.message,
        errors: error.validation.map((v) => ({ path: v.instancePath, message: v.message })),
      })
    }
    const status = error.statusCode
    if (typeof status === 'number' && status >= 400 && status < 500) {
      return sendProblem(reply, {
        type: PROBLEM_TYPES.badRequest,
        title: STATUS_CODES[status] ?? 'Client Error',
        status,
        detail: error.message,
      })
    }
    request.log.error({ err: error }, 'unhandled error')
    return sendProblem(reply, { type: PROBLEM_TYPES.internal, title: 'Internal Server Error', status: 500 })
  })

  app.setNotFoundHandler((_request, reply) =>
    sendProblem(reply, {
      type: PROBLEM_TYPES.notFound,
      title: 'Not Found',
      status: 404,
      detail: 'No operation is declared for this method and path.',
    }),
  )

  // Layer 2 of the no-truncation guarantee (see upload.ts).
  app.addHook('onSend', async (request, reply, payload) => {
    if (!uploadLimitWasHit(request) || reply.statusCode >= 400) return payload
    request.log.error('handler answered success for an upload over the ceiling; replaced with 413')
    reply.code(413).type('application/problem+json')
    return JSON.stringify({
      type: PROBLEM_TYPES.payloadTooLarge,
      title: 'Payload Too Large',
      status: 413,
      detail: `The upload exceeds the configured ceiling of ${uploadCeilingBytes} bytes.`,
      limitBytes: uploadCeilingBytes,
    })
  })

  app.register(multipart, {
    limits: { fileSize: uploadCeilingBytes },
    throwFileSizeLimit: true,
  })

  registerRoutes(app, doc, options.handlers)
  return app
}
