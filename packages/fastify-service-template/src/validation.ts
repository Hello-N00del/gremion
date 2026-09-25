// Request validation with Ajv's JSON Schema 2020-12 dialect (OpenAPI 3.1).
// Fastify's built-in compiler is draft-07; it would mis-read 3.1 schemas
// (type arrays are fine, but prefixItems/$defs/unevaluated* are not), so the
// template installs its own compiler.
//
// Two Ajv instances, one per part family:
//   - params / querystring / headers arrive as strings, so they coerce
//     (`coerceTypes: 'array'`, Fastify's own default for these parts).
//   - body is JSON and is validated as sent: no coercion, and no
//     `removeAdditional` either. A body the spec forbids is a 400, never a
//     silently trimmed object.
import { Ajv2020 } from 'ajv/dist/2020.js'
import type { Options as AjvOptions } from 'ajv'
import addFormatsImport from 'ajv-formats'
import type { FastifySchemaCompiler } from 'fastify'
import type { OpenApiDocument } from './spec.ts'

// ajv-formats is CJS with `module.exports = formatsPlugin; exports.default = ...`.
const addFormats = ((addFormatsImport as unknown as { default?: unknown }).default ?? addFormatsImport) as (
  ajv: Ajv2020,
) => Ajv2020

/**
 * OpenAPI annotation keywords that are not JSON Schema 2020-12 vocabulary.
 * Registered as no-op keywords so Ajv strict mode accepts them; strict mode
 * stays on for everything else (an unknown keyword is more likely a typo that
 * would silently validate nothing).
 */
const OPENAPI_ANNOTATIONS = ['example', 'xml', 'externalDocs', 'discriminator']

function collectExtensionKeys(node: unknown, into: Set<string>): Set<string> {
  if (Array.isArray(node)) node.forEach((n) => collectExtensionKeys(n, into))
  else if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      if (k.startsWith('x-')) into.add(k)
      collectExtensionKeys(v, into)
    }
  }
  return into
}

function makeAjv(doc: OpenApiDocument, options: AjvOptions): Ajv2020 {
  const ajv = new Ajv2020({ strict: true, allErrors: false, useDefaults: true, ...options })
  addFormats(ajv)
  for (const k of [...OPENAPI_ANNOTATIONS, ...collectExtensionKeys(doc.paths, new Set())]) {
    if (!ajv.getKeyword(k)) ajv.addKeyword({ keyword: k })
  }
  return ajv
}

export function createValidatorCompiler(doc: OpenApiDocument): FastifySchemaCompiler<unknown> {
  const coercing = makeAjv(doc, { coerceTypes: 'array' })
  const exact = makeAjv(doc, { coerceTypes: false, removeAdditional: false })
  return ({ schema, httpPart }) => (httpPart === 'body' ? exact : coercing).compile(schema as object)
}
