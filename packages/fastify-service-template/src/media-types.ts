// Request media types the spec declares, checked at boot.
//
// Fastify parses only application/json and text/plain out of the box, and
// @fastify/multipart adds multipart/form-data. Any other declared request
// media type would boot fine, pass routes:check, and then answer 415 to every
// request that follows the spec. So:
//   - a declared structured-syntax `+json` type (RFC 6839, e.g.
//     application/merge-patch+json) gets Fastify's own JSON parser, with the
//     same body ceiling and __proto__/constructor poisoning refusal as
//     application/json. Only the declared types are registered.
//   - anything else (application/octet-stream, form-urlencoded, a media range
//     like application/* or */*) refuses to boot, named, per operation.
import type { FastifyInstance } from 'fastify'
import { ServiceBootError } from './errors.ts'
import { routeKey, type JsonObject, type SpecOperation } from './spec.ts'

const NATIVE = new Set(['application/json', 'text/plain', 'multipart/form-data'])
const TOKEN = "[a-z0-9!#$&^_.'-]+"
const STRUCTURED_JSON = new RegExp(`^${TOKEN}/${TOKEN}\\+json$`)

/** `Application/Merge-Patch+JSON; charset=utf-8` -> `application/merge-patch+json`. */
export function mediaTypeEssence(mediaType: string): string {
  return mediaType.split(';')[0].trim().toLowerCase()
}

/**
 * Check every declared request media type. Returns the `+json` types that
 * need a parser registered; throws one ServiceBootError naming every type the
 * template cannot parse.
 */
export function checkRequestMediaTypes(ops: SpecOperation[]): string[] {
  const problems: string[] = []
  const structured = new Set<string>()
  for (const op of ops) {
    const body = op.operation.requestBody as JsonObject | undefined
    for (const declared of Object.keys((body?.content ?? {}) as JsonObject)) {
      const essence = mediaTypeEssence(declared)
      if (NATIVE.has(essence)) continue
      if (STRUCTURED_JSON.test(essence)) {
        structured.add(essence)
        continue
      }
      problems.push(
        `${routeKey(op.method, op.path)} declares request media type "${declared}", which the template cannot parse ` +
          '(supported: application/json, any +json type, text/plain, multipart/form-data); it would answer 415 to every request',
      )
    }
  }
  if (problems.length) throw new ServiceBootError(problems)
  return [...structured].sort()
}

/** Register Fastify's default JSON parser for each declared `+json` type. */
export function registerJsonMediaTypes(app: FastifyInstance, mediaTypes: readonly string[]): void {
  const parser = app.getDefaultJsonParser('error', 'error')
  for (const mediaType of mediaTypes) {
    app.addContentTypeParser(mediaType, { parseAs: 'string' }, parser)
  }
}
