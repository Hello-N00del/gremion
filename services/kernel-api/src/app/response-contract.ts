// services/kernel-api/src/app/response-contract.ts — Q4 (TRD-403; OWASP
// API3:2023): every response body is checked against kernel-core.json BEFORE
// it is serialised. The template's default (kept for every other service) is
// that Fastify's response serialiser DROPS a field the schema does not
// declare (packages/fastify-service-template/test/loader.test.ts); here an
// undeclared field, a wrong type, or a status/content type the spec does not
// declare for the operation is a 500 `response-contract-violation`, with the
// offending paths in the log -- fail closed, never a silent drop.
//
// Runs as a preSerialization hook (object payloads). Problem bodies the
// service sends itself are pre-serialised strings (template sendProblem) and
// are pinned against the spec's Problem schema by the conformance suite.
import { Ajv2020, type ValidateFunction } from 'ajv/dist/2020.js'
import addFormatsImport from 'ajv-formats'
import type { FastifyReply, FastifyRequest } from 'fastify'
import { listOperations, type OpenApiDocument } from '@gremion/fastify-service-template'
import type { Logger } from './deps.ts'

// ajv-formats is CJS with `module.exports = formatsPlugin; exports.default = ...` (as in the template).
const addFormats = ((addFormatsImport as unknown as { default?: unknown }).default ?? addFormatsImport) as (ajv: Ajv2020) => Ajv2020

export const RESPONSE_CONTRACT_VIOLATION = 'urn:gremion:problem:response-contract-violation'

/** operationId -> status (or 'default') -> media type -> validator. */
export type ResponseContract = Map<string, Map<string, Map<string, ValidateFunction>>>

const OPENAPI_ANNOTATIONS = ['example', 'xml', 'externalDocs', 'discriminator']

/** Compiles every declared response schema of `doc` ($refs already inlined). Throws on a schema Ajv refuses. */
export function buildResponseContract(doc: OpenApiDocument): ResponseContract {
  const ajv = new Ajv2020({ strict: true, allErrors: true, allowUnionTypes: true })
  addFormats(ajv)
  for (const k of OPENAPI_ANNOTATIONS) ajv.addKeyword(k)
  const out: ResponseContract = new Map()
  for (const op of listOperations(doc)) {
    if (!op.operationId) continue
    const byStatus = new Map<string, Map<string, ValidateFunction>>()
    for (const [status, res] of Object.entries((op.operation.responses ?? {}) as Record<string, { content?: Record<string, { schema?: unknown }> }>)) {
      const byType = new Map<string, ValidateFunction>()
      for (const [mediaType, media] of Object.entries(res?.content ?? {})) {
        if (media?.schema !== undefined) byType.set(mediaType.toLowerCase(), ajv.compile(media.schema as object))
      }
      byStatus.set(status.toLowerCase(), byType)
    }
    out.set(op.operationId, byStatus)
  }
  return out
}

export interface Violation {
  operationId: string
  status: number
  mediaType: string
  problems: string[]
}

/** null when `payload` is what the spec declares for (operationId, status, mediaType); else what is wrong. */
export function checkResponse(contract: ResponseContract, operationId: string, status: number, mediaType: string, payload: unknown): Violation | null {
  const byStatus = contract.get(operationId)
  const byType = byStatus?.get(String(status)) ?? byStatus?.get('default')
  const validate = byType?.get(mediaType)
  if (!validate) return { operationId, status, mediaType, problems: [`no ${mediaType} body is declared for status ${status}`] }
  if (validate(payload)) return null
  return {
    operationId,
    status,
    mediaType,
    problems: (validate.errors ?? []).map((e) => `${e.instancePath || '/'} ${e.message ?? 'invalid'}${e.params && 'additionalProperty' in e.params ? ` (${String(e.params.additionalProperty)})` : ''}`),
  }
}

export function createResponseContractHook(o: { contract: ResponseContract; operationOf(request: FastifyRequest): string | null; log: Logger }) {
  return async function responseContract(request: FastifyRequest, reply: FastifyReply, payload: unknown): Promise<unknown> {
    const operationId = o.operationOf(request)
    if (operationId === null) return payload
    const rawType = reply.getHeader('content-type')
    const mediaType = (typeof rawType === 'string' ? rawType : 'application/json').split(';')[0]!.trim().toLowerCase()
    const v = checkResponse(o.contract, operationId, reply.statusCode, mediaType, payload)
    if (!v) return payload
    o.log.error('response-contract-violation', { operationId: v.operationId, status: v.status, mediaType: v.mediaType, problems: v.problems })
    reply.code(500).type('application/problem+json')
    return { type: RESPONSE_CONTRACT_VIOLATION, title: 'Internal Server Error', status: 500, detail: 'The response did not match the API contract.' }
  }
}
